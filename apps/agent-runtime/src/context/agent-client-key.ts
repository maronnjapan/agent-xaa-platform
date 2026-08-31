import { webcrypto } from 'node:crypto';
import { signCompactJws, type JwsHeader } from '@xaa/crypto';

/**
 * The Agent Client Credential, narrowed to what it is for.
 *
 * REQ-05-091 draws the line by capability rather than by convention: the key can
 * sign, it cannot be exported, and the only thing the type offers is one signing
 * method. There is no accessor for the JWK, no `toJSON` that reveals it, and no
 * second use — the two callers are the actor token and the client assertion, both
 * addressed to the Agent OP. A Resource-bound request builder cannot even name this
 * type in its signature.
 */
export interface AgentClientKey {
  readonly kid: string;
  signCompactJws(header: Omit<JwsHeader, 'kid'>, payload: Record<string, unknown>): Promise<string>;
  toJSON(): string;
}

export class InvalidAgentClientKey extends Error {
  readonly code = 'invalid_agent_client_key';
}

/**
 * Imports the JWK once and drops the string from the environment.
 *
 * `extractable: false` means the private material cannot leave the process even by
 * a bug: `exportKey` throws. Deleting the env var closes the other route — a later
 * read of `process.env` finds nothing, so a checkpoint or a log that dumped the
 * environment would carry no key.
 */
export async function importAgentClientKey(input: {
  privateJwk: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentClientKey> {
  let jwk: JsonWebKey;
  try { jwk = JSON.parse(input.privateJwk) as JsonWebKey; } catch { throw new InvalidAgentClientKey('agent client jwk is not JSON'); }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
    throw new InvalidAgentClientKey('agent client key must be an EC P-256 private JWK');
  }
  const privateKey = await webcrypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  delete (input.env ?? process.env).AGENT_CLIENT_PRIVATE_JWK;
  const kid = `${input.agentId}-client-key`;
  return {
    kid,
    async signCompactJws(header, payload) {
      return signCompactJws({
        header: { ...header, kid },
        payload,
        signer: {
          kid,
          sign: async (data) => new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data)),
        },
      });
    },
    toJSON: () => '[redacted]',
  };
}
