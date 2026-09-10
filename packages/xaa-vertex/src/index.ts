import { createFakeClient, type FakeResponder } from './fake-client.js';
import { createLiveClient, type LiveClientOptions } from './live-client.js';

export { vertexResponseSchemaProblems } from './response-schema.js';
export { createFakeClient, type FakeResponder } from './fake-client.js';

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
 * The models a deployed image can reach: Vertex, and the fake that answers nothing.
 *
 * DEC-APP-10: the model, location and project all come from the deployment. There is
 * no application default for the model name, so a misconfigured deployment fails
 * loudly instead of silently calling a different model than Terraform declared.
 *
 * Every other model the platform can be pointed at — Anthropic, OpenAI, anything that
 * speaks either API, a coding agent on the machine — lives in `@xaa/model`, which no
 * image installs. A run that names one of those in `MODEL_PROVIDER` is refused here
 * rather than answered by Vertex, because a container that quietly called Gemini for a
 * deployment that asked for Claude would be the failure DEC-APP-10 exists to prevent.
 * The local runner reads the same variable, builds the client and installs it with
 * `setDefaultModelClient`, so this function never runs there.
 */
function createDefaultClient(env: NodeJS.ProcessEnv): VertexClient {
  const provider = env.MODEL_PROVIDER;
  if (provider !== undefined && provider !== '' && provider !== 'vertex' && provider !== 'fake') {
    throw new Error(`MODEL_PROVIDER=${provider} is not available here: only vertex and fake are, and the rest are installed by the local runner from @xaa/model`);
  }
  const model = env.VERTEX_MODEL;
  const project = env.PROJECT_ID;
  if (!model) throw new Error('VERTEX_MODEL is required');
  if (!project) throw new Error('PROJECT_ID is required');
  return createVertexClient({
    mode: provider === 'fake' || env.VERTEX_MODE === 'fake' ? 'fake' : 'live',
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
 * instead of by whichever service happened to ask first. It is also how a model that is
 * not Vertex reaches the applications at all, since only `@xaa/model` can build one.
 */
export function setDefaultModelClient(client: VertexClient | undefined): void { defaultClient = client; }

export function resetDefaultVertexClientForTesting(): void { defaultClient = undefined; }
