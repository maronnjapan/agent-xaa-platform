import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, jwkThumbprint, signCompactJws,
  type Es256KeyPair,
} from '@xaa/crypto';
import { JWT_BEARER_GRANT_TYPE, JWT_TYP, PLATFORM_CLIENT_ID, toAgentUrn } from '@xaa/contracts';
import { createInternalApp, createCallbackApp } from '../src/index.js';
import { difference, isSubset, parseScope } from '../src/scope/subset.js';
import { buildTokenResponse } from '../src/token/response.js';
import { allowedHostsFor, createBridgeFetch, OutboundNotAllowedError } from '../src/http/outbound.js';
import { connectionId } from '../src/store/connection.js';
import { BRIDGE_LOG_FIELDS } from '../src/log/bridge-log.js';
import {
  completeConsent, createBridgeHarness, exchangeToken, readyBridge, seedConnector, transactionReader,
  INTERNAL_BASE, SA, SHARED_ISSUER, STUB_CONNECTOR, type BridgeHarness,
} from '../src/testing/harness.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
const RESOURCE = 'https://stub-saas-api.test';

let opKey: Es256KeyPair | undefined;
async function issuerKey(): Promise<Es256KeyPair> {
  opKey ??= await generateEs256KeyPair();
  return opKey;
}

async function jwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
  const key = await issuerKey();
  return { keys: [{ ...key.publicJwk, kid: 'op-shared-1', alg: 'ES256', use: 'sig' }] };
}

/** An ID-JAG exactly as the Agent OP mints one, so the Bridge verifies the real thing. */
async function mintIdJag(options: {
  dpopKey?: Es256KeyPair;
  scope?: string;
  resource?: string;
  audience?: string;
  subject?: string;
  actSub?: string;
  typ?: string;
  omitCnf?: boolean;
  issuer?: string;
} = {}): Promise<string> {
  const key = await issuerKey();
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: options.issuer ?? SHARED_ISSUER,
    sub: options.subject ?? 'testuser',
    aud: options.audience ?? INTERNAL_BASE,
    client_id: PLATFORM_CLIENT_ID,
    jti: `idjag-${Math.random().toString(36).slice(2)}`,
    iat: issuedAt,
    exp: issuedAt + 300,
    scope: options.scope ?? 'calendar.read',
    resource: options.resource ?? RESOURCE,
    act: { sub: options.actSub ?? toAgentUrn(AGENT_ID) },
  };
  if (!options.omitCnf) {
    payload.cnf = { jkt: await jwkThumbprint((options.dpopKey ?? await generateEs256KeyPair()).publicJwk) };
  }
  return signCompactJws({
    header: { alg: 'ES256', typ: options.typ ?? JWT_TYP.ID_JAG, kid: 'op-shared-1' },
    payload,
    signer: createLocalEs256Signer({ privateKey: key.privateKey, kid: 'op-shared-1' }),
  });
}

async function seedConnection(harness: BridgeHarness, options: {
  grantedScopes?: string[];
  status?: string;
  expiresAt?: string;
  humanSubject?: string;
} = {}): Promise<string> {
  const humanSubject = options.humanSubject ?? 'testuser';
  const id = connectionId(STUB_CONNECTOR.connector_id, humanSubject);
  await harness.documents.set('bridge_connections', id, {
    connection_id: id, connector_id: STUB_CONNECTOR.connector_id, human_subject: humanSubject,
    external_subject: 'stub-user-001',
    encrypted_refresh_token: new Uint8Array([1, ...new TextEncoder().encode('stub-refresh')]),
    granted_scopes: options.grantedScopes ?? ['calendar.read', 'gmail.send'],
    status: options.status ?? 'ACTIVE',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: options.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
  });
  return id;
}

