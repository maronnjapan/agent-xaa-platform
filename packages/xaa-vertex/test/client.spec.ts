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

  /**
   * `responseSchema` is an OpenAPI subset. Vertex answered a schema carrying `$id` with
   * `400 Unknown name "$id"`, `generateContent` threw, the catch above turned it into
   * `null`, and the Authorization Platform recorded `no_capability_inferred` for a
   * request the model never saw — every decision, for every work definition. Ajv still
   * validates against the schema as written, so what is dropped here is provenance and
   * not a constraint.
   */
  it('sends Vertex a schema with no $ keywords, and still validates against the original', async () => {
    let sent: Record<string, unknown> | undefined;
    const identified = {
      $id: 'named-result',
      type: 'object', additionalProperties: false, required: ['value'],
      properties: { value: { type: 'string' }, nested: { $id: 'inner', type: 'object', properties: { deep: { type: 'string' } } } },
    };
    const client = createVertexClient({
      mode: 'live', project: 'p', location: 'l', model: 'm',
      createSdk: () => ({
        getGenerativeModel: () => ({
          generateContent: async (request: { generationConfig: { responseSchema: Record<string, unknown> } }) => {
            sent = request.generationConfig.responseSchema;
            return { response: { candidates: [{ content: { parts: [{ text: '{"value":"ok"}' }] } }] } };
          },
        }),
      }) as never,
    });

    await expect(client.generateJson({ prompt: 'p', schema: identified, maxOutputTokens: 10, temperature: 0 }))
      .resolves.toEqual({ value: 'ok' });
    expect(JSON.stringify(sent)).not.toContain('$id');
    // Everything that constrains the answer survives, at every depth.
    expect(sent).toEqual({
      type: 'object', additionalProperties: false, required: ['value'],
      properties: { value: { type: 'string' }, nested: { type: 'object', properties: { deep: { type: 'string' } } } },
    });
    // And the caller's own schema is untouched, because it is the platform's contract.
    expect(identified.$id).toBe('named-result');
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
