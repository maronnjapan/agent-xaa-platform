import { describe, expect, it } from 'vitest';
import { validateActivityEvent, type ActivityEvent } from '@xaa/contracts';
import { AGENT_ID, SUBJECT, seedAgent, startAutomationApp, type Harness } from './helpers.js';
import { SIMULATED_LABEL } from '../src/ui/components/simulated-badge.js';
import { TIMELINE_NOTE } from '../src/ui/components/timeline-link.js';

/**
 * The screens as they are actually served.
 *
 * Every assertion here goes through `app.fetch`, because the gap these cover is not
 * whether a component renders — the component tests already fix that — but whether any
 * route hands one to a browser at all, with the stylesheet and the script that make it
 * work.
 */

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return validateActivityEvent({
    event_id: 'ev-1', trace_id: 'tr-1', human_subject: SUBJECT, agent_id: AGENT_ID, task_id: 'task-1',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success',
    title: '作業が終わりました', message: '作業が終わりました。',
    detail: { event_type: 'TASK_COMPLETED', purpose: '日報をまとめる' },
    related_finding_id: null, is_simulated: false,
    ...overrides,
  }) as ActivityEvent;
}

async function seedEvent(harness: Harness, overrides: Partial<ActivityEvent> = {}): Promise<void> {
  const stored = event(overrides);
  await harness.documents.set('user_activity', stored.event_id, {
    ...stored, expire_at: '2026-01-08T00:00:00.000Z',
  });
}

describe('the timeline page', () => {
  it('is served as HTML with its stylesheet and its script', async () => {
    const harness = await startAutomationApp();
    await seedEvent(harness);
    const response = await harness.fetch('/activity');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('data-page="timeline"');
    expect(html).toContain('<script type="module" src="/timeline.js">');
    expect(html).toContain('href="/styles/emphasis.css"');
    expect(html).toContain('href="/styles/replay.css"');
  });

  it("renders the person's own finished task as a row and a canvas", async () => {
    const harness = await startAutomationApp();
    await seedEvent(harness);
    const html = await (await harness.fetch('/activity')).text();
    expect(html).toContain('data-task-id="task-1"');
    expect(html).toContain('data-outcome="success"');
    // The canvas carries the coordinates the browser draws the arrows between.
    expect(html).toContain('data-node="agent-runtime"');
    expect(html).toMatch(/data-node="agent-runtime"[^>]*data-x="260"[^>]*data-y="220"/);
  });

  it('narrows to one agent when asked, without widening past the session subject', async () => {
    const harness = await startAutomationApp();
    await seedEvent(harness);
    await seedEvent(harness, { event_id: 'ev-2', task_id: 'task-2', agent_id: 'agent-other' });
    await seedEvent(harness, { event_id: 'ev-3', task_id: 'task-3', human_subject: 'someone-else' });
    const html = await (await harness.fetch(`/activity?agent_id=${AGENT_ID}`)).text();
    expect(html).toContain('data-task-id="task-1"');
    expect(html).not.toContain('data-task-id="task-2"');
    expect(html).not.toContain('data-task-id="task-3"');
  });

  it('labels a simulated task on the page it is served on', async () => {
    const harness = await startAutomationApp();
    await seedEvent(harness, { task_id: 'demo-dpop-replay', is_simulated: true });
    const html = await (await harness.fetch('/activity')).text();
    expect(html).toContain(SIMULATED_LABEL);
  });

  it('sends an anonymous browser to the login flow rather than a JSON error', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/activity', { headers: { cookie: '' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });
});

describe('the agent detail page', () => {
  it('serves the status panel and the timeline link for the owner', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' } } });
    const response = await harness.fetch(`/agents/${AGENT_ID}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-section="status"');
    expect(html).toContain('data-section="timeline-link"');
    expect(html).toContain(TIMELINE_NOTE);
    expect(html).toContain(`/activity?agent_id=${AGENT_ID}`);
  });

  it("answers 404 for someone else's agent", async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { humanSubject: 'someone-else' });
    expect((await harness.fetch(`/agents/${AGENT_ID}`)).status).toBe(404);
  });
});

describe('the new work definition page', () => {
  it('is the destination the blocked guidance points at', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/work-definitions/new');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-form="work-definition"');
    expect(html).toContain('<script type="module" src="/work-definition.js">');
  });

  it('starts the lifetime at the configured default and caps it at 24', async () => {
    const harness = await startAutomationApp({ config: { defaultAgentLifetimeHours: 2 } });
    const html = await (await harness.fetch('/work-definitions/new')).text();
    expect(html).toMatch(/name="requested_lifetime_hours"[^>]*value="2"/);
    expect(html).toMatch(/name="requested_lifetime_hours"[^>]*max="24"/);
  });
});

describe('the static assets the pages name', () => {
  it('serves the bundled script the timeline page asks for', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/timeline.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(await response.text()).toContain('playReplay');
  });

  it('serves both stylesheets with the rules the screens depend on', async () => {
    const harness = await startAutomationApp();
    const emphasis = await harness.fetch('/styles/emphasis.css');
    expect(emphasis.headers.get('content-type')).toContain('text/css');
    const emphasisText = await emphasis.text();
    for (const className of ['ev-info', 'ev-success', 'ev-blocked-tool', 'ev-blocked-security']) {
      expect(emphasisText).toContain(`.${className}`);
    }
    // The four must differ in more than hue, and the security one most of all.
    expect(emphasisText).toContain('repeating-linear-gradient');

    const replay = await (await harness.fetch('/styles/replay.css')).text();
    expect(replay).toContain('offset-distance');
    expect(replay).toContain('var(--step-ms');
    expect(replay).toContain('var(--stop-ratio');
    expect(replay).toContain('animation-fill-mode: forwards');
  });
});
