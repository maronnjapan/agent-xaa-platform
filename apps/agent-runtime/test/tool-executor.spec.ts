import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwsUnverified, sha256Base64Url } from '@xaa/crypto';
import { ID_JAG_TOKEN_TYPE, JWT_BEARER_GRANT_TYPE, TOKEN_EXCHANGE_GRANT_TYPE } from '@xaa/contracts';
import { executeTool } from '../src/tool-executor/index.js';
import { TOOL_ERROR_CODES } from '../src/tool-executor/errors.js';
import { assertNotExpired } from '../src/tool-executor/steps/expiration.js';
import { buildToolIndex, resolveAllowedTool } from '../src/tool-executor/steps/allowed-tools.js';
import { buildTokenExchangeBody, TOKEN_EXCHANGE_BODY_KEYS } from '../src/tool-executor/steps/token-exchange.js';
import { selectRedeemer } from '../src/tool-executor/steps/select-redeemer.js';
import { redeemIdJag } from '../src/tool-executor/steps/redeem-id-jag.js';
import { redeemViaBridge } from '../src/tool-executor/steps/redeem-via-bridge.js';
import { verifyConstraints } from '../src/tool-executor/steps/verify-constraints.js';
import { buildApiRequest } from '../src/tool-executor/steps/build-api-request.js';
import { projectResponse } from '../src/tool-executor/steps/project-response.js';
import { parseToolCall, isInvalidToolCall } from '../src/reasoning/parse-tool-call.js';
import { asResourceAccessToken, buildResourceAuthorization } from '../src/http/resource-authorization.js';
import { invokerAuthorizationHeader, type InvokerIdToken } from '../src/http/internal-invoker-token.js';
import { AGENT_OP, DOCS_API, DOCS_AS, docsManifest, fakeIdToken, json, testContext, testHttp } from './helpers.js';

const JWT_ANYWHERE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

function happyPath(body: unknown = { documents: [{ document_id: 'd1', title: 'T', secret: 's' }] }) {
  return (url: string): Response => {
    if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
    if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'id.jag.token', issued_token_type: ID_JAG_TOKEN_TYPE, expires_in: 300 });
    if (url.startsWith(`${DOCS_AS}/token`)) return json({ access_token: 'access.token.value', token_type: 'DPoP', expires_in: 300 });
    return json(body);
  };
}

describe('step2, allowed tools', () => {
  it('returns tool_not_allowed without any http call', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, () => json({}));
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.finance.payment.approve', parameters: {} });
    expect(result).toMatchObject({
      outcome: 'blocked', reason: 'not_in_allowed_tools', error_code: 'tool_not_allowed', stage: 'tool_selection',
    });
    expect(calls).toHaveLength(0);
  });

  it('does not match by prefix or case', () => {
    const index = buildToolIndex(docsManifest());
    for (const candidate of ['internal.document', 'INTERNAL.DOCUMENT.LIST', 'internal.document.list.extra', ' internal.document.list']) {
      expect(resolveAllowedTool(index, candidate)).toMatchObject({ reason: 'not_in_allowed_tools' });
    }
    expect(resolveAllowedTool(index, 'internal.document.list')).toMatchObject({ tool_id: 'internal.document.list' });
  });

  it('names eleven error codes and no more', () => {
    expect(TOOL_ERROR_CODES).toHaveLength(11);
  });

  it('never mutates the allowed tool set', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const files: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (entry.name.endsWith('.ts')) files.push(await readFile(full, 'utf8'));
      }
    };
    await walk(root);
    for (const text of files) expect(text).not.toMatch(/manifest\.tools\.push|manifest\.tools\s*=/);
  });
});

