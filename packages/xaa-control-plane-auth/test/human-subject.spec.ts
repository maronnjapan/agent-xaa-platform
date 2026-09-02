import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { humanSubjectMiddleware, type ControlPlaneVariables } from '../src/index.js';

const claims = { sub: 'user-123', aud: 'authorization-platform', scope: ['workdef:submit'], cnf: { jkt: 'thumb' }, jti: 'jti' };
describe('human subject middleware', () => {
  function app(emitter = vi.fn()) {
    const instance = new Hono<{ Variables: ControlPlaneVariables }>();
    instance.use('/x', async (context, next) => { context.set('accessToken', claims); await next(); });
    instance.use('/x', humanSubjectMiddleware({ protocolValidation: emitter }));
    instance.post('/x', (context) => context.json({ humanSubject: context.get('humanSubject'), body: context.get('validatedBody') }));
    return { instance, emitter };
  }
  it('rejects a mismatched subject and emits protocol validation', async () => {
    const { instance, emitter } = app();
    const response = await instance.request('/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ human_subject: 'user-456' }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'human_subject_mismatch' });
    expect(emitter).toHaveBeenCalledOnce();
    expect(emitter.mock.calls[0]![0]).toMatchObject({ validation: 'human_subject_mismatch', outcome: 'denied' });
  });
  it('injects the verified subject when omitted', async () => {
    const { instance } = app();
    const response = await instance.request('/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // The handler reads c.get('humanSubject') only; the body carried nothing to prefer.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ humanSubject: 'user-123' });
  });
});
