import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permSet } from '@xaa/authorization/src/perm-set';
import { createFirestoreDocumentStore } from '@xaa/gcp';
import { loadLocalConfig } from '../../src/config.js';
import { startLocalPlatform, type RunningPlatform } from '../../src/runner.js';
import { api, login, scriptedModel } from './harness.js';

/**
 * A platform stopped and started again, with the state directory in between.
 *
 * The claim under test is the one a person makes when they close the terminal: what
 * they set up is still there next time. It is checked end to end rather than on the
 * state file, because the file is not the thing — the thing is a ToDo that is still on
 * the list, a permission that was granted and not taken back by a second seed, and a
 * browser that is still logged in.
 *
 * Above the default range and above the flow suite's, so a run of either cannot collide
 * with the other or with a `pnpm local` somebody left open.
 */
const PORT_OFFSET = 800;

/** Every agent the platform still counts as one: the row is there and it is not destroyed. */
async function liveAgents(running: RunningPlatform): Promise<string[]> {
  const rows = await running.platform.firestore.collection('agents').get() as unknown as {
    docs: Array<{ id: string; data(): { agent_id?: string; status?: string } }>;
  };
  return rows.docs
    .filter((document) => document.id.endsWith('__meta'))
    .map((document) => document.data())
    .filter((meta) => typeof meta.agent_id === 'string' && meta.status !== 'DESTROYED')
    .map((meta) => meta.agent_id!);
}

function configFor(stateDir: string | undefined): ReturnType<typeof loadLocalConfig> {
  return loadLocalConfig({
    LOCAL_PORT_OFFSET: String(PORT_OFFSET),
    LOCAL_QUIET: process.env.LOCAL_TEST_VERBOSE === 'true' ? 'false' : 'true',
    ...(stateDir === undefined ? { LOCAL_PERSIST: 'false' } : { LOCAL_STATE_DIR: stateDir }),
  });
}

const TITLE = '先月の請求書を確認する';

/** What `pnpm perm:set` writes, written the way it writes it. */
async function grant(running: RunningPlatform, subject: string, capability: string): Promise<void> {
  const code = await permSet([subject, capability, 'grant'], {
    documents: createFirestoreDocumentStore(running.platform.firestore, 'seed'),
    now: () => Date.now(),
    async publish() { /* the change reaches no running agent in this test */ },
  });
  expect(code).toBe(0);
}

