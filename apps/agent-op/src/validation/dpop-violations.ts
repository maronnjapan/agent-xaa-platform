import type { Context } from 'hono';
import type { ProtocolViolationCode } from '@xaa/contracts';

/**
 * REQ-09-026. Three DPoP violations are distinguished internally but the client
 * always sees the same body, so a caller cannot probe which check failed
 * (DEC-SEC-02: the decision is made here, not re-derived by Security Detection).
 *
 * - bad signature / htm / htu / iat window -> invalid_dpop_proof
 * - duplicate jti                          -> replayed_dpop_proof
 * - cnf.jkt vs proof thumbprint            -> dpop_key_binding_mismatch
 */
export type DpopViolationCode = Extract<ProtocolViolationCode,
  'invalid_dpop_proof' | 'replayed_dpop_proof' | 'dpop_key_binding_mismatch'>;

export function recordDpopViolation(context: Context, code: DpopViolationCode, path: string): void {
  const emit = context.get('emitViolation' as never) as
    | ((code: DpopViolationCode, detail: { path: string; agent_id: string | null }) => void)
    | undefined;
  emit?.(code, { path, agent_id: (context.get('authenticatedAgentId' as never) as string | undefined) ?? null });
}
