import { Hono } from 'hono';

export interface InternalBatchDeps {
  /** Resolves the caller's service account email, or null when it is not allowed. */
  verifyScheduler?(token: string): Promise<string | null>;
  /** Returns the detections it wrote, so the caller's response can report the count. */
  runSigningKeyMisuse(now: Date): Promise<readonly unknown[]>;
  now?: () => number;
}

/**
 * The Scheduler's way in, and nobody else's.
 *
 * `sa-scheduler` is the only caller, checked by the OIDC token's `email` rather than by
 * network position: everything inside the perimeter can reach this service, so "came from
 * inside" is not an authorisation. Without a check configured the routes stay closed, the
 * same posture as the ingestion push route — a batch that writes CRITICAL rule hits is not
 * something an unidentified caller should be able to start.
 */
export function createInternalBatchRoutes(deps: InternalBatchDeps): Hono {
  const app = new Hono();

  app.post('/internal/batch/signing-key-misuse', async (context) => {
    const header = context.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const caller = deps.verifyScheduler && token ? await deps.verifyScheduler(token).catch(() => null) : null;
    if (!caller) return context.json({ error: 'caller_not_allowed' }, 403);

    const now = new Date(deps.now ? deps.now() : Date.now());
    const hits = await deps.runSigningKeyMisuse(now);
    return context.json({ detections: hits.length }, 200);
  });

  return app;
}
