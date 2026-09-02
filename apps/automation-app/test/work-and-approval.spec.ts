import { describe, expect, it } from 'vitest';
import { LifetimeOutOfRange, validateLifetimeHours } from '../src/work-definition/lifetime.js';
import { WORK_DEFINITION_FIELDS, confirm } from '../src/work-definition/model.js';
import { buildBusinessWorkRequest, WorkDefinitionNotConfirmed } from '../src/work-definition/submit.js';
import { BUSINESS_WORK_REQUEST_KEYS } from '../src/schemas/index.js';
import { capabilitiesHash, assertStillApproved, CapabilitiesChanged, ApprovalRequired } from '../src/agent-definition/approval.js';
import { SUGGESTION_FIELDS, suggestAutomations } from '../src/automation/suggestions.js';
import { LifetimeInput } from '../src/ui/components/lifetime-input.js';
import {
  PRESENTED_CAPABILITIES, PRESENTED_CAPABILITIES_REORDERED, PRESENTED_CAPABILITIES_WIDENED,
} from './fixtures/presented-capabilities.fixture.js';
import { startAutomationApp } from './helpers.js';

const definition = {
  work_definition_id: 'wd_1', human_subject: 'testuser', status: 'CONFIRMED' as const,
  purpose: '毎朝の日報をまとめる', description: '前日の作業記録から日報を作る',
  operations: ['作業記録を読む', '日報を作る'], user_confirmations: ['内容を確認する'], safety_notes: ['社外に送らない'],
  requested_lifetime_hours: 2, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
};

describe('the requested lifetime', () => {
  it('accepts 24 and rejects 25', () => {
    expect(validateLifetimeHours(24)).toBe(24);
    expect(() => validateLifetimeHours(25)).toThrow(LifetimeOutOfRange);
  });

  it('rejects 1.5, "3" and 0', () => {
    for (const value of [1.5, '3', 0, -1, null, undefined, Number.NaN]) {
      expect(() => validateLifetimeHours(value)).toThrow(LifetimeOutOfRange);
    }
  });

  it('answers 400 with lifetime_out_of_range', async () => {
    const harness = await startAutomationApp();
    // 25 is over the cap; 1.5 is not a whole hour; "3" is the string a form sends when
    // nobody parsed it; 0 is no life at all. None of them is rounded into range.
    for (const requested_lifetime_hours of [25, 1.5, '3', 0]) {
      const response = await harness.fetch('/api/work-definitions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'x', requested_lifetime_hours }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'lifetime_out_of_range' });
    }
  });

  it('renders the configured default with the fixed bounds', async () => {
    const html = String(await LifetimeInput({ defaultHours: 2 }));
    expect(html).toContain('value="2"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="24"');
  });
});

describe('the work definition', () => {
  it('has exactly eleven fields', async () => {
    const harness = await startAutomationApp();
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'x', operations: ['a', 'b'], requested_lifetime_hours: 3 }),
    })).json() as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual([...WORK_DEFINITION_FIELDS].sort());
  });

  it('stays DRAFT despite an LLM confirmation phrase', async () => {
    const harness = await startAutomationApp();
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: '確定しました', description: 'この内容で確定します' }),
    })).json() as { work_definition_id: string; status: string };
    expect(created.status).toBe('DRAFT');

    const afterMessage = await (await harness.fetch(`/api/work-definitions/${created.work_definition_id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '確定でお願いします' }),
    })).json() as { status: string };
    expect(afterMessage.status).toBe('DRAFT');
  });

  it('takes the five fields the model rewrote and leaves the state alone', async () => {
    const harness = await startAutomationApp({
      generate: async () => ({
        purpose: '毎朝の日報をまとめる', description: '前日の作業記録から日報を作る',
        operations: ['作業記録を読む', '日報を作る'], user_confirmations: ['内容を確認する'],
        safety_notes: ['社外に送らない'],
      }),
    });
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: '日報', description: '' }),
    })).json() as { work_definition_id: string };

    const revised = await (await harness.fetch(`/api/work-definitions/${created.work_definition_id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '前日の記録から作ってほしい' }),
    })).json() as { status: string; operations: string[]; purpose: string };
    expect(revised.status).toBe('DRAFT');
    expect(revised.operations).toEqual(['作業記録を読む', '日報を作る']);

    const stored = await harness.documents.get<{ purpose: string; status: string }>(
      'work_definitions', created.work_definition_id,
    );
    expect(stored?.purpose).toBe('毎朝の日報をまとめる');
    expect(stored?.status).toBe('DRAFT');
  });

  it('ignores an answer that tries to set the state itself', async () => {
    const harness = await startAutomationApp({
      generate: async () => ({
        status: 'CONFIRMED', purpose: '確定済み', description: '', operations: [],
        user_confirmations: [], safety_notes: [],
      }),
    });
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: '日報' }),
    })).json() as { work_definition_id: string };

    const answered = await (await harness.fetch(`/api/work-definitions/${created.work_definition_id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'これで確定してください' }),
    })).json() as { status: string; purpose: string };
    // A sixth key means the whole answer is unusable: taking the five it did get right
    // would be accepting a shape that also carried the one field it may never write.
    expect(answered.status).toBe('DRAFT');
    expect(answered.purpose).toBe('日報');
  });

  it('refuses a message with no text', async () => {
    const harness = await startAutomationApp();
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: '日報' }),
    })).json() as { work_definition_id: string };
    const response = await harness.fetch(`/api/work-definitions/${created.work_definition_id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('is confirmed only by the confirm route', async () => {
    const harness = await startAutomationApp();
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'x' }),
    })).json() as { work_definition_id: string };
    const confirmed = await (await harness.fetch(`/api/work-definitions/${created.work_definition_id}/confirm`, {
      method: 'POST',
    })).json() as { status: string };
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('keeps the order of operations', async () => {
    const harness = await startAutomationApp();
    const operations = ['三番目', '一番目', '二番目'];
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'x', operations }),
    })).json() as { work_definition_id: string };
    const stored = await harness.documents.get<{ operations: string[] }>('work_definitions', created.work_definition_id);
    expect(stored!.operations).toEqual(operations);
  });

  it('refuses to submit while still a draft', async () => {
    const harness = await startAutomationApp();
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'x' }),
    })).json() as { work_definition_id: string };
    const response = await harness.fetch(`/api/work-definitions/${created.work_definition_id}/submit`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'work_definition_not_confirmed' });
    expect(harness.upstream).toHaveLength(0);
  });
});