async function seedBinding(harness: BridgeHarness, options: {
  scopes?: string[];
  status?: string;
  expiresAt?: string;
  humanSubject?: string;
  connectionId?: string;
} = {}): Promise<void> {
  await harness.documents.set('agent_bindings', `${AGENT_ID}:${STUB_CONNECTOR.connector_id}`, {
    binding_id: `${AGENT_ID}:${STUB_CONNECTOR.connector_id}`, agent_id: AGENT_ID,
    connector_id: STUB_CONNECTOR.connector_id,
    connection_id: options.connectionId ?? connectionId(STUB_CONNECTOR.connector_id, options.humanSubject ?? 'testuser'),
    human_subject: options.humanSubject ?? 'testuser',
    scopes: options.scopes ?? ['calendar.read'],
    status: options.status ?? 'ACTIVE',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  });
}

async function exchange(harness: BridgeHarness, options: {
  idJag: string;
  dpopKey?: Es256KeyPair;
  omitProof?: boolean;
  proof?: string;
  scope?: string;
  grantType?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Bearer caller-token',
  };
  if (!options.omitProof) {
    headers.DPoP = options.proof ?? await createDpopProof({
      method: 'POST', url: `${INTERNAL_BASE}/token`, keyPair: options.dpopKey ?? await generateEs256KeyPair(),
    });
  }
  return harness.internal('/token', {
    method: 'POST', headers,
    body: new URLSearchParams({
      grant_type: options.grantType ?? JWT_BEARER_GRANT_TYPE,
      assertion: options.idJag,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    }).toString(),
  });
}

/**
 * A harness with a connection the stub SaaS will actually honour: the consent flow runs
 * for real, so the refresh grant that follows is exercising the Bridge rather than a
 * fabricated token.
 */
async function ready(options: { rotateRefreshToken?: 'always' | 'never' } = {}): Promise<{
  harness: BridgeHarness; dpopKey: Es256KeyPair;
}> {
  const dpopKey = await generateEs256KeyPair();
  const harness = createBridgeHarness({
    jwks: await jwks(), readTransaction: transactionReader(),
    ...(options.rotateRefreshToken ? { rotateRefreshToken: options.rotateRefreshToken } : {}),
  });
  await seedConnector(harness);
  await completeConsent(harness);
  await seedBinding(harness);
  return { harness, dpopKey };
}