describe('a local platform that keeps its state', () => {
  let directory: string;

  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'xaa-local-state-')); });
  afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

  /**
   * One test rather than four, for the same reason the flow suite is one: each step's
   * output is the next one's input, and a platform started twice per assertion would
   * spend a minute of the suite's time opening and closing sixty sockets.
   */
  it('gives back the ToDos, the permissions and the login the previous run was left with', async () => {
    const config = configFor(directory);
    const first = await startLocalPlatform(config, {});
    let secondRun: RunningPlatform | undefined;
    try {
      const session = await login(config.topology.url['automation-app'], config.topology.url['human-idp']);
      const created = await api(session, '/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          title: TITLE,
          description: '記録されている請求書を読み、金額を確かめる。',
          done_criteria: ['金額が確かめられている'],
        }),
      });
      expect(created.status).toBe(201);
      const todo = await created.json() as { work_definition_id: string };
      expect((await api(session, `/api/todos/${todo.work_definition_id}/confirm`, { method: 'POST' })).status).toBe(200);

      // A permission nobody is seeded with, so its presence after the restart can only
      // mean the row survived and the seed did not run a second time over it.
      await grant(first, 'testuser', 'calendar.event.read');

      await first.stop();

      // Nothing is passed between the two runs but the directory: this is a second
      // process's worth of separation, short of actually forking one.
      secondRun = await startLocalPlatform(configFor(directory), {});

      const reloaded = await secondRun.platform.firestore
        .collection('work_definitions').doc(todo.work_definition_id).get();
      expect(reloaded.exists).toBe(true);
      expect((reloaded.data() as { title: string; status: string }).title).toBe(TITLE);
      expect((reloaded.data() as { title: string; status: string }).status).toBe('CONFIRMED');

      const permission = await secondRun.platform.firestore
        .collection('human_permissions').doc('testuser__calendar.event.read').get();
      expect(permission.exists).toBe(true);

      // The seed still ran once, on the first start: the catalogue the Provisioner
      // resolves capabilities against is there, and was not lost by not re-seeding.
      expect((await secondRun.platform.firestore.collection('catalog_tools').doc('internal.document.list').get()).exists).toBe(true);

      // The same cookie jar, against a platform that has restarted underneath it. It
      // opens because the SSO signing key was read back rather than generated again,
      // so the Access Token in the session still verifies.
      const home = await session.agent.go(`${config.topology.url['automation-app']}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain(TITLE);
    } finally {
      await secondRun?.stop();
      await first.stop().catch(() => undefined);
    }
  }, 60_000);

  /** Reads what the run above left behind, so it follows it rather than standing alone. */
  it('writes the rows and the key under the state directory, and nothing readable by anyone else', () => {
    const rows = JSON.parse(readFileSync(join(directory, 'firestore.json'), 'utf8')) as {
      version: number;
      collections: Record<string, Record<string, unknown>>;
    };
    expect(rows.version).toBe(1);
    expect(Object.keys(rows.collections)).toEqual(expect.arrayContaining(['work_definitions', 'human_permissions']));
    // What the deployed platform keeps in Cloud KMS and a private bucket is what is in
    // here, so the directory is the owner's and nobody else's.
    for (const file of ['firestore.json', 'kms-master.key', 'platform-config/sso-signing/current.json']) {
      expect([file, statSync(join(directory, file)).mode & 0o077]).toEqual([file, 0]);
    }
  });

  /**
   * The one thing that does not come back, and must not appear to.
   *
   * An agent's client credential lives in the environment of the Execution running it
   * and nowhere else (RULE-22), so a restored row describes an agent that cannot act.
   * Showing it as ACTIVE would put a countdown on the screen for something nothing can
   * stop, and hold the ToDo it carries open. The run therefore begins by ending them
   * through the Lifecycle Manager's own cleanup, which is what this asserts: over real
   * sockets, with the OP and both Resource Servers actually asked to revoke.
   */
  it('ends the agents the previous run left, and keeps the ToDo they were carrying', async () => {
    const own = mkdtempSync(join(tmpdir(), 'xaa-local-agents-'));
    const config = configFor(own);
    const first = await startLocalPlatform(config, { model: scriptedModel() });
    let secondRun: RunningPlatform | undefined;
    try {
      const session = await login(config.topology.url['automation-app'], config.topology.url['human-idp']);
      const created = await api(session, '/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          title: '日報を読んでまとめる',
          description: '記録されている日報を読み、内容を要約する。',
          done_criteria: ['要約ができている'],
        }),
      });
      const todo = await created.json() as { work_definition_id: string };
      await api(session, `/api/todos/${todo.work_definition_id}/confirm`, { method: 'POST' });
      const submitted = await api(session, `/api/todos/${todo.work_definition_id}/submit`, { method: 'POST' });
      const decision = await submitted.json() as { agent_definition_id: string };
      await api(session, `/api/agent-definitions/${decision.agent_definition_id}/approve`, { method: 'POST' });
      const provisioned = await api(session, `/api/agent-definitions/${decision.agent_definition_id}/provision`, { method: 'POST' });
      // The delegation consent, walked as a browser walks it, which is what actually
      // produces an agent (RULE-51).
      await session.agent.walk((await provisioned.json() as { consent_url: string }).consent_url);
      expect(await liveAgents(first)).toHaveLength(1);

      await first.stop();
      secondRun = await startLocalPlatform(configFor(own), { model: scriptedModel() });

      expect(await liveAgents(secondRun)).toEqual([]);
      // The work itself is not the agent's to take with it.
      expect((await secondRun.platform.firestore.collection('work_definitions').doc(todo.work_definition_id).get()).exists).toBe(true);
    } finally {
      await secondRun?.stop();
      await first.stop().catch(() => undefined);
      rmSync(own, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps nothing when persistence is off', async () => {
    const config = configFor(undefined);
    expect(config.stateDir).toBeUndefined();
    const running = await startLocalPlatform(config, {});
    try {
      expect(running.platform.state.directory).toBeUndefined();
      expect(running.platform.state.fresh).toBe(true);
      // The seed is what an empty platform needs, and `auto` gives it to one.
      expect((await running.platform.firestore.collection('catalog_tools').doc('internal.document.list').get()).exists).toBe(true);
      expect((await running.platform.firestore.collection('work_definitions').get() as unknown as { docs: unknown[] }).docs).toEqual([]);
    } finally {
      await running.stop();
    }
  }, 60_000);
});
