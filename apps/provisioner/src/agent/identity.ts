import { randomBytes } from 'node:crypto';
import { generateEs256KeyPair, jwkThumbprint, type Es256KeyPair, type PublicJwkEs256 } from '@xaa/crypto';
import { assertAgentId } from '@xaa/contracts';
import { exportPrivateJwk } from '@xaa/crypto/testing';

/**
 * 00b: `agent-` plus 26 characters of lowercase RFC 4648 base32 over 16 random
 * bytes. Not a counter: a predictable id would let one agent guess another's.
 */
export function newAgentId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  const agentId = `agent-${out.slice(0, 26)}`;
  assertAgentId(agentId);
  return agentId;
}

export interface AgentClientCredential {
  keyPair: Es256KeyPair;
  publicJwk: PublicJwkEs256 & { kid: string; alg: 'ES256'; use: 'sig' };
  thumbprint: string;
  /** Serialised for the job override; never stored anywhere (RULE-22). */
  privateJwkJson: string;
}

/**
 * The credential the agent authenticates with at Agent OP.
 *
 * Only the public half is recorded. The private key exists in the provisioning
 * request and in the job's environment, and nowhere else — not Firestore, not Secret
 * Manager, not a log line.
 */
export async function createAgentClientCredential(agentId: string): Promise<AgentClientCredential> {
  const keyPair = await generateEs256KeyPair();
  const thumbprint = await jwkThumbprint(keyPair.publicJwk);
  return {
    keyPair,
    publicJwk: { ...keyPair.publicJwk, kid: agentId, alg: 'ES256', use: 'sig' },
    thumbprint,
    privateJwkJson: JSON.stringify(await exportPrivateJwk(keyPair.privateKey)),
  };
}
