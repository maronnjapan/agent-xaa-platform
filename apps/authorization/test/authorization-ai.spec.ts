import { describe, expect, it, vi } from 'vitest';
import { compile, SchemaValidationError } from '@xaa/contracts';
import { createVertexClient } from '@xaa/vertex';
import { authorizationAiResultSchema, inferCapabilities } from '../src/ai/authorization-ai.js';

const assertAiResult = compile(authorizationAiResultSchema);

const taxonomy = [
  { capability_id: 'calendar.event.read', description: '予定を読む' },
  { capability_id: 'mail.message.send', description: 'メールを送る' },
];

const stub = {
  capabilities: ['calendar.event.read', 'mail.message.send'],
  characteristics: { write_operation: false, external_communication: true },
  confidence: 0.8,
};

/**
 * REQ-03-005. The model answers under a fixed schema, and what comes back is three
 * fields: what it proposes, what it says the work is like, and how sure it is. A
 * verdict, an endpoint or an isolation level in that answer is not part of the
 * contract, so the schema is what a stubbed answer is measured against too.
 */
describe('the Authorization AI result contract', () => {
  it('accepts the stub answer the fake model gives', () => {
    expect(() => assertAiResult(stub)).not.toThrow();
  });

  it('refuses an answer that also decides', () => {
    expect(() => assertAiResult({ ...stub, isolation_level: 'standard' })).toThrow(SchemaValidationError);
    expect(() => assertAiResult({ ...stub, api_url: 'https://calendar.example/api' })).toThrow(SchemaValidationError);
    expect(() => assertAiResult({ ...stub, confidence: 1.5 })).toThrow(SchemaValidationError);
  });

  it('keeps what the guard hands on inside the same contract', async () => {
    const vertex = createVertexClient({ mode: 'fake', project: 'p', location: 'l', model: 'm', fakeResponder: () => stub });
    const result = await inferCapabilities({ description: '予定を整理する', operations: ['read_events'], taxonomy }, { vertex });
    expect(() => assertAiResult(result)).not.toThrow();
    expect(result.capabilities).toEqual(stub.capabilities);
  });

  /**
   * VERTEX_MODE=fake has to be a model that is not there, not a model reached over a
   * different route: a test suite that quietly talks to Vertex AI would bill, flake
   * and — worse — make the platform's "no external call in tests" claim untrue.
   */
  it('makes no network call in fake mode', async () => {
    const fetchSpy = vi.fn(async () => Response.json({}));
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const vertex = createVertexClient({ mode: 'fake', project: 'p', location: 'l', model: 'm', fakeResponder: () => stub });
      await inferCapabilities({ description: '予定を整理する', operations: ['read_events'], taxonomy }, { vertex });
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
