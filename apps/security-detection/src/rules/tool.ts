import { TOOL_IDS } from '@xaa/contracts';
import type { RuleContext } from './context.js';
import { hitFromEvent, withAgent } from './hit.js';
import type { RuleHit } from './types.js';

const CATALOG = new Set<string>(TOOL_IDS);

/**
 * REQ-09-032. Tools the agent named, and resources it reached.
 *
 * The catalogue is the compiled-in `TOOL_IDS` (DEC-SCOPE-03) rather than a Firestore
 * read. A detector that asked the catalogue at judgement time would answer differently
 * before and after a seed run, so the same log line would be a finding on Tuesday and
 * nothing on Wednesday.
 *
 * Condition (2) is the one the Tool Executor already refused synchronously. Recording it
 * again here is not a second decision: the Executor stopped one call, and this says the
 * agent tried — which is only visible from the middle, across calls. The refusal is
 * linked by `trace_id` so the two halves of one incident stay attached.
 *
 * The three conditions are evaluated independently and one event can produce two hits.
 * Folding them together is the Correlation stage's job (T-SEC-27), and doing it here
 * would lose which of the three actually happened.
 */
export function detectToolHits(context: RuleContext): RuleHit[] {
  const hits: RuleHit[] = [];
  const unauthorized = new Map<string, string[]>();
  for (const violation of context.violations) {
    if (violation.code !== 'unauthorized_tool') continue;
    const uids = unauthorized.get(violation.trace_id) ?? [];
    unauthorized.set(violation.trace_id, [...uids, violation.event.metadata.correlation_uid]);
  }

  for (const event of withAgent(context.events)) {
    const baseline = context.baselines.get(event.actor.agent_id!);
    const toolId = event.attributes.tool_id;

    if (typeof toolId === 'string' && toolId !== '') {
      if (!CATALOG.has(toolId)) {
        hits.push(hitFromEvent({
          ruleId: 'tool.unknown_tool', category: 'tool', level: 'MEDIUM', event,
          detail: { observed: toolId, expected: [...CATALOG].sort() },
        }));
      } else if (baseline && !baseline.expected_tools.includes(toolId)) {
        const linked = unauthorized.get(event.metadata.trace_id) ?? [];
        hits.push(hitFromEvent({
          ruleId: 'tool.not_provisioned', category: 'tool', level: 'MEDIUM', event,
          // No matching refusal is still a hit: it means the Executor did not stop the
          // call, which is more worrying than the case where it did.
          relatedEvents: linked,
          detail: { observed: toolId, expected: [...baseline.expected_tools] },
        }));
      }
    }

    if (baseline && event.metadata.log_source === 'resource_api' && event.api.resource !== ''
      && !baseline.expected_resources.includes(event.api.resource)) {
      hits.push(hitFromEvent({
        ruleId: 'tool.unexpected_resource', category: 'tool', level: 'MEDIUM', event,
        detail: { observed: event.api.resource, expected: [...baseline.expected_resources] },
      }));
    }
  }
  return hits;
}
