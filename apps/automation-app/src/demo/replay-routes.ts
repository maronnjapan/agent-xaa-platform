import { Hono } from 'hono';
import { validateActivityEvent, type ActivityEvent } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { ACTIVITY_COLLECTION, ACTIVITY_RETENTION_DAYS, buildActivityPath } from '../activity/subscriber.js';
import { isScenarioId, SCENARIOS } from './scenarios.js';
import type { UserVariables } from '../auth/require-user.js';

export { buildActivityPath };

/**
 * Replays one of four recorded scripts into the caller's own timeline.
 *
 * Three fields are overwritten on the server for every event, whatever the request
 * said: `is_simulated` so the screen can never present a script as real (RULE-58),
 * `human_subject` from the session so a script lands in the caller's timeline and
 * nobody else's (RULE-56), and `task_id` so the rows group under a recognisable demo
 * heading.
 *
 * Nothing is published. These events go straight to the store, so Security Detection
 * sees nothing, no agent changes state, and the `agent-activity-stream` counters do
 * not move — a demonstration must not leave traces indistinguishable from an incident.
 */
export function createDemoReplayRoute(deps: {
  documents: DocumentStore;
  now?: () => number;
}): Hono<UserVariables> {
  const app = new Hono<UserVariables>();
  app.post('/replay', async (context) => {
    const body = await context.req.json().catch(() => undefined) as { scenario_id?: unknown } | undefined;
    const keys = body ? Object.keys(body) : [];
    if (!body || keys.length !== 1 || keys[0] !== 'scenario_id') {
      return context.json({ error: 'invalid_request' }, 400);
    }
    // An id is accepted only if it is one of the four, by array membership. Traversal
    // and encoded separators fail this test without any path normalisation to trust.
    if (!isScenarioId(body.scenario_id)) return context.json({ error: 'unknown_scenario' }, 400);

    const humanSubject = context.get('humanSubject');
    let written = 0;
    for (const template of SCENARIOS[body.scenario_id]) {
      const event = validateActivityEvent({
        ...(template as Record<string, unknown>),
        human_subject: humanSubject,
        task_id: `demo-${body.scenario_id}`,
        is_simulated: true,
      }) as ActivityEvent;
      buildActivityPath(event.human_subject, event.event_id);
      const id = `${humanSubject}__${event.event_id}`;
      await deps.documents.set(ACTIVITY_COLLECTION, id, {
        ...event,
        expire_at: new Date(Date.parse(event.occurred_at) + ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString(),
      });
      written += 1;
    }
    return context.json({ task_id: `demo-${body.scenario_id}`, events: written }, 201);
  });
  return app;
}
