import { createFakeClient, type FakeResponder } from './fake-client.js';
import { createLiveClient, type LiveClientOptions } from './live-client.js';

export { vertexResponseSchemaProblems } from './response-schema.js';

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
 */
export async function generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
  if (defaultClient === undefined) {
    const model = process.env.VERTEX_MODEL;
    const project = process.env.PROJECT_ID;
    if (!model) throw new Error('VERTEX_MODEL is required');
    if (!project) throw new Error('PROJECT_ID is required');
    defaultClient = createVertexClient({
      mode: process.env.VERTEX_MODE === 'fake' ? 'fake' : 'live',
      project,
      location: process.env.VERTEX_LOCATION ?? 'us-central1',
      model,
    });
  }
  return defaultClient.generateJson<T>(params);
}

export function resetDefaultVertexClientForTesting(): void { defaultClient = undefined; }