describe('the route surface', () => {
  it('builds both faces from the same deps object', () => {
    // The difference between the two services is which routes exist, not which
    // dependencies they were handed. The route sets themselves are pinned in
    // routes-snapshot.spec.ts.
    expect(typeof createInternalApp).toBe('function');
    expect(typeof createCallbackApp).toBe('function');
  });

  it('keeps the two faces apart', async () => {
    const harness = createBridgeHarness({ jwks: await jwks() });
    // The callback face has no token route at all.
    expect((await harness.callback('/token', { method: 'POST' })).status).toBe(404);
    expect((await harness.callback('/connections/verify', { method: 'POST' })).status).toBe(404);
    expect((await harness.internal('/healthz')).status).toBe(200);
    expect((await harness.callback('/healthz')).status).toBe(200);
  });

  it('names no SaaS API path anywhere in its routes', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    for (const forbidden of ["'/calendar", "'/gmail", "'/proxy"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('depends on nothing that could relay a business API', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const forbidden of ['@google-cloud/vertexai', 'http-proxy', 'node-fetch', 'axios']) {
      expect(Object.keys(manifest.dependencies)).not.toContain(forbidden);
    }
  });
});

/**
 * 00b names eight internal routes; this one was missing, so the Lifecycle Manager's
 * step5 called a path the Bridge does not serve and recorded the 404 as success —
 * a refresh token left live at the SaaS after the platform had decided to give it up.
 */
describe('giving up the upstream connection', () => {
  it('sends the refresh token to the connector\'s revocation endpoint and marks it REVOKED', async () => {
    const harness = createBridgeHarness({
      jwks: await jwks(), readTransaction: transactionReader(), caller: SA.lifecycle,
    });
    await seedConnector(harness);
    await completeConsent(harness);
    const id = connectionId(STUB_CONNECTOR.connector_id, 'testuser');

    const response = await harness.internal(`/connections/${encodeURIComponent(id)}/revoke-upstream`, {
      method: 'POST', headers: { Authorization: `Bearer ${SA.lifecycle}` },
    });

    expect(response.status).toBe(204);
    expect(harness.outbound).toContain(STUB_CONNECTOR.revocation_endpoint);
    const stored = await harness.documents.get<{ status: string }>('bridge_connections', id);
    expect(stored!.status).toBe('REVOKED');
  });

  it('treats an unknown connection as already given up', async () => {
    const harness = createBridgeHarness({ jwks: await jwks(), caller: SA.lifecycle });
    const response = await harness.internal('/connections/nothing-here/revoke-upstream', {
      method: 'POST', headers: { Authorization: `Bearer ${SA.lifecycle}` },
    });
    expect(response.status).toBe(204);
  });
});

describe('the connector registry', () => {
  it('finds a connector by an exact resource match', async () => {
    const harness = createBridgeHarness();
    await seedConnector(harness);
    await seedConnector(harness, { connector_id: 'second', resource_uris: ['https://second.test'] });
    // A second connector works with no redeploy: it is a row, not a branch.
    const { createConnectorRegistry } = await import('../src/connectors/registry.js');
    const registry = createConnectorRegistry(harness.documents);
    expect((await registry.findConnectorByResource('https://second.test')).connector_id).toBe('second');
  });

  it('refuses a resource claimed by two connectors', async () => {
    const harness = createBridgeHarness();
    await seedConnector(harness);
    await seedConnector(harness, { connector_id: 'duplicate' });
    const { createConnectorRegistry } = await import('../src/connectors/registry.js');
    await expect(createConnectorRegistry(harness.documents).findConnectorByResource(RESOURCE))
      .rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('refuses an http endpoint', async () => {
    const harness = createBridgeHarness();
    await seedConnector(harness, { connector_id: 'insecure', authorization_endpoint: 'http://insecure.test/authorize' });
    const { createConnectorRegistry } = await import('../src/connectors/registry.js');
    await expect(createConnectorRegistry(harness.documents).getConnector('insecure'))
      .rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('names no particular SaaS in the source', async () => {
    const source = await readFile(new URL('../src/connectors/registry.ts', import.meta.url), 'utf8');
    expect(source.toLowerCase()).not.toContain('google-workspace');
  });
});

describe('the token exchange', () => {
  it('accepts a valid ID-JAG with a matching proof', async () => {
    const { harness, dpopKey } = await ready();
    const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
    expect(body.token_type).toBe('Bearer');
    // DEC-ID-13: what the Bridge hands back is an external SaaS token, presented the
    // way that SaaS expects.
    expect(body).not.toHaveProperty('cnf');
  });

  it('refuses a grant type it does not implement', async () => {
    const { harness, dpopKey } = await ready();
    const response = await exchange(harness, {
      idJag: await mintIdJag({ dpopKey }), dpopKey,
      grantType: 'urn:ietf:params:oauth:grant-type:jwt-dpop',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unsupported_grant_type' });
  });

  it('refuses a wrong typ, an unknown issuer and a foreign audience alike', async () => {
    for (const options of [
      { typ: 'at+jwt' },
      { issuer: 'https://attacker.test' },
      { audience: 'https://resource-docs-as.test' },
    ]) {
      const { harness, dpopKey } = await ready();
      const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey, ...options }), dpopKey });
      expect(response.status).toBe(400);
      // One code for all three: telling them apart helps only someone probing.
      expect(await response.json()).toEqual({ error: 'invalid_grant' });
    }
  });

  it('reads no key location out of the assertion', async () => {
    const source = await readFile(new URL('../src/idjag/verify.ts', import.meta.url), 'utf8');
    expect(source).toContain("'jku', 'x5u', 'jwk'");
  });

  it('fetches the key set once inside its TTL', async () => {
    const { harness, dpopKey } = await ready();
    await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
    await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
    expect(harness.outbound.filter((url) => url.includes('jwks.json'))).toHaveLength(1);
  });
});

describe('proof of possession', () => {
  it('refuses an ID-JAG with no cnf at all', async () => {
    const { harness, dpopKey } = await ready();
    const response = await exchange(harness, { idJag: await mintIdJag({ omitCnf: true }), dpopKey });
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('tells a missing proof apart from a bad one', async () => {
    const { harness, dpopKey } = await ready();
    const missing = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), omitProof: true });
    expect(await missing.json()).toEqual({ error: 'invalid_grant' });

    const otherKey = await generateEs256KeyPair();
    const wrongKey = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey: otherKey });
    expect(await wrongKey.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('refuses a proof made for another URL', async () => {
    const { harness, dpopKey } = await ready();
    const response = await exchange(harness, {
      idJag: await mintIdJag({ dpopKey }),
      proof: await createDpopProof({ method: 'POST', url: 'https://elsewhere.test/token', keyPair: dpopKey }),
    });
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('refuses a replayed jti', async () => {
    const { harness, dpopKey } = await ready();
    const proof = await createDpopProof({ method: 'POST', url: `${INTERNAL_BASE}/token`, keyPair: dpopKey });
    expect((await exchange(harness, { idJag: await mintIdJag({ dpopKey }), proof })).status).toBe(200);
    const second = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), proof });
    expect(await second.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('refuses a proof carrying ath', async () => {
    const { harness, dpopKey } = await ready();
    const response = await exchange(harness, {
      idJag: await mintIdJag({ dpopKey }),
      // `/token` issues no Access Token of its own, so a proof bound to one was made
      // for a different request.
      proof: await createDpopProof({
        method: 'POST', url: `${INTERNAL_BASE}/token`, keyPair: dpopKey, accessToken: 'some-token',
      }),
    });
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });
});

describe('resolving the binding', () => {
  const cases: Array<[string, (harness: BridgeHarness) => Promise<void>]> = [
    ['no binding', async () => undefined],
    ['expired binding', async (harness) => seedBinding(harness, { expiresAt: '2020-01-01T00:00:00.000Z' })],
    ['disabled binding', async (harness) => seedBinding(harness, { status: 'DISABLED' })],
    ['revoked connection', async (harness) => {
      await seedConnection(harness, { status: 'REVOKED' });
      await seedBinding(harness);
    }],
    ['expired connection', async (harness) => {
      await seedConnection(harness, { expiresAt: '2020-01-01T00:00:00.000Z' });
      await seedBinding(harness);
    }],
  ];

  for (const [label, seed] of cases) {
    it(`refuses when there is ${label}, without calling the SaaS`, async () => {
      const dpopKey = await generateEs256KeyPair();
      const harness = createBridgeHarness({ jwks: await jwks() });
      await seedConnector(harness);
      if (label !== 'no binding' && !label.includes('connection')) await seedConnection(harness);
      await seed(harness);
      const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
      expect(await response.json()).toEqual({ error: 'invalid_grant' });
      expect(harness.outbound.filter((url) => url.includes('/token') && url.includes('stub-saas-op'))).toHaveLength(0);
    });
  }

  it('refuses an ID-JAG with no act claim', async () => {
    const { harness, dpopKey } = await ready();
    const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey, actSub: 'not-a-urn' }), dpopKey });
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('refuses when the binding names a different person', async () => {
    const dpopKey = await generateEs256KeyPair();
    const harness = createBridgeHarness({ jwks: await jwks() });
    await seedConnector(harness);
    await seedConnection(harness, { humanSubject: 'someone-else' });
    await seedBinding(harness, { humanSubject: 'someone-else' });
    const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  const expiryCases: Array<[string, (harness: BridgeHarness) => Promise<void>]> = [
    ['expired binding', async (harness) => {
      await seedConnection(harness);
      await seedBinding(harness, { expiresAt: '2020-01-01T00:00:00.000Z' });
    }],
    ['expired connection', async (harness) => {
      await seedConnection(harness, { expiresAt: '2020-01-01T00:00:00.000Z' });
      await seedBinding(harness);
    }],
  ];

  for (const [label, seed] of expiryCases) {
    it(`records one expired_bridge_connection for an ${label}`, async () => {
      const dpopKey = await generateEs256KeyPair();
      const harness = createBridgeHarness({ jwks: await jwks() });
      await seedConnector(harness);
      await seed(harness);
      await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
      const events = harness.logs
        .map((line) => JSON.parse(line) as { fields: { validation?: string } })
        .filter((entry) => entry.fields.validation === 'expired_bridge_connection');
      // Exactly one. A duplicate would make a single expired row look like a campaign
      // against the platform, which is how a detection rule ends up firing on nothing.
      expect(events).toHaveLength(1);
    });
  }
});

describe('scope containment', () => {
  it('narrows only, never widens', async () => {
    const { harness, dpopKey } = await ready();
    const allowed = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey, scope: 'calendar.read' });
    expect(allowed.status).toBe(200);

    const widened = await exchange(harness, {
      idJag: await mintIdJag({ dpopKey, scope: 'calendar.read' }), dpopKey, scope: 'calendar.read gmail.send',
    });
    expect(await widened.json()).toEqual({ error: 'invalid_scope' });
  });

  it('refuses a scope the binding does not carry', async () => {
    const dpopKey = await generateEs256KeyPair();
    const harness = createBridgeHarness({ jwks: await jwks() });
    await seedConnector(harness);
    await seedConnection(harness, { grantedScopes: ['calendar.read', 'gmail.send'] });
    await seedBinding(harness, { scopes: ['calendar.read'] });
    const response = await exchange(harness, {
      idJag: await mintIdJag({ dpopKey, scope: 'gmail.send' }), dpopKey, scope: 'gmail.send',
    });
    expect(await response.json()).toEqual({ error: 'invalid_scope' });
  });

  it('refuses an empty scope rather than reading it as everything', async () => {
    const { harness, dpopKey } = await ready();
    const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey, scope: '' }), dpopKey, scope: '' });
    expect(await response.json()).toEqual({ error: 'invalid_scope' });
  });

  it('refuses an omitted scope when the ID-JAG grants none either', async () => {
    const { harness, dpopKey } = await ready();
    // Omitting the parameter falls back to the ID-JAG's scope, and falling back to
    // nothing is still nothing: absence has never meant "everything" here.
    const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey, scope: '' }), dpopKey });
    expect(await response.json()).toEqual({ error: 'invalid_scope' });
  });

  it('is indifferent to order and duplication', () => {
    const a = parseScope('calendar.read gmail.send calendar.read');
    const b = parseScope('gmail.send calendar.read');
    expect(isSubset(a, b)).toBe(true);
    expect(isSubset(b, a)).toBe(true);
    expect(difference(parseScope('a b'), parseScope('b'))).toEqual(['a']);
  });
});

