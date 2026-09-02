import { CONTROL_PLANE_EVENT_FIELDS } from '../events/control-plane.js';
import { IDENTITY_EVENT_FIELDS } from '../events/identity.js';
import { assertLogEntry } from '../logger.js';

/**
 * The ten rows of docs 09 §2, as one lookup.
 *
 * T-SEC-05 and T-SEC-06 own five rows each, but a test only knows the name of the event
 * it provoked, never which half of the table declared it.
 */
export const EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ...IDENTITY_EVENT_FIELDS,
  ...CONTROL_PLANE_EVENT_FIELDS,
};

export class LogFieldsMissing extends Error {}

/** A compact JWS: base64url of a JSON header always begins `eyJ`. */
const COMPACT_JWS = /^eyJ[A-Za-z0-9_-]{4,}\./;

/**
 * Asserts that one captured stdout line carries everything the detection side reads.
 *
 * It throws rather than calling a test framework, so the helper can live beside the
 * field table it checks against instead of being copied into each application's test
 * directory. A missing field is not cosmetic: the rules and the saved SQL read these
 * names and nothing else, so a dropped key is a detection that stops matching in
 * silence (T-SEC-05).
 *
 * The same pass refuses any value shaped like a compact JWS, which is the other half of
 * the same contract — the line must be complete, and it must carry no raw token.
 */
export function expectLogFields(line: string, eventName: string): Record<string, unknown> {
  const required = EVENT_FIELDS[eventName];
  if (!required) throw new LogFieldsMissing(`no field table declares ${eventName}`);

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    throw new LogFieldsMissing(`${eventName} did not write one JSON line`);
  }
  try {
    assertLogEntry(entry);
  } catch {
    throw new LogFieldsMissing(`${eventName} did not write the shared envelope`);
  }

  const missing = required.filter((field) => !(field in entry.fields));
  if (missing.length > 0) throw new LogFieldsMissing(`${eventName} is missing ${missing.join(', ')}`);

  expectNoRawToken(entry.fields, eventName);
  return entry.fields;
}

/**
 * No value anywhere in the line may be a compact JWS (T-SEC-05, RULE-38).
 *
 * Walks the whole `fields` map rather than the declared keys: the leak that matters is
 * the one under a name nobody wrote down.
 */
export function expectNoRawToken(value: unknown, where: string): void {
  if (typeof value === 'string') {
    if (COMPACT_JWS.test(value)) throw new LogFieldsMissing(`${where} carries a raw token`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) expectNoRawToken(item, where);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) expectNoRawToken(item, `${where}.${key}`);
  }
}
