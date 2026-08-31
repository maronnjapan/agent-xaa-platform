import { DENY_FIELD_NAMES, redact } from './redact.js';
import { tokenFingerprint } from './fingerprint.js';

function decodeJsonPart(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function attachCorrelationKeys(fields: Record<string, unknown>): Record<string, unknown> {
  const output = redact(fields) as Record<string, unknown>;
  for (const [name, raw] of Object.entries(fields)) {
    if (!DENY_FIELD_NAMES.includes(name.toLowerCase() as (typeof DENY_FIELD_NAMES)[number]) || typeof raw !== 'string') continue;
    output[name] = '[REDACTED]';
    output[`${name}_fingerprint`] = tokenFingerprint(raw);
    const parts = raw.split('.');
    if (parts.length !== 3) continue;
    const header = decodeJsonPart(parts[0]!);
    const payload = decodeJsonPart(parts[1]!);
    if (!header || !payload) {
      output[`${name}_parse_error`] = true;
      continue;
    }
    for (const key of ['kid', 'typ', 'alg'] as const) if (typeof header[key] === 'string') output[`${name}_${key}`] = header[key];
    for (const key of ['jti', 'iss', 'aud', 'sub'] as const) if (typeof payload[key] === 'string' || Array.isArray(payload[key])) output[`${name}_${key}`] = payload[key];
    const cnf = payload.cnf;
    if (cnf && typeof cnf === 'object' && typeof (cnf as Record<string, unknown>).jkt === 'string') output[`${name}_jkt`] = (cnf as Record<string, unknown>).jkt;
  }
  return output;
}
