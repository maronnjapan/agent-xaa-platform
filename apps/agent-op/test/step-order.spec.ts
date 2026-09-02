import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { runIdJagIssuance, STEP_NAMES, type StepName } from '../src/idjag/pipeline.js';
import { ActorTokenReplayStore } from '../src/idjag/actor-token-replay.js';
import { resolveKeyBinding } from '../src/keys/dedicated-key.js';
import { createTrace } from '../src/log/token-exchange-log.js';
import { toXaaConfig } from '../src/store/xaa-config-repository.js';
import { generateEs256KeyPair } from '@xaa/crypto';
import {
  actorToken, baseConfig, clientAssertion, createFixture, DOCS_API_RESOURCE, DOCS_AS_ISSUER,
  exchange, ISSUER, subjectToken,
} from './helpers.js';

describe('issuance pipeline', () => {
  it('calls the 13 steps in the fixed order', async () => {
    const fixture = await createFixture();
    void createFirestoreDocumentStore(createFirestoreDouble(), 'agent-op');
    void await clientAssertion(fixture);
    const observed: StepName[] = [];
    const response = await runIdJagIssuance({
      params: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: await subjectToken(fixture),
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        actor_token: await actorToken(fixture),
        actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        audience: DOCS_AS_ISSUER,
        resource: DOCS_API_RESOURCE,
        scope: 'docs.read',
      },
      issuer: ISSUER,
      registration: fixture.registration,
      config: toXaaConfig({ ...fixture.registration, allowed_audiences: [DOCS_AS_ISSUER], resources: [DOCS_API_RESOURCE], scopes: ['docs.read'] }),
      subjectTokenJwks: { keys: [{ ...fixture.idpKeyPair.publicJwk, kid: 'idp-testkey', alg: 'ES256' }] },
      signer: fixture.opSigner,
      binding: resolveKeyBinding(baseConfig()),
      dpopJkt: 'jkt-value',
      lifetimeSeconds: 300,
      now: new Date(fixture.now()),
      replayStore: new ActorTokenReplayStore(fixture.now),
      trace: createTrace({ revision: 'r', kind: 'shared' }),
      recordStep: (step) => observed.push(step),
    });
    expect(response.issued_token_type).toBe('urn:ietf:params:oauth:token-type:id-jag');
    expect(observed).toEqual([...STEP_NAMES]);
    expect(STEP_NAMES).toHaveLength(13);
  });

  /**
   * The order is the answer. Client authentication runs before anything reads the
   * request body, so a caller who broke both learns that it was not authenticated and
   * nothing about which of the tokens the endpoint would have disliked.
   */
  it('returns invalid_client when client auth and subject token both broken', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, {
      assertion: await clientAssertion(fixture, { keyPair: await generateEs256KeyPair() }),
      form: { subject_token: 'not-a-token' },
    });
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe('invalid_client');
    // The pipeline never ran, so no step was recorded and no exchange line was written.
    expect(fixture.exchangeLogs).toHaveLength(0);
  });

  it('imports neither processIdJagIssuanceRequest nor createIdJagJwt', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = await readFile(full, 'utf8');
        for (const forbidden of ['processIdJagIssuanceRequest', 'createIdJagJwt', 'issueIdToken', 'issueAccessToken', 'importPKCS8', 'importJWK', 'createPrivateKey']) {
          if (source.includes(forbidden)) offenders.push(`${entry.name}: ${forbidden}`);
        }
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });

  it('pins allowRefreshTokenSubjects to a literal false in one place', async () => {
    const source = await readFile(new URL('../src/idjag/pipeline.ts', import.meta.url).pathname, 'utf8');
    const matches = source.match(/allowRefreshTokenSubjects: (\w+)/g) ?? [];
    expect(matches).toEqual(['allowRefreshTokenSubjects: false']);
  });

  it('injects no refreshTokenResolver anywhere', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (entry.name.endsWith('.ts') && (await readFile(full, 'utf8')).includes('refreshTokenResolver')) offenders.push(entry.name);
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });

  it('names the registration cache TTL once, as ten seconds', async () => {
    const source = await readFile(new URL('../src/idjag/verify-agent-state.ts', import.meta.url).pathname, 'utf8');
    expect(source).toContain('export const REGISTRATION_CACHE_TTL_SECONDS = 10;');
    const { REGISTRATION_CACHE_TTL_SECONDS } = await import('../src/idjag/verify-agent-state.js');
    expect(REGISTRATION_CACHE_TTL_SECONDS).toBe(10);
  });
});