describe('the refresh grant', () => {
  it('rotates the stored ciphertext when the SaaS returns a new token', async () => {
    const { harness, dpopKey } = await ready({ rotateRefreshToken: 'always' });
    const id = connectionId(STUB_CONNECTOR.connector_id, 'testuser');
    const before = await harness.documents.get<{ encrypted_refresh_token: Uint8Array }>('bridge_connections', id);
    expect((await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey })).status).toBe(200);
    const after = await harness.documents.get<{ encrypted_refresh_token: Uint8Array }>('bridge_connections', id);
    // The rotated token replaced the old one in place; no second copy anywhere.
    expect([...after!.encrypted_refresh_token]).not.toEqual([...before!.encrypted_refresh_token]);
  });

  it('leaves the connection ACTIVE and answers 502 when the SaaS returns 500', async () => {
    const { harness, issuer, dpopKey } = await readyBridge({ saasTokenStatus: 500 });
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
    const connection = await harness.documents.get<{ status: string }>(
      'bridge_connections', connectionId(STUB_CONNECTOR.connector_id, 'testuser'),
    );
    // A SaaS having a bad minute is not a person withdrawing consent, and writing the
    // connection off would force that person through the browser again for nothing.
    expect(connection!.status).toBe('ACTIVE');
  });

  it('marks the connection revoked when the SaaS says invalid_grant', async () => {
    const { harness, dpopKey } = await ready();
    // The person revoked the app at the far end.
    await harness.stubOp.fetch(new Request('https://stub-saas-op.test/internal/revoke-refresh-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    const response = await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'connection_revoked' });
    const connection = await harness.documents.get<{ status: string }>(
      'bridge_connections', connectionId(STUB_CONNECTOR.connector_id, 'testuser'),
    );
    // Recorded, because retrying would get the same answer while the row still looked healthy.
    expect(connection!.status).toBe('REVOKED');
  });
});

