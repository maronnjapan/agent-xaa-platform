import { createFakeClient, type FakeResponder } from './fake-client.js';
import { createLiveClient, type LiveClientOptions } from './live-client.js';
import { createModelClient, readModelOptions } from './provider.js';

export { vertexResponseSchemaProblems } from './response-schema.js';
export { extractJson, jsonOnlyPrompt, validateAnswer } from './json-answer.js';
export { createAnthropicClient, type AnthropicClientOptions } from './anthropic-client.js';
export { createOpenAiClient, type OpenAiClientOptions } from './openai-client.js';
export { createCliClient, type CliClientOptions, type CliPreset } from './cli-client.js';
export {
  createModelClient, readModelOptions, ModelConfigurationError,
  type ModelClientOptions, type ModelProvider,
} from './provider.js';

export interface GenerateJsonParams {
  prompt: string;
  schema: object;
  maxOutputTokens: number;
  temperature: number;
}

export interface VertexClient {
  generateJson<T>(params: GenerateJsonParams): Promise<T | null>;
}

export interface CreateVertexClientOptions extends LiveClientOptions {
  mode: 'fake' | 'live';
  fakeResponder?: FakeResponder;
}

export function createVertexClient(options: CreateVertexClientOptions): VertexClient {
  return options.mode === 'fake' ? createFakeClient(options.fakeResponder) : createLiveClient(options);
}

let defaultClient: VertexClient | undefined;

/**
 * DEC-APP-10: the model, location and project all come from the deployment. There is
 * no application default for the model name, so a misconfigured deployment fails
 * loudly instead of silently calling a different model than Terraform declared.
 *
 * `MODEL_PROVIDER` is how a deployment names something other than Gemini (Anthropic,
 * an OpenAI-compatible endpoint, or a coding agent already installed on the machine).
 * It is read first and, when absent, nothing about this function changes: the Vertex
 * variables remain the contract, and a missing `VERTEX_MODEL` is still a loud failure
 * rather than a quiet call to some other model.
 */
function createDefaultClient(env: NodeJS.ProcessEnv): VertexClient {
  if (env.MODEL_PROVIDER) return createModelClient(readModelOptions(env));
  const model = env.VERTEX_MODEL;
  const project = env.PROJECT_ID;
  if (!model) throw new Error('VERTEX_MODEL is required');
  if (!project) throw new Error('PROJECT_ID is required');
  return createVertexClient({
    mode: env.VERTEX_MODE === 'fake' ? 'fake' : 'live',
    project,
    location: env.VERTEX_LOCATION ?? 'us-central1',
    model,
  });
}

export async function generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
  defaultClient ??= createDefaultClient(process.env);
  return defaultClient.generateJson<T>(params);
}

/**
 * Installs the client `generateJson` uses, for a composition root that builds one
 * itself rather than letting this module read the environment. The local runner does:
 * it runs every service in one process, so the model is configured once, in the open,
 * instead of by whichever service happened to ask first.
 */
export function setDefaultModelClient(client: VertexClient | undefined): void { defaultClient = client; }

export function resetDefaultVertexClientForTesting(): void { defaultClient = undefined; }
