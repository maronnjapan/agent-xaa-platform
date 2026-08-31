import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, PromptContainsTechnicalValue } from '../src/ai/prompt.js';
import { DECISION_FIELDS, sanitizeAiOutput, TECHNICAL_FIELDS } from '../src/ai/output-guard.js';
import { filterToTaxonomy } from '../src/ai/taxonomy-filter.js';
import { inferCapabilities } from '../src/ai/authorization-ai.js';

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