describe('step3, expiration', () => {
  it('stops before any agent op call when expired', async () => {
    const manifest = { ...docsManifest(), expires_at: '2020-01-01T00:00:00.000Z' };
    const context = await testContext({ manifest });
    const { http, calls } = testHttp(context, happyPath());
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'agent_expired', error_code: 'agent_expired' });
    expect(calls).toHaveLength(0);
  });

  it('is identical under TZ=UTC and TZ=Asia/Tokyo', () => {
    const expiresAt = '2026-06-01T00:00:00.000Z';
    const before = Date.parse('2026-05-31T23:59:59.000Z');
    const results: Array<unknown> = [];
    for (const zone of ['UTC', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      results.push(assertNotExpired(before, expiresAt, 't'), assertNotExpired(before + 2000, expiresAt, 't'));
    }
    delete process.env.TZ;
    expect(results[0]).toBeNull();
    expect(results[2]).toBeNull();
    expect(results[1]).toMatchObject({ reason: 'agent_expired' });
    expect(results[3]).toMatchObject({ reason: 'agent_expired' });
  });

  it('re-evaluates on every tool call', async () => {
    const expiresAt = new Date(Date.now() + 50).toISOString();
    const context = await testContext({ manifest: { ...docsManifest(), expires_at: expiresAt } });
    const { http } = testHttp(context, happyPath());
    const deps = { context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} };
    const first = await executeTool(deps, { tool_id: 'internal.document.list', parameters: {} });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await executeTool(deps, { tool_id: 'internal.document.list', parameters: {} });
    expect(first.outcome).toBe('success');
    expect(second).toMatchObject({ reason: 'agent_expired' });
  });

  it('leaves the AGENT_EXPIRED activity event to the Lifecycle Manager', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const walk = async (path: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full));
        else if (entry.name.endsWith('.ts')) out.push(await readFile(full, 'utf8'));
      }
      return out;
    };
    for (const text of await walk(root)) expect(text).not.toContain('AGENT_EXPIRED');
  });
});

describe('step4, token exchange', () => {
  it('body has exactly nine keys', () => {
    const body = buildTokenExchangeBody({
      tool: docsManifest().tools[0]!, subjectToken: 'subject', actorToken: 'actor',
    });
    expect(Object.keys(body).sort()).toEqual([...TOKEN_EXCHANGE_BODY_KEYS].sort());
    expect(Object.keys(body)).toHaveLength(9);
    expect(body.grant_type).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
  });

  it('ignores llm-supplied api_base_url and scope', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, happyPath());
    await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} }, {
      tool_id: 'internal.document.list',
      parameters: { api_base_url: 'https://evil.example.test', scope: 'finance.tx.write', audience: 'https://evil.example.test' },
    });
    const exchange = calls.find((call) => call.url.startsWith(`${AGENT_OP}/xaa/token`))!;
    const sent = new URLSearchParams(exchange.init.body as string);
    expect(sent.get('scope')).toBe('docs.read');
    expect(sent.get('audience')).toBe(DOCS_AS);
    expect(calls.every((call) => !call.url.includes('evil.example.test'))).toBe(true);
  });

  it('does not retry on 5xx', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, (url) => {
      if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
      return json({ error: 'server_error' }, 500);
    });
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    expect(result).toMatchObject({ outcome: 'failed', error_code: 'agent_op_error', status: 500 });
    expect(calls.filter((call) => call.url.startsWith(`${AGENT_OP}/xaa/token`))).toHaveLength(1);
  });

  it('sends a dpop header with no ath on the exchange', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, happyPath());
    await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    const exchange = calls.find((call) => call.url.startsWith(`${AGENT_OP}/xaa/token`))!;
    const proof = (exchange.init.headers as Record<string, string>).DPoP!;
    expect(decodeJwsUnverified(proof).payload).not.toHaveProperty('ath');
    expect(decodeJwsUnverified(proof).header.typ).toBe('dpop+jwt');
  });

  it('rejects an issued_token_type that is not an ID-JAG', async () => {
    const context = await testContext();
    const { http } = testHttp(context, (url) => {
      if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
      if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'x', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' });
      return json({});
    });
    expect(await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} }))
      .toMatchObject({ error_code: 'unexpected_token_type' });
  });
});

