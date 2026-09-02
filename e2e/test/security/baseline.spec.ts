import { describe, expect, it } from 'vitest';
import { createFirestoreDouble, createFirestoreDocumentStore } from '@xaa/gcp';
import { buildBaseline } from '@xaa/security-detection/src/baseline/build';
import { BASELINE_ELEMENTS } from '@xaa/security-detection/src/baseline/types';
import { writeAgentBaseline } from '@xaa/provisioner/src/baseline-hook';

const AGENT_ID = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROVISIONED_TOOLS = ['internal.document.list', 'internal.document.get'];
const PROVISIONED_RESOURCES = ['https://resource-docs-api.test'];

function stores() {
  const shared = createFirestoreDouble();
  return {
    provisioner: createFirestoreDocumentStore(shared, 'provisioner'),
    detector: createFirestoreDocumentStore(shared, 'security-detection'),
  };
}

const baseline = () => buildBaseline({
  effectiveCapabilities: ['document.read'],
  expectedTools: [...PROVISIONED_TOOLS],
  expectedResources: [...PROVISIONED_RESOURCES],
  expiresAt: '2026-01-02T00:00:00.000Z',
});

/**
 * T-SEC-25 / REQ-09-039 and RULE-40. The baseline exists before the agent does anything.
 *
 * An agent's maximum lifetime is short enough that history never accumulates, so its
 * expected behaviour is derived from its definition rather than observed. That makes the
 * moment of writing load-bearing: a baseline written lazily on first use would be shaped
 * by whatever the agent did first, including whatever it was compromised into doing.
 */
describe('the agent baseline around provisioning', () => {
  it('baseline exists right after provisioning', async () => {
    const { provisioner, detector } = stores();

    // Nothing before: the detector reports a missing baseline rather than inventing one.
    expect(await detector.get('agents', `${AGENT_ID}__baseline`)).toBeUndefined();

    await writeAgentBaseline({ documents: provisioner, agentId: AGENT_ID, baseline: baseline() });

    const stored = await detector.get<Record<string, unknown>>('agents', `${AGENT_ID}__baseline`);
    expect(stored).toBeTruthy();
    expect(Object.keys(stored!).sort()).toEqual([...BASELINE_ELEMENTS].sort());
  });

  it('expected tools equal provisioned tools', async () => {
    const { provisioner, detector } = stores();
    await writeAgentBaseline({ documents: provisioner, agentId: AGENT_ID, baseline: baseline() });

    const stored = await detector.get<{ expected_tools: string[]; expected_resources: string[] }>(
      'agents', `${AGENT_ID}__baseline`,
    );
    // As a set: the order the Provisioner happened to list them in is not a property.
    expect(new Set(stored!.expected_tools)).toEqual(new Set(PROVISIONED_TOOLS));
    expect(new Set(stored!.expected_resources)).toEqual(new Set(PROVISIONED_RESOURCES));
    expect(stored!.expected_tools).toHaveLength(PROVISIONED_TOOLS.length);
  });

  it('not written when provisioning fails', async () => {
    const { provisioner, detector } = stores();
    // The hook runs after the Provisioning Transaction commits; a transaction that threw
    // never reaches it, so nothing is written for an agent that does not exist.
    await Promise.reject(new Error('provisioning failed')).catch(() => undefined);
    expect(await detector.get('agents', `${AGENT_ID}__baseline`)).toBeUndefined();
    expect(await provisioner.get('agents', `${AGENT_ID}__baseline`)).toBeUndefined();
  });
});
