import type { Capability } from './identifiers.js';
import type { Characteristics } from './characteristics.js';
import type { IsolationLevel } from './isolation.js';
import type { ReasonCode } from './reason-codes.js';

export interface CapabilityDecision {
  capability_id: string;
  decision: 'ALLOW' | 'DENY';
  reason_code: ReasonCode;
  policy_id: string | null;
}

export interface DelegatableEntry {
  capability_id: string;
  delegatable: boolean;
  policy_id: string;
}

export type OrganizationPolicy =
  | { policy_id: string; type: 'capability_deny'; match: { capability_id?: string; connector_not_in?: string[] }; reason_code: string }
  | { policy_id: string; type: 'capability_constraint'; match: { capability_id?: string; connector_not_in?: string[] }; constraint: Record<string, unknown> };

export interface RiskPolicy {
  policy_id: string;
  when: Partial<Characteristics>;
  weight: number;
  min_isolation_level: IsolationLevel;
  reason_code: string;
  added_constraint?: Record<string, unknown>;
  deny?: boolean;
}

/**
 * Everything the Policy Engine is allowed to see.
 *
 * The AI's own verdict is deliberately unrepresentable here: there is no
 * `isolation_level`, no `decision`, no `security_profile` and no `risk_score` field,
 * so RULE-10 and RULE-12 hold at the type level and not only by convention.
 */
export interface PolicyEngineInput {
  proposed: string[];
  characteristics: Characteristics;
  humanPermissions: string[];
  delegatableEntries: Map<string, DelegatableEntry>;
  organizationPolicies: OrganizationPolicy[];
  capabilityConnectors: Record<string, string[]>;
  riskPolicies: RiskPolicy[];
}

export interface SecurityProfile {
  risk_score: number;
  isolation_level: IsolationLevel;
  reasons: string[];
}

export interface PolicyEngineOutput {
  effective: string[];
  denied: CapabilityDecision[];
  decisions: CapabilityDecision[];
  constraints: Record<string, Record<string, unknown>>;
  securityProfile: SecurityProfile;
}

export type { Capability };
