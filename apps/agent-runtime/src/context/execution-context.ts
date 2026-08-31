import { generateDpopKeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import type { ToolManifest } from '@xaa/contracts';
import type { RuntimeEnv } from '../env.js';
import { importAgentClientKey, type AgentClientKey } from './agent-client-key.js';
import { loadToolManifest } from '../manifest/load.js';
import { TokenStore } from '../tokens/token-store.js';
import type { RuntimeStore } from '../store/runtime-store.js';

export interface DpopKey extends Es256KeyPair {
  readonly jkt: string;
}

/**
 * One object, created once, holding everything an Execution is allowed to be.
 *
 * Every field is readonly, and every credential is reached through it — there is no
 * module-level key, no ambient token, and no second place to look. When the process
 * ends the DPoP key ends with it, which is what makes DEC-ID-12's "no pre-registration"
 * safe: the key that the ID-JAG is bound to never existed anywhere else.
 */
export interface ExecutionContext {
  readonly agentId: string;
  readonly humanSubject: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly agentOpBaseUrl: string;
  readonly isolationLevel: string;
  readonly manifest: ToolManifest;
  readonly dpop: DpopKey;
  readonly agentClientKey: AgentClientKey;
  readonly tokens: TokenStore;
  readonly store: RuntimeStore;
}

export async function createExecutionContext(input: {
  env: RuntimeEnv;
  store: RuntimeStore;
  processEnv?: NodeJS.ProcessEnv;
}): Promise<ExecutionContext> {
  const { env } = input;
  const keyPair = await generateDpopKeyPair();
  const dpop: DpopKey = { ...keyPair, jkt: await jwkThumbprint(keyPair.publicJwk) };
  const agentClientKey = await importAgentClientKey({
    privateJwk: env.AGENT_CLIENT_PRIVATE_JWK,
    agentId: env.AGENT_ID,
    ...(input.processEnv ? { env: input.processEnv } : {}),
  });
  return Object.freeze({
    agentId: env.AGENT_ID,
    humanSubject: env.HUMAN_SUBJECT,
    taskId: env.TASK_ID,
    executionId: env.executionId,
    createdAt: env.AGENT_CREATED_AT,
    expiresAt: env.AGENT_EXPIRES_AT,
    agentOpBaseUrl: env.AGENT_OP_BASE_URL,
    isolationLevel: env.ISOLATION_LEVEL,
    manifest: loadToolManifest(env),
    dpop,
    agentClientKey,
    tokens: new TokenStore(),
    store: input.store,
  });
}
