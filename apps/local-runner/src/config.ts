import { readModelOptions, type ModelClientOptions } from '@xaa/vertex';
import { createTopology, type LocalTopology } from './topology.js';

export interface LocalRunnerConfig {
  topology: LocalTopology;
  model: ModelClientOptions;
  /** Who reaches the four admin consoles; empty leaves them reachable by nobody. */
  adminPrincipals: string[];
  /** How often the Lifecycle Manager's tick fires, in milliseconds. */
  lifecycleTickMs: number;
  /** What Cloud Run's scheduling latency stands as, before an Execution's first step. */
  executionStartDelayMs: number;
  /** Runs the seed at startup. Off leaves whatever the previous run wrote. */
  seed: boolean;
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
    seed: flag(env.LOCAL_SEED, true),
    quiet: flag(env.LOCAL_QUIET, false),
  };
}
