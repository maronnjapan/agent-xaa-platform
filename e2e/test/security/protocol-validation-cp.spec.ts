import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, InMemoryJtiStore,
  jwkThumbprint, signCompactJws, type Es256KeyPair,
} from '@xaa/crypto';
import { VALIDATION_NAME_TO_CODE, type ValidationName } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import {
  controlPlaneAuth, createProtocolValidationEmitter, type ControlPlaneVariables,
} from '@xaa/control-plane-auth';

const BASE = 'https://authorization.test';
const PATH = '/v1/authorization/decisions';
const ISSUER = 'https://issuer.example';
const AUDIENCE = 'authorization-platform';
const SCOPE = 'workdef:submit';

let issuerPair: Es256KeyPair;
let dpopPair: Es256KeyPair;
let jkt: string;

beforeAll(async () => {
  issuerPair = await generateEs256KeyPair();
  dpopPair = await generateEs256KeyPair();
  jkt = await jwkThumbprint(dpopPair.publicJwk);
});

const jwksImpl: typeof fetch = (async () =>
  Response.json({ keys: [{ ...issuerPair.publicJwk, kid: 'issuer-key' }] })) as unknown as typeof fetch;

async function accessToken(overrides: Record<string, unknown> = {}, pair = issuerPair): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: 'at+jwt', kid: 'issuer-key' },
    payload: {
      iss: ISSUER, sub: 'user-123', aud: AUDIENCE, scope: SCOPE,
      exp: now + 300, iat: now, jti: `at-${Math.random()}`, cnf: { jkt }, ...overrides,
    },
    signer: createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'issuer-key' }),
  });
}

/** The Control Plane, wired exactly as an application wires it. */
function controlPlane() {
  const lines: string[] = [];
  const app = new Hono<{ Variables: ControlPlaneVariables }>();
  app.use(PATH, controlPlaneAuth({
    issuer: ISSUER, jwksUrl: 'https://jwks.example', audience: AUDIENCE, requiredScope: SCOPE,
    fetchImpl: jwksImpl, iatSkewSeconds: 60, jtiStore: new InMemoryJtiStore(),
    expectedHtu: () => `${BASE}${PATH}`,
    protocolValidation: createProtocolValidationEmitter({
      logger: createLogger('authorization', 'policy_engine', (line) => lines.push(line)),
      path: 'authorization:/v1/authorization/decisions',
    }),
  }));
  app.post(PATH, (context) => context.json({ ok: true, subject: context.get('humanSubject') }));

  return {
    lines,
    async call(options: { token: string; proof?: string; body?: unknown; scheme?: string }) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      headers.Authorization = `${options.scheme ?? 'DPoP'} ${options.token}`;
      if (options.proof !== undefined) headers.DPoP = options.proof;
      return app.request(`${BASE}${PATH}`, {
        method: 'POST', headers, body: JSON.stringify(options.body ?? { human_subject: 'user-123' }),
      });
    },
    validations() {
      return lines
        .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
        .filter((line) => line.event === 'protocol_validation');
    },
  };
}

const proofFor = (token: string, pair = dpopPair, url = `${BASE}${PATH}`) =>
  createDpopProof({ method: 'POST', url, keyPair: pair, accessToken: token });

interface Case {
  name: ValidationName;
  run(plane: ReturnType<typeof controlPlane>): Promise<void>;
}

/**
 * One request per validation, each breaking exactly one thing.
 *
 * Every case sends a request that would otherwise pass, so the event observed is caused
 * by the single change the case makes and not by whatever else was already wrong.
 */
const CASES: Case[] = [
  {
    name: 'invalid signature',
    async run(plane) {
      const other = await generateEs256KeyPair();
      const token = await accessToken({}, other);
      await plane.call({ token, proof: await proofFor(token) });
    },
  },
  {
    name: 'expired token',
    async run(plane) {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const token = await accessToken({ exp: past, iat: past - 300 });
      await plane.call({ token, proof: await proofFor(token) });
    },
  },
  {
    name: 'audience mismatch',
    async run(plane) {
      const token = await accessToken({ aud: 'lifecycle-manager' });
      await plane.call({ token, proof: await proofFor(token) });
    },
  },
  {
    name: 'invalid scope',
    async run(plane) {
      const token = await accessToken({ scope: 'openid' });
      await plane.call({ token, proof: await proofFor(token) });
    },
  },
  {
    name: 'invalid DPoP proof',
    async run(plane) {
      const token = await accessToken();
      await plane.call({ token, proof: await proofFor(token, dpopPair, `${BASE}/elsewhere`) });
    },
  },
  {
    name: 'replayed DPoP proof',
    async run(plane) {
      const token = await accessToken();
      const proof = await proofFor(token);
      expect((await plane.call({ token, proof })).status).toBe(200);
      await plane.call({ token, proof });
    },
  },
  {
    name: 'DPoP key binding mismatch',
    async run(plane) {
      const token = await accessToken();
      await plane.call({ token, proof: await proofFor(token, await generateEs256KeyPair()) });
    },
  },
  {
    name: 'human_subject mismatch',
    async run(plane) {
      const token = await accessToken();
      await plane.call({ token, proof: await proofFor(token), body: { human_subject: 'someone-else' } });
    },
  },
];

/**
 * T-SEC-12 / REQ-05-022. Eight checks, eight codes, one event each.
 *
 * The guard refusing correctly is one property and the Identity領域 owns it. What this
 * fixes is the other half: that each refusal reaches Cloud Logging under the code the
 * detection side keys on, and that a request breaking one check produces one event and
 * not a running commentary.
 */
describe('the eight Control Plane validations', () => {
  it('reproduces each violation and observes its own code once', async () => {
    expect(CASES).toHaveLength(8);
    for (const testCase of CASES) {
      const plane = controlPlane();
      await testCase.run(plane);

      const observed = plane.validations().filter((line) => line.fields.outcome === 'fail');
      expect(observed, testCase.name).toHaveLength(1);
      expect(observed[0]!.fields.validation, testCase.name).toBe(VALIDATION_NAME_TO_CODE[testCase.name]);
      expect(observed[0]!.fields.path, testCase.name).toBe('authorization:/v1/authorization/decisions');
    }
  });

  it('carries no token material on any of the eight lines', async () => {
    for (const testCase of CASES) {
      const plane = controlPlane();
      await testCase.run(plane);
      expect(plane.lines.join('\n'), testCase.name).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });

  it('says nothing at all when the request is well formed', async () => {
    const plane = controlPlane();
    const token = await accessToken();
    const response = await plane.call({ token, proof: await proofFor(token) });
    expect(response.status).toBe(200);
    expect(plane.validations().filter((line) => line.fields.outcome === 'fail')).toHaveLength(0);
  });
});
