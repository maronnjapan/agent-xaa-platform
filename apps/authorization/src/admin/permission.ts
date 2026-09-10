import {
  CAPABILITY_RISK_LEVELS, isValidCapabilityId, type CapabilityRisk, type Characteristics,
} from '@xaa/contracts';

/**
 * The four keys the taxonomy owns (docs 03 §7), plus the one the seeded taxonomy also
 * states.
 *
 * `financial_operation` is nominally the AI's to describe, but the shipped taxonomy
 * states it for the payment approval capability, because it is what forces
 * FULL_ISOLATION and the AI must not be able to talk the platform out of it. An
 * administrator gets the same lever, and only that one: `write_operation` and
 * `external_communication` stay with the AI, which is where a description of this
 * particular work belongs.
 */
export const ADMIN_BOOLEAN_KEYS = [
  'sensitive_resource', 'admin_permission', 'personal_data_access', 'financial_operation',
] as const;

export type AdminBooleanKey = (typeof ADMIN_BOOLEAN_KEYS)[number];

/** One permission, as the console shows and stores it. */
export interface PermissionRecord {
  capability_id: string;
  resource: string;
  object: string;
  action: string;
  description: string;
  default_characteristics: Partial<Characteristics>;
  /** RULE-11's delegation step: whether an agent may hold this on someone's behalf. */
  delegatable: boolean;
  delegatable_policy_id: string;
}

export type PermissionInput = Record<string, string | undefined>;

export type ParseResult =
  | { ok: true; permission: PermissionRecord }
  | { ok: false; errors: string[] };

const DESCRIPTION_MAX = 200;

/**
 * Turns what an administrator typed into the two records a permission is made of.
 *
 * `resource`, `object` and `action` are derived from the id rather than asked for.
 * They are the id's own segments, and a form that accepted them separately would let
 * `finance.payment.approve` be filed under the calendar resource — a row that reads,
 * to every later query, as a capability about something it is not.
 *
 * Validation is total: every problem is reported, not the first one, because a form
 * that rejects one field at a time is a form somebody submits five times.
 */
export function parsePermission(input: PermissionInput, options: {
  /** Fixed on edit: the id is the document id, and renaming one is creating another. */
  capabilityId?: string;
  /** Kept on edit, so the audit keeps naming the policy that decided the delegation. */
  existingPolicyId?: string;
} = {}): ParseResult {
  const errors: string[] = [];
  const capabilityId = (options.capabilityId ?? input.capability_id ?? '').trim();
  if (capabilityId === '') errors.push('capability_id を入力してください');
  else if (!isValidCapabilityId(capabilityId)) {
    errors.push('capability_id は resource.object.action の形（小文字とアンダースコアのみ、ベンダー名と HTTP メソッド名は不可）で入力してください');
  }

  const description = (input.description ?? '').trim();
  if (description === '') errors.push('description を入力してください');
  else if (description.length > DESCRIPTION_MAX) errors.push(`description は ${DESCRIPTION_MAX} 文字までです`);
  else if (/[\r\n]/.test(description)) errors.push('description は1行で入力してください');

  const risk = (input.capability_risk ?? '').trim();
  if (!(CAPABILITY_RISK_LEVELS as readonly string[]).includes(risk)) {
    errors.push(`capability_risk は ${CAPABILITY_RISK_LEVELS.join(' / ')} のいずれかです`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const segments = capabilityId.split('.');
  const [resource, object, action] = segments.length === 3
    ? [segments[0]!, segments[1]!, segments[2]!]
    // Two segments: the resource is its own object, the way `document.read` is stored.
    : [segments[0]!, segments[0]!, segments[1]!];

  const characteristics: Partial<Characteristics> = {
    capability_risk: risk as CapabilityRisk,
    sensitive_resource: checked(input.sensitive_resource),
    admin_permission: checked(input.admin_permission),
    personal_data_access: checked(input.personal_data_access),
  };
  // Stated only when true, exactly as the shipped taxonomy states it: leaving it out
  // is what keeps it a key the AI may still contribute for this capability.
  if (checked(input.financial_operation)) characteristics.financial_operation = true;

  return {
    ok: true,
    permission: {
      capability_id: capabilityId,
      resource, object, action,
      description,
      default_characteristics: characteristics,
      delegatable: checked(input.delegatable),
      delegatable_policy_id: options.existingPolicyId ?? `del-${capabilityId}`,
    },
  };
}

/** An HTML checkbox is absent when unticked, so anything but a positive value is false. */
function checked(value: string | undefined): boolean {
  return value === 'on' || value === 'true' || value === '1';
}
