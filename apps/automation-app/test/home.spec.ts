import { describe, expect, it } from 'vitest';
import { validateActivityEvent, type ActivityEvent } from '@xaa/contracts';
import { AGENT_ID, SUBJECT, seedAgent, startAutomationApp, type Harness } from './helpers.js';
import { capabilitiesHash } from '../src/agent-definition/approval.js';
import { APPROVAL_NOTE } from '../src/ui/components/agent-definition-panel.js';
import { STOP_NOTE } from '../src/ui/components/agent-controls.js';
import { HOME_LEAD } from '../src/ui/pages/home.js';
import { actionUrl, afterProvision, dayRange, isHomeAction } from '../../automation-app/client/src/home-actions.js';
import { failureMessage } from '../../automation-app/client/src/messages.js';
import { toWorkDefinitionBody } from '../../automation-app/client/src/work-definition-request.js';
import { PRESENTED_CAPABILITIES } from './fixtures/presented-capabilities.fixture.js';

/**
 * The home screen, which is the whole of what a person can do.
 *
 * Logging in used to end at a sentence saying the login had worked, so every route
 * below it — confirming a draft, asking what permissions it needs, approving them,
 * creating the agent — was reachable only by writing the request by hand. These
 * assertions are about the screen offering each of those steps at the moment it becomes
 * possible, and not before.
 */

