import { describe, expect, it } from 'vitest';
import { TOOL_IDS } from '@xaa/contracts';
import { detectToolHits } from '../src/rules/tool.js';
import type { RuleContext } from '../src/rules/context.js';
import type { ProtocolViolationRecord } from '../src/pipeline/types.js';
import { normalizeEntries } from '../src/normalize/index.js';
import { AGENT_ID, baselineFor, DOCUMENT_TOOLS, logEntry } from '../src/testing/harness.js';

const DOCS_RESOURCE = 'https://resource-docs-api.test';

function context(
  entries: readonly Parameters<typeof logEntry>[0][],
  violations: ProtocolViolationRecord[] = [],
): RuleContext {
  return {
    events: normalizeEntries(entries.map((overrides) => logEntry(overrides))).events,
    violations,
    baselines: new Map([[AGENT_ID, baselineFor()]]),
    registrations: new Map(),
    maxLifetimeSeconds: null,
  };
}

function toolCall(toolId: string, traceId = 'trace-1') {
  return {
    log_source: 'agent_runtime' as const, app: 'agent-runtime', event: 'runtime.tool_call',
    trace_id: traceId, fields: { tool_id: toolId },
  };
}

/** The refusal the Tool Executor already wrote for the same request. */
function unauthorized(traceId: string): ProtocolViolationRecord {
  const event = normalizeEntries([logEntry({
    log_source: 'agent_runtime', severity: 'WARNING', trace_id: traceId,
    fields: { validation: 'unauthorized_tool' },
  })]).events[0]!;
  return {
    code: 'unauthorized_tool', agent_id: AGENT_ID, human_subject: 'testuser',
    occurred_at: event.time, trace_id: traceId, event,
  };
}

/**
 * REQ-09-032. Three independent conditions over the tool catalogue and the baseline.
 */
describe('the tool classification', () => {
  it('unknown tool id hits medium', () => {
    const hits = detectToolHits(context([toolCall('internal.document.destroy')]));
    expect(hits.map((hit) => hit.rule_id)).toEqual(['tool.unknown_tool']);
    expect(hits[0]!.level).toBe('MEDIUM');
    expect(hits[0]!.detail.observed).toBe('internal.document.destroy');
  });

  it('not provisioned tool links unauthorized_tool by trace_id', () => {
    // In the catalogue, absent from this agent's two provisioned document tools.
    const other = TOOL_IDS.find((tool) => !DOCUMENT_TOOLS.includes(tool as never))!;
    const hits = detectToolHits(context([toolCall(other, 'trace-9')], [unauthorized('trace-9')]));
    const hit = hits.find((candidate) => candidate.rule_id === 'tool.not_provisioned');
    expect(hit).toBeTruthy();
    expect(hit!.related_events).toHaveLength(1);
    expect(hit!.related_events[0]).toBe('trace-9');
  });

  it('not provisioned tool still hits when no matching validation event', () => {
    const other = TOOL_IDS.find((tool) => !DOCUMENT_TOOLS.includes(tool as never))!;
    const hits = detectToolHits(context([toolCall(other, 'trace-9')], [unauthorized('some-other-trace')]));
    const matched = hits.filter((hit) => hit.rule_id === 'tool.not_provisioned');
    expect(matched).toHaveLength(1);
    expect(matched[0]!.related_events).toEqual([]);
  });

  it('unexpected resource hits medium', () => {
    const hits = detectToolHits(context([{
      log_source: 'resource_api', app: 'resource-finance-api',
      fields: { response_status: '200', resource: 'https://resource-finance-api.test' },
    }]));
    const hit = hits.find((candidate) => candidate.rule_id === 'tool.unexpected_resource');
    expect(hit?.level).toBe('MEDIUM');
    expect(hit!.detail.expected).toEqual([DOCS_RESOURCE]);
  });

  it('leaves a provisioned tool reaching its own resource alone', () => {
    expect(detectToolHits(context([toolCall(DOCUMENT_TOOLS[0]!)]))).toHaveLength(0);
    expect(detectToolHits(context([{
      log_source: 'resource_api', app: 'resource-docs-api',
      fields: { response_status: '200', resource: DOCS_RESOURCE },
    }]))).toHaveLength(0);
  });

  it('evaluates the three conditions independently', () => {
    // One call naming a catalogue tool the agent does not have, against a resource it was
    // not provisioned for: two different things to say, so two hits.
    const other = TOOL_IDS.find((tool) => !DOCUMENT_TOOLS.includes(tool as never))!;
    const hits = detectToolHits(context([{
      log_source: 'resource_api', app: 'resource-finance-api',
      fields: { tool_id: other, response_status: '200', resource: 'https://resource-finance-api.test' },
    }]));
    expect(hits.map((hit) => hit.rule_id).sort()).toEqual(['tool.not_provisioned', 'tool.unexpected_resource']);
  });
});
