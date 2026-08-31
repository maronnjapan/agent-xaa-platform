import { shortIdOf } from '../keys/dedicated-key.js';

/**
 * REQ-09-022. A separate record from the Token Exchange log because Security
 * Detection joins it against what a Resource AS actually received: an ID-JAG signed
 * with an Agent OP kid but absent from this ledger is `signing_key_misuse`.
 */
export interface IssuanceLedgerRecord {
  jti: string;
  kid: string;
  typ: 'oauth-id-jag+jwt';
  iss: string;
  sub: string;
  act_sub: string;
  aud: string;
  resource: string;
  scope: string;
  exp: number;
  iat: number;
  agent_id: string;
  dedicated_short_id: string | null;
}

export const LEDGER_FIELDS = [
  'jti', 'kid', 'typ', 'iss', 'sub', 'act_sub', 'aud', 'resource', 'scope', 'exp', 'iat', 'agent_id', 'dedicated_short_id',
] as const;

const COMPACT_JWS = /\beyJ[A-Za-z0-9_-]{8,}/;

export function buildLedgerRecord(claims: Record<string, unknown>, kid: string, agentId: string, dedicated: boolean): IssuanceLedgerRecord {
  const actor = claims.act as { sub?: unknown } | undefined;
  return {
    jti: String(claims.jti),
    kid,
    typ: 'oauth-id-jag+jwt',
    iss: String(claims.iss),
    sub: String(claims.sub),
    act_sub: String(actor?.sub ?? ''),
    aud: String(claims.aud),
    resource: String(claims.resource ?? ''),
    scope: Array.isArray(claims.scope) ? claims.scope.join(' ') : String(claims.scope ?? ''),
    exp: Number(claims.exp),
    iat: Number(claims.iat),
    agent_id: agentId,
    dedicated_short_id: dedicated ? shortIdOf(agentId) : null,
  };
}

/** Written right after signing and before the response is built, never afterwards. */
export function emitIssuanceLedger(record: IssuanceLedgerRecord, write: (line: string) => void = (line) => process.stdout.write(line)): void {
  const line = JSON.stringify({ logName: 'idjag_issuance', ...record });
  if (COMPACT_JWS.test(line)) throw new Error('issuance ledger must not contain a compact JWS');
  write(`${line}\n`);
}
