import type { AgentBaseline } from './types.js';
import type { NormalizedEvent } from '../normalize/index.js';

export const DEVIATION_KINDS = [
  'unexpected_tool', 'capability_mismatch', 'unexpected_resource',
  'rate_exceeded', 'foreign_dedicated_op_access', 'access_after_expiry',
] as const;

export type DeviationKind = (typeof DEVIATION_KINDS)[number];

export interface Deviation {
  kind: DeviationKind;
  observed: unknown;
  expected: unknown;
  occurred_at: string;
  trace_id: string;
}

/**
 * How far this agent strayed from what it was built to do.
 *
 * Deviations are not rule hits and the two are deliberately different types. A rule hit
 * is an alarm: a count crossed a multiple of the expected ceiling and somebody should
 * look. A deviation is a description handed to the Security AI so it can reason about
 * what the agent actually did. Conflating them would mean the AI only ever hears about
 * behaviour that already tripped an alarm.
 *
 * That is why `rate_exceeded` here compares against `expected_rate.max` itself and not
 * against a multiple of it: the multipliers in thresholds.json belong to the rules.
 *
 * Each condition is evaluated on its own. One event that uses an unexpected tool to
 * reach an unexpected resource is two deviations, because they are two different things
 * to explain.
 */
export function detectDeviations(input: {
  baseline: AgentBaseline;
  events: readonly NormalizedEvent[];
  toolCapabilities?: Readonly<Record<string, string>>;
  now?: number;
}): Deviation[] {
  const deviations: Deviation[] = [];
  const tools = new Set(input.baseline.expected_tools);
  const resources = new Set(input.baseline.expected_resources);
  const capabilities = new Set(input.baseline.effective_capabilities);
  const expiresAt = Date.parse(input.baseline.lifetime);

  let idJagCount = 0;
  let apiCount = 0;

  for (const event of input.events) {
    const at = event.time;
    const trace = event.metadata.trace_id;
    const toolId = String(event.attributes.tool_id ?? event.api.operation);

    if (toolId && toolId.startsWith('internal.') && !tools.has(toolId)) {
      deviations.push({ kind: 'unexpected_tool', observed: toolId, expected: [...tools], occurred_at: at, trace_id: trace });
    }
    // Checked by capability, not by tool id: a tool the agent may name is not the same
    // as a tool it was granted the capability for.
    const required = input.toolCapabilities?.[toolId];
    if (required && !capabilities.has(required)) {
      deviations.push({ kind: 'capability_mismatch', observed: required, expected: [...capabilities], occurred_at: at, trace_id: trace });
    }
    if (event.api.resource && !resources.has(event.api.resource)) {
      deviations.push({ kind: 'unexpected_resource', observed: event.api.resource, expected: [...resources], occurred_at: at, trace_id: trace });
    }
    const opAgentId = event.attributes.op_agent_id;
    if (typeof opAgentId === 'string' && event.actor.agent_id && opAgentId !== event.actor.agent_id) {
      deviations.push({
        kind: 'foreign_dedicated_op_access', observed: opAgentId,
        expected: event.actor.agent_id, occurred_at: at, trace_id: trace,
      });
    }
    if (!Number.isNaN(expiresAt) && Date.parse(at) > expiresAt) {
      deviations.push({ kind: 'access_after_expiry', observed: at, expected: input.baseline.lifetime, occurred_at: at, trace_id: trace });
    }
    if (event.metadata.log_source === 'agent_op') idJagCount += 1;
    if (event.metadata.log_source === 'resource_api') apiCount += 1;
  }

  const last = input.events.at(-1);
  if (last) {
    for (const [count, range, label] of [
      [idJagCount, input.baseline.expected_rate.id_jag, 'id_jag'],
      [apiCount, input.baseline.expected_rate.api_request, 'api_request'],
    ] as Array<[number, { max: number }, string]>) {
      if (count > range.max) {
        deviations.push({
          kind: 'rate_exceeded', observed: { metric: label, count },
          expected: range.max, occurred_at: last.time, trace_id: last.metadata.trace_id,
        });
      }
    }
  }
  return deviations;
}
