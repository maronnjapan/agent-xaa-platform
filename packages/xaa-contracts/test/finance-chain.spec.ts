import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CAPABILITY_TO_SCOPE, TOOL_BINDINGS, type Capability, type ToolId } from '../src/identifiers.js';
import { FINANCE_SCOPES } from '../src/scopes.js';

/**
 * The Finance path is the only one that crosses every layer the platform has: a human
 * permission, a delegation rule, a taxonomy entry, a risk rule that forces
 * FULL_ISOLATION and attaches a ceiling, two catalogue rows, a registered scope list,
 * a Firestore path guard, and two Cloud Run services with the isolation gate switched
 * on. Each of those is owned by a different file, and none of them names the others.
 *
 * A break anywhere along it looks the same from the screen — the Agent is created and
 * then cannot do the one thing it was created for — so this walks the chain as one
 * piece. Every value is read off the file that owns it rather than written out here,
 * so the test fails when two owners disagree rather than when someone edits a copy.
 */
const repoRoot = new URL('../../../', import.meta.url).pathname;
const read = (path: string): string => readFileSync(`${repoRoot}${path}`, 'utf8');
const yaml = <T>(path: string): T => parse(read(path)) as T;

const APPROVE: Capability = 'finance.payment.approve';
const READ: Capability = 'finance.payment.read';
const FINANCE_TOOLS: ToolId[] = [
  'internal.finance.payment.list', 'internal.finance.payment.get', 'internal.finance.payment.approve',
];

interface CapabilitySeed {
  capability_id: string;
  default_characteristics: Record<string, unknown>;
}
interface RiskPolicySeed {
  policy_id: string;
  when: Record<string, unknown>;
  min_isolation_level: string;
  added_constraint?: Record<string, unknown>;
}
interface ToolSeed {
  tool_id: string;
  connector_id: string;
  required_capability: string;
  authorization: { type: string; audience: string; resource: string; scope: string };
  api: { base_url: string; method: string; path: string };
  parameters: Record<string, { required?: boolean }>;
  constraints: Record<string, unknown>;
  response_schema: { allowlist: string[] };
}

const capabilities = yaml<CapabilitySeed[]>('infra/seed/capabilities.yaml');
const riskPolicies = yaml<RiskPolicySeed[]>('infra/seed/policies/risk.yaml');
const delegatable = yaml<Array<{ capability_id: string; delegatable: boolean }>>('infra/seed/policies/delegatable.yaml');
const humanPermissions = yaml<Array<{ human_subject: string; capability_id: string }>>('infra/seed/human-permissions.yaml');
const payments = yaml<Array<{ amount: number; memo: string }>>('infra/seed/payments-demo.yaml');
const connector = yaml<{ resource_type: string; tools: string[] }>('infra/seed/connectors/internal-finance-api.yaml');
const tools = new Map(FINANCE_TOOLS.map((id) => [id, yaml<ToolSeed>(`infra/seed/tools/${id}.yaml`)]));
const servicesTf = read('infra/envs/demo/services.tf');
const invokerTf = read('infra/envs/demo/locals-invoker.tf');
const resourceTf = read('infra/envs/demo/locals-resource.tf');

/** The ceiling the Policy Engine attaches to an approval, read off the rule that adds it. */
const riskCeiling = (() => {
  const rule = riskPolicies.find((policy) => policy.when.financial_operation === true);
  return { rule: rule!, maxAmount: Number(rule!.added_constraint!.max_amount) };
})();