async function seedWorkDefinition(harness: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = String(overrides.work_definition_id ?? 'wd_1');
  await harness.documents.set('work_definitions', id, {
    work_definition_id: id, human_subject: SUBJECT, status: 'DRAFT',
    purpose: '毎朝の日報をまとめる', description: '前日の作業記録から日報を作る',
    operations: ['作業記録を読む', '日報を作る'], user_confirmations: ['内容を確認する'],
    safety_notes: ['社外に送らない'], requested_lifetime_minutes: 120,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
  return id;
}

async function seedAgentDefinition(harness: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = String(overrides.agent_definition_id ?? 'ad_1');
  await harness.documents.set('agent_definitions', id, {
    agent_definition_id: id, human_subject: SUBJECT, work_definition_id: 'wd_1', decision_id: 'dec_1',
    presented_capabilities: [...PRESENTED_CAPABILITIES],
    presented_capabilities_hash: await capabilitiesHash([...PRESENTED_CAPABILITIES]),
    isolation_level: 'standard', approved_by: null, approved_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
  return id;
}

/**
 * What the Authorization Platform leaves in `work_definitions`: the structured Work
 * Definition it derives from the request. Same collection, same person, different shape
 * — `target_resources` and `constraints` instead of `status`, `user_confirmations` and
 * `safety_notes` (apps/authorization/src/work-definition/build.ts).
 */
async function seedAuthorizationWorkDefinition(harness: Harness, id = 'wd_authz'): Promise<string> {
  await harness.authorizationSeed.set('work_definitions', id, {
    work_definition_id: id, human_subject: SUBJECT,
    purpose: '毎朝の日報をまとめる', description: '前日の作業記録から日報を作る',
    operations: [], target_resources: ['document'], constraints: { external_message_send: false },
    created_at: '2026-01-02T00:00:00.000Z',
  });
  return id;
}

describe('the home screen', () => {
  /**
   * The 500 a person met right after logging in. `work_definitions` is one collection
   * for the platform and the Authorization Platform writes its own shape into it, so a
   * query by `human_subject` returned rows this screen cannot render, and the first
   * `user_confirmations.map` threw before any of the page reached the browser.
   */
  it('renders when the Authorization Platform has written its own row for the same person', async () => {
    const harness = await startAutomationApp();
    await seedWorkDefinition(harness);
    await seedAuthorizationWorkDefinition(harness);

    const response = await harness.fetch('/');

    expect(response.status).toBe(200);
    const html = await response.text();
    // The person's own draft is there, and the other writer's row is not listed at all.
    expect(html).toContain('data-work-definition-id="wd_1"');
    expect(html).not.toContain('wd_authz');
  });

  /**
   * And it is not addressable either: the routes read `find`, so an id belonging to the
   * other writer has to answer the way a missing one does rather than be confirmed into
   * a shape this app could never have written.
   */
  it('answers 404 for a work definition id that belongs to the other writer', async () => {
    const harness = await startAutomationApp();
    const id = await seedAuthorizationWorkDefinition(harness);

    for (const path of [`/api/work-definitions/${id}/confirm`, `/api/work-definitions/${id}/submit`]) {
      const response = await harness.fetch(path, { method: 'POST' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
    expect(harness.upstream).toHaveLength(0);
  });

  it('is served to a logged-in person with the form, its script and its stylesheet', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('data-page="home"');
    expect(html).toContain(HOME_LEAD);
    expect(html).toContain('data-form="work-definition"');
    expect(html).toContain('<script type="module" src="/home.js">');
    expect(html).toContain('href="/styles/app.css"');
  });

  it('sends an anonymous browser to the login flow', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/', { headers: { cookie: '' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });

  /**
   * The session cookie outlives nothing, but a token inside it can expire first. A
   * browser that arrives then is in exactly the position of one with no session at all,
   * and used to be answered with a JSON body it had no way to act on.
   */
  it('sends a browser whose token has expired to the login flow too', async () => {
    const harness = await startAutomationApp({
      verifyAccessToken: async () => { throw new Error('expired'); },
    });
    const response = await harness.fetch('/');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });

  it("lists the person's own drafts and nobody else's", async () => {
    const harness = await startAutomationApp();
    await seedWorkDefinition(harness);
    await seedWorkDefinition(harness, { work_definition_id: 'wd_other', human_subject: 'someone-else' });
    const html = await (await harness.fetch('/')).text();
    expect(html).toContain('data-work-definition-id="wd_1"');
    expect(html).not.toContain('data-work-definition-id="wd_other"');
    expect(html).toContain('毎朝の日報をまとめる');
  });

  it('offers a draft the rewrite and the confirmation, and nothing further', async () => {
    const harness = await startAutomationApp();
    await seedWorkDefinition(harness);
    const html = await (await harness.fetch('/')).text();
    expect(html).toContain('data-action="confirm"');
    expect(html).toContain('data-form="revise"');
    // The permissions cannot be asked for until the person has settled what the work is.
    expect(html).not.toContain('data-action="submit"');
    expect(html).not.toContain('data-action="approve"');
  });

  it('offers a confirmed definition the permission question', async () => {
    const harness = await startAutomationApp();
    await seedWorkDefinition(harness, { status: 'CONFIRMED' });
    const html = await (await harness.fetch('/')).text();
    expect(html).toContain('data-action="submit"');
    expect(html).not.toContain('data-action="confirm"');
  });

  it('prints the presented permissions and offers approval, not provisioning', async () => {
    const harness = await startAutomationApp();
    await seedWorkDefinition(harness, { status: 'CONFIRMED' });
    await seedAgentDefinition(harness);
    const html = await (await harness.fetch('/')).text();
    expect(html).toContain('data-section="agent-definition"');
    expect(html).toContain('data-approved="false"');
    for (const capability of PRESENTED_CAPABILITIES) expect(html).toContain(capability);
    expect(html).toContain(APPROVAL_NOTE);
    expect(html).toContain('data-action="approve"');
    expect(html).not.toContain('data-action="provision"');
  });

  it('offers provisioning only once the person has approved', async () => {
    const harness = await startAutomationApp();
    await seedWorkDefinition(harness, { status: 'CONFIRMED' });
    await seedAgentDefinition(harness, { approved_by: SUBJECT, approved_at: '2026-01-02T00:00:00.000Z' });
    const html = await (await harness.fetch('/')).text();
    expect(html).toContain('data-approved="true"');
    expect(html).toContain('data-action="provision"');
    expect(html).not.toContain('data-action="approve"');
  });

  it('links to the agents that appear on the timeline', async () => {
    const harness = await startAutomationApp();
    const event = validateActivityEvent({
      event_id: 'ev-1', trace_id: 'tr-1', human_subject: SUBJECT, agent_id: AGENT_ID, task_id: 'provisioning',
      occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-provisioner', phase: 'provisioning', outcome: 'success',
      title: 'Agent を作りました', message: 'Agent を作りました。',
      detail: { event_type: 'PROVISIONED', purpose: '毎朝の日報をまとめる' },
      related_finding_id: null, is_simulated: false,
    }) as ActivityEvent;
    await harness.documents.set('user_activity', event.event_id, { ...event, expire_at: '2026-01-08T00:00:00.000Z' });

    const html = await (await harness.fetch('/')).text();
    expect(html).toContain(`href="/agents/${AGENT_ID}"`);
    expect(html).toContain('毎朝の日報をまとめる');
  });

  it('serves the script and the stylesheet the page names', async () => {
    const harness = await startAutomationApp();
    const script = await harness.fetch('/home.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(await script.text()).toContain('/api/work-definitions/');
    const style = await harness.fetch('/styles/app.css');
    expect(style.status).toBe(200);
    expect(style.headers.get('content-type')).toContain('text/css');
  });
});

/**
 * The chain the screen exists for, walked through the app's own routes: a draft, its
 * confirmation, the decision it produces, the approval of that decision, and the agent.
 * Each step is checked on the page, because a step whose button never appears is a step
 * a person cannot take.
 */
describe('the flow from a blank form to an agent', () => {
  it('carries one piece of work all the way through', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: (url) => (url.includes('/api/work-requests')
        ? Response.json({
          decision_id: 'dec_1',
          effective_capabilities: [...PRESENTED_CAPABILITIES],
          security_profile: { isolation_level: 'standard' },
        })
        : Response.json({ status: 'PROVISIONED', agent_id: AGENT_ID }, { status: 201 })),
    });

    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: '毎朝の日報をまとめる', operations: ['作業記録を読む'], requested_lifetime_minutes: 120 }),
    })).json() as { work_definition_id: string };

    const draftPage = await (await harness.fetch('/')).text();
    expect(draftPage).toContain(`data-work-definition-id="${created.work_definition_id}"`);
    expect(draftPage).toContain('data-status="DRAFT"');

    expect((await harness.fetch(`/api/work-definitions/${created.work_definition_id}/confirm`, { method: 'POST' })).status).toBe(200);
    expect(await (await harness.fetch('/')).text()).toContain('data-action="submit"');

    const decision = await (await harness.fetch(`/api/work-definitions/${created.work_definition_id}/submit`, { method: 'POST' })).json() as {
      agent_definition_id: string;
    };
    const presentedPage = await (await harness.fetch('/')).text();
    expect(presentedPage).toContain(`data-agent-definition-id="${decision.agent_definition_id}"`);
    expect(presentedPage).toContain('data-action="approve"');

    expect((await harness.fetch(`/api/agent-definitions/${decision.agent_definition_id}/approve`, { method: 'POST' })).status).toBe(200);
    expect(await (await harness.fetch('/')).text()).toContain('data-action="provision"');

    const provisioned = await harness.fetch(`/api/agent-definitions/${decision.agent_definition_id}/provision`, { method: 'POST' });
    expect(provisioned.status).toBe(201);
    expect(await provisioned.json()).toMatchObject({ agent_id: AGENT_ID });
  });
});

