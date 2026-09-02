import { describe, expect, it, vi } from 'vitest';
import type { Characteristics, DelegatableEntry, OrganizationPolicy, RiskPolicy } from '@xaa/contracts';
import { REASON_CODES, REASON_TO_VIOLATION, VIOLATION_CODES } from '@xaa/contracts';
import { mergeCharacteristics } from '../src/policy/characteristics.js';
import { applyDelegatable, IMPLICIT_NOT_DELEGATABLE } from '../src/policy/delegatable.js';
import { applyOrganizationPolicy, ConflictingConstraint } from '../src/policy/organization.js';
import { evaluateRiskPolicy } from '../src/policy/risk.js';
import { buildSecurityProfile } from '../src/policy/security-profile.js';

const base: Characteristics = {
  capability_risk: 'low', sensitive_resource: false, write_operation: false, admin_permission: false,
  external_communication: false, financial_operation: false, personal_data_access: false,
};

describe('characteristics merge', () => {
  it('lets the taxonomy override the AI', () => {
    const merged = mergeCharacteristics([{ financial_operation: true }], { financial_operation: false });
    expect(merged.characteristics.financial_operation).toBe(true);
    expect(merged.overridden).toContain('financial_operation');
  });

  it('always produces exactly seven keys', () => {
    const merged = mergeCharacteristics([{ capability_risk: 'high' }], { write_operation: true, sensitive_resource: true });
    expect(Object.keys(merged.characteristics).sort()).toEqual([
      'admin_permission', 'capability_risk', 'external_communication', 'financial_operation',
      'personal_data_access', 'sensitive_resource', 'write_operation',
    ]);
  });

  it('takes the highest capability_risk across capabilities', () => {
    expect(mergeCharacteristics([{ capability_risk: 'low' }, { capability_risk: 'high' }], {}).characteristics.capability_risk).toBe('high');
    expect(mergeCharacteristics([{ capability_risk: 'medium' }, { capability_risk: 'low' }], {}).characteristics.capability_risk).toBe('medium');
  });

  it('ORs booleans across capabilities', () => {
    expect(mergeCharacteristics([{ sensitive_resource: false }, { sensitive_resource: true }], {}).characteristics.sensitive_resource).toBe(true);
  });

  it('refuses an AI value for a taxonomy-owned key', () => {
    const merged = mergeCharacteristics([], { sensitive_resource: true } as Partial<Characteristics>);
    expect(merged.characteristics.sensitive_resource).toBe(false);
    expect(merged.overridden).toContain('sensitive_resource');
  });

  it('is stable over a hundred runs', () => {
    const first = mergeCharacteristics([{ capability_risk: 'high' }], { write_operation: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(mergeCharacteristics([{ capability_risk: 'high' }], { write_operation: true })).toEqual(first);
    }
  });
});

describe('delegatable permission', () => {
  const entries = new Map<string, DelegatableEntry>([
    ['calendar.event.read', { capability_id: 'calendar.event.read', delegatable: true, policy_id: 'del-001' }],
    ['calendar.event.write', { capability_id: 'calendar.event.write', delegatable: false, policy_id: 'del-002' }],
  ]);

  it('keeps only what is registered as delegatable', () => {
    const result = applyDelegatable(['calendar.event.read', 'calendar.event.write'], entries);
    expect(result.kept).toEqual(['calendar.event.read']);
    expect(result.denied[0]).toMatchObject({ capability_id: 'calendar.event.write', reason_code: 'not_delegatable', policy_id: 'del-002' });
  });

  it('denies an unregistered capability with the implicit policy id', () => {
    const result = applyDelegatable(['document.read'], entries);
    expect(result.kept).toEqual([]);
    expect(result.denied[0]!.policy_id).toBe(IMPLICIT_NOT_DELEGATABLE);
  });
});

describe('organization policy', () => {
  const constraint: OrganizationPolicy = {
    policy_id: 'org-001', type: 'capability_constraint',
    match: { capability_id: 'mail.message.send' }, constraint: { recipient_domain_allowlist: ['example.com'] },
  };
  const deny: OrganizationPolicy = {
    policy_id: 'org-002', type: 'capability_deny',
    match: { connector_not_in: ['internal-docs-api'] }, reason_code: 'org_policy_denied',
  };

  it('keeps the capability and records the constraint', () => {
    const result = applyOrganizationPolicy(['mail.message.send'], [constraint], { 'mail.message.send': [] });
    expect(result.kept).toEqual(['mail.message.send']);
    expect(result.constraints['mail.message.send']).toEqual({ recipient_domain_allowlist: ['example.com'] });
  });

  it('denies a capability whose connectors are all unapproved', () => {
    const result = applyOrganizationPolicy(['document.read'], [deny], { 'document.read': ['stub-saas-calendar'] });
    expect(result.denied[0]).toMatchObject({ reason_code: 'org_policy_denied', policy_id: 'org-002' });
  });

  it('keeps a capability that has at least one approved connector', () => {
    const result = applyOrganizationPolicy(['document.read'], [deny], { 'document.read': ['stub-saas-calendar', 'internal-docs-api'] });
    expect(result.kept).toEqual(['document.read']);
  });

  it('refuses two policies that set the same constraint key differently', () => {
    const other: OrganizationPolicy = {
      policy_id: 'org-003', type: 'capability_constraint',
      match: { capability_id: 'mail.message.send' }, constraint: { recipient_domain_allowlist: ['other.test'] },
    };
    expect(() => applyOrganizationPolicy(['mail.message.send'], [constraint, other], {})).toThrow(ConflictingConstraint);
  });
});

describe('risk policy', () => {
  const policies: RiskPolicy[] = [
    { policy_id: 'risk-001', when: { financial_operation: true }, weight: 40, min_isolation_level: 'full_isolation', reason_code: 'financial_operation', added_constraint: { max_amount: 100_000 } },
    { policy_id: 'risk-002', when: { sensitive_resource: true }, weight: 25, min_isolation_level: 'standard', reason_code: 'sensitive_resource' },
    { policy_id: 'risk-003', when: { write_operation: true }, weight: 15, min_isolation_level: 'standard', reason_code: 'write_permission' },
    { policy_id: 'risk-004', when: { external_communication: true }, weight: 10, min_isolation_level: 'standard', reason_code: 'external_communication' },
  ];

  it('sums the weights and takes the strongest isolation level', () => {
    const result = evaluateRiskPolicy({ ...base, sensitive_resource: true, write_operation: true, financial_operation: true }, [], policies);
    expect(result.riskScore).toBe(80);
    expect(result.minIsolationLevel).toBe('full_isolation');
    expect(result.reasons).toEqual(['financial_operation', 'sensitive_resource', 'write_permission']);
  });

  it('is stable over a hundred runs', () => {
    const input = { ...base, financial_operation: true };
    const first = evaluateRiskPolicy(input, [], policies);
    for (let attempt = 0; attempt < 100; attempt += 1) expect(evaluateRiskPolicy(input, [], policies)).toEqual(first);
  });

  it('clamps the score at 100', () => {
    const heavy = Array.from({ length: 5 }, (_, index) => ({
      policy_id: `risk-${index}`, when: { write_operation: true }, weight: 40,
      min_isolation_level: 'standard' as const, reason_code: `r${index}`,
    }));
    expect(evaluateRiskPolicy({ ...base, write_operation: true }, [], heavy).riskScore).toBe(100);
  });

  it('never downgrades a financial operation, whatever the score', () => {
    const result = evaluateRiskPolicy({ ...base, financial_operation: true }, [], policies);
    expect(result.riskScore).toBe(40);
    expect(result.minIsolationLevel).toBe('full_isolation');
  });

  /**
   * The rules are evaluated against what was already read, so the same characteristics
   * always score the same. A rule that fetched anything would make the score depend on
   * when it ran, and a decision would stop being reproducible from its record.
   */
  it('reads no database and asks no model', async () => {
    const gcp = await import('@xaa/gcp');
    const firestoreSpy = vi.spyOn(gcp, 'createFirestoreDocumentStore');
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      evaluateRiskPolicy({ ...base, financial_operation: true, write_operation: true }, ['finance.payment.approve'], policies);
    } finally {
      globalThis.fetch = originalFetch;
      firestoreSpy.mockRestore();
    }
    expect(firestoreSpy).toHaveBeenCalledTimes(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe('security profile', () => {
  it('takes the strongest isolation level among matching rules', () => {
    const profile = buildSecurityProfile({
      riskScore: 55, minIsolationLevel: 'full_isolation', addedConstraints: {},
      reasons: ['financial_operation', 'write_permission'], denied: [],
    });
    expect(profile.isolation_level).toBe('full_isolation');
  });

  it('answers standard with an empty score when nothing matches', () => {
    expect(buildSecurityProfile({ riskScore: 0, minIsolationLevel: 'standard', addedConstraints: {}, reasons: [], denied: [] }))
      .toEqual({ risk_score: 0, isolation_level: 'standard', reasons: [] });
  });

  it('refuses a score outside 0..100', () => {
    expect(() => buildSecurityProfile({ riskScore: 101, minIsolationLevel: 'standard', addedConstraints: {}, reasons: [], denied: [] })).toThrow();
  });

  it('rejects a third isolation level at the type level', () => {
    // @ts-expect-error there are exactly two isolation levels
    const bad: import('@xaa/contracts').IsolationLevel = 'partial';
    void bad;
  });
});

describe('reason vocabulary', () => {
  it('maps every reason code, and only to a known violation or null', () => {
    expect(Object.keys(REASON_TO_VIOLATION).sort()).toEqual([...REASON_CODES].sort());
    for (const value of Object.values(REASON_TO_VIOLATION)) {
      if (value !== null) expect(VIOLATION_CODES).toContain(value);
    }
    expect(REASON_TO_VIOLATION.allowed).toBeNull();
  });
});
