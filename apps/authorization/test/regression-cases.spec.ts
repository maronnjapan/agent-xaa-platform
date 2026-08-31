import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { CAPABILITIES } from '@xaa/contracts';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import { decide, type DecisionRecord } from '../src/pipeline/decide.js';
import { createFakeVertex, seedAuthorizationData, type FakeModel } from './helpers.js';

/**
 * The five values every regression case pins (DEC-TEST-04): the proposed set, the
 * effective set, the isolation level, each denial's reason code, and — once the
 * Provisioner exists — the allowed tool set. The tool set is asserted in the
 * Provisioner's own suite, where the manifest is built.
 */
async function run(options: { humanPermissions: string[]; model: FakeModel; description: string }): Promise<DecisionRecord> {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(documents, options.humanPermissions, createFirestoreDocumentStore(firestore, 'seed'));
  return decide({
    humanSubject: 'testuser', purpose: 'テスト', description: options.description,
    constraints: {}, requestedLifetimeHours: 8,
  }, {
    store: createAuthorizationStore(documents),
    vertex: createFakeVertex(options.model),
    clock: { now: () => Date.parse('2026-03-01T00:00:00Z') },
  });
}

describe('Calendar and Documents', () => {
  it('grants the read pair, and withholds calendar write', async () => {
    const record = await run({
      humanPermissions: ['calendar.event.read', 'calendar.event.write', 'document.read', 'document.write'],
      description: '当日の予定を取得し、重要な予定を日報としてまとめる',
      model: {
        targetResources: ['calendar', 'document'],
        operations: ['read_events', 'summarise', 'write_report'],
        capabilities: ['calendar.event.read', 'calendar.event.write', 'document.write'],
        characteristics: { write_operation: true },
      },
    });

    expect(record.proposed_capabilities).toEqual(['calendar.event.read', 'calendar.event.write', 'document.write']);
    expect(record.effective_capabilities).toEqual(['calendar.event.read', 'document.write']);
    expect(record.security_profile.isolation_level).toBe('standard');
    expect(record.security_profile.reasons).toEqual(['write_permission']);
    expect(record.denied.map((entry) => [entry.capability_id, entry.reason_code]))
      .toEqual([['calendar.event.write', 'not_delegatable']]);
  });

  it('removes a capability that no connector can reach', async () => {
    // This deployment has connectors for documents, payments and the stub calendar.
    // mail.message.send is in the taxonomy and delegatable, but nothing implements
    // it, so org-002 removes it: a capability with no reachable connector is a grant
    // the agent could never exercise.
    const record = await run({
      humanPermissions: ['mail.message.send'],
      description: 'メールを送る',
      model: { targetResources: ['mail'], capabilities: ['mail.message.send'], characteristics: { external_communication: true } },
    });
    expect(record.effective_capabilities).toEqual([]);
    expect(record.denied.map((entry) => [entry.capability_id, entry.reason_code, entry.policy_id]))
      .toEqual([['mail.message.send', 'org_policy_denied', 'org-002']]);
  });

  it('constrains a capability rather than removing it when a connector exists', async () => {
    // The same organisation rule shape, applied where a connector does exist: the
    // capability stays and the constraint travels with it.
    const record = await run({
      humanPermissions: ['calendar.event.read'],
      description: '予定を読む',
      model: { targetResources: ['calendar'], capabilities: ['calendar.event.read'], characteristics: { external_communication: true } },
    });
    expect(record.effective_capabilities).toEqual(['calendar.event.read']);
    expect(record.security_profile.reasons).toContain('external_communication');
  });

  it('withholds a capability the human does not hold', async () => {
    const record = await run({
      humanPermissions: ['calendar.event.read'],
      description: '文書を書く',
      model: { targetResources: ['document'], capabilities: ['document.write'] },
    });
    expect(record.effective_capabilities).toEqual([]);
    expect(record.denied.map((entry) => entry.reason_code)).toEqual(['not_in_human_permission']);
  });
});

describe('Finance', () => {
  it('demands full isolation and attaches the amount ceiling', async () => {
    const record = await run({
      humanPermissions: [...CAPABILITIES],
      description: '未承認の支払を確認し、条件を満たすものを承認する',
      model: {
        targetResources: ['finance'],
        operations: ['list_payments', 'approve_payment'],
        capabilities: ['finance.payment.read', 'finance.payment.approve'],
        characteristics: { write_operation: true },
      },
    });

    expect(record.effective_capabilities).toEqual(['finance.payment.approve', 'finance.payment.read']);
    expect(record.security_profile.isolation_level).toBe('full_isolation');
    // financial_operation comes from the taxonomy, not the model: 40 + 25 + 15.
    expect(record.security_profile.risk_score).toBe(80);
    expect(record.security_profile.reasons).toEqual(['financial_operation', 'sensitive_resource', 'write_permission']);
    expect(record.denied).toEqual([]);
    expect(record.constraints['finance.payment.approve']).toMatchObject({ max_amount: 100_000 });
  });

  it('keeps full isolation even when the model claims the work is not financial', async () => {
    const record = await run({
      humanPermissions: [...CAPABILITIES],
      description: '支払を承認する',
      model: {
        targetResources: ['finance'], capabilities: ['finance.payment.approve'],
        characteristics: { financial_operation: false },
      },
    });
    expect(record.security_profile.isolation_level).toBe('full_isolation');
  });

  it('never lets a low score downgrade a financial operation', async () => {
    const record = await run({
      humanPermissions: ['finance.payment.read'],
      description: '支払を確認する',
      model: { targetResources: ['finance'], capabilities: ['finance.payment.read'], characteristics: {} },
    });
    expect(record.effective_capabilities).toEqual(['finance.payment.read']);
    // finance.payment.read is sensitive but not itself a financial operation.
    expect(record.security_profile.isolation_level).toBe('standard');
    expect(record.security_profile.risk_score).toBe(25);
  });
});
