import { createLogger } from '@xaa/logging';
/**
 * REQ-09-009. Five fields, correlated by idp_connection_id alone: agent_id and
 * human_subject are deliberately absent so this record cannot be used to profile a
 * person's agents. Neither the refresh token, its ciphertext nor its hash appears.
 */
export interface IdpConnectionLogRecord {
  idp_connection_id: string;
  refresh_rotation_result: 'rotated' | 'failed' | 'not_rotated';
  refresh_reuse_detected: boolean;
  subject_token_refetch_result: 'ok' | 'failed' | 'n/a';
  revoke_result: 'ok' | 'failed' | 'n/a';
}

export const IDP_CONNECTION_LOG_FIELDS = [
  'idp_connection_id', 'refresh_rotation_result', 'refresh_reuse_detected', 'subject_token_refetch_result', 'revoke_result',
] as const;

/**
 * Every key is always present; a path that does not apply writes `n/a`.
 *
 * The envelope names `agent_op_idp_connection` as the source, which is both what the
 * Log Sink filters on and the key the normalizer picks a converter by. `agent_id` and
 * `human_subject` stay null on purpose: this record correlates by connection alone, so
 * it cannot be used to profile a person's agents.
 */
export function emitIdpConnectionLog(record: IdpConnectionLogRecord, write: (line: string) => void = (line) => process.stdout.write(line)): void {
  createLogger('shared-agent-op', 'agent_op_idp_connection', write).info('idp_connection', {
    request_id: '', trace_id: record.idp_connection_id, agent_id: null, human_subject: null,
  }, { ...record });
}
