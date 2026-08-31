import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { REPLAY_NODES, REPLAY_VIEWBOX, SOURCE_TO_NODE, nodeIdFor, visibleNodeIds } from '../src/ui/replay/nodes.js';
import { EMPHASIS_CLASSES, EMPHASIS_LABELS, emphasisClass } from '../src/ui/replay/emphasis.js';
import { buildReplayPlan, isFinished } from '../../automation-app/client/src/replay-plan.js';
import { REPLAY_STEP_MS, BLOCKED_STOP_RATIO } from '../../automation-app/client/src/replay-config.js';
import { OutcomeBadge } from '../src/ui/components/outcome-badge.js';
import { DetailDisclosure } from '../src/ui/components/detail-disclosure.js';
import { ReplayCanvas } from '../src/ui/components/replay-canvas.js';
import { TaskRow } from '../src/ui/components/task-row.js';
import { AgentDetailPage } from '../src/ui/pages/agent-detail.js';
import { TimelinePage } from '../src/ui/pages/timeline.js';
import { BLOCKED_GUIDANCE_TEXT } from '../src/ui/components/blocked-guidance.js';
import { TIMELINE_NOTE } from '../src/ui/components/timeline-link.js';
import { SIMULATED_LABEL } from '../src/ui/components/simulated-badge.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const render = async (element: unknown): Promise<string> => String(await element);

