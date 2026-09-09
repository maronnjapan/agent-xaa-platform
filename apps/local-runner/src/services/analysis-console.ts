import createAnalysisConsole from '@xaa/analysis-console/app';
import { loadConfig } from '@xaa/analysis-console/src/config';
import { createJwksCache, verifyHumanIdToken } from '@xaa/crypto';
import { createFirestoreDocumentStore } from '@xaa/gcp';
import { listen, type Listener } from '../local/serve.js';
import type { LocalPlatform } from '../platform.js';

export function analysisConsoleEnvironment(platform: LocalPlatform): Record<string, string> {
  const { url, endpoints } = platform.config.topology;
  return {
    ISSUER: endpoints.issuer,
    PUBLIC_BASE_URL: url['analysis-console'],
    AUTOMATION_APP_URL: url['automation-app'],
    CLIENT_SECRET_ANALYSIS_CONSOLE: platform.secrets.analysisConsole,
    STORE_MODE: 'emulator',
  };
}

/**
 * The second screen: what Security Detection decided, shown to the person it was
 * decided about.
 *
 * A separate site with its own Human IdP client and its own session, exactly as it is
 * deployed — so a person who opens it here logs in a second time, which is the
 * behaviour the guide describes rather than a local shortcoming.
 */
export function startAnalysisConsole(platform: LocalPlatform): Listener {
  const config = loadConfig(analysisConsoleEnvironment(platform));
  // The issuer's own endpoint rather than the platform's aggregate set: only tokens
  // this issuer minted are verified with it, and its own copy cannot lag a rotation.
  const jwks = createJwksCache({ url: `${config.issuer}/.well-known/jwks.json` });
  const app = createAnalysisConsole({
    config,
    documents: createFirestoreDocumentStore(platform.firestore, 'analysis-console'),
    verifyIdToken: (token) => verifyHumanIdToken(token, { issuer: config.issuer, jwks, audience: config.clientId }),
  });
  return listen({
    name: 'analysis-console',
    host: platform.config.topology.host,
    port: platform.config.topology.port['analysis-console'],
    fetch: (request) => app.fetch(request),
  });
}
