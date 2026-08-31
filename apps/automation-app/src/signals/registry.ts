/**
 * One source, named once.
 *
 * The registry exists so the set of places work signals can come from is visible in a
 * single line. Adding a SaaS source means adding it here, which means someone has to
 * look at this comment first.
 */
export const SIGNAL_SOURCES = ['document-rs'] as const;
export type SignalSourceId = (typeof SIGNAL_SOURCES)[number];