describe('step5, redemption at the resource AS', () => {
  it('sends no client_secret and no basic auth', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, happyPath());
    await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    const redeem = calls.find((call) => call.url === `${DOCS_AS}/token`)!;
    const body = new URLSearchParams(redeem.init.body as string);
    expect(body.get('grant_type')).toBe(JWT_BEARER_GRANT_TYPE);
    expect(body.get('client_id')).toBe('agent-platform');
    expect(body.get('client_secret')).toBeNull();
    expect((redeem.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('rejects a non-DPoP token_type', async () => {
    const context = await testContext();
    const { http } = testHttp(context, (url) => {
      if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
      if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'i.j.k', issued_token_type: ID_JAG_TOKEN_TYPE });
      if (url === `${DOCS_AS}/token`) return json({ access_token: 'a.b.c', token_type: 'Bearer' });
      return json({});
    });
    expect(await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} }))
      .toMatchObject({ error_code: 'unexpected_token_type', stage: 'access_token' });
  });

  it('never logs token strings', async () => {
    const context = await testContext();
    const lines: string[] = [];
    const { http } = testHttp(context, happyPath());
    await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: (line) => lines.push(line) },
      { tool_id: 'internal.document.list', parameters: {} });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(JWT_ANYWHERE);
  });

  it('does not retry with a different scope', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, (url) => {
      if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
      if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'i.j.k', issued_token_type: ID_JAG_TOKEN_TYPE });
      return json({ error: 'invalid_scope' }, 400);
    });
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    expect(result).toMatchObject({ error_code: 'resource_as_error', status: 400 });
    expect(calls.filter((call) => call.url === `${DOCS_AS}/token`)).toHaveLength(1);
  });
});

describe('the redeemer is chosen once, from the manifest', () => {
  it('returns one redeemer per type', () => {
    const native = docsManifest().tools[0]!;
    const bridged = { ...native, authorization: { ...native.authorization, type: 'xaa_bridge' as const }, token_provider: 'https://bridge.example.test' };
    expect(selectRedeemer(native)).toBe(redeemIdJag);
    expect(selectRedeemer(bridged)).toBe(redeemViaBridge);
  });

  it('resource as 500 does not call the bridge', async () => {
    const context = await testContext();
    let bridgeCalls = 0;
    const { http } = testHttp(context, (url) => {
      if (url.includes('bridge')) { bridgeCalls += 1; return json({}); }
      if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
      if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'i.j.k', issued_token_type: ID_JAG_TOKEN_TYPE });
      return json({}, 500);
    });
    expect(await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} }))
      .toMatchObject({ error_code: 'resource_as_error' });
    expect(bridgeCalls).toBe(0);
  });

  it('has no fallback anywhere in the source', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const walk = async (path: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full));
        else if (entry.name.endsWith('.ts')) out.push(await readFile(full, 'utf8'));
      }
      return out;
    };
    for (const text of await walk(root)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toMatch(/fallback|retryWithBridge|tryBridge/);
      expect(code).not.toMatch(/bridge.*proxy|\/bridge\/proxy/);
    }
  });
});

