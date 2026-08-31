/**
 * REQ-09-009. Five fields, correlated by idp_connection_id alone: agent_id and
 * human_subject are deliberately absent so this record cannot be used to profile a
 * person's agents. Neither the refresh token, its ciphertext nor its hash appears.
 */
export interface IdpConnectionLogRecord {
  idp_connection_id: string;
  rotation_result: 'rotated' | 'failed' | 'not_rotated';
  reuse_detected: boolean;
  subject_token_reissue: 'ok' | 'failed' | 'n/a';
  revoke_result: 'ok' | 'failed' | 'n/a';
}

export const IDP_CONNECTION_LOG_FIELDS = [
  'idp_connection_id', 'rotation_result', 'reuse_detected', 'subject_token_reissue', 'revoke_result',
] as const;

/** Every key is always present; a path that does not apply writes `n/a`. */
export function emitIdpConnectionLog(record: IdpConnectionLogRecord, write: (line: string) => void = (line) => process.stdout.write(line)): void {
  write(`${JSON.stringify({ logName: 'agent_op_idp_connection', ...record })}\n`);
}
