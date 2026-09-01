import { CAPABILITIES } from '@xaa/contracts';
import type { RuleContext } from './context.js';
import { asElementList, hitFromEvent, withAgent } from './hit.js';
import type { RuleHit } from './types.js';

const TAXONOMY = new Set<string>(CAPABILITIES);

/** The shape a Capability ID has, stated once (DEC-SCOPE-03 / RULE-09). */
const CAPABILITY_PATTERN = /^[a-z]+(\.[a-z_]+){1,2}$/;
const HTTP_METHOD_PREFIX = /^(GET|POST|PUT|PATCH|DELETE) /;

export const LARGE_GAP_RATIO = 0.5;

/**
 * REQ-09-035. Checking the model's arithmetic after the fact.
 *
 * The Authorization AI proposes capabilities and the Policy Engine cuts them down; both
 * decisions are already made by the time this runs. What is checked here is whether the
 * proposal was inside the taxonomy at all, and whether the cut was so deep that the
 * proposal and the grant are barely related — a model asking for twice what anyone would
 * approve is a model that has stopped modelling the work.
 *
 * The taxonomy is the compiled-in `CAPABILITIES` list, not a Firestore read: the same
 * proposal has to be judged the same way whenever the batch is replayed.
 *
 * Condition (2) is checked before condition (1). `https://api.example.com/v1/x` is both
 * out of the taxonomy and out of its form, and reporting it twice would count one mistake
 * as two — the form is the more specific statement, so it is the one that is kept.
 */
export function detectAuthorizationAiHits(context: RuleContext): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const event of withAgent(context.events)) {
    const proposed = asElementList(event.attributes.proposed_capabilities);
    if (proposed.length === 0) continue;

    const malformed = proposed.filter((capability) => !wellFormed(capability));
    if (malformed.length > 0) {
      hits.push(hitFromEvent({
        ruleId: 'authz_ai.out_of_taxonomy_format', category: 'authorization_ai', level: 'HIGH', event,
        detail: { observed: malformed, expected: CAPABILITY_PATTERN.source },
      }));
    }

    // Set membership, so two lists that differ only in order are the same list.
    const unknown = proposed.filter((capability) => wellFormed(capability) && !TAXONOMY.has(capability));
    if (unknown.length > 0) {
      hits.push(hitFromEvent({
        ruleId: 'authz_ai.unknown_capability', category: 'authorization_ai', level: 'HIGH', event,
        detail: { observed: [...new Set(unknown)].sort(), expected: [...TAXONOMY].sort() },
      }));
    }

    const effective = asElementList(event.attributes.effective_capabilities);
    const gap = 1 - effective.length / proposed.length;
    if (gap > LARGE_GAP_RATIO) {
      hits.push(hitFromEvent({
        ruleId: 'authz_ai.large_gap', category: 'authorization_ai', level: 'MEDIUM', event,
        detail: { observed: { proposed: proposed.length, effective: effective.length }, expected: LARGE_GAP_RATIO },
      }));
    }
  }
  return hits;
}

/**
 * A URL, an HTTP verb or a colon means the model answered in some other vocabulary —
 * an OAuth scope, an endpoint, a Google API name — rather than in capability ids. The
 * pattern alone would already reject those, but naming them separately is what makes the
 * detail readable to whoever reviews the finding.
 */
function wellFormed(capability: string): boolean {
  if (capability.includes('://') || capability.includes(':')) return false;
  if (HTTP_METHOD_PREFIX.test(capability)) return false;
  return CAPABILITY_PATTERN.test(capability);
}
