import type { Logger, LogContext } from '@xaa/logging';

/**
 * docs 09 §5.1. The judgement is made synchronously by the application that saw the
 * request; Security Detection consumes the result and never re-decides (DEC-SEC-02).
 *
 * The order is fixed and codes are never assembled from fragments at run time: a
 * detection query keys on these literals.
 */
export const PROTOCOL_VIOLATION_CODES = [
  'invalid_signature',
  'expired_token',
  'expired_agent',
  'audience_mismatch',
  'resource_mismatch',
  'invalid_scope',
  'unknown_issuer',
  'invalid_client',
  'invalid_id_jag',
  'invalid_dpop_proof',
  'replayed_dpop_proof',
  'dpop_key_binding_mismatch',
  'human_subject_mismatch',
  'unauthorized_tool',
  'expired_bridge_connection',
  'expired_idp_connection',
  'delegation_mismatch',
  'xaa_config_out_of_range',
  'forbidden_bridge_caller',
  'invalid_bridge_binding',
  'bridge_scope_violation',
  'code_already_used',
] as const;

export type ProtocolViolationCode = (typeof PROTOCOL_VIOLATION_CODES)[number];

/**
 * Refresh token reuse is a validation outcome, not one of the protocol violations
 * above, so it is kept in its own list and never inflates the fixed set.
 */
export const EXTENDED_VALIDATION_CODES = ['refresh_token_reuse'] as const;
export type ExtendedValidationCode = (typeof EXTENDED_VALIDATION_CODES)[number];

export type ValidationCode = ProtocolViolationCode | ExtendedValidationCode;

export interface ProtocolValidationEvent {
  code: ValidationCode;
  outcome: 'pass' | 'fail';
  validation_name: string;
  human_subject: string | null;
  agent_id: string | null;
  occurred_at: string;
  /** Identifier of the path the validation ran on, e.g. `agent-op:/xaa/token`. */
  path: string;
  trace_id: string;
}

export const protocolValidationEventSchema = {
  $id: 'protocol-validation-event',
  type: 'object',
  additionalProperties: false,
  required: ['code', 'outcome', 'validation_name', 'human_subject', 'agent_id', 'occurred_at', 'path', 'trace_id'],
  properties: {
    code: { enum: [...PROTOCOL_VIOLATION_CODES, ...EXTENDED_VALIDATION_CODES] },
    outcome: { enum: ['pass', 'fail'] },
    validation_name: { type: 'string', minLength: 1 },
    human_subject: { type: ['string', 'null'] },
    agent_id: { type: ['string', 'null'] },
    occurred_at: { type: 'string', format: 'date-time' },
    path: { type: 'string', minLength: 1 },
    trace_id: { type: 'string' },
  },
} as const;

/**
 * The single emission point. Every application calls this and never invents its own
 * event name, so `grep protocol_validation` finds exactly one producer.
 */
export function emitProtocolValidation(logger: Logger, ctx: LogContext, event: ProtocolValidationEvent): void {
  logger.warning('protocol_validation', ctx, { ...event });
}

/** Human-readable names, used by the Activity Event message (REQ-11-018). */
export const VIOLATION_MESSAGES: Readonly<Record<ValidationCode, string>> = {
  invalid_signature: '署名が検証できませんでした',
  expired_token: 'トークンの有効期限が切れています',
  expired_agent: 'Agent の有効期限が切れています',
  audience_mismatch: '宛先が許可された範囲にありません',
  resource_mismatch: 'リソース指定が許可された範囲にありません',
  invalid_scope: '要求された権限が許可された範囲にありません',
  unknown_issuer: '発行元が信頼された発行元ではありません',
  invalid_client: 'クライアント認証に失敗しました',
  invalid_id_jag: 'ID-JAG が有効ではありません',
  invalid_dpop_proof: 'DPoP Proof が有効ではありません',
  replayed_dpop_proof: '同じ DPoP Proof が再提示されました',
  dpop_key_binding_mismatch: 'トークンと DPoP の鍵が一致しません',
  human_subject_mismatch: '要求された委譲元が認証された利用者と一致しません',
  unauthorized_tool: '許可されていないツールが要求されました',
  expired_bridge_connection: '外部サービス接続の有効期限が切れています',
  expired_idp_connection: 'IdP 接続の有効期限が切れています',
  delegation_mismatch: '委譲関係が確認できませんでした',
  xaa_config_out_of_range: '要求が Agent の静的設定の範囲外です',
  forbidden_bridge_caller: '許可されていない呼び出し元です',
  invalid_bridge_binding: 'Agent と外部サービスの結び付きが有効ではありません',
  bridge_scope_violation: '外部サービスへの要求が許可された権限を超えています',
  code_already_used: '同じコードが再利用されました',
  refresh_token_reuse: 'Refresh Token が再利用されました',
};
