import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLocalConfig } from '../../src/config.js';
import { startLocalPlatform, type RunningPlatform } from '../../src/runner.js';
import { api, browser, login, scriptedModel, type Session } from './harness.js';

/**
 * The claim the Analysis Console makes, made end to end: the logs the platform writes
 * reach the analyser, and what the analyser did with them reaches the screen.
 *
 * It is here rather than in either app's own suite because neither app can hold it
 * alone. The detector's suite can prove it writes a row for a batch it was handed, and
 * the console's can prove it renders a row it was seeded. Between them sit the shared
 * logger's sink, the `security-logs` topic, the pull loop and the access matrix — four
 * hops that were all in place while the screen still showed nothing, because the run
 * ended at a mechanical check that wrote nothing down.
 *
 * So the assertion is the one a person makes: run an agent, open the console, and see
 * that something was read.
 *
 * The ports are offset clear of the other two integration suites and of a `pnpm local`
 * somebody left open.
 */
const PORT_OFFSET = 900;

describe('what the console shows after an agent has run', () => {
  let running: RunningPlatform;
  let session: Session;
  let config: ReturnType<typeof loadLocalConfig>;

  beforeAll(async () => {
    config = loadLocalConfig({
      LOCAL_PORT_OFFSET: String(PORT_OFFSET),
      LOCAL_QUIET: process.env.LOCAL_TEST_VERBOSE === 'true' ? 'false' : 'true',
      LOCAL_PERSIST: 'false',
    });
    running = await startLocalPlatform(config, { model: scriptedModel() });
    session = await login(config.topology.url['automation-app'], config.topology.url['human-idp']);
  }, 60_000);

  afterAll(async () => { await running?.stop(); });

  it('has read this person’s agent logs and says so on the screen', async () => {
    const created = await api(session, '/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        title: '先月の日報を読んでまとめる',
        description: '記録されている日報を読み、内容を要約する。',
        done_criteria: ['要約ができている'],
      }),
    });
    expect(created.status).toBe(201);
    const todo = await created.json() as { work_definition_id: string };

    await api(session, `/api/todos/${todo.work_definition_id}/confirm`, { method: 'POST' });
    const submitted = await api(session, `/api/todos/${todo.work_definition_id}/submit`, { method: 'POST' });
    const decision = await submitted.json() as { agent_definition_id: string };

    await api(session, `/api/agent-definitions/${decision.agent_definition_id}/approve`, { method: 'POST' });
    const provisioned = await api(session, `/api/agent-definitions/${decision.agent_definition_id}/provision`, { method: 'POST' });
    const asked = await provisioned.json() as { consent_url?: string };
    // The delegation leg, as `local-platform.spec.ts` walks it: without it there is no
    // agent, and without an agent there is nothing for the detector to have read.
    if (asked.consent_url) await session.agent.walk(asked.consent_url);

    // The sink publishes without waiting for its subscriber, exactly as Pub/Sub does, so
    // the run has to settle before the rows it produced can be read.
    await running.platform.pubsub.drain();

    const inspections = await running.platform.firestore.collection('security_inspections').get() as unknown as {
      docs: Array<{ data(): { agent_id?: string; human_subject?: string; events_examined?: number } }>;
    };
    const rows = inspections.docs.map((document) => document.data());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => (row.events_examined ?? 0) > 0)).toBe(true);
    expect(rows.some((row) => row.human_subject === 'testuser')).toBe(true);

    // The console is its own site with its own Human IdP client, so it is its own login
    // and its own cookie jar — which is also the boundary the access matrix is checked
    // across on the way to the page.
    const consoleUrl = config.topology.url['analysis-console'];
    const consoleAgent = browser(config.topology.url['human-idp']);
    await consoleAgent.walk(`${consoleUrl}/login`);
    const page = await (await consoleAgent.go(consoleUrl)).text();

    // The screen names the agent and how much of its log was read, rather than telling
    // this person that nothing has been recorded about them.
    const agentId = rows.find((row) => row.human_subject === 'testuser')!.agent_id!;
    expect(page).toContain(`data-agent-id="${agentId}"`);
    expect(page).toContain('機械的なチェックの記録');
    expect(page).toContain('data-field="events_examined"');
    expect(page).not.toContain('まだ分析エージェントに届いていません');
  }, 60_000);
});