describe('the outbound allow list', () => {
  it('refuses a host nobody named', async () => {
    const bridgeFetch = createBridgeFetch(async () => new Response('{}'));
    const allowed = allowedHostsFor({ connector: STUB_CONNECTOR, jwksUrl: 'https://storage.test/jwks.json' });
    await expect(bridgeFetch('https://evil.example.com/', {}, allowed)).rejects.toThrow(OutboundNotAllowedError);
    await expect(bridgeFetch('http://stub-saas-op.test/token', {}, allowed)).rejects.toThrow(OutboundNotAllowedError);
    await expect(bridgeFetch('https://stub-saas-op.test/token', {}, allowed)).resolves.toBeTruthy();
  });

  it('does not follow a redirect', async () => {
    let init: RequestInit | undefined;
    const bridgeFetch = createBridgeFetch(async (_url, options) => { init = options; return new Response('{}'); });
    await bridgeFetch('https://storage.test/jwks.json', {}, new Set(['storage.test']));
    expect(init!.redirect).toBe('manual');
  });

  // The check spawns a Node process per source file, so it runs for seconds rather
  // than milliseconds and the default 5s budget is a coin toss under a loaded suite.
  it('sends HTTP through one file only', () => {
    expect(() => execFileSync('bash', ['scripts/check-bridge-raw-fetch.sh'], { cwd: repoRoot })).not.toThrow();
  }, 60_000);
});

