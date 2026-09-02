import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createDedicatedLedger, type DedicatedResourceRecord } from '../src/dedicated-ledger.js';
import { createDedicatedResources } from '../src/dedicated.js';
import { recordingAdmin } from './helpers.js';

/**
 * DEC-IAC-23. What was actually created for a FULL_ISOLATION agent, written down as it
 * happens.
 *
 * Cleanup reads only this. It never rebuilds a name from the agent id, for two
 * reasons: a run that died halfway would otherwise be asked to delete resources that
 * were never made, and anything created under a naming rule that has since changed
 * would be missed entirely — left running, with a service account still holding its
 * grants.
 *
 * Each entry is appended the moment the resource exists rather than in one batch at
 * the end, because the case the ledger exists for is precisely the run that does not
 * reach the end.
 */
const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

function open() {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'provisioner');
  let clock = Date.parse('2026-03-01T00:00:00Z');
  return { documents, ledger: createDedicatedLedger(documents, () => { clock += 1000; return clock; }) };
}

describe('the ledger of what was created', () => {
  it('opens with the six fields and nothing built yet', async () => {
    const { documents, ledger } = open();
    await ledger.open(AGENT_ID, '2026-03-01T08:00:00Z');
    const record = (await documents.get<DedicatedResourceRecord>('dedicated_resources', AGENT_ID))!;
    expect(Object.keys(record).sort())
      .toEqual(['agent_id', 'created', 'created_at', 'expires_at', 'last_error', 'status']);
    expect(record.status).toBe('CREATING');
    expect(record.created).toEqual([]);
  });

  it('holds six entries covering all five kinds once a build finishes', async () => {
    const { ledger } = open();
    await ledger.open(AGENT_ID, '2026-03-01T08:00:00Z');
    await createDedicatedResources({
      admin: recordingAdmin(), ledger, agentId: AGENT_ID,
      projectId: 'xaa-test', region: 'asia-northeast1',
      signingKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idjag-signing',
      connectionKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idp-connection-encryption',
      imageEnv: {}, runtimeEnv: {}, jwksBucket: 'b', activityTopic: 't', runtimeInvokerServices: [],
      provisionerMember: 'serviceAccount:sa@x.test', agentPlatformClientSecret: 'projects/p/secrets/s',
      taskTimeoutSeconds: 3600, now: () => 0, sleep: async () => undefined,
    });
    await ledger.markReady(AGENT_ID);

    const record = (await ledger.read(AGENT_ID))!;
    // The six named resources, plus the IAM bindings between them — which are as much
    // a thing to delete as the identities are.
    expect(record.created.filter((entry) => entry.kind !== 'iam_binding')).toHaveLength(6);
    expect(new Set(record.created.map((entry) => entry.kind))).toEqual(new Set([
      'service_account', 'crypto_key', 'iam_binding', 'cloud_run_service', 'cloud_run_job',
    ]));
    expect(record.status).toBe('READY');
  });

  it('appends the same name only once, however often the step is retried', async () => {
    const { ledger } = open();
    await ledger.open(AGENT_ID, '2026-03-01T08:00:00Z');
    const name = 'projects/xaa-test/serviceAccounts/sa-op-abcdefghijkl@xaa-test.iam.gserviceaccount.com';
    await ledger.record(AGENT_ID, 'service_account', name);
    await ledger.record(AGENT_ID, 'service_account', name);
    await ledger.record(AGENT_ID, 'service_account', name);
    // A retried step must not double-list what it created: cleanup would then try to
    // delete the same resource twice and report the second as a failure.
    expect((await ledger.read(AGENT_ID))!.created).toHaveLength(1);
  });

  it('records a failure with the reason, keeping what was already built', async () => {
    const { ledger } = open();
    await ledger.open(AGENT_ID, '2026-03-01T08:00:00Z');
    await ledger.record(AGENT_ID, 'service_account', 'projects/p/serviceAccounts/sa-op-abcdefghijkl@p.test');
    await ledger.record(AGENT_ID, 'service_account', 'projects/p/serviceAccounts/sa-agent-abcdefghijkl@p.test');
    await ledger.markFailed(AGENT_ID, 'createCryptoKey failed');

    const record = (await ledger.read(AGENT_ID))!;
    expect(record.status).toBe('FAILED');
    expect(record.created).toHaveLength(2);
    expect(record.last_error).toBe('createCryptoKey failed');
  });

  it('refuses to record against an agent it never opened', async () => {
    const { ledger } = open();
    // Recording into a document that does not exist would create a ledger with one
    // entry and no expiry, which the sweep has no basis to act on.
    await expect(ledger.record(AGENT_ID, 'crypto_key', 'projects/p/keyRings/r/cryptoKeys/idjag-abcdefghijkl'))
      .rejects.toThrow(/no dedicated ledger/);
  });
});
