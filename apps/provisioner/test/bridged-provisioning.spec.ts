import { describe, expect, it } from 'vitest';
import { createLogger } from '@xaa/logging';
import {
  BRIDGE_CONSENT_URL, createProvisionerHarness, createTokenIssuer, recordingBridge, seedDecision,
  type ProvisionerHarness,
} from './helpers.js';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { toRfc3339Seconds } from '../src/agent/expiry.js';
import { provisionAgent, type ProvisionResponse } from '../src/provisioning/flow.js';
import type { ProvisioningTransaction } from '../src/transaction/store.js';

/**
 * RULE-24, from the Provisioner's end.
 *
 * The Bridge's own routes have been implemented and tested since T-BRIDGE-13, and its
 * specs drive them from a harness that stands in for this service. Nothing drove them
 * from this service: there was no Bridge client here, no step that asked for a
 * connection, and nothing that ever moved a transaction to WAITING_EXTERNAL_CONSENT.
 * So a deployment with the Bridge switched on registered an Agent holding a bridged
 * Tool, no connection and no binding, and the failure arrived at the Agent's first
 * SaaS call as `invalid_bridge_binding` — after the person had approved everything and
 * with nothing pointing back at the step that never ran.
 *
 * These fix the two halves of that: that the person is asked, and that what they
 * granted is narrowed to a binding before the Agent is registered.
 */
const CALENDAR = ['calendar.event.read'];

async function bridgedProvision(target: ProvisionerHarness, options: {
  capabilities?: string[];
} = {}): Promise<ProvisionResponse> {
  const capabilities = options.capabilities ?? CALENDAR;
  await seedDecision(target, { capabilities });
  return provisionAgent({
    ...target.deps,
    logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
    catalogue: createCatalogRepository(target.documents),
  }, {
    humanSubject: 'testuser', taskId: 'task-1', effectiveCapabilities: capabilities,
    isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', minutes: 480 },
  });
}

const transaction = async (target: ProvisionerHarness, id: string): Promise<ProvisioningTransaction> =>
  (await target.documents.get<ProvisioningTransaction>('provisioning_transactions', id))!;

describe('a provisioning that needs an external SaaS', () => {
  it('asks the person for consent and stops, naming the connector', async () => {
    const bridge = recordingBridge({ connectionStatus: 'CONSENT_REQUIRED' });
    const target = await createProvisionerHarness({ bridge });
    const outcome = await bridgedProvision(target);

    expect(outcome.status).toBe(200);
    const body = outcome.body as { status: string; consent_url: string; connector_id: string; transaction_id: string };
    expect(body.status).toBe('CONSENT_REQUIRED');
    expect(body.connector_id).toBe('stub-saas-calendar');
    expect(body.consent_url.startsWith(BRIDGE_CONSENT_URL)).toBe(true);
    // RULE-37: the browser is sent to the Bridge's public callback face, never here.
    expect(new URL(body.consent_url).host).not.toBe('provisioner.test');

    // Paused, not failed: the transaction is what the resume comes back to.
    const record = await transaction(target, body.transaction_id);
    expect(record.status).toBe('WAITING_EXTERNAL_CONSENT');
    expect(record.pending_step).toBe('external_consent');

    // And nothing past the pause has happened.
    expect(bridge.calls.map((call) => call.method)).toEqual(['checkConnection']);
    expect(target.jobRuns).toHaveLength(0);
    expect(await target.documents.get('agents', `${record.agent_id}__meta`)).toBeUndefined();
  });

  it('asks only for the scopes the bridged tools declare', async () => {
    const bridge = recordingBridge({ connectionStatus: 'CONSENT_REQUIRED' });
    const target = await createProvisionerHarness({ bridge });
    // An agent that also reads documents. Those scopes belong to a resource of this
    // platform and must not be carried to a SaaS as if it were being asked for them.
    await bridgedProvision(target, { capabilities: [...CALENDAR, 'document.read'] });

    expect(bridge.calls[0]!.scopes).toEqual(['calendar.read']);
  });

  /**
   * REQ-06-018. The connection belongs to the person, not to the agent, so the second
   * agent that needs the same SaaS is created without a browser anywhere in it.
   */
  it('creates the binding without a consent when the connection is already there', async () => {
    const bridge = recordingBridge({ connectionStatus: 'READY' });
    const target = await createProvisionerHarness({ bridge });
    const outcome = await bridgedProvision(target);

    expect(outcome.status).toBe(201);
    expect(bridge.calls.map((call) => call.method)).toEqual(['checkConnection', 'createBinding']);
    const binding = bridge.calls[1]!;
    expect(binding.connectorId).toBe('stub-saas-calendar');
    expect(binding.scopes).toEqual(['calendar.read']);
    expect(target.jobRuns).toHaveLength(1);
  });

  /**
   * The order is the point. A binding written after the registration would leave a
   * window in which the Agent exists, is entitled to the Tool, and is refused by the
   * Bridge — and `start_job_execution` could open that window on a running Agent.
   */
  it('binds before the agent is registered and before the job starts', async () => {
    const bridge = recordingBridge({ connectionStatus: 'READY' });
    const target = await createProvisionerHarness({ bridge });
    const outcome = await bridgedProvision(target);

    const types = target.activity.map((event) => (event.detail as { event_type: string }).event_type);
    expect(types).toEqual([
      'provisioning.started', 'provisioning.idp_connection_created', 'provisioning.binding_created',
      'provisioning.agent_registered', 'provisioning.job_started', 'agent.active',
    ]);
    const agentId = (outcome.body as { agent_id: string }).agent_id;
    expect(await target.documents.get('agents', `${agentId}__meta`)).toBeDefined();
  });

  it('names the connector and the range on the timeline', async () => {
    const bridge = recordingBridge({ connectionStatus: 'CONSENT_REQUIRED' });
    const target = await createProvisionerHarness({ bridge });
    await bridgedProvision(target);

    const consent = target.activity.at(-1) as {
      detail: { event_type: string; activity_kind: string };
      record: { sections: Array<{ fields?: Array<{ label: string; value: string }> }> };
    };
    expect(consent.detail.event_type).toBe('provisioning.external_consent_required');
    expect(consent.detail.activity_kind).toBe('CONSENT_REQUIRED');
    // A person deciding whether to consent has to be able to read what for.
    const record = consent.record;
    const fields = record.sections[0]!.fields ?? [];
    expect(fields).toContainEqual({ label: '接続先', value: 'stub-saas-calendar' });
    expect(fields).toContainEqual({ label: '同意を求める範囲', value: 'calendar.read' });
  });

  /**
   * A catalogue that offers a bridged tool on a deployment with no Bridge is a
   * configuration fault, and the seed is built so it cannot happen (DEC-SCOPE-04). If
   * it does, it is named here rather than at the Agent's first SaaS call hours later.
   */
  it('refuses rather than registering an agent it cannot bind', async () => {
    const target = await createProvisionerHarness();
    const outcome = await bridgedProvision(target);

    expect(outcome.status).toBe(500);
    expect(outcome.body).toMatchObject({ error: 'bridge_unavailable', connector_ids: ['stub-saas-calendar'] });
    expect(target.jobRuns).toHaveLength(0);
  });

  /** A native-only agent must not gain a step, or a call, it has no use for. */
  it('leaves an agent with no bridged tool untouched', async () => {
    const bridge = recordingBridge({ connectionStatus: 'CONSENT_REQUIRED' });
    const target = await createProvisionerHarness({ bridge });
    const outcome = await bridgedProvision(target, { capabilities: ['document.read'] });

    expect(outcome.status).toBe(201);
    expect(bridge.calls).toHaveLength(0);
  });
});

