import { randomUUID } from 'node:crypto';
import type { Characteristics } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';
import { loadPolicyInputs } from '../pipeline/load-policy-inputs.js';
import { computeEffectiveCapabilities } from '../policy/effective.js';
import { publishPermissionChangeIgnored, type ActivityDeps } from '../activity/publish.js';
import { logPolicyDecision } from '../log/policy-log.js';
import type { AgentSummary, AuthorizationStore, StoredDecision } from '../store/authorization-store.js';
import { classifyChange, retainedCapabilities, type PermissionChangeKind } from './classify.js';
import type { ReprovisionClient } from './reprovision-client.js';

export interface PermissionChange {
  human_subject: string;
  changed_at: string;
  capability_id?: string;
  action?: 'grant' | 'revoke';
}

export interface ReevaluationOutcome {
  agent_id: string;
  decision_id: string;
  previous_decision_id: string;
  change: PermissionChangeKind;
  effective_capabilities: string[];
  reprovision_requested: boolean;
}

export interface ReevaluateDeps extends ActivityDeps {
  store: AuthorizationStore;
  clock: { now(): number };
  logger?: Logger;
  requestReprovision?: ReprovisionClient;
}

export class ReevaluationFailed extends Error {
  constructor(readonly failures: Array<{ agent_id: string; error: unknown }>) {
    super(`re-evaluation failed for ${failures.length} agent(s)`);
    this.name = 'ReevaluationFailed';
  }
}

/**
 * REQ-03-022 / REQ-07-027. A permission change re-runs the Policy Engine and nothing
 * else.
 *
 * The proposal that produced each running agent is read back and reused: asking the
 * model again could return a different set for the same work, which would make a
 * revocation look like a re-scoping. Only the deterministic half re-runs, over freshly
 * loaded policy inputs.
 *
 * Each agent is processed on its own. One agent's failure must not leave the others
 * unevaluated, and it must not roll back a decision that was already written for an
 * agent that succeeded.
 */
export async function reevaluate(change: PermissionChange, deps: ReevaluateDeps): Promise<ReevaluationOutcome[]> {
  const agents = await deps.store.listAgentsBySubject(change.human_subject);
  if (agents.length === 0) return [];
  const decisions = await deps.store.listActiveDecisionsBySubject(change.human_subject);

  const outcomes: ReevaluationOutcome[] = [];
  const failures: Array<{ agent_id: string; error: unknown }> = [];
  for (const agent of agents) {
    try {
      const outcome = await reevaluateAgent(change, agent, decisions, deps);
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      failures.push({ agent_id: agent.agent_id, error });
      deps.logger?.error('policy.reevaluate_failed', logContext(change.human_subject, agent.agent_id), {
        reason: String(error),
      });
    }
  }
  if (failures.length > 0) throw new ReevaluationFailed(failures);
  return outcomes;
}

async function reevaluateAgent(
  change: PermissionChange,
  agent: AgentSummary,
  decisions: StoredDecision[],
  deps: ReevaluateDeps,
): Promise<ReevaluationOutcome | undefined> {
  const previous = decisionBehind(agent, decisions);
  if (!previous) {
    deps.logger?.warning('policy.reevaluate_skipped', logContext(change.human_subject, agent.agent_id), {
      reason: 'no_decision_for_agent',
    });
    return undefined;
  }

  const proposal = await deps.store.getProposalByDecisionId(previous.decision_id);
  if (!proposal || !Array.isArray(proposal.proposed_capabilities) || !proposal.characteristics) {
    // Re-inferring is not an option here (RULE-10), so an unusable proposal means this
    // agent cannot be re-evaluated at all — which is worth a line, not a silent pass.
    deps.logger?.warning('policy.reevaluate_skipped', logContext(change.human_subject, agent.agent_id), {
      reason: 'proposal_unavailable', decision_id: previous.decision_id,
    });
    return undefined;
  }

  const createdAt = new Date(deps.clock.now()).toISOString();
  const decisionId = `dec_${randomUUID()}`;
  const policyInput = await loadPolicyInputs(
    change.human_subject, proposal.proposed_capabilities, proposal.characteristics as Characteristics, deps.store,
  );
  const output = computeEffectiveCapabilities(policyInput);

  // A new record, never an edit of the old one: the decision an agent was created
  // under is what an audit reads to explain that agent, and re-evaluation must not
  // rewrite history to match the present.
  await deps.store.saveDecision(decisionId, {
    decision_id: decisionId,
    status: 'decided',
    human_subject: change.human_subject,
    work_definition_id: previous.work_definition_id,
    proposed_capabilities: proposal.proposed_capabilities,
    effective_capabilities: output.effective,
    security_profile: output.securityProfile,
    denied: output.denied,
    dropped_out_of_taxonomy: [],
    constraints: output.constraints,
    created_at: createdAt,
    source: 'permission_change',
    previous_decision_id: previous.decision_id,
    agent_id: agent.agent_id,
  });
  await deps.store.savePolicyDecisions(decisionId, output.decisions, createdAt);

  if (deps.logger) {
    logPolicyDecision(deps.logger, logContext(change.human_subject, agent.agent_id), {
      decision_id: decisionId,
      proposed_capabilities: proposal.proposed_capabilities,
      effective_capabilities: output.effective,
      security_profile: output.securityProfile,
      decisions: output.decisions,
    });
  }

  const kind = classifyChange(previous.effective_capabilities, output.effective);
  const outcome: ReevaluationOutcome = {
    agent_id: agent.agent_id,
    decision_id: decisionId,
    previous_decision_id: previous.decision_id,
    change: kind,
    effective_capabilities: output.effective,
    reprovision_requested: false,
  };

  if (kind === 'unchanged') return outcome;

  if (kind === 'expanded') {
    // RULE-13: the widening is recorded and stops. Nothing is asked of Lifecycle, and
    // the running agent keeps the authority it was created with.
    await publishPermissionChangeIgnored({
      humanSubject: change.human_subject,
      agentId: agent.agent_id,
      decisionId,
      added: output.effective.filter((capability) => !previous.effective_capabilities.includes(capability)),
      occurredAt: createdAt,
    }, deps);
    return outcome;
  }

  // `shrunk` and `mixed`. A mixed change contains a narrowing, so it is handled as
  // one — and only the capabilities the agent already had are carried over, so
  // re-provisioning can never be the way an agent gains something new.
  const retained = kind === 'mixed'
    ? retainedCapabilities(previous.effective_capabilities, output.effective)
    : output.effective;
  await deps.requestReprovision?.({
    agentId: agent.agent_id,
    effectiveCapabilities: retained,
    workDefinitionId: previous.work_definition_id,
    reason: 'human_permission_revoked',
  });
  return { ...outcome, effective_capabilities: retained, reprovision_requested: deps.requestReprovision !== undefined };
}

/**
 * Which decision this agent was created under.
 *
 * `agents/{agent_id}/meta` deliberately carries no `decision_id` (00b §3 fixes its
 * seventeen keys), so the link is reconstructed from time: the newest decision for
 * this person that already existed when the agent was created. A decision written
 * after the agent — including one this re-evaluation is about to write — cannot be
 * the one it was created under, which is what keeps a widening from silently becoming
 * the baseline of the next comparison.
 */
function decisionBehind(agent: AgentSummary, decisions: StoredDecision[]): StoredDecision | undefined {
  return decisions.find((decision) => decision.created_at <= agent.created_at);
}

function logContext(humanSubject: string, agentId: string) {
  return { request_id: '', trace_id: `authz-${agentId}`, agent_id: agentId, human_subject: humanSubject };
}
