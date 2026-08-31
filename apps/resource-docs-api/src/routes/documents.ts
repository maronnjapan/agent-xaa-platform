import { Hono } from 'hono';
import { compile, documentCreateSchema, documentPatchSchema, SchemaValidationError } from '@xaa/contracts';
import type { XaaResourceContext } from '@xaa/resource-guard';
import { VersionConflict, type createDocumentRepository } from '../store/documents.js';

type Env = { Variables: { xaa: XaaResourceContext } };

type CreateInput = { type: string; title: string; body: string; occurred_at: string; metadata?: Record<string, unknown> };
type PatchInput = { version: number; title?: string; body?: string };
const assertCreate: (value: unknown) => asserts value is CreateInput = compile<CreateInput>(documentCreateSchema);
const assertPatch: (value: unknown) => asserts value is PatchInput = compile<PatchInput>(documentPatchSchema);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Routes carry their operation name statically; it is never derived from the path. */
export const DOCUMENT_OPERATIONS = {
  list: 'document.list', get: 'document.get', create: 'document.create', update: 'document.update',
} as const;

export function createDocumentRoutes(repository: ReturnType<typeof createDocumentRepository>): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/', async (context) => {
    const limit = Number(context.req.query('limit') ?? DEFAULT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return context.json({ error: 'invalid_request' }, 400);
    return context.json({
      documents: await repository.list({
        ownerSubject: context.get('xaa').humanSubject,
        ...(context.req.query('type') ? { type: context.req.query('type')! } : {}),
        ...(context.req.query('from') ? { from: context.req.query('from')! } : {}),
        ...(context.req.query('to') ? { to: context.req.query('to')! } : {}),
        limit,
      }),
    });
  });

  app.get('/:id', async (context) => {
    const document = await repository.get(context.req.param('id'), context.get('xaa').humanSubject);
    // Another owner's document is 404, not 403: a 403 would confirm it exists.
    if (!document) return context.json({ error: 'not_found' }, 404);
    return context.json(document);
  });

  app.post('/', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
      assertCreate(body);
    } catch (error) {
      if (error instanceof SchemaValidationError || error instanceof SyntaxError) return context.json({ error: 'invalid_request' }, 400);
      throw error;
    }
    const input = body as CreateInput;
    const documentId = await repository.create({
      ownerSubject: context.get('xaa').humanSubject,
      type: input.type, title: input.title, body: input.body, occurredAt: input.occurred_at,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return context.json({ document_id: documentId }, 201);
  });

  app.patch('/:id', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
      assertPatch(body);
    } catch (error) {
      if (error instanceof SchemaValidationError || error instanceof SyntaxError) return context.json({ error: 'invalid_request' }, 400);
      throw error;
    }
    const patch = body as PatchInput;
    try {
      const updated = await repository.update(context.req.param('id'), context.get('xaa').humanSubject, patch);
      if (!updated) return context.json({ error: 'not_found' }, 404);
      return context.json({ document_id: updated.document_id, version: updated.version, updated_at: updated.updated_at });
    } catch (error) {
      if (error instanceof VersionConflict) return context.json({ error: 'version_conflict' }, 409);
      throw error;
    }
  });

  return app;
}
