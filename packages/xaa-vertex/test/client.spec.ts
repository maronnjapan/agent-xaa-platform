import { describe, expect, it } from 'vitest';
import { createVertexClient, generateJson, resetDefaultVertexClientForTesting } from '../src/index.js';

const schema = { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } };
describe('vertex client', () => {
  it('returns null on non-json response', async () => {
    const client = createVertexClient({ mode: 'fake', project: 'p', location: 'l', model: 'm', fakeResponder: () => 'not-json' });
    await expect(client.generateJson({ prompt: 'p', schema, maxOutputTokens: 10, temperature: 0 })).resolves.toBeNull();
  });
  it('validates fake structured output', async () => {
    const client = createVertexClient({ mode: 'fake', project: 'p', location: 'l', model: 'm', fakeResponder: () => ({ value: 'ok' }) });
    await expect(client.generateJson({ prompt: 'p', schema, maxOutputTokens: 10, temperature: 0 })).resolves.toEqual({ value: 'ok' });
  });

  /**
   * DEC-APP-10. The model is a deployment decision, so it arrives in `VERTEX_MODEL`
   * (00b: `VERTEX_MODEL_ID` was retired in favour of that name) and is handed to the
   * SDK unchanged. A caller cannot name a model, and there is no application default:
   * a deployment that forgot the variable fails loudly rather than quietly calling a
   * different model than Terraform declared.
   */
  it('asks the SDK for the model the deployment named', async () => {
    const asked: string[] = [];
    const model = 'gemini-x';
    const client = createVertexClient({
      mode: 'live', project: 'p', location: 'l', model,
      createSdk: () => ({
        getGenerativeModel: (options: { model: string }) => {
          asked.push(options.model);
          return { generateContent: async () => ({ response: { candidates: [] } }) };
        },
      }) as never,
    });
    await client.generateJson({ prompt: 'p', schema, maxOutputTokens: 10, temperature: 0 });
    expect(asked).toEqual(['gemini-x']);
  });

  it('takes that model from VERTEX_MODEL and has no default for it', async () => {
    resetDefaultVertexClientForTesting();
    const previous = process.env.VERTEX_MODEL;
    delete process.env.VERTEX_MODEL;
    try {
      await expect(generateJson({ prompt: 'p', schema, maxOutputTokens: 10, temperature: 0 }))
        .rejects.toThrow(/VERTEX_MODEL is required/);
    } finally {
      if (previous === undefined) delete process.env.VERTEX_MODEL; else process.env.VERTEX_MODEL = previous;
      resetDefaultVertexClientForTesting();
    }
  });
});