describe('the replay diagram', () => {
  it('has 8 nodes with fixed coordinates', () => {
    expect(REPLAY_NODES).toHaveLength(8);
    expect(REPLAY_NODES.map((node) => node.id)).toEqual([
      'human-user', 'automation-app', 'authorization-platform', 'agent-provisioner',
      'agent-op', 'agent-runtime', 'resource-as', 'resource-api',
    ]);
    expect(REPLAY_NODES.map((node) => [node.x, node.y])).toEqual([
      [80, 60], [260, 60], [440, 60], [620, 60], [80, 220], [260, 220], [440, 220], [620, 220],
    ]);
    expect(REPLAY_VIEWBOX).toBe('0 0 720 300');
  });

  it('gives lifecycle-manager and security-detection no node', () => {
    expect(nodeIdFor('lifecycle-manager')).toBeNull();
    expect(nodeIdFor('security-detection')).toBeNull();
    expect(Object.values(SOURCE_TO_NODE).every((id) => REPLAY_NODES.some((node) => node.id === id))).toBe(true);
  });

  it('shows only the nodes a task involved', async () => {
    const provisioning = await render(ReplayCanvas({
      taskId: 'provisioning',
      events: [{ source: 'automation-app', detail: { target: 'authorization-platform' } }],
    }));
    expect(provisioning).toMatch(/data-node="authorization-platform"(?![^>]*hidden)/);

    const toolCall = await render(ReplayCanvas({
      taskId: 'task-1',
      events: [{ source: 'agent-runtime', detail: { target: 'resource-api' } }],
    }));
    expect(toolCall).toMatch(/data-node="authorization-platform"[^>]*hidden/);
    expect(toolCall).toMatch(/data-node="resource-api"(?![^>]*hidden)/);
  });

  it('marks every node unreached before anything plays', async () => {
    const html = await render(ReplayCanvas({ taskId: 'task-1', events: [{ source: 'agent-runtime' }] }));
    expect(html.match(/data-reached="false"/g)).toHaveLength(8);
    expect(html).toContain('data-replay-state="idle"');
  });

  it('computes the visible set from sources and targets together', () => {
    expect(visibleNodeIds([{ source: 'agent-runtime', detail: { target: 'resource-as' } }]))
      .toEqual(new Set(['agent-runtime', 'resource-as']));
  });

  it('names no graph library', async () => {
    const manifest = JSON.parse(await readFile(`${repoRoot}apps/automation-app/package.json`, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const forbidden of ['mermaid', 'd3', 'react', 'react-dom']) {
      expect(Object.keys(manifest.dependencies)).not.toContain(forbidden);
    }
  });
});

describe('the replay plan', () => {
  const events = [
    { event_id: 'b', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', outcome: 'success', message: '二番目', detail: { target: 'resource-as' } },
    { event_id: 'a', occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', outcome: 'info', message: '一番目', detail: { target: 'agent-runtime' } },
    { event_id: 'c', occurred_at: '2026-01-01T00:03:00.000Z', source: 'agent-runtime', outcome: 'blocked', message: '許可された Tool に含まれない', detail: { target: 'resource-api' } },
  ];

  it('orders by occurred_at then event_id', () => {
    const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan.map((step) => step.eventId)).toEqual(['a', 'b', 'c']);
  });

  it('paces every step identically whatever the real gap', () => {
    const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan.map((step) => step.delayMs)).toEqual([REPLAY_STEP_MS, REPLAY_STEP_MS, REPLAY_STEP_MS]);
    expect(REPLAY_STEP_MS).toBe(800);
  });

  it('stops a blocked step short of its destination', () => {
    const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan[2]).toMatchObject({ blocked: true, stopRatio: BLOCKED_STOP_RATIO, to: 'resource-api' });
    expect(plan.filter((step) => step.blocked)).toHaveLength(1);
    expect(BLOCKED_STOP_RATIO).toBe(0.6);
  });

  it('continues after a blocked step', () => {
    const plan = buildReplayPlan([...events, {
      event_id: 'd', occurred_at: '2026-01-01T00:04:00.000Z', source: 'agent-runtime', outcome: 'success', message: '続き',
    }], (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan).toHaveLength(4);
    expect(isFinished(plan, 2)).toBe(false);
    expect(isFinished(plan, 3)).toBe(true);
  });

  it('gives a nodeless event no endpoints', () => {
    const plan = buildReplayPlan([{
      event_id: 'x', occurred_at: '2026-01-01T00:00:00.000Z', source: 'security-detection', outcome: 'blocked', message: '検知',
    }], (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan[0]).toMatchObject({ from: null, to: null });
  });

  it('names the step length in one place', async () => {
    const hits = execFileSync('bash', ['-c',
      "grep -rn 'REPLAY_STEP_MS' apps/automation-app/src apps/automation-app/client/src"],
      { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');
    expect(hits.filter((line) => line.includes('export const'))).toHaveLength(1);
    expect(hits.length).toBeGreaterThan(1);
    const literals = execFileSync('bash', ['-c', "grep -rn '800' apps/automation-app/src apps/automation-app/client/src || true"], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim();
    expect(literals.split('\n').filter((line) => line !== '' && !line.includes('REPLAY_STEP_MS = 800'))).toEqual([]);
  });
});

describe('emphasis', () => {
  it('distinguishes a blocked security event from a blocked tool call', () => {
    expect(emphasisClass('blocked', 'security')).toBe('ev-blocked-security');
    expect(emphasisClass('blocked', 'tool_call')).toBe('ev-blocked-tool');
    expect(emphasisClass('blocked', 'security')).not.toBe(emphasisClass('blocked', 'tool_call'));
    expect(new Set(EMPHASIS_CLASSES).size).toBe(4);
  });

  it('gives all four a text label, not only a colour', async () => {
    const rendered = await Promise.all([
      render(OutcomeBadge({ outcome: 'info', phase: 'login' })),
      render(OutcomeBadge({ outcome: 'success', phase: 'tool_call' })),
      render(OutcomeBadge({ outcome: 'blocked', phase: 'tool_call' })),
      render(OutcomeBadge({ outcome: 'blocked', phase: 'security' })),
    ]);
    for (const [index, html] of rendered.entries()) {
      expect(html).toContain(EMPHASIS_LABELS[EMPHASIS_CLASSES[index]!]);
    }
    expect(new Set(rendered.map((html) => /data-emphasis="([^"]+)"/.exec(html)![1]))).toHaveLength(4);
  });

  it('puts the warning icon on the security badge only', async () => {
    expect(await render(OutcomeBadge({ outcome: 'blocked', phase: 'security' }))).toContain('data-icon="warning"');
    expect(await render(OutcomeBadge({ outcome: 'blocked', phase: 'tool_call' }))).not.toContain('data-icon="warning"');
  });
});

describe('the detail disclosure', () => {
  it('is closed to begin with', async () => {
    const html = await render(DetailDisclosure({ detail: { tool_id: 'internal.document.list' } }));
    expect(html).toContain('<details');
    expect(html).not.toContain(' open');
  });

  it('joins arrays with a Japanese separator and never composes a sentence', async () => {
    const html = await render(DetailDisclosure({ detail: { effective_capabilities: ['a', 'b'] } }));
    expect(html).toContain('a、b');
    expect(html).toContain('effective_capabilities');
  });

  it('renders nothing when the event has no detail', () => {
    expect(DetailDisclosure({})).toBeNull();
    expect(DetailDisclosure({ detail: {} })).toBeNull();
  });
});

describe('the task list', () => {
  it('renders a running task as a disabled button with no outcome', async () => {
    const html = await render(TaskRow({ task_id: 'task-1', purpose: '日報', status: 'running' }));
    expect(html).toContain('disabled');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('実行中');
  });

  it('renders a completed task with four columns', async () => {
    const html = await render(TaskRow({
      task_id: 'task-1', purpose: '日報', status: 'completed',
      terminal_outcome: 'blocked', completed_at: '2026-01-01T00:00:00.000Z', phase: 'tool_call',
    }));
    expect(html).toContain('data-task-id="task-1"');
    expect(html).toContain('data-outcome="blocked"');
    expect(html).not.toContain('disabled');
    for (const column of ['col-purpose', 'col-task-id', 'col-outcome', 'col-completed-at']) {
      expect(html).toContain(column);
    }
  });

  it('labels a simulated task everywhere and a real one nowhere', async () => {
    const simulated = await render(TimelinePage({
      tasks: [{
        task_id: 'demo-dpop-replay', agent_id: null, purpose: 'デモ', status: 'completed',
        terminal_outcome: 'blocked', completed_at: '2026-01-01T00:00:00.000Z',
        events: [{
          event_id: 'e', trace_id: 't', human_subject: 'testuser', agent_id: null, task_id: 'demo-dpop-replay',
          occurred_at: '2026-01-01T00:00:00.000Z', source: 'security-detection', phase: 'security', outcome: 'blocked',
          title: 'x', message: 'y', detail: { event_type: 'DPOP_REPLAY' }, related_finding_id: null, is_simulated: true,
        }],
      }],
    }));
    // Row, canvas and detail summary: three places, none of them behind a disclosure
    // that starts closed.
    expect(simulated.match(new RegExp(SIMULATED_LABEL, 'g'))).toHaveLength(3);
    expect(simulated).toContain('simulated-row');
    expect(simulated).toContain('simulated-canvas');

    const real = await render(TimelinePage({
      tasks: [{ task_id: 'task-1', agent_id: null, purpose: '実作業', status: 'running' }],
    }));
    expect(real).not.toContain(SIMULATED_LABEL);
  });
});

describe('the agent detail page', () => {
  const status = {
    agent_status: 'ACTIVE', remaining_seconds: 100, current_task: 'task-1',
    tool_invocations: [{ tool_id: 'internal.finance.payment.approve', outcome: 'blocked', summary: 'not_in_allowed_tools' }],
  };

  it('separates the status panel from the timeline link', async () => {
    const html = await render(AgentDetailPage({ agentId: 'agent-a', status }));
    expect(html).toContain('data-section="status"');
    expect(html).toContain('data-section="timeline-link"');
    expect(html.indexOf('data-section="status"')).toBeLessThan(html.indexOf('data-section="timeline-link"'));
  });

  it('always shows the note about what the timeline replays', async () => {
    const html = await render(AgentDetailPage({ agentId: 'agent-a', status }));
    expect(html).toContain(TIMELINE_NOTE);
    // Outside any <details>: the caveat must be readable without opening anything.
    expect(html.split('<details')[0]).toContain(TIMELINE_NOTE);
  });

  it('offers one link, to a new work definition, when something was blocked', async () => {
    const html = await render(AgentDetailPage({ agentId: 'agent-a', status }));
    expect(html).toContain(BLOCKED_GUIDANCE_TEXT);
    expect(html.match(/\/work-definitions\/new/g)).toHaveLength(1);
    expect(html).not.toContain('権限を追加');
    expect(html).not.toContain('Capability を編集');
    expect(html).not.toContain('agent_id=agent-a&');
  });

  it('shows no guidance when nothing was blocked', async () => {
    const html = await render(AgentDetailPage({
      agentId: 'agent-a',
      status: { ...status, tool_invocations: [{ tool_id: 'internal.document.list', outcome: 'success', summary: '' }] },
    }));
    expect(html).not.toContain(BLOCKED_GUIDANCE_TEXT);
  });
});

describe('the frontend bundle', () => {
  it('carries no datastore SDK and holds no connection open', () => {
    // The Firestore check lives with the other static infra checks, where CI runs it.
    expect(() => execFileSync('bash', ['infra/tests/no-firestore-sdk-in-frontend.sh'], { cwd: repoRoot })).not.toThrow();
    expect(() => execFileSync('bash', ['scripts/checks/no-persistent-connection.sh'], { cwd: repoRoot })).not.toThrow();
  });

  it('passes every automation-app boundary check', () => {
    for (const script of [
      'no-offline-access-in-automation-app.sh', 'no-authz-vocabulary-in-automation-app.sh',
      'no-capability-update-route.sh', 'no-recording-switch.sh', 'no-cross-user-route.sh',
      'no-demo-route.sh', 'no-fake-actor-token.sh', 'activity-event-single-channel.sh',
      'no-direct-vertex-sdk.sh',
    ]) {
      expect(() => execFileSync('bash', [`scripts/checks/${script}`], { cwd: repoRoot })).not.toThrow();
    }
  });
});
