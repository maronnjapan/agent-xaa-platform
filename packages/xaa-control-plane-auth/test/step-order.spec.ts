import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, InMemoryJtiStore, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { controlPlaneAuth, STEP_TABLE, type ControlPlaneVariables } from '../src/index.js';
import { accessToken, setupIssuer } from './helpers.js';

const BASE = 'https://authorization.test';
const PATH = '/v1/authorization/decisions';

let issuer: Awaited<ReturnType<typeof setupIssuer>>;
let keyPair: Es256KeyPair;
let jkt: string;

beforeAll(async () => {
  issuer = await setupIssuer();
  keyPair = await generateEs256KeyPair();
  jkt = await jwkThumbprint(keyPair.publicJwk);
});

function build() {
  const emitted: string[] = [];
  const app = new Hono<{ Variables: ControlPlaneVariables }>();
  app.use(PATH, controlPlaneAuth({
    issuer: 'https://issuer.example', jwksUrl: 'https://jwks.example',
    audience: 'authorization-platform', requiredScope: 'workdef:submit',
    fetchImpl: issuer.fetchImpl, iatSkewSeconds: 60, jtiStore: new InMemoryJtiStore(),
    expectedHtu: () => `${BASE}${PATH}`,
    protocolValidation: (event) => emitted.push(event.validation),
  }));
  app.post(PATH, (context) => context.json({ subject: context.get('humanSubject'), body: context.get('validatedBody') }));
  return { app, emitted };
}

async function call(options: { token?: string; proof?: string; body?: unknown; scheme?: string } = {}) {
  const { app, emitted } = build();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers.Authorization = `${options.scheme ?? 'DPoP'} ${options.token}`;
  if (options.proof !== undefined) headers.DPoP = options.proof;
  const response = await app.request(`${BASE}${PATH}`, {
    method: 'POST', headers, body: JSON.stringify(options.body ?? {}),
  });
  return { response, emitted };
}

const proofFor = (token: string, pair = keyPair) =>
  createDpopProof({ method: 'POST', url: `${BASE}${PATH}`, keyPair: pair, accessToken: token });

