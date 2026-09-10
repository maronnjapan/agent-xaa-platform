import { resolve } from 'node:path';
import { readModelOptions, type ModelClientOptions } from '@xaa/model';
import { createTopology, type LocalTopology } from './topology.js';

/**
 * When the seed runs.
 *
 * `auto` is the default and the only one that reads the state: the seed writes the
 * catalogue, the taxonomy and who holds which permission, and re-running it replaces
 * all three — so on a platform whose state was carried over it would undo the
 * permissions an administrator granted since. It runs when there is nothing to undo.
 */
export const SEED_MODES = ['auto', 'always', 'never'] as const;
export type SeedMode = (typeof SEED_MODES)[number];

/** Where a run keeps its state when `LOCAL_STATE_DIR` says nothing, relative to the cwd. */
export const DEFAULT_STATE_DIR = '.local/state';

export interface LocalRunnerConfig {
  topology: LocalTopology;
  model: ModelClientOptions;
  /** Who reaches the four admin consoles; empty leaves them reachable by nobody. */
  adminPrincipals: string[];
  /** How often the Lifecycle Manager's tick fires, in milliseconds. */
  lifecycleTickMs: number;
  /** What Cloud Run's scheduling latency stands as, before an Execution's first step. */
  executionStartDelayMs: number;
  /** Where the run keeps its state, or undefined when it keeps none. */
  stateDir: string | undefined;
  /** When the seed runs. */
  seed: SeedMode;
  /** Prints nothing but errors: no banner, and no structured log lines on stdout. */
  quiet: boolean;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * `LOCAL_SEED` still takes the two words it always took, and means by them what it
 * always meant: `true` seeds this run, `false` seeds no run. Unset now means `auto`
 * rather than `true`, because a platform that keeps its state has something to lose.
 */
function seedMode(value: string | undefined): SeedMode {
  const normalized = (value ?? '').trim();
  if (normalized === '' || normalized === 'auto') return 'auto';
  if (normalized === 'true' || normalized === '1') return 'always';
  if (normalized === 'false' || normalized === '0') return 'never';
  return (SEED_MODES as readonly string[]).includes(normalized) ? normalized as SeedMode : 'auto';
}

function nonNegative(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * What an operator can change about a local run, and nothing more.
 *
 * The list is short on purpose. Everything the deployed platform reads from Terraform
 * is derived in `topology.ts` from one host and one port map, because a local platform
 * whose forty environment variables had to be set by hand would be a second deployment
 * contract to keep in step with the first. What is left here is what genuinely differs
 * between one machine and another: which model answers, whether the optional Bridge is
 * on, and how loud the run is.
 */
export function loadLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalRunnerConfig {
  const topology = createTopology({
    ...(env.LOCAL_HOST ? { host: env.LOCAL_HOST } : {}),
    bridgeEnabled: flag(env.LOCAL_ENABLE_GOOGLE_BRIDGE, false),
    agentMaxLifetimeSeconds: positive(env.AGENT_MAX_LIFETIME_SECONDS, 86_400),
    portOffset: nonNegative(env.LOCAL_PORT_OFFSET, 0),
    ...(env.PROJECT_ID ? { projectId: env.PROJECT_ID } : {}),
    ...(env.VERTEX_MODEL ? { vertexModel: env.VERTEX_MODEL } : {}),
  });
  return {
    topology,
    // `MODEL_PROVIDER` unset means the fake model, because that is the only provider
    // that needs nothing installed and no key: a first run works, and shows what the
    // platform does with a model that answers nothing.
    //
    // The environment is read as it stands, without the topology's stand-in name behind
    // it. Substituting that would make `MODEL_PROVIDER=vertex` with no `MODEL_NAME` call
    // whichever model the stand-in happened to be, where `createModelClient` otherwise
    // refuses to build the client and says which variable is missing.
    model: readModelOptions(env),
    adminPrincipals: (env.ADMIN_PRINCIPALS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    lifecycleTickMs: positive(env.LOCAL_LIFECYCLE_TICK_MS, 300_000),
    // Zero is a value somebody may mean here — "start the Execution at once" — so it
    // cannot share the "unset or nonsense" branch every other number falls back through.
    executionStartDelayMs: nonNegative(env.LOCAL_EXECUTION_START_DELAY_MS, 3_000),
    stateDir: flag(env.LOCAL_PERSIST, true) ? resolve(env.LOCAL_STATE_DIR?.trim() || DEFAULT_STATE_DIR) : undefined,
    seed: seedMode(env.LOCAL_SEED),
    quiet: flag(env.LOCAL_QUIET, false),
  };
}
