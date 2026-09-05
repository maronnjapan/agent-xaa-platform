export const DENY_FIELD_NAMES = [
  'access_token', 'id_jag', 'dpop_proof', 'subject_token', 'actor_token', 'refresh_token',
  'private_key', 'client_secret', 'code', 'authorization_code', 'client_assertion', 'assertion',
] as const;

/**
 * Identifiers, not secrets. They are high-entropy by design and the detection
 * queries join on them (T-RES-10, T-OP-32), so the entropy heuristic must not eat
 * them. Knowing a jti or a thumbprint grants nothing on its own.
 */
export const IDENTIFIER_FIELD_NAMES = [
  'jti', 'idjag_jti', 'actor_token_jti', 'kid', 'idjag_kid', 'received_kid', 'issued_kid',
  'jkt', 'cnf_jkt', 'issued_jkt', 'act_sub', 'idjag_act_sub', 'id_jag_act', 'actor_token_sub',
  'agent_id', 'op_agent_id', 'human_subject', 'subject_token_sub', 'idjag_sub', 'id_jag_sub',
  // RULE-46's two subjects of an approval. They are the same kind of value as
  // `human_subject` and `act_sub`; redacting them would leave the approval audit
  // line unable to answer who approved the payment (REQ-09-012).
  'approved_by', 'approved_by_agent',
  'trace_id', 'request_id', 'span_id', 'grant_id', 'document_id', 'payment_id',
  'idp_connection_id', 'connection_id', 'binding_id', 'transaction_id', 'decision_id',
  // `<app>:<route template>` (T-SEC-12). A long template crosses the entropy threshold
  // and was blanked, which left the detection side unable to say where a refusal
  // happened. It names a route, never a value.
  'path', 'validation_name', 'resource', 'requested_resource', 'target_resource', 'audience', 'requested_audience',
  'issued_jti', 'task_id', 'execution_id', 'work_definition_hash', 'fingerprint',
  // What the confirmation binding compared. A thumbprint is 43 base64url characters
  // and a token endpoint URL is about as long, so both cross the entropy threshold
  // and were blanked — which left `dpop_key_binding_mismatch` unable to say whether
  // the key was wrong or the two sides disagreed about the endpoint. Neither is a
  // secret: the first is derived from a public key, the second is a URL.
  'dpop_binding_step', 'expected_jkt', 'presented_jkt', 'expected_htu', 'presented_htu',
] as const;

const IDENTIFIERS = new Set<string>(IDENTIFIER_FIELD_NAMES);

/**
 * A compact JWS, not merely a dotted string: the header segment of a real one always
 * begins `eyJ`, because it is base64url of a JSON object. Matching on dots alone
 * redacted ordinary identifiers such as `internal.document.get`, which the detection
 * queries need to read.
 */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function redactString(value: string): string {
  if (JWT_SHAPE.test(value) || (value.length >= 40 && shannonEntropy(value) >= 3.5)) return '[REDACTED]';
  return value;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const name = key.toLowerCase();
      if (DENY_FIELD_NAMES.includes(name as (typeof DENY_FIELD_NAMES)[number])) {
        output[key] = '[REDACTED]';
      } else if (IDENTIFIERS.has(name) && typeof item === 'string') {
        // Still refuse a compact JWS here: an identifier field holding a whole
        // token is a bug, and passing it through would defeat RULE-38.
        output[key] = JWT_SHAPE.test(item) ? '[REDACTED]' : item;
      } else {
        output[key] = redact(item, depth + 1);
      }
    }
    return output;
  }
  return value;
}