describe('step5.5, constraints', () => {
  const financeTool = {
    ...docsManifest().tools[1]!,
    tool_id: 'internal.finance.payment.approve' as const,
    constraints: { max_amount: 100000 },
  };

  it('over max_amount performs zero http calls', async () => {
    const context = await testContext({ manifest: { ...docsManifest(), tools: [financeTool] } });
    const { http, calls } = testHttp(context, happyPath());
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.finance.payment.approve', parameters: { id: 'p1', amount: 100001 } });
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'constraint_violation', constraint: 'max_amount' });
    expect(calls).toHaveLength(0);
  });

  it('equal to max_amount is allowed', () => {
    expect(verifyConstraints(financeTool, { amount: 100000 })).toBeNull();
    expect(verifyConstraints(financeTool, { amount: 100001 })).toMatchObject({ constraint: 'max_amount' });
  });

  it('unknown constraint key is fail-closed', () => {
    const tool = { ...financeTool, constraints: { unheard_of_limit: 3 } };
    expect(verifyConstraints(tool, {})).toMatchObject({ reason: 'constraint_violation', constraint: 'unheard_of_limit' });
  });

  it('tool without constraints passes through', () => {
    expect(verifyConstraints(docsManifest().tools[0]!, {})).toBeNull();
  });

  it('matches a recipient domain exactly', () => {
    const tool = { ...financeTool, constraints: { recipient_domain_allowlist: ['example.com'] } };
    expect(verifyConstraints(tool, { to: 'a@example.com' })).toBeNull();
    expect(verifyConstraints(tool, { to: 'a@EXAMPLE.COM' })).toBeNull();
    expect(verifyConstraints(tool, { to: 'a@evil-example.com' })).toMatchObject({ constraint: 'recipient_domain_allowlist' });
    expect(verifyConstraints(tool, { to: 'a@sub.example.com' })).toMatchObject({ constraint: 'recipient_domain_allowlist' });
  });

  it('reports the constraint name but not the value', async () => {
    const context = await testContext({ manifest: { ...docsManifest(), tools: [financeTool] } });
    const { http } = testHttp(context, happyPath());
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.finance.payment.approve', parameters: { id: 'p1', amount: 999999 } });
    expect(JSON.stringify(result)).not.toContain('999999');
  });
});

describe('step6, building the request', () => {
  const getTool = docsManifest().tools[1]!;

  it('missing required parameter performs zero http calls', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, happyPath());
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.get', parameters: {} });
    expect(result).toMatchObject({ error_code: 'missing_required_parameter', reason: 'missing_required_parameter:id' });
    expect(calls.filter((call) => call.url.startsWith(DOCS_API))).toHaveLength(0);
  });

  it('traversal value stays under base_url', () => {
    // A traversal in the value is encoded, so it stays one path segment.
    const result = buildApiRequest(getTool, { id: 'primary/../../admin' });
    expect(result).toMatchObject({ url: `${DOCS_API}/documents/primary%2F..%2F..%2Fadmin` });

    // And when base_url has a prefix, a template that climbs out of it is refused —
    // the check runs on the parsed URL, after `..` has actually been resolved.
    const scoped = {
      ...getTool,
      api: { base_url: `${DOCS_API}/v1/documents`, method: 'GET' as const, path: '/v1/documents/{id}/../../../admin' },
    };
    expect(buildApiRequest(scoped, { id: 'x' })).toMatchObject({ error_code: 'invalid_path_parameter' });
    expect(buildApiRequest({ ...scoped, api: { ...scoped.api, path: '/v1/documents/{id}' } }, { id: 'x' }))
      .toMatchObject({ url: `${DOCS_API}/v1/documents/x` });
  });

  it('unknown parameter is not sent', () => {
    const result = buildApiRequest(getTool, { id: 'd1', shadow: 'x' });
    expect(result).toMatchObject({ droppedParameters: ['shadow'] });
    expect((result as { url: string }).url).not.toContain('shadow');
  });

  it('aborts after the timeout and does not retry', async () => {
    const context = await testContext();
    let attempts = 0;
    const { http } = testHttp(context, async (url, init) => {
      if (url.startsWith(DOCS_API)) {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return happyPath()(url);
    });
    const promise = executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    await expect(promise).rejects.toThrow(/abort/i);
    expect(attempts).toBe(1);
  }, 20_000);
});

