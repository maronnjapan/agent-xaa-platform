import { describe, expect, it, vi } from 'vitest';
import type { PolicyEngineInput } from '@xaa/contracts';
import { buildPrompt, PromptContainsTechnicalValue } from '../src/ai/prompt.js';
import { DECISION_FIELDS, sanitizeAiOutput, TECHNICAL_FIELDS } from '../src/ai/output-guard.js';
import { filterToTaxonomy } from '../src/ai/taxonomy-filter.js';
import { inferCapabilities } from '../src/ai/authorization-ai.js';
import { computeEffectiveCapabilities } from '../src/policy/effective.js';
import { runDecision } from './helpers.js';

const taxonomy = [
  { capability_id: 'calendar.event.read', description: '予定を読む' },
  { capability_id: 'mail.message.send', description: 'メールを送る' },
];

describe('prompt construction', () => {
  it('carries no url, endpoint or oauth wording', () => {
    const prompt = buildPrompt({ description: '予定を整理する', operations: ['read_events'], taxonomy });
    for (const marker of ['https://', 'endpoint', 'base_url']) expect(prompt.toLowerCase()).not.toContain(marker);
  });

  it('throws before any model call when a technical value slips into the taxonomy', () => {
    expect(() => buildPrompt({
      description: '予定を整理する', operations: [],
      taxonomy: [{ capability_id: 'calendar.event.read', description: 'https://calendar.example/api を呼ぶ' }],
    })).toThrow(PromptContainsTechnicalValue);
  });

  it('does not reach the model when the prompt is refused', async () => {
    const generateJson = vi.fn();
    await expect(inferCapabilities({
      description: 'https://evil.test を呼ぶ', operations: [], taxonomy,
    }, { vertex: { generateJson } })).rejects.toThrow(PromptContainsTechnicalValue);
    expect(generateJson).toHaveBeenCalledTimes(0);
  });
});

describe('AI output guard', () => {
  it('drops technical fields and reports one warning each', () => {
    const { result, warnings } = sanitizeAiOutput({
      capabilities: ['calendar.event.read'], characteristics: {}, confidence: 0.9,
      api_url: 'https://x.test', oauth_scope: 'calendar.read',
    });
    expect(result).not.toHaveProperty('api_url');
    expect(result).not.toHaveProperty('oauth_scope');
    expect(warnings.filter((warning) => warning.code === 'ai_output_contains_technical_field')).toHaveLength(2);
  });

  it('drops the model\'s own verdict', () => {
    const { result, warnings } = sanitizeAiOutput({
      capabilities: [], characteristics: {}, confidence: 1,
      isolation_level: 'standard', decision: 'allow', risk_score: 0,
    });
    expect(result).not.toHaveProperty('isolation_level');
    expect(warnings.filter((warning) => warning.code === 'ai_output_contains_decision_field')).toHaveLength(3);
  });

  it('always returns exactly three keys', () => {
    for (const raw of [
      { capabilities: ['a'], characteristics: { write_operation: true }, confidence: 0.5 },
      { capabilities: ['a'], characteristics: {}, confidence: 0.5, api_url: 'x', decision: 'allow' },
      {},
      null,
    ]) {
      expect(Object.keys(sanitizeAiOutput(raw).result).sort()).toEqual(['capabilities', 'characteristics', 'confidence']);
    }
  });

  it('keeps only the four known characteristics', () => {
    const { result } = sanitizeAiOutput({
      capabilities: [], confidence: 1,
      characteristics: { write_operation: true, made_up: true, capability_risk: 'high' },
    });
    expect(Object.keys(result.characteristics)).toEqual(['write_operation']);
  });

  it('clamps an out-of-range confidence to zero', () => {
    expect(sanitizeAiOutput({ capabilities: [], characteristics: {}, confidence: 5 }).result.confidence).toBe(0);
  });

  it('lists the two guarded field groups without overlap', () => {
    expect(new Set([...TECHNICAL_FIELDS, ...DECISION_FIELDS]).size).toBe(TECHNICAL_FIELDS.length + DECISION_FIELDS.length);
  });
});

