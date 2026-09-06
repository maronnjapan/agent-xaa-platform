import { createAnthropicClient } from './anthropic-client.js';
import { createCliClient, type CliPreset } from './cli-client.js';
import { createFakeClient, type FakeResponder } from './fake-client.js';
import { createLiveClient } from './live-client.js';
import { createOpenAiClient } from './openai-client.js';
import type { VertexClient } from './index.js';

/**
 * Which model answers, as a deployment chooses it.
 *
 * `vertex` is what GCP runs and what `VERTEX_MODE=live` has always meant. The other
 * three exist because the platform's decisions are not Gemini's to make: an operator
 * running this locally may have an Anthropic or OpenAI key, or only a coding agent
 * already installed on their machine, and none of that should change a line of the
 * applications that ask the question.
 */
export type ModelProvider = 'fake' | 'vertex' | 'anthropic' | 'openai' | 'cli';

export interface ModelClientOptions {
  provider: ModelProvider;
  /** The model name the provider is asked for; `vertex` requires one. */
  model: string;
  project?: string;
  location?: string;
  apiKey?: string;
  baseUrl?: string;
  cliPreset?: CliPreset;
  cliCommand?: string;
  cliArgs?: readonly string[];
  cliCwd?: string;
  cliTimeoutMs?: number;
  fakeResponder?: FakeResponder;
  fetchImpl?: typeof fetch;
}

export class ModelConfigurationError extends Error {}

const PROVIDERS: readonly ModelProvider[] = ['fake', 'vertex', 'anthropic', 'openai', 'cli'];
const CLI_PRESETS: readonly CliPreset[] = ['claude-code', 'codex', 'custom'];

export function createModelClient(options: ModelClientOptions): VertexClient {
  switch (options.provider) {
    case 'fake':
      return createFakeClient(options.fakeResponder);
    case 'vertex':
      if (!options.project) throw new ModelConfigurationError('PROJECT_ID is required for MODEL_PROVIDER=vertex');
      if (!options.model) throw new ModelConfigurationError('MODEL_NAME is required for MODEL_PROVIDER=vertex');
      return createLiveClient({ project: options.project, location: options.location ?? 'us-central1', model: options.model });
    case 'anthropic':
      if (!options.apiKey) throw new ModelConfigurationError('ANTHROPIC_API_KEY is required for MODEL_PROVIDER=anthropic');
      if (!options.model) throw new ModelConfigurationError('MODEL_NAME is required for MODEL_PROVIDER=anthropic');
      return createAnthropicClient({
        model: options.model, apiKey: options.apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    case 'openai':
      if (!options.apiKey) throw new ModelConfigurationError('OPENAI_API_KEY is required for MODEL_PROVIDER=openai');
      if (!options.model) throw new ModelConfigurationError('MODEL_NAME is required for MODEL_PROVIDER=openai');
      return createOpenAiClient({
        model: options.model, apiKey: options.apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    case 'cli': {
      const preset = options.cliPreset ?? 'claude-code';
      if (preset === 'custom' && !options.cliCommand) {
        throw new ModelConfigurationError('MODEL_CLI_COMMAND is required for MODEL_CLI=custom');
      }
      return createCliClient({
        preset,
        ...(options.model ? { model: options.model } : {}),
        ...(options.cliCommand ? { command: options.cliCommand } : {}),
        ...(options.cliArgs ? { args: options.cliArgs } : {}),
        ...(options.cliCwd ? { cwd: options.cliCwd } : {}),
        ...(options.cliTimeoutMs ? { timeoutMs: options.cliTimeoutMs } : {}),
      });
    }
  }
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) throw new ModelConfigurationError(`${name} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

/**
 * The deployment's model configuration, read once.
 *
 * `MODEL_PROVIDER` is the new name and the only one that can select something other
 * than Gemini. `VERTEX_MODE` stays authoritative when it is absent, so every existing
 * Terraform environment and every existing test keeps the client it had: `live` is
 * Vertex, anything else is the fake.
 */
export function readModelOptions(env: NodeJS.ProcessEnv): ModelClientOptions {
  const provider = oneOf('MODEL_PROVIDER', env.MODEL_PROVIDER, PROVIDERS)
    ?? (env.VERTEX_MODE === 'live' ? 'vertex' : 'fake');
  // `VERTEX_MODEL` holds a Gemini model name, so it stands in for `MODEL_NAME` only
  // where a Gemini name is what the provider wants. Letting it through to the others
  // would have `claude --model gemini-2.5-flash` on a deployment that named neither.
  const model = env.MODEL_NAME ?? (provider === 'vertex' || provider === 'fake' ? env.VERTEX_MODEL ?? '' : '');
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : undefined;
  const baseUrl = provider === 'anthropic' ? env.ANTHROPIC_BASE_URL : provider === 'openai' ? env.OPENAI_BASE_URL : undefined;
  const cliArgs = env.MODEL_CLI_ARGS === undefined || env.MODEL_CLI_ARGS === ''
    ? undefined
    : parseCliArgs(env.MODEL_CLI_ARGS);
  const timeout = Number(env.MODEL_CLI_TIMEOUT_MS ?? '');
  return {
    provider,
    model,
    ...(env.PROJECT_ID ? { project: env.PROJECT_ID } : {}),
    ...(env.VERTEX_LOCATION ? { location: env.VERTEX_LOCATION } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(oneOf('MODEL_CLI', env.MODEL_CLI, CLI_PRESETS) ? { cliPreset: oneOf('MODEL_CLI', env.MODEL_CLI, CLI_PRESETS)! } : {}),
    ...(env.MODEL_CLI_COMMAND ? { cliCommand: env.MODEL_CLI_COMMAND } : {}),
    ...(cliArgs ? { cliArgs } : {}),
    ...(env.MODEL_CLI_CWD ? { cliCwd: env.MODEL_CLI_CWD } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { cliTimeoutMs: timeout } : {}),
  };
}

function parseCliArgs(raw: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ModelConfigurationError('MODEL_CLI_ARGS must be a JSON array of strings'); }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new ModelConfigurationError('MODEL_CLI_ARGS must be a JSON array of strings');
  }
  return parsed as string[];
}
