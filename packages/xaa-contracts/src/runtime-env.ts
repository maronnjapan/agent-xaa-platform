/**
 * The environment an Agent Runtime execution receives.
 *
 * The eleven override keys are the only per-agent values; everything else the Job
 * definition sets statically in Terraform. Keeping the list here means the
 * Provisioner that writes them and the Runtime that reads them cannot drift.
 *
 * 00b retires `AGENT_CLIENT_ID` (the client id is the single platform constant),
 * `XAA_CONFIG_JSON` (Agent OP reads it from the registration), `OP_TOKEN_ENDPOINT`
 * (built from AGENT_OP_BASE_URL) and `TOOL_MANIFEST_JSON` (renamed TOOL_MANIFEST).
 */
export const RUNTIME_ENV_KEYS = [
  'AGENT_ID',
  'HUMAN_SUBJECT',
  'TASK_ID',
  'AGENT_CREATED_AT',
  'AGENT_EXPIRES_AT',
  'AGENT_OP_BASE_URL',
  'TOOL_MANIFEST',
  'TOOL_MANIFEST_SHA256',
  'AGENT_CLIENT_PRIVATE_JWK',
  'ISOLATION_LEVEL',
] as const;

export type RuntimeEnvKey = (typeof RUNTIME_ENV_KEYS)[number];
export type RuntimeEnvOverrides = Record<RuntimeEnvKey, string>;

/** Names that were considered and rejected; a deployment must never set them. */
export const RETIRED_RUNTIME_ENV_KEYS = [
  'AGENT_CLIENT_ID', 'XAA_CONFIG_JSON', 'OP_TOKEN_ENDPOINT', 'TOOL_MANIFEST_JSON',
  'AGENT_CLIENT_PRIVATE_KEY', 'AGENT_SIGNING_JWK', 'EXPIRES_AT',
] as const;

export function assertRuntimeEnv(overrides: Record<string, string>): asserts overrides is RuntimeEnvOverrides {
  const keys = Object.keys(overrides).sort();
  const expected = [...RUNTIME_ENV_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`runtime env overrides must be exactly: ${expected.join(', ')}`);
  }
}

/**
 * Values the Job definition sets statically for every agent (00b): they are not
 * per-agent, so the Provisioner never writes them into an Execution override.
 */
export const RUNTIME_STATIC_ENV_KEYS = [
  'ACTIVITY_TOPIC', 'LOG_LEVEL', 'VERTEX_MODE', 'VERTEX_MODEL', 'PUBSUB_MODE',
  'STORE_MODE', 'PROJECT_ID', 'AGENT_MAX_LIFETIME_SECONDS',
] as const;

/**
 * REQ-05-090. A human session must not be reachable from inside an Execution. These
 * names are the shapes that would carry one, and the Runtime refuses to start if a
 * deployment sets any of them — a misconfiguration is caught before the first token
 * is minted, not after it has been used.
 */
export const FORBIDDEN_ENV_KEYS = [
  'HUMAN_ACCESS_TOKEN', 'HUMAN_REFRESH_TOKEN', 'SESSION_ID', 'SUBJECT_TOKEN',
  'CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'IDP_CONNECTION_ID',
] as const;

/** Exit codes are a four-value contract with the Job (T-RUN-01), plus 78 for a bad start. */
export const RUNTIME_EXIT_CODES = {
  completed: 0,
  agentExpired: 10,
  completedWithBlock: 20,
  failed: 30,
  invalidStartup: 78,
} as const;