describe('the business work request', () => {
  it('body has exactly 5 keys', () => {
    const body = buildBusinessWorkRequest(definition);
    expect(Object.keys(body).sort()).toEqual([...BUSINESS_WORK_REQUEST_KEYS].sort());
  });

  it('names no capability, scope, audience or tool', () => {
    const serialized = JSON.stringify(buildBusinessWorkRequest(definition));
    for (const word of ['capability', 'scope', 'audience', 'tool_id', 'isolation']) {
      expect(serialized).not.toContain(word);
    }
  });

  it('refuses a draft', () => {
    expect(() => buildBusinessWorkRequest({ ...definition, status: 'DRAFT' })).toThrow(WorkDefinitionNotConfirmed);
  });

  it('reaches the Authorization Platform with five keys and a proof', async () => {
    const harness = await startAutomationApp();
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: '日報を作る' }),
    })).json() as { work_definition_id: string };
    await harness.fetch(`/api/work-definitions/${created.work_definition_id}/confirm`, { method: 'POST' });
    await harness.fetch(`/api/work-definitions/${created.work_definition_id}/submit`, { method: 'POST' });

    const call = harness.upstream.at(-1)!;
    expect(call.url).toBe('https://authorization.test/api/work-requests');
    expect(Object.keys(JSON.parse(call.init.body as string) as object)).toHaveLength(5);
    expect((call.init.headers as Record<string, string>).DPoP).toBeTruthy();
  });

  /**
   * The decision has to land somewhere a person can approve. Without this record the
   * Authorization Platform answered and the flow stopped: `/approve` and `/provision`
   * both address an agent definition, and nothing in production made one.
   */
  it('records the agent definition the decision produced', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: () => Response.json({
        decision_id: 'dec_00000000-0000-4000-8000-000000000000',
        status: 'decided',
        effective_capabilities: ['document.read'],
        security_profile: { risk_score: 10, isolation_level: 'standard', reasons: [] },
        denied: [],
      }, { status: 200 }),
    });
    const created = await (await harness.fetch('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: '日報を作る' }),
    })).json() as { work_definition_id: string };
    await harness.fetch(`/api/work-definitions/${created.work_definition_id}/confirm`, { method: 'POST' });

    const submitted = await (await harness.fetch(
      `/api/work-definitions/${created.work_definition_id}/submit`, { method: 'POST' },
    )).json() as { agent_definition_id: string };

    expect(submitted.agent_definition_id).toMatch(/^ad_/);
    const stored = await harness.documents.get<{
      decision_id: string; presented_capabilities: string[]; isolation_level: string; approved_at: string | null;
    }>('agent_definitions', submitted.agent_definition_id);
    expect(stored!.decision_id).toBe('dec_00000000-0000-4000-8000-000000000000');
    expect(stored!.presented_capabilities).toEqual(['document.read']);
    expect(stored!.isolation_level).toBe('standard');
    // Recorded, not approved: the approval is a separate act by a person.
    expect(stored!.approved_at).toBeNull();
  });

  /**
   * A token addressed elsewhere is not sent, and the failure is local. Presenting an
   * `aud=agent-provisioner` token to the Authorization Platform would be refused at the
   * far end anyway; refusing it here means the mistake has a name at the place that
   * made it, and the token never leaves this process (DEV-12).
   */
  it('does not send when the session token is for a different audience', async () => {
    for (const options of [{ authorizationAudience: 'agent-provisioner' }, { scope: 'nothing:useful' }]) {
      const harness = await startAutomationApp(options);
      const created = await (await harness.fetch('/api/work-definitions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'x' }),
      })).json() as { work_definition_id: string };
      await harness.fetch(`/api/work-definitions/${created.work_definition_id}/confirm`, { method: 'POST' });
      const response = await harness.fetch(`/api/work-definitions/${created.work_definition_id}/submit`, { method: 'POST' });
      expect(response.status).toBe(500);
      expect(harness.upstream).toHaveLength(0);
    }
  });
});

