import { webcrypto } from 'node:crypto';
import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws, type Es256KeyPair } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import createAutomationApp from '@xaa/automation-app/app';
import type { AutomationAppConfig } from '@xaa/automation-app/src/config';
import { createSessionStore } from '@xaa/automation-app/src/auth/session-store';
import type { WorkSignalSource } from '@xaa/automation-app/src/signals/work-signal-source';
import type { Generate } from '@xaa/automation-app/src/automation/suggestions';
import type { Fetcher } from './oauth-flow.js';

export const AUTOMATION_APP_BASE = 'https://automation-app.test';
export const AUTHORIZATION_BASE = 'https://authorization.test';
export const PROVISIONER_BASE = 'https://provisioner.test';
export const LIFECYCLE_BASE = 'https://lifecycle.test';

export interface AutomationHarness {
  fetch: Fetcher;
  documents: DocumentStore;
  /** Scoped as the Runtime, for the checkpoint this app only reads. */
  runtimeStore: DocumentStore;
  /** Scoped as the Provisioner, for the registration this app only reads. */
  provisionerStore: DocumentStore;
  humanSubject: string;
  upstream: Array<{ url: string; init: RequestInit }>;
  auditLines: string[];
}

const ISSUER = 'https://human-idp.test';
let idpKey: Es256KeyPair | undefined;

async function accessToken(subject: string, audience: string): Promise<string> {
  idpKey ??= await generateEs256KeyPair();
  const issuedAt = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: 'at+jwt', kid: 'idp-1' },
    payload: {
      iss: ISSUER, sub: subject, aud: audience,
      scope: 'workdef:submit agent:provision agent:revoke', iat: issuedAt, exp: issuedAt + 3600,
    },
    signer: createLocalEs256Signer({ privateKey: idpKey.privateKey, kid: 'idp-1' }),
  });
}

/**
 * The Automation App wired for an end-to-end run: a real session, a real Firestore
 * double, and a transport that hands each upstream call to whichever app is standing
 * in for it. Nothing about the app under test is stubbed.
 */
export async function startAutomationAppHarness(options: {
  humanSubject?: string;
  shared?: ReturnType<typeof createFirestoreDouble>;
  upstream?: (url: string, init: RequestInit) => Response | Promise<Response>;
  /** The Automation App's own Cloud Run service identity, for calls made before any
   *  agent exists to delegate through (T-APP-04, T-APP-05). */
  identityTokenProvider?: (audience: string) => Promise<string>;
  /** Overrides the default Document RS signal source, e.g. to hand a scenario a
   *  work log directly rather than reproducing its read path over HTTP. */
  signals?: WorkSignalSource;
  /** Stands in for Vertex AI, the way `apps/automation-app/test/helpers.ts` does. */
  generate?: Generate;
} = {}): Promise<AutomationHarness> {
  const humanSubject = options.humanSubject ?? 'testuser';
  const firestore = options.shared ?? createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'automation-app');
  const runtimeStore = createFirestoreDocumentStore(firestore, 'agent-runtime');
  const provisionerStore = createFirestoreDocumentStore(firestore, 'provisioner');
  const sessions = createSessionStore(documents);

  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const dpopJwk = Object.fromEntries(Object.entries(exported).filter(([key]) => key !== 'key_ops' && key !== 'ext'));

  const session = await sessions.create({
    human_subject: humanSubject,
    id_token: await accessToken(humanSubject, 'automation-app'),
    access_tokens: {
      'automation-app': await accessToken(humanSubject, 'automation-app'),
      'authorization-platform': await accessToken(humanSubject, 'authorization-platform'),
      'agent-provisioner': await accessToken(humanSubject, 'agent-provisioner'),
      'lifecycle-manager': await accessToken(humanSubject, 'lifecycle-manager'),
    },
    dpop_private_jwk: dpopJwk,
  });

  const config: AutomationAppConfig = {
    port: 8080, issuer: ISSUER, clientId: 'automation-app',
    clientSecret: 'test-automation-app-secret', publicBaseUrl: AUTOMATION_APP_BASE,
    authorizationPlatformUrl: AUTHORIZATION_BASE, agentProvisionerUrl: PROVISIONER_BASE,
    lifecycleManagerUrl: LIFECYCLE_BASE, docsApiUrl: 'https://resource-docs-api.test',
    activityTopic: 'agent-activity-stream', defaultAgentLifetimeHours: 1,
    vertexModel: 'test-model', vertexMode: 'fake', storeMode: 'emulator',
  };

  const upstream: Array<{ url: string; init: RequestInit }> = [];
  const auditLines: string[] = [];
  const app = createAutomationApp({
    config,
    documents,
    sessions,
    verifyAccessToken: async (token) =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
    verifyIdToken: async (token) =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
    auditWrite: (line) => auditLines.push(line),
    ...(options.identityTokenProvider ? { identityTokenProvider: options.identityTokenProvider } : {}),
    ...(options.signals ? { signals: options.signals } : {}),
    ...(options.generate ? { generate: options.generate } : {}),
    fetchImpl: (async (url: string | URL | Request, init: RequestInit = {}) => {
      const target = String(url);
      upstream.push({ url: target, init });
      if (options.upstream) return await options.upstream(target, init);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });

  const cookie = `xaa_session=${session.session_id}`;
  return {
    documents, runtimeStore, provisionerStore, humanSubject, upstream, auditLines,
    fetch: async (path, init = {}) => app.fetch(new Request(new URL(path, AUTOMATION_APP_BASE), {
      ...init,
      headers: { cookie, ...(init.headers as Record<string, string> | undefined) },
    })),
  };
}
