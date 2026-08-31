export class CheckpointSecretError extends Error {
  readonly code = 'checkpoint_secret';
  constructor(readonly key: string) { super(`checkpoint_secret: ${key}`); }
}

/**
 * Key names that must never carry a value into the checkpoint. `d` is the private
 * component of an EC JWK; `jwk` and `dpop` are the objects that would hold one.
 */
const DENY_KEYS = new Set([
  'access_token', 'refresh_token', 'id_token', 'id_jag', 'assertion', 'client_assertion',
  'client_secret', 'private_key', 'privatekey', 'd', 'jwk', 'dpop',
]);

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Two different failures, kept apart on purpose (REQ-07-019, REQ-05-092).
 *
 * A key object or a private JWK in the checkpoint is a programming error: something
 * handed the state writer a credential, and continuing would mean guessing which
 * other paths do the same. That throws.
 *
 * A token-shaped *string* is a data leak from a response body — plausible, recoverable,
 * and best handled by dropping the key and saying so. The agent keeps working; the
 * secret does not reach Firestore.
 */
/** Key material, as opposed to a value that merely looks sensitive. */
function secretKind(value: unknown): string | null {
  if (value instanceof CryptoKey) return 'CryptoKey';
  if (typeof value === 'function') return 'function';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.d === 'string' && typeof record.kty === 'string') return 'private jwk';
    if (typeof record.signCompactJws === 'function') return 'AgentClientKey';
  }
  return null;
}

export function sanitizeCheckpoint(value: unknown, warn: (event: { removed_keys: string[] }) => void): unknown {
  const removed: string[] = [];
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 12) return '[TRUNCATED]';
    const kind = secretKind(input);
    if (kind) throw new CheckpointSecretError(kind);
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input && typeof input === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        // The secret check runs before the denylist drop: a private JWK stored under
        // a denied key name is still a bug worth raising, not something to swallow.
        const itemKind = secretKind(item);
        if (itemKind) throw new CheckpointSecretError(itemKind);
        if (DENY_KEYS.has(key.toLowerCase())) { removed.push(key); continue; }
        if (typeof item === 'string' && JWT_SHAPE.test(item)) { removed.push(key); continue; }
        output[key] = walk(item, depth + 1);
      }
      return output;
    }
    return input;
  };
  const sanitized = walk(value, 0);
  if (removed.length > 0) warn({ removed_keys: removed });
  return sanitized;
}
