import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { detectLifetimeHits, LIFETIME_SOURCES } from '../src/rules/lifetime.js';
import type { RuleContext } from '../src/rules/context.js';
import { normalizeEntries } from '../src/normalize/index.js';
import { AGENT_ID, baselineFor, logEntry } from '../src/testing/harness.js';

/** The verification profile's ceiling (DEC-IAC-16), passed in as production passes it. */
const MAX_LIFETIME = 3600;

function context(entries: readonly Parameters<typeof logEntry>[0][], max: number | null = MAX_LIFETIME): RuleContext {
  return {
    events: normalizeEntries(entries.map((overrides) => logEntry(overrides))).events,
    violations: [],
    baselines: new Map([[AGENT_ID, baselineFor()]]),
    registrations: new Map(),
    maxLifetimeSeconds: max,
  };
}

function toolCall(fields: Record<string, unknown>, timestamp = '2026-01-01T12:00:00.000Z') {
  return { log_source: 'agent_runtime' as const, app: 'agent-runtime', timestamp, fields };
}

/**
 * REQ-09-033. Age and expiry, taken from what the Runtime reported at the call.
 */
describe('the lifetime classification', () => {
  it('age max plus one second hits high', () => {
    expect(detectLifetimeHits(context([toolCall({ agent_age_seconds: MAX_LIFETIME })]))).toHaveLength(0);
    const hits = detectLifetimeHits(context([toolCall({ agent_age_seconds: MAX_LIFETIME + 1 })]));
    expect(hits.map((hit) => hit.rule_id)).toEqual(['lifetime.age_exceeded']);
    expect(hits[0]!.level).toBe('HIGH');
    expect(hits[0]!.detail).toEqual({ observed: MAX_LIFETIME + 1, expected: MAX_LIFETIME });
  });

  it('access after expires_at hits high', () => {
    const hits = detectLifetimeHits(context([
      toolCall({ expires_at: '2026-01-01T11:00:00.000Z' }, '2026-01-01T12:00:00.000Z'),
    ]));
    expect(hits.map((hit) => hit.rule_id)).toEqual(['lifetime.access_after_expiry']);
    expect(hits[0]!.level).toBe('HIGH');
    // Exactly at the expiry is not past it.
    expect(detectLifetimeHits(context([
      toolCall({ expires_at: '2026-01-01T12:00:00.000Z' }, '2026-01-01T12:00:00.000Z'),
    ]))).toHaveLength(0);
  });

  it('skips events without age fields', () => {
    expect(detectLifetimeHits(context([toolCall({ tool_id: 'internal.document.list' })]))).toHaveLength(0);
    // And an Agent OP line, which has never carried either field, is not a violation.
    expect(detectLifetimeHits(context([{ fields: { agent_age_seconds: MAX_LIFETIME + 1 } }]))).toHaveLength(0);
    expect(LIFETIME_SOURCES).toEqual(['agent_runtime', 'resource_api']);
  });

  it('says nothing about age when the deployment set no ceiling', () => {
    const hits = detectLifetimeHits(context([toolCall({ agent_age_seconds: 999_999 })], null));
    expect(hits).toHaveLength(0);
  });

  it('reads the ceiling from the environment rather than a literal', async () => {
    const source = await readFile(new URL('../src/rules/lifetime.ts', import.meta.url), 'utf8');
    // Comments may name the Terraform defaults; the code may not hold a copy of them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('86400');
    expect(code).not.toContain('3600');
  });
});