describe('approval', () => {
  it('is order-independent', async () => {
    expect(await capabilitiesHash(['b', 'a'])).toBe(await capabilitiesHash(['a', 'b']));
    // The same set the person was shown, listed in another order, is the same approval.
    expect(await capabilitiesHash([...PRESENTED_CAPABILITIES_REORDERED]))
      .toBe(await capabilitiesHash([...PRESENTED_CAPABILITIES]));
  });

  it('notices a capability that appeared after approval', async () => {
    const approved = {
      agent_definition_id: 'ad_1', human_subject: 'testuser', work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: [...PRESENTED_CAPABILITIES],
      presented_capabilities_hash: await capabilitiesHash([...PRESENTED_CAPABILITIES]),
      isolation_level: 'standard', approved_by: 'testuser', approved_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    await expect(assertStillApproved(approved, [...PRESENTED_CAPABILITIES])).resolves.toBeUndefined();
    await expect(assertStillApproved(approved, [...PRESENTED_CAPABILITIES_REORDERED])).resolves.toBeUndefined();
    await expect(assertStillApproved(approved, [...PRESENTED_CAPABILITIES_WIDENED])).rejects.toThrow(CapabilitiesChanged);
    await expect(assertStillApproved({ ...approved, approved_at: null }, [...PRESENTED_CAPABILITIES]))
      .rejects.toThrow(ApprovalRequired);
  });

  it('provision without approval returns 409', async () => {
    const harness = await startAutomationApp();
    await harness.documents.set('agent_definitions', 'ad_1', {
      agent_definition_id: 'ad_1', human_subject: 'testuser', work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: ['a'], presented_capabilities_hash: await capabilitiesHash(['a']),
      isolation_level: 'standard', approved_by: null, approved_at: null, created_at: '2026-01-01T00:00:00.000Z',
    });
    const response = await harness.fetch('/api/agent-definitions/ad_1/provision', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'approval_required' });
    expect(harness.upstream).toHaveLength(0);
  });

  it('returns capabilities_changed when the decision moved underneath', async () => {
    const harness = await startAutomationApp();
    await harness.documents.set('agent_definitions', 'ad_1', {
      agent_definition_id: 'ad_1', human_subject: 'testuser', work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: ['a'], presented_capabilities_hash: await capabilitiesHash(['a']),
      isolation_level: 'standard', approved_by: 'testuser', approved_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await harness.authorizationSeed.set('authorization_decisions', 'dec_1', { effective_capabilities: ['a', 'b'] });
    const response = await harness.fetch('/api/agent-definitions/ad_1/provision', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'capabilities_changed' });
    expect(harness.upstream).toHaveLength(0);
  });

  it('refuses to approve twice', async () => {
    const harness = await startAutomationApp();
    await harness.documents.set('agent_definitions', 'ad_1', {
      agent_definition_id: 'ad_1', human_subject: 'testuser', work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: ['a'], presented_capabilities_hash: await capabilitiesHash(['a']),
      isolation_level: 'standard', approved_by: null, approved_at: null, created_at: '2026-01-01T00:00:00.000Z',
    });
    expect((await harness.fetch('/api/agent-definitions/ad_1/approve', { method: 'POST' })).status).toBe(200);
    expect((await harness.fetch('/api/agent-definitions/ad_1/approve', { method: 'POST' })).status).toBe(409);
  });

  it("refuses to approve someone else's definition, and says only that it is not there", async () => {
    const harness = await startAutomationApp();
    await harness.documents.set('agent_definitions', 'ad_other', {
      agent_definition_id: 'ad_other', human_subject: 'someone-else', work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: ['a'], presented_capabilities_hash: await capabilitiesHash(['a']),
      isolation_level: 'standard', approved_by: null, approved_at: null, created_at: '2026-01-01T00:00:00.000Z',
    });
    const response = await harness.fetch('/api/agent-definitions/ad_other/approve', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    // Nothing was written: an approval by the wrong person is not a partial approval.
    const stored = await harness.documents.get<{ approved_by: string | null }>('agent_definitions', 'ad_other');
    expect(stored?.approved_by).toBeNull();
  });

  it('sends the provisioning request once everything still matches', async () => {
    const harness = await startAutomationApp();
    await harness.documents.set('agent_definitions', 'ad_1', {
      agent_definition_id: 'ad_1', human_subject: 'testuser', work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: ['a'], presented_capabilities_hash: await capabilitiesHash(['a']),
      isolation_level: 'standard', approved_by: 'testuser', approved_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await harness.authorizationSeed.set('authorization_decisions', 'dec_1', { effective_capabilities: ['a'] });
    // The lifetime the person asked for, on the work definition this agent is for.
    await harness.documents.set('work_definitions', 'wd_1', {
      work_definition_id: 'wd_1', human_subject: 'testuser', status: 'CONFIRMED',
      purpose: '書類を読む', description: '毎朝', operations: [], user_confirmations: [], safety_notes: [],
      requested_lifetime_hours: 3,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    });

    expect((await harness.fetch('/api/agent-definitions/ad_1/provision', { method: 'POST' })).status).toBe(200);

    const call = harness.upstream.at(-1)!;
    expect(call.url).toBe('https://provisioner.test/provisioning');
    // The Provisioner's schema is closed: three keys, and `agent_definition_id` is not
    // one of them, so sending it made every provisioning request a 400.
    expect(JSON.parse(String(call.init.body))).toEqual({
      decision_id: 'dec_1', task_id: 'wd_1', requested_lifetime_hours: 3,
    });
  });
});

/**
 * The other half of the consent round trip. The Agent OP redirects the browser here
 * after the person approves, so a missing route means every consent silently ends at a
 * 404 and the provisioning it paused is never resumed.
 */
describe('returning from a consent screen', () => {
  it('presents the one-time code to the Provisioner and comes back to the dashboard', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: () => Response.json({ status: 'RESUMABLE', transaction_id: 'txn-1' }, { status: 200 }),
    });

    const response = await harness.fetch('/provisioning/resume?transaction_id=txn-1&code=one-time', { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const call = harness.upstream.at(-1)!;
    expect(call.url).toBe('https://provisioner.test/provisioning/txn-1/resume');
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(String(call.init.body))).toEqual({ one_time_code: 'one-time' });
  });

  it('follows a second consent url rather than building one', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: () => Response.json(
        { status: 'CONSENT_REQUIRED', transaction_id: 'txn-1', consent_url: 'https://google-bridge.test/stub/oauth/start' },
        { status: 200 },
      ),
    });

    const response = await harness.fetch('/provisioning/resume?transaction_id=txn-1&code=one-time', { redirect: 'manual' });

    expect(response.headers.get('location')).toBe('https://google-bridge.test/stub/oauth/start');
  });

  it('refuses a return with no session and answers a failed resume with a page', async () => {
    const harness = await startAutomationApp({ upstreamHandler: () => new Response('{}', { status: 409 }) });
    const noSession = await harness.fetch('/provisioning/resume?transaction_id=txn-1&code=one-time', {
      headers: { cookie: '' },
    });
    expect(noSession.status).toBe(401);

    const failed = await harness.fetch('/provisioning/resume?transaction_id=txn-1&code=one-time');
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain('やり直して');
  });
});

