import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLocalConfig } from '../../src/config.js';
import { startLocalPlatform, type RunningPlatform } from '../../src/runner.js';
import { api, login, scriptedModel, type Session } from './harness.js';

/**
 * The whole platform, started the way `pnpm local` starts it, and driven the way a
 * person drives it: a browser login through the real Human IdP, a ToDo, a decision, an
 * approval, and a provisioning that ends with an agent running.
 *
 * It exists because the local runner's claim is a strong one — that the platform behaves
 * the same off GCP — and the only way to hold it is to make the same round trip the
 * deployed platform makes. Every hop here goes over a socket: nothing calls `app.fetch`,
 * and nothing skips a redirect.
 *
 * The ports are offset so a run of this test cannot collide with a `pnpm local` already
 * open on the default range.
 */
const PORT_OFFSET = 700;

describe('the platform running on one machine', () => {
  let running: RunningPlatform;
  let session: Session;

  beforeAll(async () => {
    // Quiet by default: this run produces the structured log of sixteen services, and a
    // suite that printed all of it would bury its own failures. `LOCAL_TEST_VERBOSE=true`
    // turns it back on, which is how a failure here is read.
    const config = loadLocalConfig({
      LOCAL_PORT_OFFSET: String(PORT_OFFSET),
      LOCAL_QUIET: process.env.LOCAL_TEST_VERBOSE === 'true' ? 'false' : 'true',
      // What this suite asserts is a platform that starts from the seed: a run that
      // found a previous run's ToDos and permissions in the state directory would be
      // testing whatever the last person to run it happened to leave there. The
      // persistence itself has its own suite, beside this one.
      LOCAL_PERSIST: 'false',
    });
    running = await startLocalPlatform(config, { model: scriptedModel() });
    session = await login(config.topology.url['automation-app'], config.topology.url['human-idp']);
  }, 60_000);

  afterAll(async () => { await running?.stop(); });

  it('serves every declared service', async () => {
    for (const listener of running.listeners) {
      const response = await fetch(`${listener.url}/livez`);
      expect([listener.name, response.status]).toEqual([listener.name, 200]);
    }
  });

  it('publishes one JWK Set holding the Human IdP, the Agent OP and both Resource Servers', async () => {
    const response = await fetch(`${running.platform.config.topology.endpoints.jwks_url}`);
    const document = await response.json() as { keys: Array<{ kid: string }> };
    const prefixes = document.keys.map((key) => key.kid.replace(/-[^-]+$/, ''));
    expect(prefixes).toEqual(expect.arrayContaining(['op-shared', 'docs-as', 'fin-as']));
    expect(document.keys.some((key) => key.kid.startsWith('idp-'))).toBe(true);
  });

  it('seeds the catalogue the Provisioner resolves capabilities against', async () => {
    const tool = await running.platform.firestore.collection('catalog_tools').doc('internal.document.list').get();
    expect(tool.exists).toBe(true);
  });

  /**
   * The whole of the guide's flow, in one test rather than five: each step's output is
   * the next one's input, and splitting them would mean either five logins or a shared
   * mutable fixture.
   */
  it('takes a ToDo through decision, approval and provisioning to a running agent', async () => {
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

    expect((await api(session, `/api/todos/${todo.work_definition_id}/confirm`, { method: 'POST' })).status).toBe(200);

    const submitted = await api(session, `/api/todos/${todo.work_definition_id}/submit`, { method: 'POST' });
    expect(submitted.status).toBe(200);
    const decision = await submitted.json() as {
      agent_definition_id: string;
      effective_capabilities: string[];
    };
    // RULE-11: what the model proposed, intersected with what `testuser` actually holds.
    expect(decision.effective_capabilities).toEqual(['document.read']);

    expect((await api(session, `/api/agent-definitions/${decision.agent_definition_id}/approve`, { method: 'POST' })).status).toBe(200);

    const provisioned = await api(session, `/api/agent-definitions/${decision.agent_definition_id}/provision`, { method: 'POST' });
    expect(provisioned.status).toBe(200);
    const asked = await provisioned.json() as { status?: string; consent_url?: string };
    // The person has not yet delegated: an agent acts on their behalf only after they
    // have granted `offline_access` to the platform's one client, so the first
    // provisioning answers with a consent screen rather than an agent (RULE-51).
    expect(asked.status).toBe('IDP_CONSENT_REQUIRED');

    // Following it is the browser leg the deployment has too: the Human IdP asks, the
    // Agent OP's callback redeems the code and resumes the provisioning that was
    // waiting on it, and the browser lands back on the Automation App.
    const resumed = await session.agent.walk(asked.consent_url!);
    expect(resumed.url.startsWith(running.platform.config.topology.url['automation-app'])).toBe(true);

    const agents = await running.platform.firestore.collection('agents').get() as unknown as {
      docs: Array<{ id: string; data(): { agent_id?: string; status?: string; job_execution_name?: string } }>;
    };
    const registration = agents.docs.map((document) => document.data()).find((row) => row.agent_id);
    expect(registration?.agent_id).toMatch(/^agent-/);
    // On GCP this names a Cloud Run Job Execution; here it names one hosted in this
    // process, and the Provisioner cannot tell the difference.
    expect(registration?.job_execution_name).toMatch(/\/jobs\/agent-runtime-standard\/executions\//);
  }, 60_000);
});
