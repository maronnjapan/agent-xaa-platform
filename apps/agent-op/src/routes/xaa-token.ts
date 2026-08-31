import { IdJagError } from '@maronn-openid-connect/experimental/id-jag';
import { Hono } from 'hono';
import type { AgentOpDeps } from '../deps.js';
import { createSharedJwks } from '../keys/shared-jwks.js';
import { resolveKeyBinding, AgentBindingError } from '../keys/dedicated-key.js';
import { runIdJagIssuance } from '../idjag/pipeline.js';
import { ActorTokenReplayStore } from '../idjag/actor-token-replay.js';
import { NamespaceViolation } from '../idjag/verify-namespace.js';
import { createTrace, emitTokenExchangeLog } from '../log/token-exchange-log.js';
import { buildLedgerRecord, emitIssuanceLedger } from '../log/issuance-ledger.js';
import { emitProtocolViolationEvent } from '../log/protocol-violation-event.js';
import { createAgentOpStore } from '../store/index.js';
import type { AgentRegistration } from '../store/types.js';

export function createXaaTokenRoute(deps: AgentOpDeps): Hono {
  const jwks = createSharedJwks(deps.jwksSource, deps.now);
  const binding = resolveKeyBinding(deps.config);
  const store = createAgentOpStore(deps.documents, deps.config, () => deps.signer.kid);
  // Per-process, on purpose: see ActorTokenReplayStore's note on the limitation.
  const replayStore = new ActorTokenReplayStore(deps.now);

  const app = new Hono();
  app.post('/', async (context) => {
    const registration = context.get('agentRegistration' as never) as AgentRegistration;
    const trace = createTrace({ revision: deps.revision, kind: binding.boundAgentId === null ? 'shared' : 'dedicated' });
    try {
      const form = (context.get('parsedForm' as never) ?? await context.req.parseBody()) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(form)) if (typeof value === 'string') params[key] = value;

      const config = await store.xaaConfigs.find(registration.agent_id);
      if (!config) throw new IdJagError('invalid_grant', 'The agent is no longer eligible');

      const response = await runIdJagIssuance({
        params,
        issuer: deps.config.issuer,
        registration,
        config,
        subjectTokenJwks: await jwks.subjectTokenJwks(),
        signer: deps.signer,
        binding,
        dpopJkt: context.get('dpopJkt' as never) as string,
        lifetimeSeconds: deps.config.idJagLifetimeSeconds,
        now: new Date(deps.now?.() ?? Date.now()),
        replayStore,
        trace,
        onViolation: (code, detail) => {
          void emitProtocolViolationEvent(deps.publisher, {
            violation_code: code, agent_id: registration.agent_id, human_subject: registration.human_subject,
            ...(deps.now ? { now: deps.now } : {}),
          });
          trace.error_code ??= code === 'delegation_mismatch' ? 'invalid_grant' : 'invalid_scope';
          void detail;
        },
        onIssued: (claims, kid) => {
          emitIssuanceLedger(
            buildLedgerRecord(claims, kid, registration.agent_id, binding.boundAgentId !== null),
            deps.writeLedger,
          );
        },
      });
      return context.json(response);
    } catch (error) {
      const mapped = toErrorResponse(error);
      trace.error_code = mapped.body.error;
      return context.json(mapped.body, mapped.status);
    } finally {
      emitTokenExchangeLog(trace, deps.writeExchangeLog);
    }
  });
  return app;
}

/** IdJagError is caught in exactly one place; no step builds an HTTP response. */
function toErrorResponse(error: unknown): { status: 400; body: { error: string; error_description: string } } {
  if (error instanceof IdJagError) {
    return { status: 400, body: { error: error.code, error_description: error.errorDescription } };
  }
  if (error instanceof NamespaceViolation || error instanceof AgentBindingError) {
    return { status: 400, body: { error: error.code, error_description: error.message } };
  }
  return { status: 400, body: { error: 'invalid_request', error_description: 'The request could not be processed' } };
}
