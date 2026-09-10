export interface AnalysisConsoleConfig {
  port: number;
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  /** Where a finding's agent is operated. A link only; this app calls nothing there. */
  automationAppUrl: string;
  storeMode: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/**
 * Four variables the deployment must set, and the list is short for the same reason the
 * Automation App's is.
 *
 * Three are the login: the issuer to send a person to, the secret to redeem their code
 * with, and this app's own base URL, which is the redirect the Human IdP was registered
 * with. `AUTOMATION_APP_URL` is a link on the page and nothing more — no request leaves
 * this app for it.
 *
 * What is absent is the point. There is no Security Detection URL, because T-SEC-08
 * makes the detector a one-way feed and no application may invoke it; this app reads the
 * findings out of Firestore under the access matrix. There is no Capability Taxonomy and
 * no resource list, because this app judges nothing — it prints what the detector
 * decided, in the detector's words (RULE-54).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnalysisConsoleConfig {
  return {
    port: Number(env.PORT ?? 8080),
    issuer: required(env, 'ISSUER'),
    clientId: env.ANALYSIS_CONSOLE_CLIENT_ID ?? 'analysis-console',
    clientSecret: required(env, 'CLIENT_SECRET_ANALYSIS_CONSOLE'),
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
    automationAppUrl: required(env, 'AUTOMATION_APP_URL'),
    storeMode: env.STORE_MODE ?? 'emulator',
  };
}