describe('automation suggestions', () => {
  it('schema violation yields empty list', async () => {
    const harness = await startAutomationApp({ generate: async () => ({ suggestions: [{ purpose: 'incomplete' }] }) });
    const response = await harness.fetch('/api/automation/suggestions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'a', to: 'b' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [] });
  });

  it('answers 200 with an empty list when the model throws', async () => {
    const result = await suggestAutomations({
      signals: [], promptTemplate: '{{signals}}', generate: async () => { throw new Error('vertex down'); },
    });
    expect(result).toEqual({ suggestions: [] });
  });

  it('keeps the candidates that have all six fields', async () => {
    const good = {
      candidate_id: 'c1', purpose: '日報作成', description: '毎朝', operations: ['読む'],
      user_confirmations: ['確認'], safety_notes: ['注意'],
    };
    const result = await suggestAutomations({
      signals: [], promptTemplate: '{{signals}}',
      generate: async () => ({ suggestions: [good, { purpose: 'broken' }] }),
    });
    expect(result.suggestions).toHaveLength(1);
    expect(Object.keys(result.suggestions[0]!).sort()).toEqual([...SUGGESTION_FIELDS].sort());
  });
});

describe('the confirmation transition', () => {
  it('is a pure function of the definition and the clock', () => {
    const confirmed = confirm({ ...definition, status: 'DRAFT' }, '2026-02-01T00:00:00.000Z');
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(definition.status).toBe('CONFIRMED');
  });
});