describe('step7, projecting the response', () => {
  it('drops fields not in schema', () => {
    const projected = projectResponse({ type: 'array', allowlist: ['title'] }, {
      items: [{ title: 'Sync', attendees: [{ email: 'a@example.com' }] }],
    });
    // The allow list names `title` and nothing else, so `attendees[].email` — a field
    // the calendar API really returns — is never copied into the projection.
    const items = (projected as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]).not.toHaveProperty('attendees');
    expect(JSON.stringify(projected)).not.toContain('email');
    expect(projected).toEqual({ items: [{ title: 'Sync' }] });
  });

  it('projected key set equals schema', () => {
    const projected = projectResponse({ type: 'object', allowlist: ['document_id', 'title'] }, {
      document_id: 'd1', title: 'T', body: 'secret', version: 3,
    });
    expect(Object.keys(projected as object).sort()).toEqual(['document_id', 'title']);
  });

  it('projects each array element', () => {
    const projected = projectResponse({ type: 'array', allowlist: ['document_id'] }, {
      documents: [{ document_id: 'a', body: 'x' }, { document_id: 'b', body: 'y' }],
    });
    expect(projected).toEqual({ documents: [{ document_id: 'a' }, { document_id: 'b' }] });
  });

  it('reads the nested items[] form', () => {
    const projected = projectResponse({ type: 'object', allowlist: ['items[].title'] }, {
      items: [{ title: 'a', email: 'x' }], other: 1,
    });
    expect(projected).toEqual({ items: [{ title: 'a' }] });
  });

  it('the executor hands the model only the projection', async () => {
    const context = await testContext();
    const { http } = testHttp(context, happyPath());
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    expect(result).toMatchObject({ outcome: 'success' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('the tool call the model is allowed to make', () => {
  it('ignores api_base_url and scope in llm output', () => {
    const call = parseToolCall({
      tool_id: 'internal.document.list', parameters: { q: 1 },
      api_base_url: 'https://evil.example.test', scope: 'finance.tx.write', method: 'DELETE',
    });
    expect(isInvalidToolCall(call)).toBe(false);
    expect(Object.keys(call)).toEqual(['tool_id', 'parameters']);
  });

  it('rejects a non-string tool_id', () => {
    for (const raw of [{ tool_id: 1, parameters: {} }, { tool_id: 'x' }, { parameters: {} }, null, [], 'string']) {
      expect(parseToolCall(raw)).toMatchObject({ error_code: 'invalid_tool_call' });
    }
  });

  it('reads no transport field anywhere in the source', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const walk = async (path: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full));
        else if (entry.name.endsWith('.ts')) out.push(await readFile(full, 'utf8'));
      }
      return out;
    };
    for (const text of await walk(root)) {
      expect(text).not.toMatch(/call\.(url|scope|audience|resource|method|headers)\b/);
      expect(text).not.toMatch(/\.\.\.raw|\.\.\.llm/);
    }
  });
});

describe('the bridged path', () => {
  const bridge = 'https://bridge.example.test';
  const bridged = {
    ...docsManifest().tools[0]!,
    authorization: { ...docsManifest().tools[0]!.authorization, type: 'xaa_bridge' as const },
    token_provider: bridge,
  };

  async function runBridged() {
    const context = await testContext({ manifest: { ...docsManifest(), tools: [bridged] } });
    const { http, calls } = testHttp(context, (url) => {
      if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
      if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'i.j.k', issued_token_type: ID_JAG_TOKEN_TYPE });
      if (url === `${bridge}/token`) return json({ access_token: 'saas-token', expires_in: 300 });
      return json({ documents: [{ document_id: 'd1' }] });
    });
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    return { result, calls };
  }

  it('calls bridge exactly once', async () => {
    const { result, calls } = await runBridged();
    expect(result).toMatchObject({ outcome: 'success' });
    const toBridge = calls.filter((call) => call.url.startsWith(bridge));
    expect(toBridge).toHaveLength(1);
    // One exchange, for a credential. The Bridge is never asked to run the business call.
    expect(toBridge[0]!.url).toBe(`${bridge}/token`);
  });

  it('calls saas api from the executor with bearer', async () => {
    const { calls } = await runBridged();
    // The SaaS call comes from the executor, not from the bridge acting as a proxy:
    // its URL is built from the manifest's api fields, never from the bridge's origin.
    const saas = calls.find((call) => call.url.startsWith(DOCS_API));
    expect(saas!.url).toBe(`${DOCS_API}/documents`);
    const headers = saas!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer saas-token');
    // DEC-ID-13: nothing outward-facing is DPoP-bound.
    expect(headers).not.toHaveProperty('DPoP');
  });

  it('reports a bridge failure without switching to the native path', async () => {
    const context = await testContext({ manifest: { ...docsManifest(), tools: [bridged] } });
    const { http, calls } = testHttp(context, (url) => {
      if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
      if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'i.j.k', issued_token_type: ID_JAG_TOKEN_TYPE });
      return json({ error: 'bridge_down' }, 502);
    });
    expect(await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} }))
      .toMatchObject({ error_code: 'bridge_error', status: 502 });
    expect(calls.filter((call) => call.url === `${DOCS_AS}/token`)).toHaveLength(0);
  });
});

