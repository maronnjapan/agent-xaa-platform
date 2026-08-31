import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_SCENARIOS = [
  'delegation-mismatch', 'signing-key-misuse', 'cross-agent-isolation', 'dpop-replay',
] as const;

export type ScenarioId = (typeof ALLOWED_SCENARIOS)[number];

/**
 * Finds `demo-scenarios/` by walking up from this module.
 *
 * The directory sits at the repository root so the scripts can be reviewed alongside
 * the docs they illustrate, and the walk keeps the same code working from `src` and
 * from `dist`, whose depths differ.
 */
function scenarioDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let step = 0; step < 8; step += 1) {
    try {
      readFileSync(join(directory, 'demo-scenarios', 'dpop-replay.json'));
      return join(directory, 'demo-scenarios');
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error('demo-scenarios directory not found');
}

/**
 * Four scripts, read once, by name.
 *
 * The four demonstrations that are dangerous to stage for real — a forged delegation,
 * a misused signing key, one agent reaching another's data, a replayed proof — are
 * shown from recorded event lists instead. Every name is a literal in this file and
 * the table is frozen, so a `scenario_id` from a request is only ever a key lookup;
 * it never becomes part of a path (DEC-DEMO-01).
 */
export const SCENARIOS: Readonly<Record<ScenarioId, unknown[]>> = Object.freeze(
  Object.fromEntries(ALLOWED_SCENARIOS.map((id) => [
    id, JSON.parse(readFileSync(join(scenarioDirectory(), `${id}.json`), 'utf8')) as unknown[],
  ])) as Record<ScenarioId, unknown[]>,
);

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (ALLOWED_SCENARIOS as readonly string[]).includes(value);
}
