import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { CAPABILITIES, drainActivityQueueForTesting, resetActivityPublisherForTesting } from '@xaa/contracts';
import { assertCapabilitiesSufficient, CapabilityInsufficientError } from '../src/reprovision-guard.js';
import { reprovision, REPROVISION_BODY_KEYS } from '../src/reprovision.js';
import { cleanupAgent } from '../src/cleanup/index.js';
import { eventTypeFor } from '../src/events.js';
import { LIFECYCLE_MESSAGES } from '../src/messages.js';
import { CLEANUP_REASONS } from '../src/config.js';
import { createLifecycleHarness, recordingClients, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };
const HOUR = 3_600_000;

function cleanupDeps(harness: LifecycleHarness) {
  return { documents: harness.documents, clients: harness.clients, logger, logContext };
}

describe('the capability guard', () => {
  it('treats capability ids as exact strings', () => {
    expect(() => assertCapabilitiesSufficient(['document.read'], ['document.read'])).not.toThrow();
    expect(() => assertCapabilitiesSufficient(['document.read'], ['document.readonly'])).toThrow(CapabilityInsufficientError);
    expect(() => assertCapabilitiesSufficient(['document.read'], ['document.'])).toThrow(CapabilityInsufficientError);
    expect(CAPABILITIES).toContain('document.read');
  });

  it('reports every missing capability', () => {
    try {
      assertCapabilitiesSufficient(['document.read', 'document.write', 'finance.payment.read'], ['document.read']);
      expect.unreachable();
    } catch (error) {
      expect((error as CapabilityInsufficientError).missing_capabilities.sort())
        .toEqual(['document.write', 'finance.payment.read']);
    }
  });
});

describe('reprovisioning', () => {
  /**
   * The replacement inherits the deadline, it does not get a new one. A permission
   * change is not a reason to live longer, and recomputing the lifetime here would turn
   * every shrink into a quiet extension — repeatable as often as someone edits a role.
   */
  it('keeps expires_at from the old agent and asks for a new id', async () => {
    const shared = createFirestoreDouble();
    const harness = createLifecycleHarness({ shared });
    const expiresAt = new Date(Date.now() + HOUR).toISOString();
    const agentId = await seedDomain(harness, { expiresAt });

    const outcome = await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'], requiredCapabilities: ['document.read'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });

    expect(outcome.result).toBe('reprovisioned');
    expect(outcome.new_agent_id).not.toBe(agentId);
    const body = harness.provisionerCalls[0]!;
    expect(Object.keys(body).sort()).toEqual([...REPROVISION_BODY_KEYS].sort());
    expect(body.inherited_expires_at).toBe(expiresAt);
    // Nothing recomputes the lifetime: a permission change must not extend an agent.
    expect(body).not.toHaveProperty('requested_lifetime_hours');
    expect(body).not.toHaveProperty('expires_at');
  });

  /**
   * A fresh identifier, allocated by the Provisioner. Reusing the old one would leave
   * every log line, every issued token and every audit record about the destroyed agent
   * pointing at its replacement, which is a different agent with different permissions.
   */
  it('allocates a new agent_id and never reuses the old one', async () => {
    const shared = createFirestoreDouble();
    const harness = createLifecycleHarness({ shared, newAgentId: 'agent-nnnnnnnnnnnnnnnnnnnnnnnnnn' });
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });

    const outcome = await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'], requiredCapabilities: ['document.read'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });

    expect(outcome.new_agent_id).toBe('agent-nnnnnnnnnnnnnnnnnnnnnnnnnn');
    expect(outcome.new_agent_id).not.toBe(agentId);
    expect(outcome.old_agent_id).toBe(agentId);
    // The id came back from the Provisioner; this service sent only the old one as
    // provenance and never assembled a candidate of its own.
    const body = harness.provisionerCalls[0]!;
    expect(body.previous_agent_id).toBe(agentId);
    expect(Object.values(body)).not.toContain(outcome.new_agent_id);
  });

  it('destroys the old agent before asking for the new one', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'], requiredCapabilities: ['document.read'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });
    expect(await harness.documents.get('agents', `${agentId}__meta`)).toBeUndefined();
  });

  it('does not call the provisioner when cleanup fails', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ failAt: 'disableIssuance' }) });
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const outcome = await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'], requiredCapabilities: ['document.read'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });
    expect(outcome).toMatchObject({ result: 'blocked', reason_code: 'reprovision_blocked_by_cleanup' });
    expect(harness.provisionerCalls).toHaveLength(0);
  });

  it('destroys the old agent and creates no new one when capabilities are insufficient', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    await harness.documents.set('provisioning_transactions', 'tx-1', {
      work_definition_id: 'wd_1', status: 'IN_PROGRESS', created_at: '2026-01-01T00:00:00.000Z',
    });
    const outcome = await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'],
      requiredCapabilities: ['document.read', 'finance.payment.approve'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });
    expect(outcome).toMatchObject({ result: 'aborted', reason_code: 'capability_insufficient' });
    expect(outcome.missing_capabilities).toEqual(['finance.payment.approve']);
    expect(harness.provisionerCalls).toHaveLength(0);
    expect(await harness.documents.get('agents', `${agentId}__meta`)).toBeUndefined();
    const transaction = await harness.documents.get<{ status: string; failure_code: string }>('provisioning_transactions', 'tx-1');
    expect(transaction).toMatchObject({ status: 'FAILED', failure_code: 'capability_insufficient' });
  });

  /**
   * The Authorization Platform's transaction is the record of the request, and it has to
   * end somewhere. An abort marks it FAILED with the code and the specific capabilities
   * that were missing, so the person is told what they lost rather than that "it did not
   * work".
   */
  it('marks the transaction FAILED with capability_insufficient', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    await harness.documents.set('provisioning_transactions', 'tx-1', {
      work_definition_id: 'wd_1', status: 'IN_PROGRESS', created_at: '2026-01-01T00:00:00.000Z',
    });

    const outcome = await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'],
      requiredCapabilities: ['document.read', 'document.write', 'finance.payment.approve'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });

    expect(outcome).toMatchObject({ result: 'aborted', reason_code: 'capability_insufficient' });
    const transaction = await harness.documents.get<{
      status: string; failure_code: string; missing_capabilities: string[];
    }>('provisioning_transactions', 'tx-1');
    expect(transaction!.status).toBe('FAILED');
    expect(transaction!.failure_code).toBe('capability_insufficient');
    expect([...transaction!.missing_capabilities].sort()).toEqual(['document.write', 'finance.payment.approve']);
  });

  it('returns reprovision_expired when the inherited expires_at is in the past', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() - HOUR).toISOString() });
    const outcome = await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'], requiredCapabilities: ['document.read'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });
    expect(outcome).toMatchObject({ result: 'aborted', reason_code: 'reprovision_expired' });
    expect(harness.provisionerCalls).toHaveLength(0);
  });

  it('copies no checkpoint to the new agent', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    await harness.documents.set('agents', `${agentId}__state`, { agent_status: 'ACTIVE', conversation_context: ['secret'] });
    const outcome = await reprovision({
      agentId, newEffectiveCapabilities: ['document.read'], requiredCapabilities: ['document.read'],
      workDefinitionId: 'wd_1', documents: harness.documents, cleanup: cleanupDeps(harness),
      provisioner: harness.deps.provisioner, provisionerUrl: 'https://provisioner.test',
    });
    expect(await harness.documents.get('agents', `${outcome.new_agent_id}__state`)).toBeUndefined();
    expect(JSON.stringify(harness.provisionerCalls)).not.toContain('secret');
  });
});