describe('taxonomy filter', () => {
  const known = new Set(['calendar.event.read', 'mail.message.send']);

  it('keeps only what the taxonomy defines', () => {
    expect(filterToTaxonomy(['calendar.event.read', 'slack.channel.admin'], known))
      .toEqual({ kept: ['calendar.event.read'], dropped: ['slack.channel.admin'] });
  });

  it('matches exactly, without case folding', () => {
    expect(filterToTaxonomy(['Calendar.Event.Read'], known).dropped).toEqual(['Calendar.Event.Read']);
  });

  it('is a pure function of its two arguments', () => {
    const first = filterToTaxonomy(['calendar.event.read', 'x'], known);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(filterToTaxonomy(['calendar.event.read', 'x'], known)).toEqual(first);
    }
  });
});

/**
 * RULE-12. The model may describe the work; it may not decide how the work is
 * contained. An `isolation_level` in its answer is dropped, and the level the agent
 * actually runs under is derived from the characteristics by the Risk Policy — which
 * is why a model that says "standard" over a financial operation changes nothing.
 */
describe('what the Policy Engine is given', () => {
  it('ignores the level the model asked for and raises it from the characteristics', async () => {
    const result = await runDecision({
      humanPermissions: ['document.write'],
      description: '支払を承認するために書類を更新する',
      model: {
        targetResources: ['document'],
        raw: {
          capabilities: ['document.write'],
          characteristics: { financial_operation: true },
          confidence: 0.9,
          isolation_level: 'standard',
        },
      },
    });

    expect(result.record.effective_capabilities).toEqual(['document.write']);
    expect(result.record.security_profile.isolation_level).toBe('full_isolation');
    expect(result.record.security_profile.reasons).toContain('financial_operation');
    // Nothing the model said about isolation reached the record.
    expect(JSON.stringify(result.record.security_profile)).not.toContain('"standard"');
  });

  it('has no isolation_level to assign, at the type level', () => {
    const input: PolicyEngineInput = {
      proposed: [], characteristics: {
        capability_risk: 'low', sensitive_resource: false, write_operation: false, admin_permission: false,
        external_communication: false, financial_operation: false, personal_data_access: false,
      },
      humanPermissions: [], delegatableEntries: new Map(), organizationPolicies: [],
      capabilityConnectors: {}, riskPolicies: [],
      // @ts-expect-error the Policy Engine's input has no isolation_level field
      isolation_level: 'standard',
    };
    // And nothing reads it either: the level in the output comes from the risk
    // policies, which here are empty, not from the value attached to the input.
    expect(computeEffectiveCapabilities(input).securityProfile.isolation_level).toBe('standard');
  });
});

/**
 * The note is prose for the person who asked, and nothing else. It is kept when the
 * model wrote one, absent when it did not, and dropped whole — with a warning — when
 * it names where or how to call something (RULE-09).
 */
describe('the model\'s note', () => {
  it('is kept when clean and absent when not written', () => {
    const { result } = sanitizeAiOutput({ capabilities: ['a'], characteristics: {}, confidence: 0.5, note: '  読むだけで足ります。 ' });
    expect(result.note).toBe('読むだけで足ります。');
    expect(sanitizeAiOutput({ capabilities: ['a'], characteristics: {}, confidence: 0.5 }).result).not.toHaveProperty('note');
    expect(sanitizeAiOutput({ capabilities: ['a'], characteristics: {}, confidence: 0.5, note: '   ' }).result).not.toHaveProperty('note');
  });

  it('drops a note that names an endpoint, and says so', () => {
    const { result, warnings } = sanitizeAiOutput({
      capabilities: ['a'], characteristics: {}, confidence: 0.5, note: 'https://api.example.test/v1 を呼べば足ります。',
    });
    expect(result).not.toHaveProperty('note');
    expect(warnings).toContainEqual({ code: 'ai_output_contains_technical_field', field: 'note' });
  });
});
