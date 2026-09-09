import type { Characteristics } from '@xaa/contracts';

export interface AuthorizationAiResult {
  capabilities: string[];
  characteristics: Partial<Characteristics>;
  confidence: number;
  /** The model's own words about the proposal, when it wrote any and they were clean. */
  note?: string;
}

/** Where or how to call something: the model has no business naming these. */
export const TECHNICAL_FIELDS = ['api_url', 'http_method', 'token_endpoint', 'oauth_scope', 'bridge_url', 'base_url', 'endpoint'] as const;
/** The same markers `prompt.ts` refuses on the way in, applied to the prose on the way out. */
export const NOTE_TECHNICAL_MARKERS = ['https://', 'http://', 'endpoint', 'base_url', 'oauth', 'bearer', 'token_url'] as const;
/** Long enough to explain a proposal; short enough that the note stays a note. */
export const NOTE_MAX_LENGTH = 1200;
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

  // The note is prose for a person and nothing else. One that names where or how to
  // call something is dropped whole rather than trimmed: a model that put a URL in its
  // explanation has done the thing RULE-09 forbids, and the warning says so.
  const note = typeof source.note === 'string' ? source.note.trim().slice(0, NOTE_MAX_LENGTH) : '';
  const marker = NOTE_TECHNICAL_MARKERS.find((candidate) => note.toLowerCase().includes(candidate));
  if (marker) warnings.push({ code: 'ai_output_contains_technical_field', field: 'note' });

  return { result: { capabilities, characteristics, confidence, ...(note !== '' && !marker ? { note } : {}) }, warnings };
}
