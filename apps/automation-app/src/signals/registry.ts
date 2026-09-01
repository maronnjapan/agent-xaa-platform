import { createDocumentRsSource } from './document-rs-source.js';
import type { WorkSignalSource } from './work-signal-source.js';

/**
 * One source, named once.
 *
 * The registry exists so the set of places work signals can come from is visible in a
 * single line. Adding a SaaS source means adding it here, which means someone has to
 * look at this comment first.
 */
export const SIGNAL_SOURCES = ['document-rs'] as const;
export type SignalSourceId = (typeof SIGNAL_SOURCES)[number];

export interface SignalSourceOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  authorization(): Promise<string>;
  withBody?: boolean;
}

/**
 * Resolves an id from the list above to the implementation behind it.
 *
 * The app asks for a source by id rather than importing one, so the list and what runs
 * cannot drift: an id with no branch here fails to compile, and an implementation
 * nobody listed is unreachable.
 */
export function createSignalSource(id: SignalSourceId, options: SignalSourceOptions): WorkSignalSource {
  switch (id) {
    case 'document-rs':
      return createDocumentRsSource(options);
    default: {
      const unreachable: never = id;
      throw new Error(`unknown signal source: ${String(unreachable)}`);
    }
  }
}