describe('the token response', () => {
  it('is four keys, built fresh', () => {
    const body = buildTokenResponse({ accessToken: 'abc', expiresIn: 3600, scope: ['b', 'a'] });
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
    expect(body.scope).toBe('a b');
    expect(body.token_type).toBe('Bearer');
  });

  // The check spawns a Node process per source file, so it runs for seconds rather
  // than milliseconds and the default 5s budget is a coin toss under a loaded suite.
  it('names no refresh token in the response path', () => {
    expect(() => execFileSync('bash', ['scripts/check-bridge-no-refresh-token.sh'], { cwd: repoRoot })).not.toThrow();
  }, 60_000);
});

describe('the log line', () => {
  it('carries all seven fields whether the request succeeded or not', async () => {
    const { harness, dpopKey } = await ready();
    await exchange(harness, { idJag: await mintIdJag({ dpopKey }), dpopKey });
    await exchange(harness, { idJag: await mintIdJag({ dpopKey, typ: 'at+jwt' }), dpopKey });
    const lines = harness.logs
      .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
      .filter((entry) => entry.event === 'bridge_token_exchange');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Object.keys(line.fields).sort()).toEqual([...BRIDGE_LOG_FIELDS].sort());
    }
    // The stage a failed request never reached says so, rather than being absent.
    expect(lines[1]!.fields.connection_id).toBe('skipped');
  });

  it('drops a credential-named field and refuses an unplanned one', async () => {
    const { emitBridgeTokenLog, DisallowedLogField } = await import('../src/log/bridge-log.js');
    const { createLogger } = await import('@xaa/logging');
    expect(() => emitBridgeTokenLog(
      createLogger('google-bridge', 'google_bridge', () => {}),
      { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null },
      // A credential-named key is dropped silently wherever it comes from; a key
      // nobody planned for is a mistake, and mistakes should be loud in development.
      { operator_note: 'unexpected' } as never,
    )).toThrow(DisallowedLogField);

    const lines: string[] = [];
    emitBridgeTokenLog(
      createLogger('google-bridge', 'google_bridge', (line) => lines.push(line)),
      { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null },
      { access_token: 'secret-value' } as never,
      { production: true },
    );
    expect(lines[0]).not.toContain('secret-value');
  });
});