/**
 * The way back from a SaaS consent screen.
 *
 * The one-time code the Bridge mints lives in the Bridge's own store
 * (`bridge_consent_codes`), which this service neither reads nor writes. So the branch
 * cannot be chosen by looking the code up here — that answers `code_not_found` for
 * every external consent, which is exactly what the old code did before it ever
 * reached the `issuer_kind` test it was written around. The transaction is the record
 * both halves share, and it is what decides.
 */
describe('resuming after a SaaS consent', () => {
  const externalTransaction = async (target: ProvisionerHarness): Promise<string> => {
    await seedDecision(target, { capabilities: CALENDAR });
    const record = await target.deps.transactions.create({
      human_subject: 'testuser', agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
      required_capabilities: CALENDAR, required_connectors: ['stub-saas-calendar'],
      isolation_level: 'standard', pending_step: 'external_consent', dedicated_short_id: null,
      task_id: 'wd-1', constraints: {}, agent_expires_at: toRfc3339Seconds(Date.now() + 3_600_000),
    });
    await target.deps.transactions.advance(record.transaction_id, 'WAITING_EXTERNAL_CONSENT', {
      pending_step: 'external_consent',
    });
    return record.transaction_id;
  };

  it('hands the code to the Bridge and finishes the provisioning', async () => {
    const issuer = await createTokenIssuer();
    const bridge = recordingBridge({ connectionStatus: 'READY' });
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk, bridge });
    const transactionId = await externalTransaction(target);

    const response = await issuer.provision(target, { one_time_code: 'bridge-code-1' }, {
      path: `/provisioning/${transactionId}/resume`,
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: 'PROVISIONED', transaction_id: transactionId });
    // Spent at the Bridge, and never looked for in this service's own code store.
    expect(bridge.calls.map((call) => call.method)).toEqual(['verifyConnection', 'checkConnection', 'createBinding']);
    expect(target.jobRuns).toHaveLength(1);
  });

  /**
   * A connection the Bridge will not vouch for is not a failed provisioning: the
   * person may still fix it at the SaaS. Failing the transaction here would take the
   * consent they already gave down with it.
   */
  it('leaves the transaction waiting when the Bridge does not confirm the connection', async () => {
    const issuer = await createTokenIssuer();
    const bridge = recordingBridge({ connectionStatus: 'READY', verifyStatus: 'PENDING' });
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk, bridge });
    const transactionId = await externalTransaction(target);

    const response = await issuer.provision(target, { one_time_code: 'bridge-code-1' }, {
      path: `/provisioning/${transactionId}/resume`,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'connection_not_ready' });
    expect((await target.deps.transactions.find(transactionId))!.status).toBe('WAITING_EXTERNAL_CONSENT');
    expect(target.jobRuns).toHaveLength(0);
  });
});
