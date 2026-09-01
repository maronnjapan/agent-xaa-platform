import { randomUUID } from 'node:crypto';
import type { CapabilityDecision, Characteristics, SecurityProfile } from '@xaa/contracts';
import type { LogContext, Logger } from '@xaa/logging';
import { computeEffectiveCapabilities } from '../policy/effective.js';
import { mergeCharacteristics } from '../policy/characteristics.js';
import { filterToTaxonomy } from '../ai/taxonomy-filter.js';
import { inferCapabilities, type VertexClient } from '../ai/authorization-ai.js';
import type { Warning } from '../ai/output-guard.js';
import { buildWorkDefinition } from '../work-definition/build.js';
import { publishDecisionActivity, type ActivityPublisher } from '../activity/publish.js';
import { inferenceInputHash, logAiInference } from '../log/ai-log.js';
import { logPolicyDecision } from '../log/policy-log.js';
import { loadPolicyInputs } from './load-policy-inputs.js';
import type { AuthorizationStore } from '../store/authorization-store.js';
import type { BusinessWorkRequest } from '../validation/work-request.js';

export type DecisionStep =
  | 'validate' | 'work_definition' | 'infer' | 'sanitize' | 'taxonomy_filter' | 'merge_characteristics'
  | 'load_policy_inputs' | 'policy_engine' | 'security_profile' | 'save_proposal' | 'save_decision'
  | 'activity_event' | 'respond';

export interface DecideInput {
  humanSubject: string;
  purpose: string;
  description: string;
  constraints: Record<string, unknown>;
  requestedLifetimeHours: number;
}

export interface DecideDeps {
  store: AuthorizationStore;
  vertex: VertexClient;
  clock: { now(): number };
  /** The model behind `vertex`, recorded so a decision can be tied to what proposed it. */
  modelVersion: string;
  /** Used only when the seeded taxonomy carries no version of its own. */
  taxonomyVersion: string;
  logger?: Logger;
  publishActivity?: ActivityPublisher;
  onWarning?: (warning: Warning) => void;
  recordStep?: (step: DecisionStep) => void;
  onDecided?: (record: DecisionRecord) => void;
}

export interface DecisionRecord {
  decision_id: string;
  status: 'decided' | 'no_capability_inferred';
  human_subject: string;
  work_definition_id: string;
  proposed_capabilities: string[];
  effective_capabilities: string[];
  security_profile: SecurityProfile;
  denied: CapabilityDecision[];
  dropped_out_of_taxonomy: string[];
  constraints: Record<string, Record<string, unknown>>;
  created_at: string;
}

const EMPTY_PROFILE: SecurityProfile = { risk_score: 0, isolation_level: 'standard', reasons: [] };

/**
 * docs 03 §8, in order. The AI runs first and proposes; the Policy Engine runs last
 * and decides. Between them sit the guards that make the proposal safe to act on:
 * the output sanitiser, the taxonomy filter and the characteristics merge.
 *
 * Every store read finishes before the engine is called, so the engine stays pure
 * and a decision is reproducible from what was recorded.
 */
