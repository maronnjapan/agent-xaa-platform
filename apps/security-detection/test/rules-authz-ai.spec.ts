import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@xaa/contracts';
import { detectAuthorizationAiHits, LARGE_GAP_RATIO } from '../src/rules/authorization-ai.js';
import type { RuleContext } from '../src/rules/context.js';
import { normalizeEntries } from '../src/normalize/index.js';
import { AGENT_ID, baselineFor, logEntry } from '../src/testing/harness.js';

function context(fields: Record<string, unknown>): RuleContext {
  return {
    events: normalizeEntries([logEntry({ log_source: 'authz_ai', app: 'authorization', fields })]).events,
    violations: [],
    baselines: new Map([[AGENT_ID, baselineFor()]]),
    registrations: new Map(),
    maxLifetimeSeconds: null,
  };
}

const ruleIds = (fields: Record<string, unknown>) =>
  detectAuthorizationAiHits(context(fields)).map((hit) => hit.rule_id).sort();

/**
 * REQ-09-035. Checking the Authorization AI's answer against the taxonomy it was given.
 */
describe('the authorization AI classification', () => {
  it('unknown capability hits high', () => {
    const hits = detectAuthorizationAiHits(context({ proposed_capabilities: ['document.read', 'document.purge'] }));
    const hit = hits.find((candidate) => candidate.rule_id === 'authz_ai.unknown_capability');
    expect(hit?.level).toBe('HIGH');
    expect(hit!.detail.observed).toEqual(['document.purge']);
    expect(hits.some((candidate) => candidate.rule_id === 'authz_ai.out_of_taxonomy_format')).toBe(false);
  });

  it('url form hits high', () => {
    const hits = detectAuthorizationAiHits(context({ proposed_capabilities: ['https://api.example.com/v1/x'] }));
    const hit = hits.find((candidate) => candidate.rule_id === 'authz_ai.out_of_taxonomy_format');
    expect(hit?.level).toBe('HIGH');
    // Out of form and out of taxonomy is one mistake, reported once, as the form.
    expect(hits.some((candidate) => candidate.rule_id === 'authz_ai.unknown_capability')).toBe(false);
  });

  it('http method form hits high', () => {
    const hits = detectAuthorizationAiHits(context({ proposed_capabilities: ['GET /v1/documents'] }));
    expect(hits.find((candidate) => candidate.rule_id === 'authz_ai.out_of_taxonomy_format')?.level).toBe('HIGH');
  });

  it('treats an OAuth scope as out of the taxonomy form', () => {
    expect(ruleIds({
      proposed_capabilities: ['https://www.googleapis.com/auth/calendar'],
      effective_capabilities: ['calendar.event.read'],
    })).toEqual(['authz_ai.out_of_taxonomy_format']);
  });

  it('gap 50 percent no hit, 51 percent medium', () => {
    expect(LARGE_GAP_RATIO).toBe(0.5);
    const half = ruleIds({
      proposed_capabilities: [...CAPABILITIES].slice(0, 4),
      effective_capabilities: [...CAPABILITIES].slice(0, 2),
    });
    expect(half).not.toContain('authz_ai.large_gap');

    const past = detectAuthorizationAiHits(context({
      proposed_capabilities: [...CAPABILITIES].slice(0, 8),
      effective_capabilities: [...CAPABILITIES].slice(0, 3),
    }));
    const hit = past.find((candidate) => candidate.rule_id === 'authz_ai.large_gap');
    expect(hit?.level).toBe('MEDIUM');
    expect(hit!.detail.observed).toEqual({ proposed: 8, effective: 3 });
  });

  it('empty proposed produces no hit', () => {
    expect(detectAuthorizationAiHits(context({ proposed_capabilities: [], effective_capabilities: [] }))).toHaveLength(0);
    expect(detectAuthorizationAiHits(context({}))).toHaveLength(0);
  });

  it('compares as sets, so order does not matter', () => {
    const forward = [...CAPABILITIES].slice(0, 3);
    expect(ruleIds({ proposed_capabilities: forward, effective_capabilities: forward })).toEqual([]);
    expect(ruleIds({ proposed_capabilities: [...forward].reverse(), effective_capabilities: forward })).toEqual([]);
  });
});
