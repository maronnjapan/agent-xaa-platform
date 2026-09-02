import { randomUUID } from 'node:crypto';
import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, InMemoryJtiStore,
  jwkThumbprint, signCompactJws, toPublicJwk, type Es256KeyPair,
} from '@xaa/crypto';
import { createLogger } from '@xaa/logging';
import type { RedeemStep } from '@xaa/resource-guard';
import createApp, { type ResourceAsDeps } from '../src/app.js';
import type { ResourceAsEnv } from '../src/config/env.js';
import { generateLocalSigningJwk, localSigningKey } from '../src/keys/self-bootstrap.js';

export const AS_ISSUER = 'https://resource-finance-as.test';
export const AGENT_URN = 'urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz';
export const OP_KID = 'op-shared-1';

export const asEnv: ResourceAsEnv = {
  port: 8080, issuer: AS_ISSUER,
  trustedIdpIssuer: 'https://human-idp.test',
  trustedIdpJwksUri: 'https://storage.test/xaa-jwks/jwks.json',
  accessTokenExpiresIn: 300,
  registeredScopes: ['finance.tx.read', 'finance.tx.write'],
  signingKeyBucket: 'xaa-keys', signingKeyObject: 'signing/current.json',
  signingKeyKmsKey: 'projects/p/locations/l/keyRings/resource-as-signing/cryptoKeys/finance',
  jwksBucket: 'xaa-jwks', jwksKeyPrefix: 'fin-as',
  signerMode: 'local', storeMode: 'emulator',
  resourceUri: 'https://resource-finance-api.test', asKind: 'finance',
};

export async function createTestAs(
  overrides: Partial<ResourceAsEnv> = {},
  jwks: unknown = { keys: [] },
  extra: Partial<ResourceAsDeps> = {},
) {
  const logs: string[] = [];
  const steps: RedeemStep[] = [];
  const signingKey = await localSigningKey(await generateLocalSigningJwk(), overrides.jwksKeyPrefix ?? asEnv.jwksKeyPrefix);
  const app = createApp({
    env: { ...asEnv, ...overrides },
    signingKey,
    jtiStore: new InMemoryJtiStore(),
    fetchImpl: (async () => Response.json(jwks)) as unknown as typeof fetch,
    logger: createLogger('resource-finance-as', 'native_resource_as', (line) => { logs.push(line); }),
    recordStep: (step) => steps.push(step),
    // Terraform injects REQUIRE_ISOLATION_LEVEL here, so the tests run the app the
    // way it is deployed: finance only serves a fully isolated agent (T-RES-19).
    requireIsolationLevel: 'full_isolation',
    ...extra,
  });
  return {
    logs, steps, signingKey,
    fetch: (path: string, init?: RequestInit) => app.fetch(new Request(new URL(path, AS_ISSUER), init)),
  };
}

export interface MintIdJagOptions {
  /** The Agent OP key the assertion is signed with. */
  keyPair: Es256KeyPair;
  kid?: string;
  issuer?: string;
  audience?: string;
  clientId?: string;
  subject?: string;
  actorUrn?: string | null;
  scope?: string;
  resource?: string;
  /** The DPoP key the grant is bound to; `null` mints an assertion with no `cnf`. */
  jkt?: string | null;
  isolationLevel?: string;
  constraints?: Record<string, unknown>;
  expiresIn?: number;
  /** Embeds the signing key in the JOSE header, which the library must refuse. */
  embedJwk?: boolean;
}

/**
 * An ID-JAG as the Agent OP mints one. The Resource AS tests need to vary single
 * claims (`aud`, `client_id`, `cnf`, `isolation_level`) one at a time, which is what
 * every negative case here is: one field wrong and nothing else.
 */
export async function mintIdJag(options: MintIdJagOptions): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const kid = options.kid ?? OP_KID;
  const header: Record<string, unknown> = { alg: 'ES256', typ: 'oauth-id-jag+jwt', kid };
  if (options.embedJwk) header.jwk = await toPublicJwk(options.keyPair.publicKey);
  return signCompactJws({
    header: header as never,
    payload: {
      iss: options.issuer ?? asEnv.trustedIdpIssuer,
      sub: options.subject ?? 'testuser',
      aud: options.audience ?? AS_ISSUER,
      client_id: options.clientId ?? 'agent-platform',
      jti: `idjag-${randomUUID()}`,
      iat: issuedAt,
      exp: issuedAt + (options.expiresIn ?? 300),
      scope: options.scope ?? 'finance.tx.read finance.tx.write',
      resource: options.resource ?? asEnv.resourceUri,
      ...(options.actorUrn === null ? {} : { act: { sub: options.actorUrn ?? AGENT_URN } }),
      ...(options.jkt === null ? {} : { cnf: { jkt: options.jkt! } }),
      ...(options.isolationLevel ? { isolation_level: options.isolationLevel } : {}),
      ...(options.constraints ? { constraints: options.constraints } : {}),
    },
    signer: createLocalEs256Signer({ privateKey: options.keyPair.privateKey, kid }),
  });
}

export interface RedeemableAs {
  as: Awaited<ReturnType<typeof createTestAs>>;
  opKeyPair: Es256KeyPair;
  dpopKeyPair: Es256KeyPair;
  jkt: string;
  mint(options?: Partial<MintIdJagOptions>): Promise<string>;
  redeem(options?: {
    assertion?: string;
    proofKeyPair?: Es256KeyPair;
    proof?: string;
    omitProof?: boolean;
    scope?: string;
    clientId?: string;
  }): Promise<Response>;
}

/**
 * A Resource AS whose trusted JWK Set holds the Agent OP key these helpers sign with,
 * so a redemption runs end to end inside one vitest process (DEC-APP-07).
 */
export async function createRedeemableAs(
  overrides: Partial<ResourceAsEnv> = {},
  extra: Partial<ResourceAsDeps> = {},
  /** The kid the Agent OP key is published and signed under. */
  opKid: string = OP_KID,
): Promise<RedeemableAs> {
  const opKeyPair = await generateEs256KeyPair();
  const dpopKeyPair = await generateEs256KeyPair();
  const jkt = await jwkThumbprint(await toPublicJwk(dpopKeyPair.publicKey));
  const jwks = { keys: [{ ...await toPublicJwk(opKeyPair.publicKey), kid: opKid, alg: 'ES256', use: 'sig' }] };
  const as = await createTestAs(overrides, jwks, extra);

  const mint = (options: Partial<MintIdJagOptions> = {}) =>
    mintIdJag({ keyPair: opKeyPair, jkt, kid: opKid, isolationLevel: 'full_isolation', ...options });

  return {
    as, opKeyPair, dpopKeyPair, jkt, mint,
    async redeem(options = {}) {
      const assertion = options.assertion ?? await mint();
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
      if (!options.omitProof) {
        headers.DPoP = options.proof ?? await createDpopProof({
          method: 'POST', url: `${overrides.issuer ?? AS_ISSUER}/token`,
          keyPair: options.proofKeyPair ?? dpopKeyPair,
        });
      }
      return as.fetch('/token', {
        method: 'POST', headers,
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
          client_id: options.clientId ?? 'agent-platform',
          ...(options.scope ? { scope: options.scope } : {}),
        }).toString(),
      });
    },
  };
}
