import { LOG_SOURCES, type LogSource } from '@xaa/logging';

/**
 * One numeric class per log source, in the order docs 09 §2 lists them.
 *
 * The numbers are OCSF-shaped rather than OCSF-conformant: the field names are what a
 * SIEM needs to read the stream, and inventing a full class hierarchy would be work
 * nobody is asking for. Keeping the map in one place means a new source gets a number
 * by editing one line.
 */
export const CLASS_UID_BASE = 6001;
export const UNMAPPED_CLASS_UID = 6999;

export const CLASS_UID: Readonly<Record<LogSource, number>> = Object.freeze(
  Object.fromEntries(LOG_SOURCES.map((source, index) => [source, CLASS_UID_BASE + index])) as Record<LogSource, number>,
);

export function isKnownSource(value: unknown): value is LogSource {
  return typeof value === 'string' && (LOG_SOURCES as readonly string[]).includes(value);
}
