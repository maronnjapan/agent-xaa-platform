import { describe, expect, it, beforeEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { drainActivityQueueForTesting, resetActivityPublisherForTesting, validateActivityEvent } from '@xaa/contracts';
import { createFirestoreDouble } from '@xaa/gcp';
import { ALLOWED_SCENARIOS, SCENARIOS, isScenarioId } from '../src/demo/scenarios.js';
import { buildActivityPath } from '../src/demo/replay-routes.js';
import { SUBJECT, startAutomationApp } from './helpers.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;

const replay = (harness: Awaited<ReturnType<typeof startAutomationApp>>, body: unknown, query = '') =>
  harness.fetch(`/api/demo/replay${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

describe('the four recorded scenarios', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  it('names four and refuses a fifth', async () => {
    const harness = await startAutomationApp();
    expect(ALLOWED_SCENARIOS).toHaveLength(4);
    for (const scenario of ALLOWED_SCENARIOS) {
      expect((await replay(harness, { scenario_id: scenario })).status).toBe(201);
    }
    const rejected = await replay(harness, { scenario_id: 'privilege-escalation' });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'unknown_scenario' });
  });

  it('validates every recorded file against the Activity Event schema', async () => {
    const files = (await readdir(`${repoRoot}demo-scenarios`)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(4);
    for (const file of files) {
      const events = JSON.parse(await readFile(`${repoRoot}demo-scenarios/${file}`, 'utf8')) as unknown[];
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(() => validateActivityEvent({ ...(event as object), human_subject: SUBJECT })).not.toThrow();
      }
    }
  });

  it('marks everything it writes as simulated, whatever the request said', async () => {
    const harness = await startAutomationApp();
    await replay(harness, { scenario_id: 'dpop-replay' });
    const rows = await harness.documents.queryEqual<{ is_simulated: boolean; human_subject: string; task_id: string }>(
      'user_activity', [['task_id', 'demo-dpop-replay']],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data.is_simulated).toBe(true);
      expect(row.data.human_subject).toBe(SUBJECT);
      expect(row.data.task_id).toBe('demo-dpop-replay');
    }
  });

  it('ignores a body that tries to say who it is for', async () => {
    const harness = await startAutomationApp();
    const response = await replay(harness, { scenario_id: 'dpop-replay', human_subject: 'user-B', is_simulated: false });
    // A second key is refused outright rather than ignored: the request is not one the
    // API accepts, and answering 201 would suggest the extra field meant something.
    expect(response.status).toBe(400);
    expect(await harness.documents.queryEqual('user_activity', [['human_subject', 'user-B']])).toHaveLength(0);
  });

  it('publishes nothing and touches no agent', async () => {
    const harness = await startAutomationApp();
    await replay(harness, { scenario_id: 'cross-agent-isolation' });
    expect(drainActivityQueueForTesting()).toEqual([]);
    expect(harness.upstream).toHaveLength(0);
  });

  it('appears in the ordinary timeline, from the ordinary endpoint', async () => {
    const harness = await startAutomationApp();
    await replay(harness, { scenario_id: 'delegation-mismatch' });
    const body = await (await harness.fetch('/api/activity/tasks')).json() as {
      tasks: Array<{ task_id: string; status: string; events?: unknown[] }>;
    };
    const demo = body.tasks.find((task) => task.task_id === 'demo-delegation-mismatch')!;
    expect(demo.status).toBe('completed');
    expect(demo.events!.length).toBeGreaterThan(0);
  });
});

describe('the demo cannot reach another user', () => {
  const attempts = [
    { label: 'a subject in the body', body: { scenario_id: 'dpop-replay', human_subject: 'user-B' }, query: '' },
    { label: 'traversal in the id', body: { scenario_id: '../user-B/activity' }, query: '' },
    { label: 'an encoded separator in the id', body: { scenario_id: '..%2Fuser-B%2Factivity' }, query: '' },
    { label: 'a subject in the query', body: { scenario_id: 'dpop-replay' }, query: '?human_subject=user-B' },
  ];

  for (const attempt of attempts) {
    it(`writes nothing for user-B given ${attempt.label}`, async () => {
      const shared = createFirestoreDouble();
      const userA = await startAutomationApp({ shared, subject: 'user-A' });
      const userB = await startAutomationApp({ shared, subject: 'user-B' });
      await replay(userA, attempt.body, attempt.query);
      expect(await userB.documents.queryEqual('user_activity', [['human_subject', 'user-B']])).toHaveLength(0);
    });
  }

  it('rejects traversal by list membership, not by normalising a path', () => {
    expect(isScenarioId('../user-B/activity')).toBe(false);
    expect(isScenarioId('..%2Fuser-B')).toBe(false);
    expect(isScenarioId('dpop-replay')).toBe(true);
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ALLOWED_SCENARIOS].sort());
  });

  it('throws on slash in subject', () => {
    expect(() => buildActivityPath('user/../other', 'ev-1')).toThrow();
    expect(() => buildActivityPath('user-A', 'ev-1')).not.toThrow();
  });

  it('builds the activity path in one place', () => {
    const hits = execFileSync('bash', ['-c', "grep -rn 'users/' apps/automation-app/src/demo || true"], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim();
    expect(hits).toBe('');
  });

  it('mints no agent assertion of its own', () => {
    expect(() => execFileSync('bash', ['scripts/checks/no-fake-actor-token.sh'], { cwd: repoRoot })).not.toThrow();
  });
});
