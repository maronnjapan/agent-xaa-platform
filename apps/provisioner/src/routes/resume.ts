import { Hono } from 'hono';
import { compile, SchemaValidationError } from '@xaa/contracts';
import type { ControlPlaneVariables } from '@xaa/control-plane-auth';
import { createCompletionCodes } from '../transaction/one-time-code.js';
import { isTerminal } from '../transaction/state.js';
import type { ProvisionerDeps } from '../deps.js';

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
 * after a consent screen.
 *
 * Both halves must be present: a valid Access Token proves who is asking, and the
 * one-time code proves they came back from the consent they were sent to. Either
 * alone is not enough.
 *
 * The subject is checked before the code is consumed, so a wrong caller cannot burn
 * someone else's code by trying.
 */
export function createResumeRoute(deps: ProvisionerDeps): Hono<Env> {
  const app = new Hono<Env>();
  const codes = createCompletionCodes(deps.documents, () => deps.clock.now());

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

    const consumed = await codes.consume({
      code: (body as { one_time_code: string }).one_time_code,
      transaction_id: transactionId,
      human_subject: transaction.human_subject,
    });
    if (!consumed.ok) return context.json({ error: consumed.error }, consumed.status);

    // The consent is only believed once the issuing service confirms it: a code says
    // the browser came back, not that the connection is usable.
    const verified = await deps.agentOp.verifyIdpConnection(`idpconn-${transaction.agent_id}`);
    if (verified.status !== 'READY') return context.json({ error: 'connection_not_ready' }, 409);

    const resumed = await deps.transactions.advance(transactionId, 'RESUMABLE', { pending_step: 'verify_idp_connection' });
    return context.json({ status: resumed.status, transaction_id: transactionId, pending_step: resumed.pending_step });
  });

  return app;
}
