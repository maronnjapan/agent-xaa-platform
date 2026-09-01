import { describe, expect, it } from 'vitest';
import { compile, REASON_CODES, REASON_TO_VIOLATION, SchemaValidationError, VIOLATION_CODES, type CapabilityDecision } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { authorizationDecisionResponseSchema } from '../src/routes/index.js';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import { runDecision, seedAuthorizationData } from './helpers.js';

async function emptyStore(): Promise<{ documents: DocumentStore; commits: number[] }> {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(documents, ['document.read'], createFirestoreDocumentStore(firestore, 'seed'));
  return { documents, commits: [] };
}

/** Counts how many times the store opened a commit of its own. */
function countingStore(documents: DocumentStore, commits: number[]): DocumentStore {
  return {
    ...documents,
    transaction: async (body) => {
      commits.push(1);
      return documents.transaction(body);
    },
  };
}

describe('the per-capability decision rows', () => {
  it('are as many as the capabilities that were evaluated', async () => {
    const result = await runDecision({
      humanPermissions: ['document.read'],
      model: { capabilities: ['document.read', 'finance.payment.approve'] },
    });
    const rows = await result.documents.queryEqual('policy_decisions', [['decision_id', result.record.decision_id]]);
    expect(rows).toHaveLength(result.record.proposed_capabilities.length);
    expect(rows).toHaveLength(2);
  });

  it('commit together rather than one at a time', async () => {
    const { documents, commits } = await emptyStore();
    const store = createAuthorizationStore(countingStore(documents, commits));
    const decisions: CapabilityDecision[] = [
      { capability_id: 'document.read', decision: 'ALLOW', reason_code: 'allowed', policy_id: null },
      { capability_id: 'document.write', decision: 'DENY', reason_code: 'not_delegatable', policy_id: 'del-006' },
      { capability_id: 'calendar.event.read', decision: 'ALLOW', reason_code: 'allowed', policy_id: null },
    ];

    await store.savePolicyDecisions('dec_1', decisions, '2026-03-01T00:00:00.000Z');

    expect(commits).toHaveLength(1);
    expect(await documents.queryEqual('policy_decisions', [['decision_id', 'dec_1']])).toHaveLength(3);
  });

  it('write nothing at all when a reason code is not one of the five', async () => {
    const { documents } = await emptyStore();
    const store = createAuthorizationStore(documents);
    const decisions = [
      { capability_id: 'document.read', decision: 'ALLOW', reason_code: 'allowed', policy_id: null },
      { capability_id: 'document.write', decision: 'DENY', reason_code: 'because it looked risky', policy_id: null },
    ] as unknown as CapabilityDecision[];

    await expect(store.savePolicyDecisions('dec_1', decisions, '2026-03-01T00:00:00.000Z')).rejects.toThrow(/reason_code/);
    expect(await documents.queryEqual('policy_decisions', [['decision_id', 'dec_1']])).toHaveLength(0);
  });

  it('maps every reason code to a violation code or to null', () => {
    expect(Object.keys(REASON_TO_VIOLATION).sort()).toEqual([...REASON_CODES].sort());
    for (const violation of Object.values(REASON_TO_VIOLATION)) {
      expect(violation === null || (VIOLATION_CODES as readonly string[]).includes(violation)).toBe(true);
    }
  });
});

describe('the isolation level a decision is stored with', () => {
  it('is refused at the edge as well, so neither layer is the only guard', () => {
    const assertResponse = compile(authorizationDecisionResponseSchema);
    expect(() => assertResponse({
      decision_id: 'dec_00000000-0000-4000-8000-000000000000', status: 'decided',
      effective_capabilities: [], denied: [],
      security_profile: { risk_score: 0, isolation_level: 'partial', reasons: [] },
    })).toThrow(SchemaValidationError);
  });

  it('refuses a third value before it reaches the collection', async () => {
    const { documents } = await emptyStore();
    const store = createAuthorizationStore(documents);

    await expect(store.saveDecision('dec_1', {
      decision_id: 'dec_1', human_subject: 'testuser',
      security_profile: { risk_score: 0, isolation_level: 'sandboxed', reasons: [] },
    })).rejects.toThrow(/isolation level/);
    expect(await documents.get('authorization_decisions', 'dec_1')).toBeUndefined();
  });

  it('accepts the two the platform has', async () => {
    const { documents } = await emptyStore();
    const store = createAuthorizationStore(documents);
    for (const level of ['standard', 'full_isolation']) {
      await store.saveDecision(`dec_${level}`, {
        decision_id: `dec_${level}`, human_subject: 'testuser',
        security_profile: { risk_score: 0, isolation_level: level, reasons: [] },
      });
      expect(await documents.get('authorization_decisions', `dec_${level}`)).toBeDefined();
    }
  });
});

describe('reading a decision back', () => {
  it('keeps what the AI proposed even where the decision does not', async () => {
    const result = await runDecision({
      humanPermissions: ['document.read'],
      model: { capabilities: ['document.read', 'slack.channel.admin'] },
    });
    const proposals = await result.documents.listAll<{ dropped_out_of_taxonomy: string[] }>('ai_proposals');

    expect(proposals[0]!.data.dropped_out_of_taxonomy).toContain('slack.channel.admin');
    expect(result.record.effective_capabilities).toEqual(['document.read']);
  });

  it('finds the decision and the proposal it came from', async () => {
    const result = await runDecision({
      humanPermissions: ['document.read'],
      model: { capabilities: ['document.read', 'finance.payment.approve'] },
    });
    const store = createAuthorizationStore(result.documents);

    const decision = await store.getDecision(result.record.decision_id);
    expect(decision?.effective_capabilities).toEqual(['document.read']);

    const proposal = await store.getProposalByDecisionId(result.record.decision_id);
    expect(proposal?.proposed_capabilities).toEqual(['document.read', 'finance.payment.approve']);
    expect(proposal?.taxonomy_version).toBe('v1');
    expect(proposal?.model_version).toBe('gemini-2.5-flash');
    expect(proposal?.characteristics).toBeDefined();
    // The proposal is what was asked for, never what was granted (RULE-10).
    expect(proposal).not.toHaveProperty('effective_capabilities');
  });

  it('lists only that subject\'s decisions', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'] });
    const store = createAuthorizationStore(result.documents);
    expect((await store.listActiveDecisionsBySubject('testuser')).map((decision) => decision.decision_id))
      .toEqual([result.record.decision_id]);
    expect(await store.listActiveDecisionsBySubject('someone-else')).toEqual([]);
  });
});
