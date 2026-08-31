export const DENY_FIELD_NAMES = [
  'access_token', 'id_jag', 'dpop_proof', 'subject_token', 'actor_token', 'refresh_token',
  'private_key', 'client_secret', 'code', 'authorization_code', 'client_assertion', 'assertion',
] as const;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

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
      output[key] = DENY_FIELD_NAMES.includes(key.toLowerCase() as (typeof DENY_FIELD_NAMES)[number])
        ? '[REDACTED]'
        : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}