describe('the authorization header a resource sees', () => {
  it('rejects plain string token', async () => {
    const context = await testContext();
    const request = { method: 'GET', url: `${DOCS_API}/documents` };
    // @ts-expect-error a bare string is not a ResourceAccessToken: only the two
    // response parsers can make one, so a Service Account ID Token cannot get here.
    void (() => buildResourceAuthorization('metadata-server-id-token', request, context.dpop));
    // And the brand is not reachable by hand either: the one producer demands to be
    // told which parser it is speaking for.
    const source = await readFile(new URL('../src/http/resource-authorization.ts', import.meta.url), 'utf8');
    expect(source).toContain("source: 'resource-as' | 'bridge'");
    expect(source.match(/as ResourceAccessToken/g)).toHaveLength(1);
  });

  it('rejects invoker id token', async () => {
    const context = await testContext();
    const invoker = 'invoker.id.token' as unknown as InvokerIdToken;
    // @ts-expect-error an InvokerIdToken says "this service may be called", never who
    // the agent acts for, so the resource builder does not accept one.
    void (() => buildResourceAuthorization(invoker, { method: 'GET', url: `${DOCS_API}/x` }, context.dpop));
    expect(invokerAuthorizationHeader(invoker)).toEqual({ 'X-Serverless-Authorization': 'Bearer invoker.id.token' });
  });

  it('proof includes ath of the access token', async () => {
    const context = await testContext();
    const token = asResourceAccessToken('access.token.value', 'resource-as');
    const headers = await buildResourceAuthorization(token, { method: 'GET', url: `${DOCS_API}/documents` }, context.dpop);
    expect(headers.Authorization).toBe('DPoP access.token.value');
    const proof = decodeJwsUnverified(headers.DPoP).payload;
    expect(proof.ath).toBe(await sha256Base64Url('access.token.value'));
    expect(proof.htm).toBe('GET');
    expect(proof.htu).toBe(`${DOCS_API}/documents`);
  });
});

describe('the whole call', () => {
  it('walks the seven steps and reaches the resource', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, happyPath());
    const result = await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    expect(result).toMatchObject({ outcome: 'success', tool_id: 'internal.document.list' });
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      new URL(AGENT_OP).host, new URL(AGENT_OP).host, new URL(DOCS_AS).host, new URL(DOCS_API).host,
    ]);
  });

  it('binds the resource request to the access token with ath', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, happyPath());
    await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    const call = calls.find((entry) => entry.url.startsWith(DOCS_API))!;
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('DPoP access.token.value');
    expect(decodeJwsUnverified(headers.DPoP!).payload).toHaveProperty('ath');
  });

  it('refuses a destination the manifest never named', async () => {
    const context = await testContext();
    const { http } = testHttp(context, happyPath());
    await expect(http.send('https://evil.example.test/anything', { method: 'GET' })).rejects.toThrow(/host_not_allowed/);
  });

  it('never calls the real network', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network'); });
    const context = await testContext();
    const { http } = testHttp(context, happyPath());
    await executeTool({ context, http, logger: console as never, logContext: {} as never, stageWrite: () => {} },
      { tool_id: 'internal.document.list', parameters: {} });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
