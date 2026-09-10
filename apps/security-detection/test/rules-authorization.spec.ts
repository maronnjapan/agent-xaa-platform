import { describe, expect, it } from 'vitest';
import { CAPABILITY_TO_SCOPE } from '@xaa/contracts';
import { detectAuthorizationHits } from '../src/rules/authorization.js';
import { THRESHOLDS } from '../src/rules/thresholds.js';
import type { AgentRegistrationView, RuleContext } from '../src/rules/context.js';
import { normalizeEntries } from '../src/normalize/index.js';
import { AGENT_ID, baselineFor, DOCUMENT_READ, logEntry } from '../src/testing/harness.js';

const DOCS_AS = 'https://resource-docs-as-x.example';
const DOCS_RESOURCE = 'https://resource-docs-api.test';

const REGISTRATION: AgentRegistrationView = {
  idp_connection_id: 'idpconn-1',
  allowed_audiences: [DOCS_AS],
  resources: [DOCS_RESOURCE],
};

function context(
  entries: readonly Parameters<typeof logEntry>[0][],
  options: { registration?: AgentRegistrationView; capabilities?: string[] } = {},
): RuleContext {
  return {
    events: normalizeEntries(entries.map((overrides) => logEntry(overrides))).events,
    violations: [],
    baselines: new Map([[AGENT_ID, options.capabilities
      ? { ...baselineFor(), effective_capabilities: options.capabilities }
      : baselineFor()]]),
    registrations: new Map([[AGENT_ID, options.registration ?? REGISTRATION]]),
    maxLifetimeSeconds: null,
  };
}

/** Refusals, all inside one ten-minute window so they are counted together. */
function refusals(count: number, status = '403') {
  return Array.from({ length: count }, (_unused, index) => ({
    log_source: 'resource_api' as const, app: 'resource-docs-api',
    timestamp: `2026-01-01T12:0${index % 10}:00.000Z`,
    trace_id: `trace-${index}`,
    fields: { response_status: status, resource: DOCS_RESOURCE },
  }));
}

/**
 * REQ-09-031. The counted condition and the two that need only one event.
 *
 * The distinction is the point of the test: a burst of 403s is a matter of degree, and a
 * scope or an audience the agent could not have derived is not.
 */
describe('the authorization classification', () => {
  it('status errors 20 no hit, 21 medium, 101 high', () => {
    const limits = THRESHOLDS.authorization!.status_error!;
    expect([limits.medium, limits.high]).toEqual([20, 100]);

    expect(detectAuthorizationHits(context(refusals(limits.medium)))
      .filter((hit) => hit.rule_id.startsWith('authorization.status_error'))).toHaveLength(0);

    const medium = detectAuthorizationHits(context(refusals(limits.medium + 1)));
    expect(medium.map((hit) => hit.rule_id)).toContain('authorization.status_error.medium');

    const high = detectAuthorizationHits(context(refusals(limits.high + 1)));
    expect(high.map((hit) => hit.rule_id)).toContain('authorization.status_error.high');
  });

  it('counts 401 alongside 403', () => {
    const hits = detectAuthorizationHits(context([...refusals(11, '401'), ...refusals(11, '403')]));
    expect(hits.some((hit) => hit.rule_id === 'authorization.status_error.medium')).toBe(true);
  });

  it('unmapped scope hits medium with a single event', () => {
    // The baseline grants document.read, which maps to docs.read and nothing else.
    expect(CAPABILITY_TO_SCOPE[DOCUMENT_READ]).toEqual(['docs.read']);
    const hits = detectAuthorizationHits(context([{ fields: { requested_scope: 'docs.read finance.tx.write' } }]));
    const hit = hits.find((candidate) => candidate.rule_id === 'authorization.scope_out_of_range');
    expect(hit).toBeTruthy();
    expect(hit!.level).toBe('MEDIUM');
    expect(hit!.detail).toEqual({ observed: ['finance.tx.write'], expected: ['docs.read'] });
    // One event, one hit: no count threshold stands between the request and the finding.
    expect(hits.filter((candidate) => candidate.rule_id === 'authorization.scope_out_of_range')).toHaveLength(1);
  });

  /**
   * An administrator can define a capability of their own and map a resource to it, and
   * `CAPABILITY_TO_SCOPE` — a table of the eight the platform ships with — knows nothing
   * about it. Reading the scopes the Provisioner actually injected is what keeps the
   * detector from reporting every request such an agent makes as out of range.
   */
  it('measures against the scopes the agent was issued, not a table of the shipped eight', () => {
    const registration: AgentRegistrationView = { ...REGISTRATION, scopes: ['docs.read'] };

    const issued = detectAuthorizationHits(context([{ fields: { requested_scope: 'docs.read' } }],
      { registration, capabilities: ['contract.review'] }));
    const beyond = detectAuthorizationHits(context([{ fields: { requested_scope: 'finance.tx.write' } }],
      { registration, capabilities: ['contract.review'] }));

    expect(CAPABILITY_TO_SCOPE['contract.review' as never]).toBeUndefined();
    expect(issued.filter((hit) => hit.rule_id === 'authorization.scope_out_of_range')).toHaveLength(0);
    // A scope outside the registration is still a finding: the yardstick moved, not the rule.
    expect(beyond.filter((hit) => hit.rule_id === 'authorization.scope_out_of_range')).toHaveLength(1);
  });

  it('unknown audience hits medium with a single event', () => {
    const hits = detectAuthorizationHits(context([{ fields: { requested_audience: 'https://elsewhere.test' } }]));
    const hit = hits.find((candidate) => candidate.rule_id === 'authorization.unknown_audience');
    expect(hit?.level).toBe('MEDIUM');
    expect(hit!.detail).toEqual({ observed: ['https://elsewhere.test'], expected: [DOCS_AS] });
  });

  it('unknown resource hits medium with a single event', () => {
    const hits = detectAuthorizationHits(context([{ fields: { requested_resource: 'https://resource-finance-api.test' } }]));
    expect(hits.find((candidate) => candidate.rule_id === 'authorization.unknown_resource')?.level).toBe('MEDIUM');
  });

  it('audience comparison is exact', () => {
    // A registered host and a look-alike that merely starts with it (DEV-12).
    const hits = detectAuthorizationHits(context([{ fields: { requested_audience: `${DOCS_AS}.evil` } }]));
    expect(hits.some((hit) => hit.rule_id === 'authorization.unknown_audience')).toBe(true);
    expect(detectAuthorizationHits(context([{ fields: { requested_audience: DOCS_AS } }]))).toHaveLength(0);
  });

  it('stays silent when there is no registration to compare against', () => {
    const missing: RuleContext = { ...context([{ fields: { requested_audience: 'https://elsewhere.test' } }]), registrations: new Map() };
    expect(detectAuthorizationHits(missing)).toHaveLength(0);
  });
});