describe('the eight control plane steps', () => {
  it('publishes the step table with its statuses', () => {
    expect(STEP_TABLE.map((entry) => entry.status)).toEqual([401, 401, 403, 401, 401, 401, 401, 403]);
  });

  it('step 1: a Bearer scheme is refused', async () => {
    const token = await accessToken(issuer.pair, { cnf: { jkt } });
    const { response } = await call({ token, scheme: 'Bearer', proof: await proofFor(token) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  it('step 2: a token this issuer did not sign is refused', async () => {
    const other = await generateEs256KeyPair();
    const token = await accessToken(other, { cnf: { jkt } });
    const { response } = await call({ token, proof: await proofFor(token) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  it('step 3: a token without the scope is 403', async () => {
    const token = await accessToken(issuer.pair, { scope: 'openid', cnf: { jkt } });
    const { response } = await call({ token, proof: await proofFor(token) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('step 4: a missing proof is 401', async () => {
    const token = await accessToken(issuer.pair, { cnf: { jkt } });
    const { response } = await call({ token });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('step 5: a proof for another endpoint is 401', async () => {
    const token = await accessToken(issuer.pair, { cnf: { jkt } });
    const proof = await createDpopProof({ method: 'POST', url: `${BASE}/elsewhere`, keyPair, accessToken: token });
    const { response } = await call({ token, proof });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('step 6: a replayed proof is 401', async () => {
    const { app } = build();
    const token = await accessToken(issuer.pair, { cnf: { jkt } });
    const proof = await proofFor(token);
    const send = () => app.request(`${BASE}${PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `DPoP ${token}`, DPoP: proof },
      body: '{}',
    });
    expect((await send()).status).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'replayed_dpop_proof' });
  });

  it('step 7: a proof made with another key is 401', async () => {
    const token = await accessToken(issuer.pair, { cnf: { jkt } });
    const other = await generateEs256KeyPair();
    const { response } = await call({ token, proof: await proofFor(token, other) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'dpop_key_binding_mismatch' });
  });

  it('step 8: a body naming a different human is 403', async () => {
    const token = await accessToken(issuer.pair, { cnf: { jkt } });
    const { response } = await call({ token, proof: await proofFor(token), body: { human_subject: 'someone-else' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'human_subject_mismatch' });
  });

  it('passes the whole chain and strips human_subject from the body', async () => {
    const token = await accessToken(issuer.pair, { cnf: { jkt } });
    const { response } = await call({ token, proof: await proofFor(token), body: { human_subject: 'user-123', purpose: 'p' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subject: 'user-123', body: { purpose: 'p' } });
  });

  it('stops at the first failure: a bad token never reaches the scope check', async () => {
    const { emitted } = await call({ token: 'not-a-token', proof: 'x' });
    expect(emitted).toEqual(['invalid_signature']);
  });

  it('emits one protocol validation per refusal', async () => {
    const token = await accessToken(issuer.pair, { scope: 'openid', cnf: { jkt } });
    const { emitted } = await call({ token, proof: await proofFor(token) });
    expect(emitted).toEqual(['invalid_scope']);
  });

  /**
   * One refusal, one line — for every step. A step that refuses without recording it
   * leaves Security Detection reading a platform where nothing was ever refused
   * (T-SEC-12), and a step that records twice inflates every rule counting them.
   */
  it('records exactly one validation for each of the eight refusals', async () => {
    const good = await accessToken(issuer.pair, { cnf: { jkt } });
    const foreign = await accessToken(await generateEs256KeyPair(), { cnf: { jkt } });
    const unscoped = await accessToken(issuer.pair, { scope: 'openid', cnf: { jkt } });
    const attacker = await generateEs256KeyPair();
    const refusals: Array<Promise<{ emitted: string[] }>> = [
      call({ token: good, scheme: 'Bearer', proof: await proofFor(good) }),
      call({ token: foreign, proof: await proofFor(foreign) }),
      call({ token: unscoped, proof: await proofFor(unscoped) }),
      call({ token: good }),
      call({ token: good, proof: await createDpopProof({ method: 'POST', url: `${BASE}/elsewhere`, keyPair, accessToken: good }) }),
      (async () => {
        // Replay needs the same app twice, so this one is built by hand.
        const { app, emitted } = build();
        const proof = await proofFor(good);
        const send = () => app.request(`${BASE}${PATH}`, {
          method: 'POST', headers: { 'content-type': 'application/json', Authorization: `DPoP ${good}`, DPoP: proof }, body: '{}',
        });
        await send();
        await send();
        return { emitted };
      })(),
      call({ token: good, proof: await proofFor(good, attacker) }),
      call({ token: good, proof: await proofFor(good), body: { human_subject: 'someone-else' } }),
    ];
    const emissions = (await Promise.all(refusals)).map((result) => result.emitted);
    expect(emissions.map((emitted) => emitted.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(emissions.flat()).toEqual([
      'invalid_signature', 'invalid_signature', 'invalid_scope', 'invalid_dpop_proof',
      'invalid_dpop_proof', 'replayed_dpop_proof', 'dpop_key_binding_mismatch', 'human_subject_mismatch',
    ]);
  });

  /**
   * The eight steps are a sequence, not a menu: an app that reached for one of the
   * halves could compose them in another order, or leave one out, and no test of that
   * app would notice. `controlPlaneAuth` is the only entry point apps may use.
   */
  it('is used by apps only through controlPlaneAuth', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const appsRoot = new URL('../../../apps/', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}${entry.name}`;
        if (entry.isDirectory()) await walk(`${path}/`);
        else if (entry.name.endsWith('.ts')) {
          const source = await readFile(path, 'utf8');
          for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@xaa\/control-plane-auth'/g)) {
            if (/accessTokenMiddleware|dpopMiddleware/.test(match[1]!)) offenders.push(path);
          }
        }
      }
    };
    for (const app of await readdir(appsRoot, { withFileTypes: true })) {
      if (app.isDirectory()) await walk(`${appsRoot}${app.name}/src/`);
    }
    expect(offenders).toEqual([]);
  });
});
