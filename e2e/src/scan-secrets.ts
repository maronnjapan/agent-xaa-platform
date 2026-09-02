import { DENY_FIELD_NAMES } from '@xaa/logging';

export interface Violation {
  /** Which check matched — never the value that matched it. */
  rule: 'compact_jws' | 'private_key' | 'deny_field';
  app: string;
  event: string;
  trace_id: string;
  /** For `deny_field`, the key whose value was not redacted. */
  field?: string;
}

const COMPACT_JWS = /eyJ[A-Za-z0-9_-]{10,}/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** What a redacted value looks like once the logger has been through it. */
const REDACTED = new Set(['[REDACTED]', '[TRUNCATED]', '']);

/**
 * The three ways a secret reaches a log line, checked over collected output.
 *
 * The redactor runs inside the logger, so this only fires when something wrote a line
 * another way — which is exactly the case a library-level test cannot see. Split out of
 * the spec so the same function runs over a file collected from BigQuery and over stdout
 * captured in process, rather than two checks that agree until they do not.
 *
 * A violation names the check, the app, the event and the trace, and nothing else: an
 * assertion message that quoted the offending line would put the secret into CI output,
 * which is where the failure would be read by the most people.
 */
export function scanSecrets(lines: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A line that is not JSON never came from the shared logger; scan it as text.
      if (COMPACT_JWS.test(line)) violations.push(where('compact_jws', {}));
      if (PRIVATE_KEY.test(line)) violations.push(where('private_key', {}));
      continue;
    }
    const serialized = JSON.stringify(entry);
    if (COMPACT_JWS.test(serialized)) violations.push(where('compact_jws', entry));
    if (PRIVATE_KEY.test(serialized)) violations.push(where('private_key', entry));
    for (const field of unredactedDenyFields(entry)) {
      violations.push({ ...where('deny_field', entry), field });
    }
  }
  return violations;
}

/** Deny-list keys that still carry a value, wherever in the line they appear. */
function unredactedDenyFields(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) unredactedDenyFields(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    if ((DENY_FIELD_NAMES as readonly string[]).includes(key.toLowerCase())) {
      if (typeof item === 'string' && !REDACTED.has(item)) found.push(key);
    }
    unredactedDenyFields(item, found);
  }
  return found;
}

function where(rule: Violation['rule'], entry: Record<string, unknown>): Violation {
  return {
    rule,
    app: typeof entry.app === 'string' ? entry.app : 'unknown',
    event: typeof entry.event === 'string' ? entry.event : 'unknown',
    trace_id: typeof entry.trace_id === 'string' ? entry.trace_id : '',
  };
}

/** One line per violation, safe to print: no captured text, only where to look. */
export function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map((violation) => `${violation.rule} in ${violation.app}/${violation.event} trace=${violation.trace_id}${violation.field ? ` field=${violation.field}` : ''}`)
    .join('\n');
}