describe('the agent screen', () => {
  it('carries the instruction box and the stop button behind the ownership check', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    const html = await (await harness.fetch(`/agents/${AGENT_ID}`)).text();
    expect(html).toContain('data-section="controls"');
    expect(html).toContain('data-form="instruction"');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain(STOP_NOTE);
    expect(html).toContain('<script type="module" src="/agent-detail.js">');
  });

  it("shows no controls for someone else's agent, because the page is not served at all", async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { humanSubject: 'someone-else' });
    expect((await harness.fetch(`/agents/${AGENT_ID}`)).status).toBe(404);
  });
});

describe("the browser half's decisions", () => {
  it('sends each button to the route that step belongs to', () => {
    expect(actionUrl('confirm', 'wd_1')).toBe('/api/work-definitions/wd_1/confirm');
    expect(actionUrl('submit', 'wd_1')).toBe('/api/work-definitions/wd_1/submit');
    expect(actionUrl('approve', 'ad_1')).toBe('/api/agent-definitions/ad_1/approve');
    expect(actionUrl('provision', 'ad_1')).toBe('/api/agent-definitions/ad_1/provision');
    expect(actionUrl('confirm', 'wd/1')).toBe('/api/work-definitions/wd%2F1/confirm');
    expect(isHomeAction('use-suggestion')).toBe(false);
    expect(isHomeAction(null)).toBe(false);
  });

  /**
   * RULE-37: the consent URL is followed, never built here. An agent id means the agent
   * exists, so the person is taken to it; anything else leaves the page to re-read its
   * own state rather than guess at what happened.
   */
  it('follows the consent url the Provisioner named, and otherwise the new agent', () => {
    expect(afterProvision({ status: 'IDP_CONSENT_REQUIRED', consent_url: 'https://agent-op.test/consent' }))
      .toEqual({ kind: 'navigate', url: 'https://agent-op.test/consent' });
    expect(afterProvision({ status: 'PROVISIONED', agent_id: AGENT_ID }))
      .toEqual({ kind: 'navigate', url: `/agents/${AGENT_ID}` });
    expect(afterProvision({ status: 'PROVISIONING' })).toEqual({ kind: 'reload' });
  });

  it('says what a refusal means, and shows an unknown one as itself', () => {
    expect(failureMessage(409, { error: 'approval_required' })).toContain('承認');
    expect(failureMessage(409, { error: 'capabilities_changed' })).toContain('権限が変わりました');
    expect(failureMessage(409, { error: 'agent_not_active' })).toContain('動いていない');
    expect(failureMessage(500, { error: 'something_new' })).toContain('something_new');
    expect(failureMessage(502, {})).toContain('502');
  });

  it('asks for whole days, so a document written this afternoon is inside today', () => {
    expect(dayRange('2026-01-01', '2026-01-07'))
      .toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-07T23:59:59.999Z' });
    expect('2026-01-07T15:00:00.000Z' <= dayRange('2026-01-01', '2026-01-07').to).toBe(true);
  });

  it('reads one list item per line and drops the blank ones', () => {
    const fields: Record<string, string> = {
      purpose: '日報', description: '',
      operations: '作業記録を読む\n\n  日報を作る  \n', user_confirmations: '', safety_notes: '',
      requested_lifetime_minutes: '2',
    };
    expect(toWorkDefinitionBody((name) => fields[name] ?? '')).toEqual({
      purpose: '日報', description: '',
      operations: ['作業記録を読む', '日報を作る'], user_confirmations: [], safety_notes: [],
      requested_lifetime_minutes: 2,
    });
  });
});
