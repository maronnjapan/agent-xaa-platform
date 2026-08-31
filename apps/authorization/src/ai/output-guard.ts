import type { Characteristics } from '@xaa/contracts';

export interface AuthorizationAiResult {
  capabilities: string[];
  characteristics: Partial<Characteristics>;
  confidence: number;
}

/** Where or how to call something: the model has no business naming these. */
export const TECHNICAL_FIELDS = ['api_url', 'http_method', 'token_endpoint', 'oauth_scope', 'bridge_url', 'base_url', 'endpoint'] as const;
/** The verdict itself: the model proposes, the Policy Engine decides. */
export const DECISION_FIELDS = ['decision', 'allow', 'deny', 'isolation_level', 'security_profile', 'risk_score'] as const;

const KNOWN_CHARACTERISTICS = ['write_operation', 'external_communication', 'financial_operation', 'sensitive_resource'] as const;

export interface Warning {
  code: 'ai_output_contains_technical_field' | 'ai_output_contains_decision_field';
  field: string;
}

/**
 * RULE-09 / RULE-10 / RULE-12, enforced on the way out.
 *
 * The result is rebuilt from scratch with exactly three keys rather than spread from
 * the model's response, so a field nobody anticipated cannot ride along. A technical
 * or decision field that does appear is dropped and recorded as a warning: it is
 * worth knowing the model tried, but not worth failing the request over.
 */
export function sanitizeAiOutput(raw: unknown): { result: AuthorizationAiResult; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  for (const field of TECHNICAL_FIELDS) if (field in source) warnings.push({ code: 'ai_output_contains_technical_field', field });
  for (const field of DECISION_FIELDS) if (field in source) warnings.push({ code: 'ai_output_contains_decision_field', field });

  const rawCharacteristics = (source.characteristics && typeof source.characteristics === 'object'
    ? source.characteristics : {}) as Record<string, unknown>;
  for (const field of [...TECHNICAL_FIELDS, ...DECISION_FIELDS]) {
    if (field in rawCharacteristics) {
      warnings.push({
        code: (TECHNICAL_FIELDS as readonly string[]).includes(field) ? 'ai_output_contains_technical_field' : 'ai_output_contains_decision_field',
        field: `characteristics.${field}`,
      });
    }
  }

  const characteristics: Partial<Characteristics> = {};
  for (const key of KNOWN_CHARACTERISTICS) {
    const value = rawCharacteristics[key];
    if (typeof value === 'boolean') characteristics[key] = value;
  }

  const confidence = typeof source.confidence === 'number' && source.confidence >= 0 && source.confidence <= 1 ? source.confidence : 0;
  const capabilities = Array.isArray(source.capabilities)
    ? source.capabilities.filter((value): value is string => typeof value === 'string')
    : [];

  return { result: { capabilities, characteristics, confidence }, warnings };
}
