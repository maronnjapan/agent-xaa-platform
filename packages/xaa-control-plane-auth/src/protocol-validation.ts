import type { Context } from 'hono';

export const PROTOCOL_VALIDATIONS = ['invalid_signature', 'expired_token', 'audience_mismatch', 'invalid_scope', 'invalid_dpop_proof', 'replayed_dpop_proof', 'dpop_key_binding_mismatch', 'human_subject_mismatch'] as const;
export type ProtocolValidation = (typeof PROTOCOL_VALIDATIONS)[number];
export type ProtocolValidationEmitter = (event: { validation: ProtocolValidation; outcome: 'allowed' | 'denied'; error: string; human_subject: string | null; trace_id: string; timestamp: string }) => void;

export function emitProtocolValidation(emitter: ProtocolValidationEmitter | undefined, context: Context, validation: ProtocolValidation, outcome: 'allowed' | 'denied', error: string): void {
  if (!emitter) return;
  emitter({ validation, outcome, error, human_subject: context.get('accessToken' as never)?.sub ?? null, trace_id: context.req.header('X-Cloud-Trace-Context')?.split('/')[0] ?? '', timestamp: new Date().toISOString() });
}
