import type { Context } from 'hono';
import { CONTROL_PLANE_VALIDATION_CODES, emitProtocolValidation as emitProtocolValidationLog } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';

/**
 * The eight checks, named once (T-SEC-12). The table lives in `@xaa/contracts` so the
 * guard and the detection side cannot drift into two lists of eight.
 */
export const PROTOCOL_VALIDATIONS = CONTROL_PLANE_VALIDATION_CODES;
export type ProtocolValidation = (typeof CONTROL_PLANE_VALIDATION_CODES)[number];
export type ProtocolValidationEmitter = (event: { validation: ProtocolValidation; outcome: 'allowed' | 'denied'; error: string; human_subject: string | null; trace_id: string; timestamp: string }) => void;

export function emitProtocolValidation(emitter: ProtocolValidationEmitter | undefined, context: Context, validation: ProtocolValidation, outcome: 'allowed' | 'denied', error: string): void {
  if (!emitter) return;
  emitter({ validation, outcome, error, human_subject: context.get('accessToken' as never)?.sub ?? null, trace_id: context.req.header('X-Cloud-Trace-Context')?.split('/')[0] ?? '', timestamp: new Date().toISOString() });
}

/**
 * Turns the guard's refusals into the platform's one protocol-validation log line.
 *
 * The guard is a package and has no logger of its own, so each Control Plane app hands
 * it this. Without it the eight checks refuse correctly and silently, and the Security
 * Detection pipeline — whose whole input is these lines — sees a platform where no
 * request was ever refused (T-SEC-12).
 */
export function createProtocolValidationEmitter(input: {
  logger: Logger;
  /** `<app>:<route family>`, as the event's `path` (00b). */
  path: string;
}): ProtocolValidationEmitter {
  return (event) => {
    emitProtocolValidationLog(input.logger, {
      request_id: '', trace_id: event.trace_id, agent_id: null, human_subject: event.human_subject,
    }, {
      code: event.validation,
      outcome: event.outcome === 'denied' ? 'fail' : 'pass',
      validation_name: event.error,
      human_subject: event.human_subject,
      agent_id: null,
      occurred_at: event.timestamp,
      path: input.path,
      trace_id: event.trace_id,
    });
  };
}
