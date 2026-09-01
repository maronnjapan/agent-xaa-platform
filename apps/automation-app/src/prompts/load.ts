import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads a prompt from the file next to this module, or from the source tree above it.
 *
 * The prompt is a file rather than a string literal so that someone reviewing what the
 * model is told can read it as prose, and so a change to the wording is a change to a
 * document rather than to code. The build copies the `.md` alongside the compiled
 * module; the walk upwards covers a tree where only `tsc` has run.
 *
 * A missing file throws rather than falling back to an empty instruction. A server
 * that answered with `{{signals}}` alone would still return suggestions, and nobody
 * would notice that the constraints had stopped being sent.
 */
export function loadPrompt(name: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let step = 0; step < 8; step += 1) {
    for (const candidate of [join(directory, name), join(directory, 'src', 'prompts', name)]) {
      try {
        return readFileSync(candidate, 'utf8');
      } catch {
        // Not here; keep climbing.
      }
    }
    directory = dirname(directory);
  }
  throw new Error(`prompt not found: ${name}`);
}

export const SUGGESTION_PROMPT_FILE = 'suggestion.md';

export function loadSuggestionPrompt(): string {
  return loadPrompt(SUGGESTION_PROMPT_FILE);
}
