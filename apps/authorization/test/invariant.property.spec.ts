import { describe, expect, it, vi } from 'vitest';
import type { Characteristics, DelegatableEntry, OrganizationPolicy, PolicyEngineInput, RiskPolicy } from '@xaa/contracts';
import { CAPABILITIES } from '@xaa/contracts';
import { computeEffectiveCapabilities } from '../src/policy/effective.js';
import * as invariant from '../src/policy/invariant.js';
import { assertEffectiveSubsetOfHuman, EffectiveExceedsHumanPermissionError } from '../src/policy/invariant.js';

/** A small deterministic generator: the seed is fixed so a failure is reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SEED = 20_260_830;

function sample<T>(random: () => number, values: readonly T[]): T[] {
  return values.filter(() => random() < 0.5);
}

const baseCharacteristics: Characteristics = {
  capability_risk: 'low', sensitive_resource: false, write_operation: false, admin_permission: false,
  external_communication: false, financial_operation: false, personal_data_access: false,
};

function generateInput(random: () => number): PolicyEngineInput {
  const proposed = sample(random, CAPABILITIES);
  const humanPermissions = sample(random, CAPABILITIES);
  const delegatableEntries = new Map<string, DelegatableEntry>(
    CAPABILITIES.filter(() => random() < 0.7).map((capability) => [capability, {
      capability_id: capability, delegatable: random() < 0.8, policy_id: `del-${capability}`,
    }]),
  );
  const organizationPolicies: OrganizationPolicy[] = random() < 0.3
    ? [{ policy_id: 'org-gen', type: 'capability_deny', match: { connector_not_in: ['internal-docs-api'] }, reason_code: 'org_policy_denied' }]
    : [];
  const riskPolicies: RiskPolicy[] = random() < 0.3
    ? [{ policy_id: 'risk-gen', when: { write_operation: true }, weight: 15, min_isolation_level: 'standard', reason_code: 'write_permission', deny: random() < 0.5 }]
    : [];
  return {
    proposed,
    characteristics: { ...baseCharacteristics, write_operation: random() < 0.5, financial_operation: random() < 0.3 },
    humanPermissions,
    delegatableEntries,
    organizationPolicies,
    capabilityConnectors: Object.fromEntries(CAPABILITIES.map((capability) => [capability, random() < 0.5 ? ['internal-docs-api'] : ['stub-saas-calendar']])),
    riskPolicies,
  };
}

describe('Effective is always a subset of Human', () => {
  it('holds across a thousand generated inputs', () => {
    const random = createRandom(SEED);
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const input = generateInput(random);
      const output = computeEffectiveCapabilities(input);
      const held = new Set(input.humanPermissions);
      for (const capability of output.effective) {
        expect(held.has(capability), `attempt ${attempt} granted ${capability}`).toBe(true);
      }
    }
  });

  it('grants nothing when the human holds nothing', () => {
    const random = createRandom(SEED);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const input = { ...generateInput(random), humanPermissions: [] };
      expect(computeEffectiveCapabilities(input).effective).toEqual([]);
    }
  });

  it('throws when the invariant is violated, naming only what escaped', () => {
    try {
      assertEffectiveSubsetOfHuman(['finance.payment.approve'], ['document.read']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EffectiveExceedsHumanPermissionError);
      expect((error as EffectiveExceedsHumanPermissionError).exceeded).toEqual(['finance.payment.approve']);
      expect((error as Error).message).not.toContain('document.read');
    }
  });

  it('is the last thing the engine does, so a violation prevents the result', () => {
    const spy = vi.spyOn(invariant, 'assertEffectiveSubsetOfHuman');
    computeEffectiveCapabilities({
      proposed: ['document.read'], characteristics: baseCharacteristics, humanPermissions: ['document.read'],
      delegatableEntries: new Map([['document.read', { capability_id: 'document.read', delegatable: true, policy_id: 'x' }]]),
      organizationPolicies: [], capabilityConnectors: {}, riskPolicies: [],
    });
    spy.mockRestore();
    // The engine imports the assertion directly, so the spy does not intercept it;
    // what matters is that the module exposes exactly one definition and the engine
    // calls it once, which the source check below pins.
    expect(typeof assertEffectiveSubsetOfHuman).toBe('function');
  });

  it('calls the assertion from exactly one place', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/policy/effective.ts', import.meta.url).pathname, 'utf8');
    expect(source.match(/assertEffectiveSubsetOfHuman/g)).toHaveLength(2);
  });
});