export async function decide(input: DecideInput, deps: DecideDeps): Promise<DecisionRecord> {
  const step = (name: DecisionStep) => deps.recordStep?.(name);
  const createdAt = new Date(deps.clock.now()).toISOString();
  const decisionId = `dec_${randomUUID()}`;
  const context = logContext(input.humanSubject, decisionId);

  step('validate');
  const taxonomy = await deps.store.loadTaxonomy();
  const taxonomyIds = new Set(taxonomy.map((entry) => entry.capability_id));
  // The seeded rows carry no version column today, so the configured value stands in.
  // The data wins where it exists: what was actually read is what the decision was
  // made against.
  const taxonomyVersion = taxonomy.find((entry) => typeof entry.version === 'string')?.version ?? deps.taxonomyVersion;

  step('work_definition');
  const { workDefinition, dropped } = await buildWorkDefinition({
    purpose: input.purpose, description: input.description,
    constraints: input.constraints, humanSubject: input.humanSubject,
  }, { vertex: deps.vertex, allowedResources: new Set(taxonomy.map((entry) => entry.resource)), now: () => deps.clock.now() });
  await deps.store.saveWorkDefinition({ ...workDefinition });

  step('infer');
  step('sanitize');
  const proposal = await inferCapabilities({
    description: input.description,
    operations: workDefinition.operations,
    taxonomy: taxonomy.map((entry) => ({ capability_id: entry.capability_id, description: entry.description })),
  }, { vertex: deps.vertex, ...(deps.onWarning ? { onWarning: deps.onWarning } : {}) });

  if (deps.logger) {
    logAiInference(deps.logger, context, {
      // No agent exists yet; the decision is what the not-yet-created agent is
      // carried by, from here through provisioning.
      agent_draft_id: decisionId,
      work_definition_id: workDefinition.work_definition_id,
      work_definition_hash: await inferenceInputHash({
        description: input.description, operations: workDefinition.operations,
      }),
      proposed_capabilities: proposal.capabilities,
      confidence: proposal.confidence,
      taxonomy_version: taxonomyVersion,
      model_version: deps.modelVersion,
    });
  }

  step('taxonomy_filter');
  const filtered = filterToTaxonomy(proposal.capabilities, taxonomyIds);

  const saveProposal = (capabilities: string[], characteristics?: Characteristics) => deps.store.saveProposal(`prop_${randomUUID()}`, {
    decision_id: decisionId,
    work_definition_id: workDefinition.work_definition_id,
    proposed_capabilities: capabilities,
    ...(characteristics ? { characteristics } : {}),
    dropped_out_of_taxonomy: filtered.dropped,
    dropped_target_resource: dropped.dropped_target_resource,
    dropped_operation: dropped.dropped_operation,
    confidence: proposal.confidence,
    taxonomy_version: taxonomyVersion,
    model_version: deps.modelVersion,
    created_at: createdAt,
  });

  // Nothing survived the taxonomy filter, so there is nothing for the Policy Engine
  // to decide. The decision is still recorded: "we asked and the answer was nothing"
  // is an auditable outcome, and the proposal is stored without characteristics rather
  // than with seven defaults nobody derived.
  if (filtered.kept.length === 0) {
    step('save_proposal');
    await saveProposal([]);
    const record: DecisionRecord = {
      decision_id: decisionId, status: 'no_capability_inferred', human_subject: input.humanSubject,
      work_definition_id: workDefinition.work_definition_id, proposed_capabilities: [],
      effective_capabilities: [], security_profile: EMPTY_PROFILE, denied: [],
      dropped_out_of_taxonomy: filtered.dropped, constraints: {}, created_at: createdAt,
    };
    step('save_decision');
    await deps.store.saveDecision(decisionId, { ...record });
    step('respond');
    deps.onDecided?.(record);
    return record;
  }

  step('merge_characteristics');
  const defaults = taxonomy
    .filter((entry) => filtered.kept.includes(entry.capability_id))
    .map((entry) => entry.default_characteristics ?? {});
  const merged = mergeCharacteristics(defaults, proposal.characteristics);
  for (const key of merged.overridden) deps.onWarning?.({ code: 'ai_output_contains_decision_field', field: `characteristic_overridden_by_taxonomy:${key}` });

  step('load_policy_inputs');
  const policyInput = await loadPolicyInputs(input.humanSubject, filtered.kept, merged.characteristics, deps.store);

  step('policy_engine');
  step('security_profile');
  const output = computeEffectiveCapabilities(policyInput);

  // The proposal is stored with the merged characteristics rather than the AI's raw
  // ones: a re-evaluation replays the Policy Engine from this record alone (RULE-10),
  // and it must see the same inputs this decision saw.
  step('save_proposal');
  await saveProposal(filtered.kept, merged.characteristics);

  const record: DecisionRecord = {
    decision_id: decisionId,
    status: 'decided',
    human_subject: input.humanSubject,
    work_definition_id: workDefinition.work_definition_id,
    proposed_capabilities: filtered.kept,
    effective_capabilities: output.effective,
    security_profile: output.securityProfile,
    denied: output.denied,
    dropped_out_of_taxonomy: filtered.dropped,
    constraints: output.constraints,
    created_at: createdAt,
  };

  step('save_decision');
  await deps.store.saveDecision(decisionId, { ...record });
  await deps.store.savePolicyDecisions(decisionId, output.decisions, createdAt);

  if (deps.logger) {
    logPolicyDecision(deps.logger, context, {
      decision_id: decisionId,
      proposed_capabilities: filtered.kept,
      effective_capabilities: output.effective,
      security_profile: output.securityProfile,
      decisions: output.decisions,
    });
  }

  step('activity_event');
  await publishDecisionActivity({
    decisionId,
    humanSubject: input.humanSubject,
    effective: output.effective,
    decisions: output.decisions,
    securityProfile: output.securityProfile,
    occurredAt: createdAt,
  }, {
    ...(deps.publishActivity ? { publish: deps.publishActivity } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  step('respond');
  deps.onDecided?.(record);
  return record;
}

function logContext(humanSubject: string, decisionId: string): LogContext {
  // No agent has been created at decision time, and the decision id is what later
  // records join on, so it carries the correlation instead.
  return { request_id: '', trace_id: `authz-${decisionId}`, agent_id: null, human_subject: humanSubject };
}

export type { BusinessWorkRequest };
