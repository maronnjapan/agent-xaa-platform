import type { CapabilityDecision, PolicyEngineInput, PolicyEngineOutput } from '@xaa/contracts';
import { applyDelegatable } from './delegatable.js';
import { applyOrganizationPolicy } from './organization.js';
import { evaluateRiskPolicy } from './risk.js';
import { buildSecurityProfile } from './security-profile.js';
import { assertEffectiveSubsetOfHuman } from './invariant.js';

/**
 * RULE-11 as one function:
 * Effective = Proposed ∩ Human ∩ Delegatable ∩ (org policy) ∩ (risk policy).
 *
 * Everything it needs arrives as arguments. It reads no database, calls no model,
 * takes no clock and draws no random number, so the same request always yields the
 * same decision and the whole thing is reviewable by reading one file.
 *
 * Removals happen first and in a fixed order; constraints are attached only once
 * nothing more can be removed, so a constraint can never be recorded against a
 * capability that was then denied.
 */
export function computeEffectiveCapabilities(input: PolicyEngineInput): PolicyEngineOutput {
  const decisions: CapabilityDecision[] = [];

  // (1) Proposed, deduplicated and ordered so the output does not depend on Set order.
  const proposed = [...new Set(input.proposed)].sort();

  // (2) Intersect with what the human actually holds.
  const held = new Set(input.humanPermissions);
  const withinHuman: string[] = [];
  for (const capability of proposed) {
    if (held.has(capability)) withinHuman.push(capability);
    else decisions.push({ capability_id: capability, decision: 'DENY', reason_code: 'not_in_human_permission', policy_id: null });
  }

  // (3) Delegation.
  const delegated = applyDelegatable(withinHuman, input.delegatableEntries);
  decisions.push(...delegated.denied);

  // (4) Organization policy: denies remove, constraints narrow.
  const organization = applyOrganizationPolicy(delegated.kept, input.organizationPolicies, input.capabilityConnectors);
  decisions.push(...organization.denied);

  // (5) Risk policy, evaluated over what survives.
  const risk = evaluateRiskPolicy(input.characteristics, organization.kept, input.riskPolicies);
  const riskDenied = new Set(risk.denied.map((entry) => entry.capability_id));
  decisions.push(...risk.denied);

  const effective = organization.kept.filter((capability) => !riskDenied.has(capability)).sort();
  for (const capability of effective) {
    decisions.push({ capability_id: capability, decision: 'ALLOW', reason_code: 'allowed', policy_id: null });
  }

  const constraints: Record<string, Record<string, unknown>> = {};
  for (const capability of effective) {
    const merged = { ...(organization.constraints[capability] ?? {}), ...risk.addedConstraints };
    if (Object.keys(merged).length > 0) constraints[capability] = merged;
  }

  // The last thing before returning, and the only place this is checked.
  assertEffectiveSubsetOfHuman(effective, input.humanPermissions);

  return {
    effective,
    denied: decisions.filter((entry) => entry.decision === 'DENY').sort((left, right) => left.capability_id.localeCompare(right.capability_id)),
    decisions,
    constraints,
    securityProfile: buildSecurityProfile(risk),
  };
}
