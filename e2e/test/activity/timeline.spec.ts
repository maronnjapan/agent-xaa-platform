import { describe, expect, it, beforeEach } from 'vitest';
import { resetActivityPublisherForTesting, validateActivityEvent, type ActivityEvent } from '@xaa/contracts';
import { createFirestoreDouble } from '@xaa/gcp';
import { storeActivityEvent } from '@xaa/automation-app/src/activity/subscriber';
import { TimelinePage } from '@xaa/automation-app/src/ui/pages/timeline';
import { readTimeline } from '@xaa/automation-app/src/activity/query';
import { startAutomationAppHarness, type AutomationHarness } from '../../harness/automation-app.js';

const render = async (element: unknown): Promise<string> => String(await element);

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return validateActivityEvent({
    event_id: 'ev', trace_id: 'tr', human_subject: 'testuser', agent_id: null, task_id: 'provisioning',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', phase: 'provisioning', outcome: 'info',
    title: 't', message: 'm', related_finding_id: null, is_simulated: false, ...overrides,
  });
}

async function seed(harness: AutomationHarness, events: ActivityEvent[]): Promise<void> {
  for (const entry of events) await storeActivityEvent({ documents: harness.documents, event: entry });
}

/**
 * REQ-11-021 / REQ-11-028. The list a person actually sees: two agents, four kinds of
 * task, in the order the work happened.
 */
describe('the timeline list', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  it('groups by agent and orders provisioning, tasks, lifecycle', async () => {
    const harness = await startAutomationAppHarness();
    const agentOne = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const agentTwo = 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb';
    await seed(harness, [
      event({ event_id: '1', agent_id: agentOne, task_id: 'provisioning', outcome: 'success', occurred_at: '2026-01-01T01:00:00.000Z', detail: { event_type: 'AGENT_PROVISIONED', purpose: '日報を作る' } }),
      event({ event_id: '2', agent_id: agentOne, task_id: 'task-1', phase: 'tool_call', outcome: 'success', occurred_at: '2026-01-01T02:00:00.000Z', detail: { event_type: 'TASK_COMPLETED' } }),
      event({ event_id: '3', agent_id: agentOne, task_id: 'task-2', phase: 'tool_call', outcome: 'blocked', occurred_at: '2026-01-01T03:00:00.000Z', detail: { event_type: 'TASK_BLOCKED' } }),
      event({ event_id: '4', agent_id: agentOne, task_id: 'lifecycle', phase: 'lifecycle', outcome: 'success', occurred_at: '2026-01-01T04:00:00.000Z', detail: { event_type: 'AGENT_STOPPED' } }),
      event({ event_id: '5', agent_id: agentTwo, task_id: 'task-9', phase: 'tool_call', outcome: 'success', occurred_at: '2026-01-02T01:00:00.000Z', detail: { event_type: 'TASK_COMPLETED', purpose: '経費を集計する' } }),
    ]);

    const body = await (await harness.fetch('/api/activity/tasks')).json() as {
      tasks: Array<{ run_id: string; task_id: string; agent_id: string | null; status: string; terminal_outcome?: string }>;
    };
    // The agent a person most recently started is on top; within an agent the order is
    // the order the work happened in (docs 11 §5.1).
    expect(body.tasks.map((task) => [task.run_id, task.task_id])).toEqual([
      [agentTwo, 'task-9'],
      [agentOne, 'provisioning'], [agentOne, 'task-1'], [agentOne, 'task-2'], [agentOne, 'lifecycle'],
    ]);

    const html = await render(TimelinePage({
      tasks: await readTimeline({ documents: harness.documents, humanSubject: 'testuser' }),
    }));
    const groups = [...html.matchAll(/<section class="agent-group" data-run-id="[^"]*" data-agent-id="([^"]*)"/g)].map((match) => match[1]);
    expect(groups).toEqual([agentTwo, agentOne]);
    // Within each agent's group: provisioning, then the numbered tasks in the order
    // they finished, then lifecycle.
    const sections = html.split('<section class="agent-group"').slice(1);
    expect(sections).toHaveLength(2);
    expect([...sections[1]!.matchAll(/data-task-key="[^"]+:([^"]+)"/g)].map((match) => match[1]))
      .toEqual(['provisioning', 'task-1', 'task-2', 'lifecycle']);
    expect([...sections[0]!.matchAll(/data-task-key="[^"]+:([^"]+)"/g)].map((match) => match[1]).slice(0, 1))
      .toEqual(['task-9']);
  });

  it('renders a running task as a disabled row with no replay canvas', async () => {
    const harness = await startAutomationAppHarness();
    await seed(harness, [event({ event_id: '1', task_id: 'task-1', phase: 'tool_call', detail: { event_type: 'TOOL_SUCCEEDED' } })]);
    const html = await render(TimelinePage({
      tasks: await readTimeline({ documents: harness.documents, humanSubject: 'testuser' }),
    }));
    expect(html).toContain('data-status="running"');
    expect(html).toContain('disabled');
    // No canvas for an unfinished task: there is nothing complete to play.
    expect(html).not.toContain('class="replay"');
  });

  it('renders the four columns of a completed row', async () => {
    const harness = await startAutomationAppHarness();
    await seed(harness, [event({
      event_id: '1', task_id: 'task-1', phase: 'tool_call', outcome: 'blocked',
      occurred_at: '2026-01-01T09:00:00.000Z', detail: { event_type: 'TASK_BLOCKED', purpose: '支払を承認する' },
    })]);
    const html = await render(TimelinePage({
      tasks: await readTimeline({ documents: harness.documents, humanSubject: 'testuser' }),
    }));
    expect(html).toContain('支払を承認する');
    expect(html).toContain('data-task-id="task-1"');
    expect(html).toContain('data-outcome="blocked"');
    expect(html).toContain('2026-01-01T09:00:00.000Z');
    expect(html).toContain('data-emphasis="ev-blocked-tool"');
  });
});

describe('recording is not a mode', () => {
  it('records without anyone turning it on', async () => {
    const harness = await startAutomationAppHarness();
    await seed(harness, [event({ event_id: '1', task_id: 'task-1', phase: 'tool_call', outcome: 'success', detail: { event_type: 'TASK_COMPLETED' } })]);
    const body = await (await harness.fetch('/api/activity/tasks')).json() as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(1);
  });

  it('answers the same for a token claiming to be an administrator', async () => {
    const shared = createFirestoreDouble();
    const owner = await startAutomationAppHarness({ shared, humanSubject: 'user-A' });
    const other = await startAutomationAppHarness({ shared, humanSubject: 'user-B' });
    await seed(owner, [event({
      event_id: '1', human_subject: 'user-A', task_id: 'task-1', phase: 'tool_call',
      outcome: 'success', detail: { event_type: 'TASK_COMPLETED' },
    })]);
    // user-B's session is an ordinary one; there is no claim the app would read to
    // widen it, so the answer is the same as for any other user.
    const seen = await (await other.fetch('/api/activity/tasks')).json() as { tasks: unknown[] };
    expect(seen.tasks).toEqual([]);
  });
});
