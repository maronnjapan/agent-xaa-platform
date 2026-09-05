import { Hono } from 'hono';
import { compile, SchemaValidationError } from '@xaa/contracts';
import type { ControlPlaneVariables } from '@xaa/control-plane-auth';
import { provisionAgent, type FlowDeps } from '../provisioning/flow.js';
import { createCompletionCodes } from '../transaction/one-time-code.js';
import { isTerminal } from '../transaction/state.js';

type Env = { Variables: ControlPlaneVariables };

const resumeBodySchema = {
  $id: 'resume-body',
  type: 'object',
  additionalProperties: false,
  required: ['one_time_code'],
  properties: { one_time_code: { type: 'string', minLength: 1 } },
} as const;

const assertBody: (value: unknown) => asserts value is { one_time_code: string } =
  compile<{ one_time_code: string }>(resumeBodySchema);

/**
 * `POST /provisioning/:transaction_id/resume`. Picks a paused provisioning back up
 * after a consent screen, and carries it to a running agent.
 *
 * Both halves must be present: a valid Access Token proves who is asking, and the
 * one-time code proves they came back from the consent they were sent to. Either
 * alone is not enough.
 *
 * The subject is checked before the code is consumed, so a wrong caller cannot burn
 * someone else's code by trying.
 *
 * Reaching `RESUMABLE` is not the answer to this request, it is the permission to
 * continue: the steps the pause interrupted — registering the agent, starting its
 * execution, activating it — are the reason the person was sent to a consent screen
 * at all. Answering with the status and stopping there left the consent spent, the
 * transaction parked in a state nothing else advances, and the person back on a
 * dashboard with no agent on it. What this route returns is the flow's own answer
 * (docs 07 §3.3: `PROV-->>AUTO: Agent Ready`).
 */
export function createResumeRoute(deps: FlowDeps): Hono<Env> {
  const app = new Hono<Env>();
  const codes = createCompletionCodes(deps.documents, () => deps.clock.now(), deps.logger);

  // Declared explicitly so a browser landing here gets a clear 405 rather than a 404.
  app.get('/:transaction_id/resume', (context) => context.body(null, 405, { Allow: 'POST' }));

  app.post('/:transaction_id/resume', async (context) => {
    const transactionId = context.req.param('transaction_id');
    const body: unknown = context.get('validatedBody');
    try {
      assertBody(body);
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      return context.json({ error: 'invalid_request' }, 400);
    }

    const transaction = await deps.transactions.find(transactionId);
    if (!transaction) return context.json({ error: 'transaction_not_found' }, 404);
    if (transaction.human_subject !== context.get('humanSubject')) return context.json({ error: 'code_owner_mismatch' }, 403);
    if (isTerminal(transaction.status)) return context.json({ error: 'transaction_not_resumable' }, 409);
    // Everything the second half needs, checked before the one-time code is spent on a
    // transaction that could never have finished: the agent the consent was given for,
    // and the inputs the first half wrote down for this one. A transaction started by
    // a build that did not write them cannot be reconstructed — and a code burnt on it
    // would be a consent the person has to give again for nothing.
    if (!transaction.agent_id || !transaction.task_id || !transaction.agent_expires_at) {
      return context.json({ error: 'transaction_not_resumable' }, 409);
    }

    const consumed = await codes.consume({
      code: (body as { one_time_code: string }).one_time_code,
      transaction_id: transactionId,
      human_subject: transaction.human_subject,
    });
    if (!consumed.ok) return context.json({ error: consumed.error }, consumed.status);

    // The consent is only believed once the issuing service confirms it: a code says
    // the browser came back, not that the connection is usable. Which service is asked
    // follows the code's own `issuer_kind`, so a code minted for an external connector
    // cannot be redeemed by asking the Agent OP about an IdP connection instead. The
    // Bridge is disabled by default (DEC-SCOPE-04) and this service holds no client for
    // it, so such a code is refused rather than verified against the wrong issuer.
    if (consumed.record.issuer_kind !== 'idp') return context.json({ error: 'connection_not_ready' }, 409);
    // Asked here as well as inside the flow, and for a different reason: a connection
    // that is not ready is not a failed provisioning, so this one answers 409 with the
    // transaction untouched, where the flow's own check would fail the transaction and
    // take the person's consent down with it.
    const verified = await deps.agentOp.verifyIdpConnection(`idpconn-${transaction.agent_id}`);
    if (verified.status !== 'READY') return context.json({ error: 'connection_not_ready' }, 409);

    await deps.transactions.advance(transactionId, 'RESUMABLE', { pending_step: 'verify_idp_connection' });

    // The expiry is the one fixed before the consent, inherited rather than recomputed:
    // an agent must not gain the time its owner spent on the consent screen.
    const outcome = await provisionAgent(deps, {
      humanSubject: transaction.human_subject,
      taskId: transaction.task_id,
      effectiveCapabilities: transaction.required_capabilities,
      isolationLevel: transaction.isolation_level,
      constraints: transaction.constraints ?? {},
      lifetime: { kind: 'inherited', expiresAt: transaction.agent_expires_at },
    }, { transactionId, agentId: transaction.agent_id });

    // A refusal the flow makes before its first step leaves the transaction where this
    // route put it, and `RESUMABLE` is not a state anything else advances: the code is
    // spent, so nobody is coming back with it. It is failed here rather than left for
    // the sweep to find half an hour later.
    if (outcome.status >= 400) {
      await deps.transactions.advance(transactionId, 'FAILED', { pending_step: 'verify_idp_connection' })
        .catch(() => undefined);
    }
    return context.json(outcome.body, outcome.status, outcome.headers ?? {});
  });

  return app;
}
