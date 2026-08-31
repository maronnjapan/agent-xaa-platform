import { describe, expect, it } from 'vitest';
import { createVertexClient } from '../src/index.js';

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
});
