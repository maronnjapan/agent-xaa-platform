import { shortId } from '@xaa/contracts';
import type { NormalizedEvent } from '../normalize/index.js';
import type { RuleContext } from './context.js';
import { hitFromEvent, withAgent } from './hit.js';
import type { RuleHit } from './types.js';
import { groupByWindow } from './window.js';

interface Issuance {
  actSub: string;
  sub: string;
}

/**
 * REQ-09-034. The three ways one agent's world can touch another's.
 *
 * Every judgement is made from the log line itself plus the registration the line names.
 * There is no lease table and no history to write: a dedicated OP belongs to exactly one
 * agent for the whole of that agent's life, so "whose OP is this" needs no interval
 * arithmetic — and a history table would be a second record of the same fact, wrong the
 * moment the two disagree.
 *
 * Nothing here creates or changes a GCP resource. Isolation is verified by reading; a
 * detector that could also repair it would be a second authority over the boundary.
 */
export function detectIsolationHits(context: RuleContext): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const event of withAgent(context.events)) {
    const agentId = event.actor.agent_id!;

    const connectionId = event.attributes.idp_connection_id;
    const registered = context.registrations.get(agentId)?.idp_connection_id;
    if (typeof connectionId === 'string' && connectionId !== ''
      && typeof registered === 'string' && registered !== '' && connectionId !== registered) {
      hits.push(hitFromEvent({
        ruleId: 'isolation.cross_agent_idp', category: 'isolation', level: 'HIGH', event,
        detail: { observed: connectionId, expected: registered },
      }));
    }

    const opAgentId = event.attributes.op_agent_id;
    if (typeof opAgentId === 'string' && opAgentId !== '' && opAgentId !== agentId) {
      hits.push(hitFromEvent({
        ruleId: 'isolation.dedicated_op_mismatch', category: 'isolation', level: 'HIGH', event,
        detail: {
          observed: opAgentId, expected: agentId,
          // What the platform-wide pass groups on: one dedicated OP reached by agents
          // belonging to two different people is the breach that matters most.
          ...shortIdOf(event, opAgentId),
        },
      }));
    }
  }

  return [...hits, ...multiSubjectActorHits(context)];
}

/**
 * One actor token, two people.
 *
 * `act.sub` names the agent that asked; `sub` names the person it asked for. An agent is
 * delegated to by exactly one person, so two subjects under one actor inside ten minutes
 * means either the delegation check was bypassed or the actor token is being replayed
 * against a second session. One hit per actor, not per pair: the finding is that the
 * actor is doing this at all.
 */
function multiSubjectActorHits(context: RuleContext): RuleHit[] {
  const issuances = withAgent(context.events)
    .map((event) => ({ event, issuance: issuanceOf(event) }))
    .filter((row): row is { event: NormalizedEvent; issuance: Issuance } => row.issuance !== null);

  const hits: RuleHit[] = [];
  for (const [, group] of groupByWindow(issuances, (row) => row.issuance.actSub, (row) => row.event.time)) {
    const subjects = [...new Set(group.map((row) => row.issuance.sub))];
    if (subjects.length < 2) continue;
    const last = group.at(-1)!;
    hits.push(hitFromEvent({
      ruleId: 'isolation.multi_subject_actor', category: 'isolation', level: 'HIGH', event: last.event,
      relatedEvents: group.map((row) => row.event.metadata.correlation_uid),
      detail: { observed: subjects.sort(), expected: 1, act_sub: last.issuance.actSub },
    }));
  }
  return hits;
}

/**
 * An issued ID-JAG, under either of the two names the platform writes it.
 *
 * The issuance ledger line carries `jti` / `act_sub` / `sub` (T-SEC-15); the Token
 * Exchange line carries the same three facts as `issued_jti` / `actor_token_sub` /
 * `subject_token_sub`. Reading both means the rule keeps working whichever of the two a
 * deployment happens to be emitting, rather than going silent on the one it did not
 * expect.
 */
function issuanceOf(event: NormalizedEvent): Issuance | null {
  const attributes = event.attributes;
  const jti = attributes.jti ?? attributes.issued_jti;
  const actSub = attributes.act_sub ?? attributes.actor_token_sub;
  const sub = attributes.sub ?? attributes.subject_token_sub ?? event.actor.human_subject;
  if (typeof jti !== 'string' || jti === '') return null;
  if (typeof actSub !== 'string' || actSub === '') return null;
  if (typeof sub !== 'string' || sub === '') return null;
  return { actSub, sub };
}

function shortIdOf(event: NormalizedEvent, opAgentId: string): { dedicated_short_id: string } | Record<string, never> {
  const declared = event.attributes.dedicated_short_id;
  if (typeof declared === 'string' && declared !== '') return { dedicated_short_id: declared };
  // Derived with the same function the Provisioner names the dedicated resources with,
  // so the two sides agree without a lookup table between them.
  return opAgentId.length >= 12 ? { dedicated_short_id: shortId(opAgentId) } : {};
}
