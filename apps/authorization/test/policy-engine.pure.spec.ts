import { describe, expect, it, vi } from 'vitest';
import type { Characteristics, DelegatableEntry, OrganizationPolicy, PolicyEngineInput, RiskPolicy } from '@xaa/contracts';
import { computeEffectiveCapabilities } from '../src/policy/effective.js';

const characteristics: Characteristics = {
  capability_risk: 'low', sensitive_resource: false, write_operation: false,
  admin_permission: false, external_communication: false, financial_operation: false,
  personal_data_access: false,
};

function delegatable(...capabilities: string[]): Map<string, DelegatableEntry> {
  return new Map(capabilities.map((capability) => [capability, { capability_id: capability, delegatable: true, policy_id: 'del-x' }]));
}

const baseInput: PolicyEngineInput = {
  proposed: ['calendar.event.read', 'mail.message.send'],
  characteristics,
  humanPermissions: ['calendar.event.read', 'calendar.event.write', 'mail.message.read', 'mail.message.send'],
  delegatableEntries: new Map([
    ...delegatable('calendar.event.read', 'mail.message.read', 'mail.message.send'),
    ['calendar.event.write', { capability_id: 'calendar.event.write', delegatable: false, policy_id: 'del-002' }],
  ]),
  organizationPolicies: [],
  capabilityConnectors: {},
  riskPolicies: [],
};

describe('the Policy Engine is a pure function', () => {
  it('reproduces docs 03 §2', () => {
    const output = computeEffectiveCapabilities(baseInput);
    expect(output.effective).toEqual(['calendar.event.read', 'mail.message.send']);
  });

  it('gives the same answer a hundred times over', () => {
    const first = computeEffectiveCapabilities(baseInput);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(computeEffectiveCapabilities(baseInput)).toEqual(first);
    }
  });

  it('touches neither Firestore nor Vertex', async () => {
    const gcp = await import('@xaa/gcp');
    const firestoreSpy = vi.spyOn(gcp, 'createFirestoreDocumentStore');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('the Policy Engine must not perform I/O'); }) as unknown as typeof fetch;
    try {
      computeEffectiveCapabilities(baseInput);
    } finally {
      globalThis.fetch = originalFetch;
      firestoreSpy.mockRestore();
    }
    expect(firestoreSpy).toHaveBeenCalledTimes(0);
  });

  it('drops what the human does not hold', () => {
    const output = computeEffectiveCapabilities({ ...baseInput, humanPermissions: ['calendar.event.read'] });
    expect(output.effective).toEqual(['calendar.event.read']);
    expect(output.denied.map((entry) => entry.reason_code)).toContain('not_in_human_permission');
  });

  it('drops what may not be delegated, even when the human holds it', () => {
    const output = computeEffectiveCapabilities({ ...baseInput, proposed: ['calendar.event.write'] });
    expect(output.effective).toEqual([]);
    expect(output.denied[0]).toMatchObject({ capability_id: 'calendar.event.write', reason_code: 'not_delegatable', policy_id: 'del-002' });
  });

  it('treats an unregistered capability as not delegatable', () => {
    const output = computeEffectiveCapabilities({
      ...baseInput, proposed: ['mail.message.read'], delegatableEntries: new Map(),
    });
    expect(output.denied[0]).toMatchObject({ reason_code: 'not_delegatable', policy_id: 'implicit-not-delegatable' });
  });

  it('orders the output deterministically, not by set insertion', () => {
    const forward = computeEffectiveCapabilities(baseInput);
    const reversed = computeEffectiveCapabilities({ ...baseInput, proposed: [...baseInput.proposed].reverse() });
    expect(reversed.effective).toEqual(forward.effective);
  });

  it('records one decision per evaluated capability', () => {
    const output = computeEffectiveCapabilities(baseInput);
    expect(output.decisions).toHaveLength(2);
    expect(output.decisions.every((entry) => entry.reason_code === 'allowed')).toBe(true);
  });

  it('keeps a capability under an organization constraint and records the constraint', () => {
    const policies: OrganizationPolicy[] = [{
      policy_id: 'org-001', type: 'capability_constraint',
      match: { capability_id: 'mail.message.send' },
      constraint: { recipient_domain_allowlist: ['example.com'] },
    }];
    const output = computeEffectiveCapabilities({ ...baseInput, organizationPolicies: policies });
    expect(output.effective).toContain('mail.message.send');
    expect(output.constraints['mail.message.send']).toEqual({ recipient_domain_allowlist: ['example.com'] });
  });

  it('raises the isolation level for a financial operation regardless of score', () => {
    const riskPolicies: RiskPolicy[] = [{
      policy_id: 'risk-001', when: { financial_operation: true }, weight: 40,
      min_isolation_level: 'full_isolation', reason_code: 'financial_operation',
      added_constraint: { max_amount: 100_000 },
    }];
    const output = computeEffectiveCapabilities({
      ...baseInput,
      proposed: ['finance.payment.approve'],
      humanPermissions: ['finance.payment.approve'],
      delegatableEntries: delegatable('finance.payment.approve'),
      characteristics: { ...characteristics, financial_operation: true },
      riskPolicies,
    });
    expect(output.securityProfile.isolation_level).toBe('full_isolation');
    expect(output.securityProfile.risk_score).toBe(40);
    expect(output.constraints['finance.payment.approve']).toEqual({ max_amount: 100_000 });
  });
});