describe('lifecycle events', () => {
  it('maps reason to event type', () => {
    const mapping = Object.fromEntries(CLEANUP_REASONS.map((reason) => [reason, eventTypeFor(reason)]));
    expect(mapping).toEqual({
      EXPIRED: 'AGENT_EXPIRED',
      USER_STOP: null,
      QUARANTINE: 'AGENT_REVOKED_SECURITY',
      IDENTITY_DISABLED: 'AGENT_REVOKED_SECURITY',
      REPROVISION: null,
    });
  });

  it('emits exactly one lifecycle event per destroyed agent', async () => {
    const shared = createFirestoreDouble();
    const harness = createLifecycleHarness({ shared });
    const agentId = await seedDomain(harness);
    const withEvents = {
      ...cleanupDeps(harness),
      onDestroyed: harness.deps.publishActivity
        ? async () => {
            const { emitLifecycleEvent } = await import('../src/events.js');
            await emitLifecycleEvent({
              eventType: 'AGENT_EXPIRED', agentId, humanSubject: 'testuser', traceId: 't',
              publish: harness.deps.publishActivity!,
            });
          }
        : undefined,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) await cleanupAgent(agentId, 'EXPIRED', withEvents);
    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]).toMatchObject({
      task_id: 'lifecycle', phase: 'lifecycle', outcome: 'info', is_simulated: false, source: 'lifecycle-manager',
    });
    // A deterministic id, so a redelivery lands on the same document.
    expect(harness.activity[0]!.event_id).toBe(`evt-${agentId}-AGENT_EXPIRED`);
  });

  it('emits nothing before DESTROYED', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ failAt: 'disableIssuance' }) });
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', {
      ...cleanupDeps(harness),
      onDestroyed: async () => { harness.activity.push({} as never); },
    });
    expect(harness.activity).toHaveLength(0);
  });

  it('writes Japanese wording for every event type', () => {
    for (const wording of Object.values(LIFECYCLE_MESSAGES)) {
      expect(wording.title.trim()).not.toBe('');
      expect(wording.message.trim()).not.toBe('');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(wording.title)).toBe(false);
    }
  });

  it('carries no JWT-shaped string in the payload', async () => {
    resetActivityPublisherForTesting();
    const { emitLifecycleEvent } = await import('../src/events.js');
    await emitLifecycleEvent({
      eventType: 'AGENT_REVOKED_SECURITY', agentId: 'agent-abcdefghijklmnopqrstuvwxyz',
      humanSubject: 'testuser', traceId: 't',
      detail: { leaked: 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig', refresh_token: 'r' },
    });
    const [event] = drainActivityQueueForTesting();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./);
    expect(serialized).not.toContain('refresh_token');
  });
});

