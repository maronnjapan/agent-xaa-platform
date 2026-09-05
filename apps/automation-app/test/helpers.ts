import { webcrypto } from 'node:crypto';
import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws, type Es256KeyPair } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import createApp, { type AutomationAppDeps } from '../src/app.js';
import type { AutomationAppConfig } from '../src/config.js';
import { createSessionStore, type Session } from '../src/auth/session-store.js';

export const ISSUER = 'https://human-idp.test';
export const SUBJECT = 'testuser';
export const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

export const config: AutomationAppConfig = {
  port: 8080,
  issuer: ISSUER,
  clientId: 'automation-app',
  // Shaped like the deployed secret (`openssl rand -base64 48`): a header that does
  // not form-url-encode hands the IdP the `+` as a space and is answered 401.
  clientSecret: 'test+automation/secret=',
  publicBaseUrl: 'https://automation-app.test',
  authorizationPlatformUrl: 'https://authorization.test',
  agentProvisionerUrl: 'https://provisioner.test',
  lifecycleManagerUrl: 'https://lifecycle.test',
  docsApiUrl: 'https://resource-docs-api.test',
  activityTopic: 'agent-activity-stream',
  defaultAgentLifetimeHours: 1,
  vertexModel: 'test-model',
  vertexMode: 'fake',
  storeMode: 'emulator',
};

let signingKey: Es256KeyPair | undefined;
async function idpKey(): Promise<Es256KeyPair> {
  signingKey ??= await generateEs256KeyPair();
  return signingKey;
}

export async function mintAccessToken(options: {
  audience?: string | string[];
  subject?: string;
  scope?: string;
  typ?: string;
  extra?: Record<string, unknown>;
} = {}): Promise<string> {
  const pair = await idpKey();
  const issuedAt = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: options.typ ?? 'at+jwt', kid: 'idp-1' },
    payload: {
      iss: ISSUER, sub: options.subject ?? SUBJECT, aud: options.audience ?? 'automation-app',
      scope: options.scope ?? 'workdef:submit agent:provision agent:revoke',
      iat: issuedAt, exp: issuedAt + 3600, ...options.extra,
    },
    signer: createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'idp-1' }),
  });
}

async function dpopPrivateJwk(): Promise<JsonWebKey> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  // key_ops and ext are export metadata, not part of the key the session stores.
  return Object.fromEntries(Object.entries(exported).filter(([key]) => key !== 'key_ops' && key !== 'ext'));
}

export interface Harness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Scoped as automation-app: the guard applies exactly as it would in production. */
  documents: DocumentStore;
  /** Scoped as provisioner, for seeding rows this app may only read. */
  seed: DocumentStore;
  /** Scoped as agent-runtime: the checkpoint is written by the Runtime, never here. */
  runtimeSeed: DocumentStore;
  /** Scoped as authorization: decisions are written by the Authorization Platform. */
  authorizationSeed: DocumentStore;
  session: Session;
  auditLines: string[];
  upstream: Array<{ url: string; init: RequestInit }>;
  cookie: string;
}

export async function startAutomationApp(options: {
  subject?: string;
  config?: Partial<AutomationAppConfig>;
  identityTokenProvider?: (audience: string) => Promise<string>;
  tokenAudience?: string | string[];
  tokenTyp?: string;
  /** Extra claims on the session's own Access Token, to prove which ones are ignored. */
  tokenClaims?: Record<string, unknown>;
  /** The `aud` of the Authorization Platform token, to exercise a misrouted one. */
  authorizationAudience?: string | string[];
  scope?: string;
  upstreamHandler?: (url: string, init: RequestInit) => Response | Promise<Response>;
  verifyAccessToken?: AutomationAppDeps['verifyAccessToken'];
  /** Stands in for the Google OIDC check on `/internal/activity/push`. */
  verifyPush?: AutomationAppDeps['verifyPush'];
  generate?: AutomationAppDeps['generate'];
  now?: () => number;
  shared?: ReturnType<typeof createFirestoreDouble>;
} = {}): Promise<Harness> {
  const subject = options.subject ?? SUBJECT;
  const firestore = options.shared ?? createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'automation-app');
  const seed = createFirestoreDocumentStore(firestore, 'provisioner');
  const runtimeSeed = createFirestoreDocumentStore(firestore, 'agent-runtime');
  const authorizationSeed = createFirestoreDocumentStore(firestore, 'authorization');
  const sessions = createSessionStore(documents);
  const session = await sessions.create({
    human_subject: subject,
    id_token: await mintAccessToken({ subject, typ: 'JWT' }),
    access_tokens: {
      'automation-app': await mintAccessToken({
        subject,
        ...(options.tokenAudience === undefined ? {} : { audience: options.tokenAudience }),
        ...(options.tokenTyp === undefined ? {} : { typ: options.tokenTyp }),
        ...(options.tokenClaims === undefined ? {} : { extra: options.tokenClaims }),
      }),
      'authorization-platform': await mintAccessToken({
        subject,
        audience: options.authorizationAudience ?? 'authorization-platform',
        ...(options.scope ? { scope: options.scope } : {}),
      }),
      'agent-provisioner': await mintAccessToken({ subject, audience: 'agent-provisioner' }),
      'lifecycle-manager': await mintAccessToken({ subject, audience: 'lifecycle-manager' }),
    },
    dpop_private_jwk: await dpopPrivateJwk(),
  });

  const auditLines: string[] = [];
  const upstream: Array<{ url: string; init: RequestInit }> = [];
  const app = createApp({
    config: { ...config, ...options.config },
    documents,
    sessions,
    verifyAccessToken: options.verifyAccessToken ?? (async (token) => decodePayload(token)),
    verifyIdToken: async (token) => decodePayload(token),
    auditWrite: (line) => auditLines.push(line),
    ...(options.now ? { now: options.now } : {}),
    ...(options.verifyPush ? { verifyPush: options.verifyPush } : {}),
    ...(options.generate ? { generate: options.generate } : {}),
    ...(options.identityTokenProvider ? { identityTokenProvider: options.identityTokenProvider } : {}),
    fetchImpl: (async (url: string | URL | Request, init: RequestInit = {}) => {
      const target = String(url);
      upstream.push({ url: target, init });
      return options.upstreamHandler?.(target, init)
        ?? new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });

  const cookie = `xaa_session=${session.session_id}`;
  return {
    documents, seed, runtimeSeed, authorizationSeed, session, auditLines, upstream, cookie,
    fetch: (path, init = {}) => app.fetch(new Request(new URL(path, 'https://automation-app.test'), {
      ...init,
      headers: { cookie, ...(init.headers as Record<string, string> | undefined) },
    })),
  };
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export async function seedAgent(harness: Harness, options: {
  agentId?: string;
  humanSubject?: string;
  status?: string;
  expiresAt?: string;
  state?: Record<string, unknown>;
} = {}): Promise<string> {
  const agentId = options.agentId ?? AGENT_ID;
  await harness.seed.set('agents', `${agentId}__meta`, {
    agent_id: agentId,
    human_subject: options.humanSubject ?? SUBJECT,
    status: options.status ?? 'ACTIVE',
    expires_at: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  });
  if (options.state) await harness.runtimeSeed.set('agents', `${agentId}__state`, options.state);
  return agentId;
}
