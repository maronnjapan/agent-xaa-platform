import {
  publishActivityEvent, REASON_TO_VIOLATION,
  type ActivityEvent, type CapabilityDecision, type SecurityProfile,
} from '@xaa/contracts';
import type { Logger } from '@xaa/logging';
import {
  ACTIVITY_TITLES, capabilityDecidedMessage, isolationDecidedMessage, permissionChangeIgnoredMessage,
  type DeniedCapability,
} from './messages.js';
import { capabilityDecidedRecord, isolationDecidedRecord, type DecisionRecordInput } from './record.js';

export type ActivityPublisher = (event: ActivityEvent) => Promise<void>;

export interface ActivityDeps {
  publish?: ActivityPublisher;
  logger?: Logger;
}

/**
 * The display channel, kept separate from the decision itself (RULE-55).
 *
 * A failed publish is a warning and nothing more: the decision has already been made
 * and stored, and failing the API because a timeline line did not reach a topic would
 * turn a display outage into a permission outage.
 */
async function emit(event: ActivityEvent, deps: ActivityDeps): Promise<void> {
  try {
    await (deps.publish ?? publishActivityEvent)(event);
  } catch (error) {
    deps.logger?.warning('activity_publish_failed', {
      request_id: '', trace_id: event.trace_id, agent_id: event.agent_id, human_subject: event.human_subject,
    }, { event_type: String((event.detail as { event_type?: unknown } | undefined)?.event_type ?? ''), reason: String(error) });
  }
}

export interface DecisionActivityInput extends DecisionRecordInput {
  humanSubject: string;
  effective: string[];
  decisions: CapabilityDecision[];
  securityProfile: SecurityProfile;
  occurredAt: string;
}

/**
 * REQ-11-015. Two events per decision, in this order: what the agent may do, then how
 * it will be contained. They are separate because a person reading the timeline asks
 * two different questions, and because the isolation decision has its own inputs.
 *
 * CAPABILITY_DECIDED is emitted even when nothing was rejected. "Nothing was refused"
 * is information; leaving the event out would make an unrestricted decision
 * indistinguishable from one that was never made. It is emitted when nothing survived
 * the taxonomy filter, too: a decision that granted nothing is the one a person most
 * needs to see explained, and it used to leave no trace at all. The isolation event is
 * skipped in that case, because no profile was computed and none is being claimed.
 *
 * Each event carries the record (`record.ts`) that says how it was reached.
 */
export async function publishDecisionActivity(input: DecisionActivityInput, deps: ActivityDeps): Promise<void> {
  const denied: DeniedCapability[] = input.decisions
    .filter((entry) => entry.decision === 'DENY')
    .map((entry) => ({ capability_id: entry.capability_id, violation_code: REASON_TO_VIOLATION[entry.reason_code] }));
  const policyIds = [...new Set(input.decisions
    .map((entry) => entry.policy_id)
    .filter((policyId): policyId is string => typeof policyId === 'string'))];
  const base = {
    trace_id: `authz-${input.decisionId}`,
    human_subject: input.humanSubject,
    agent_id: null,
    // The decision is one step of provisioning; no agent exists yet to own a task.
    task_id: 'provisioning',
    occurred_at: input.occurredAt,
    source: 'authorization',
    phase: 'authorization',
    // Neither event reports success or refusal: the decision itself is the fact, and
    // `detail.denied` carries what was refused (docs 11 §3.1).
    outcome: 'info',
    related_finding_id: null,
    is_simulated: false,
  } as const;

  await emit({
    ...base,
    event_id: `evt-${input.decisionId}-CAPABILITY_DECIDED`,
    title: ACTIVITY_TITLES.CAPABILITY_DECIDED,
    message: capabilityDecidedMessage(input.effective, denied),
    detail: {
      event_type: 'CAPABILITY_DECIDED',
      decision_id: input.decisionId,
      status: input.status,
      proposed: [...input.proposal.capabilities],
      allowed: input.effective,
      denied,
      policy_ids: policyIds,
    },
    record: capabilityDecidedRecord(input),
  }, deps);

  if (input.status !== 'decided') return;

  await emit({
    ...base,
    event_id: `evt-${input.decisionId}-ISOLATION_DECIDED`,
    title: ACTIVITY_TITLES.ISOLATION_DECIDED,
    message: isolationDecidedMessage(input.securityProfile.isolation_level, input.securityProfile.risk_score),
    detail: {
      event_type: 'ISOLATION_DECIDED',
      decision_id: input.decisionId,
      isolation_level: input.securityProfile.isolation_level,
      risk_score: input.securityProfile.risk_score,
      reasons: input.securityProfile.reasons,
    },
    record: isolationDecidedRecord(input),
  }, deps);
}

/**
 * REQ-07-028. The one thing a widening produces. The agent is untouched, so the event
 * exists to say so — otherwise the person sees their new permission and an agent that
 * never uses it, with nothing explaining the gap.
 */
export async function publishPermissionChangeIgnored(input: {
  humanSubject: string;
  agentId: string;
  decisionId: string;
  added: string[];
  occurredAt: string;
}, deps: ActivityDeps): Promise<void> {
  await emit({
    event_id: `evt-${input.decisionId}-PERMISSION_CHANGE_IGNORED`,
    trace_id: `authz-${input.decisionId}`,
    human_subject: input.humanSubject,
    agent_id: input.agentId,
    // It concerns an agent that is already running, not the provisioning of a new one.
    task_id: 'lifecycle',
    occurred_at: input.occurredAt,
    source: 'authorization',
    phase: 'authorization',
    outcome: 'info',
    title: ACTIVITY_TITLES.PERMISSION_CHANGE_IGNORED,
    message: permissionChangeIgnoredMessage(input.agentId, input.added),
    detail: {
      event_type: 'PERMISSION_CHANGE_IGNORED',
      decision_id: input.decisionId,
      added_capabilities: input.added,
    },
    related_finding_id: null,
    is_simulated: false,
  }, deps);
}