describe('the Finance authorization chain', () => {
  /**
   * `testuser` is the account the guide tells a person to log in with, and RULE-11
   * makes their permissions the ceiling on any agent of theirs. Without these two rows
   * every decision intersects with an empty set and the Agent is granted nothing —
   * which reads on screen as the platform refusing rather than as data nobody seeded.
   */
  it('grants the demo login both finance capabilities', () => {
    const held = humanPermissions.filter((row) => row.human_subject === 'testuser').map((row) => row.capability_id);
    expect(held).toContain(READ);
    expect(held).toContain(APPROVE);
  });

  /** RULE-11's second half: holding a capability is not the same as being able to hand it on. */
  it('lets both finance capabilities be delegated to an agent', () => {
    for (const capability of [READ, APPROVE]) {
      expect(delegatable.find((row) => row.capability_id === capability)?.delegatable, capability).toBe(true);
    }
  });

  /**
   * `financial_operation` is the taxonomy's to state, not the model's (docs 03 §7).
   * If it moved into what the Authorization AI contributes, a model could talk the
   * platform out of full isolation by describing the work differently.
   */
  it('marks the approval capability as a financial operation in the taxonomy', () => {
    const approve = capabilities.find((row) => row.capability_id === APPROVE);
    expect(approve?.default_characteristics.financial_operation).toBe(true);
    // The read side deliberately does not carry it: reading a payment forces nothing.
    expect(capabilities.find((row) => row.capability_id === READ)?.default_characteristics.financial_operation)
      .toBeUndefined();
  });

  /** RULE-12: the isolation level is decided by the rule table and nothing may lower it. */
  it('forces full isolation from that characteristic', () => {
    expect(riskCeiling.rule.min_isolation_level).toBe('full_isolation');
    for (const policy of riskPolicies) expect(policy.min_isolation_level).not.toBe('none');
  });

  it('resolves both capabilities to the scopes the Finance Resource AS registers', () => {
    expect(CAPABILITY_TO_SCOPE[READ]).toEqual(['finance.tx.read']);
    expect(CAPABILITY_TO_SCOPE[APPROVE]).toEqual(['finance.tx.write']);
    const registered = new Set<string>(FINANCE_SCOPES);
    for (const capability of [READ, APPROVE]) {
      for (const scope of CAPABILITY_TO_SCOPE[capability]) expect(registered.has(scope), scope).toBe(true);
    }
  });

  it('catalogues the three tools under the one native finance connector', () => {
    expect(connector.resource_type).toBe('native_xaa');
    expect([...connector.tools].sort()).toEqual([...FINANCE_TOOLS].sort());
    for (const [id, tool] of tools) {
      expect(tool.connector_id).toBe('internal-finance-api');
      // A bridged connector would put a token provider in front of the resource; a
      // native one must reach the Resource AS directly (00b).
      expect(tool.authorization.type).toBe('native_xaa');
      expect(tool.required_capability).toBe(TOOL_BINDINGS[id].capability);
      expect(tool.authorization.scope).toBe(TOOL_BINDINGS[id].scope);
      expect(tool.api.method).toBe(TOOL_BINDINGS[id].method);
      expect(tool.api.path).toBe(TOOL_BINDINGS[id].pathTemplate);
    }
  });

  /**
   * The parity check that caught the two Document 400s, applied to the write tool on
   * this side. `buildApiRequest` drops every argument the catalogue did not declare and
   * refuses a declared-required one that is absent, so the declaration is the whole of
   * what can reach the API.
   *
   * The approve endpoint reads nothing but the path: the two subjects come from the
   * token and the amount from the stored row, because RULE-46 will not take either from
   * a request body. So `id` is the only parameter the API itself needs.
   */
  it('declares on the approve tool the path segment the Finance API requires', () => {
    const approve = tools.get('internal.finance.payment.approve')!;
    const path = [...approve.api.path.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]!);
    expect(path).toEqual(['id']);
    for (const name of path) expect(approve.parameters[name]?.required, name).toBe(true);
  });

  /**
   * `amount` is the one declared parameter the API never reads, and it is declared on
   * purpose: `verifyConstraints` checks `max_amount` against `parameters.amount` before
   * the request is built, so leaving it out would make the Tool Executor's half of the
   * double check (specs §5.2) unreachable. Declaring it is only safe because the API
   * re-checks the ceiling against the amount it has stored — a call that understates
   * the amount passes the Executor and is still refused at the resource
   * (e2e/test/resource/finance-flow.spec.ts).
   */
  it('declares the amount the constraint check reads, and lets a read supply it', () => {
    const approve = tools.get('internal.finance.payment.approve')!;
    expect(Object.keys(approve.constraints)).toContain('max_amount');
    expect(approve.parameters.amount?.required).toBe(true);
    // The only way an agent can learn an amount is to read the payment first, so both
    // read tools have to return it or the write tool cannot be called at all.
    for (const id of ['internal.finance.payment.list', 'internal.finance.payment.get'] as const) {
      expect(tools.get(id)!.response_schema.allowlist, id).toContain('amount');
    }
  });

  /**
   * The Provisioner merges the decided constraint over the catalogue's declared one
   * (build-manifest.ts), and only for keys the catalogue already declares. A catalogue
   * ceiling below the policy's would therefore silently win, and one above it is the
   * fallback for a decision that carries none.
   */
  it('keeps the catalogue ceiling from undercutting the policy ceiling', () => {
    const declared = Number(tools.get('internal.finance.payment.approve')!.constraints.max_amount);
    expect(declared).toBeGreaterThanOrEqual(riskCeiling.maxAmount);
  });

  /**
   * The demo has to be completable. Every seeded payment above the ceiling is one the
   * Tool Executor refuses before it is sent, so a seed made entirely of those looks
   * exactly like a Finance path that does not work.
   */
  it('seeds payments a demo agent can actually approve', () => {
    const approvable = payments.filter((row) => row.amount <= riskCeiling.maxAmount);
    const refused = payments.filter((row) => row.amount > riskCeiling.maxAmount);
    expect(approvable.length).toBeGreaterThanOrEqual(2);
    expect(approvable.length).toBeGreaterThan(refused.length);
    // One is kept above the ceiling on purpose, so the refusal is demonstrated too.
    expect(refused.length).toBe(1);
  });

  it('gives the two finance services only the Firestore paths they use', () => {
    // Read from disk rather than imported: `@xaa/gcp` depends on this package, and a
    // dependency the other way round would be a cycle for the sake of one JSON file.
    const matrix = JSON.parse(read('packages/gcp/src/access-matrix.json')) as Record<string, { read?: string[]; write?: string[] }>;
    expect(matrix['resource-finance-api']?.read).toContain('payments/**');
    expect(matrix['resource-finance-api']?.write).toContain('payments/**');
    // The Authorization Server signs tokens; it has no business reading a payment.
    expect(matrix['resource-finance-as']?.read ?? []).not.toContain('payments/**');
    expect(matrix['resource-finance-as']?.write ?? []).not.toContain('payments/**');
  });

  /**
   * T-RES-19. The gate is on both halves: the Resource AS refuses to mint a token for a
   * standard agent, and the API refuses one that reaches it anyway. Losing either turns
   * the double check into a single one without anything failing.
   */
  it('switches the isolation gate on at both finance services', () => {
    const asBlock = serviceBlock('resource-finance-as');
    const apiBlock = serviceBlock('resource-finance-api');
    expect(asBlock).toMatch(/REQUIRE_ISOLATION_LEVEL\s*=\s*"full_isolation"/);
    expect(apiBlock).toMatch(/REQUIRE_ISOLATION_LEVEL\s*=\s*"full_isolation"/);
    // The server-wide ceiling is unconditional, so the API cannot start without one.
    expect(apiBlock).toMatch(/FINANCE_ABSOLUTE_MAX_AMOUNT/);
    expect(apiBlock).toMatch(/FIRESTORE_COLLECTION\s*=\s*"payments"/);
  });

  it('registers exactly the two finance scopes on the Resource AS', () => {
    const declared = resourceTf.match(/finance\s*=\s*\{[^}]*scopes\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    const parsed = [...declared.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(parsed.sort()).toEqual([...FINANCE_SCOPES].sort());
  });

  /**
   * An Agent that redeems an Access Token and is then refused at the API door has come
   * no further than one refused at the token endpoint, so both edges have to exist.
   */
  it('lets the Agent Runtime reach both finance services', () => {
    for (const target of ['resource-finance-as', 'resource-finance-api']) {
      expect(invokerTf, target).toContain(`["agent_runtime", "${target}"]`);
    }
  });
});

/** The one `"<name>" = { ... }` block of services.tf, so a match cannot come from a neighbour. */
function serviceBlock(name: string): string {
  const start = servicesTf.indexOf(`"${name}" = {`);
  expect(start, `${name} has no env block`).toBeGreaterThan(-1);
  const end = servicesTf.indexOf('\n    }', start);
  return servicesTf.slice(start, end);
}
