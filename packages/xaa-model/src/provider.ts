import { createFakeClient, createVertexClient, type FakeResponder, type VertexClient } from '@xaa/vertex';
import { createCliClient, type CliPreset } from './cli-client.js';
import {
  createLangChainClient, isLangChainProvider, LANGCHAIN_PROVIDERS, LANGCHAIN_PROVIDER_NAMES,
  type LangChainProvider,
} from './langchain-client.js';

/**
 * Which model answers, as a deployment chooses it.
 *
 * `vertex` is what GCP runs and what `VERTEX_MODE=live` has always meant, and it keeps
 * its own client in `@xaa/vertex`. Everything else is either a model LangChain reaches
 * (`LANGCHAIN_PROVIDER_NAMES`) or a coding agent already installed on the machine, and
 * none of it changes a line of the applications that ask the question.
 */
export type ModelProvider = 'fake' | 'vertex' | LangChainProvider | 'cli';

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
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

export class ModelConfigurationError extends Error {}

const PROVIDERS: readonly ModelProvider[] = ['fake', 'vertex', ...LANGCHAIN_PROVIDER_NAMES, 'cli'];
const CLI_PRESETS: readonly CliPreset[] = ['claude-code', 'codex', 'custom'];

export function createModelClient(options: ModelClientOptions): VertexClient {
  const provider = options.provider;
  if (provider === 'fake') return createFakeClient(options.fakeResponder);

  if (provider === 'vertex') {
    if (!options.project) throw new ModelConfigurationError('PROJECT_ID is required for MODEL_PROVIDER=vertex');
    if (!options.model) throw new ModelConfigurationError('MODEL_NAME is required for MODEL_PROVIDER=vertex');
    return createVertexClient({ mode: 'live', project: options.project, location: options.location ?? 'us-central1', model: options.model });
  }

  if (provider === 'cli') {
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

  // Every remaining provider is one LangChain reaches, and each names the variable it
  // wants its credential in. The message therefore comes from the table rather than from
  // a branch per provider, so a provider added to the table is refused by name too.
  const definition = LANGCHAIN_PROVIDERS[provider];
  if (!options.apiKey) throw new ModelConfigurationError(`${definition.apiKeyEnv} is required for MODEL_PROVIDER=${provider}`);
  if (!options.model) throw new ModelConfigurationError(`MODEL_NAME is required for MODEL_PROVIDER=${provider}`);
  return createLangChainClient({
    provider, model: options.model, apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
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
  // would have `claude --model` pointed at a Gemini one on a deployment that named
  // neither.
  const model = env.MODEL_NAME ?? (provider === 'vertex' || provider === 'fake' ? env.VERTEX_MODEL ?? '' : '');
  // Which variable holds the credential is the provider's own answer, so a provider
  // added to the table brings its variable names with it rather than adding a branch.
  const credential = isLangChainProvider(provider) ? LANGCHAIN_PROVIDERS[provider] : undefined;
  const apiKey = credential ? env[credential.apiKeyEnv] : undefined;
  const baseUrl = credential ? env[credential.baseUrlEnv] : undefined;
  const cliArgs = env.MODEL_CLI_ARGS === undefined || env.MODEL_CLI_ARGS === ''
    ? undefined
    : parseCliArgs(env.MODEL_CLI_ARGS);
  const cliPreset = oneOf('MODEL_CLI', env.MODEL_CLI, CLI_PRESETS);
  const timeout = Number(env.MODEL_CLI_TIMEOUT_MS ?? '');
  return {
    provider,
    model,
    ...(env.PROJECT_ID ? { project: env.PROJECT_ID } : {}),
    ...(env.VERTEX_LOCATION ? { location: env.VERTEX_LOCATION } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(cliPreset ? { cliPreset } : {}),
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