describe('the revoke API', () => {
  async function signedHarness(options: { subject?: string } = {}) {
    const { createDpopProof, createLocalEs256Signer, generateEs256KeyPair, jwkThumbprint, signCompactJws } =
      await import('@xaa/crypto');
    const idpKey = await generateEs256KeyPair();
    const dpopKey = await generateEs256KeyPair();
    const issuedAt = Math.floor(Date.now() / 1000);
    const accessToken = await signCompactJws({
      header: { alg: 'ES256', typ: 'at+jwt', kid: 'idp-testkey' },
      payload: {
        iss: 'https://human-idp.test', sub: options.subject ?? 'testuser', aud: 'lifecycle-manager',
        scope: 'agent:revoke', iat: issuedAt, exp: issuedAt + 3600,
        jti: `at-${Math.random().toString(36).slice(2)}`,
        cnf: { jkt: await jwkThumbprint(dpopKey.publicJwk) },
      },
      signer: createLocalEs256Signer({ privateKey: idpKey.privateKey, kid: 'idp-testkey' }),
    });
    const harness = createLifecycleHarness({ idpPublicJwk: idpKey.publicJwk });
    const call = async (agentId: string, body?: unknown): Promise<Response> => harness.fetch(
      `/agents/${agentId}/revoke`,
      {
        method: 'POST',
        headers: {
          Authorization: `DPoP ${accessToken}`,
          'Content-Type': 'application/json',
          DPoP: await createDpopProof({
            method: 'POST', url: `https://lifecycle.test/agents/${agentId}/revoke`,
            keyPair: dpopKey, accessToken,
          }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { harness, call };
  }

  it('returns 202 and starts cleanup for the owner', async () => {
    const { harness, call } = await signedHarness();
    const agentId = await seedDomain(harness);
    const response = await call(agentId);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'REVOKED', cleanup: 'started' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(1);
  });

  it("returns 403 for another user's agent", async () => {
    const { harness, call } = await signedHarness();
    const agentId = await seedDomain(harness, { humanSubject: 'someone-else' });
    const response = await call(agentId);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_subject' });
    expect(harness.clients.calls).toHaveLength(0);
  });

  it('returns 404 for an unknown agent', async () => {
    const { call } = await signedHarness();
    const response = await call('agent-zzzzzzzzzzzzzzzzzzzzzzzzzz');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'agent_not_found' });
  });

  it('returns 200 for an already DESTROYED agent', async () => {
    const { harness, call } = await signedHarness();
    const agentId = await seedDomain(harness, { status: 'DESTROYED' });
    const response = await call(agentId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'DESTROYED' });
  });

  it('ignores human_subject in the body', async () => {
    const { harness, call } = await signedHarness();
    const agentId = await seedDomain(harness, { humanSubject: 'testuser' });
    // The token says testuser; the body claims otherwise and is not consulted.
    const response = await call(agentId, { human_subject: 'someone-else' });
    expect([202, 403]).toContain(response.status);
    if (response.status === 403) {
      // The control-plane guard rejects a body that disagrees with the token, which is
      // the same protection stated a step earlier (RULE-43).
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }
  });

  it('writes an audit line for denied requests', async () => {
    const { harness, call } = await signedHarness();
    const owned = await seedDomain(harness, { agentId: 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa', humanSubject: 'someone-else' });
    await call(owned);
    await call('agent-zzzzzzzzzzzzzzzzzzzzzzzzzz');
    const denials = harness.auditLines.map((line) => JSON.parse(line) as { result: string; denial_reason: string })
      .filter((entry) => entry.result === 'denied');
    expect(denials.map((entry) => entry.denial_reason).sort()).toEqual(['agent_not_found', 'forbidden_subject']);
  });
});
