import type { MiddlewareHandler } from 'hono';
import { compile, documentInternalWriteSchema, SchemaValidationError } from '@xaa/contracts';
import type { ServiceIdentityVerifier } from './internal-revoke.js';
import type { XaaResourceContext } from './protect.js';

type Env = { Variables: { xaa: XaaResourceContext } };

interface DocumentInternalWriteBody {
  human_subject: string;
  type: 'daily_report';
  title: string;
  body: string;
  occurred_at: string;
}

const assertBody: (value: unknown) => asserts value is DocumentInternalWriteBody =
  compile<DocumentInternalWriteBody>(documentInternalWriteSchema);

export interface InternalDocumentWriteInput {
  humanSubject: string;
  title: string;
  body: string;
  occurredAt: string;
}

/**
 * T-APP-05. A first-party writer for the Automation App's daily report.
 *
 * The Automation App calls `POST /documents` with its own Cloud Run service
 * identity, not a delegated agent's DPoP-bound Access Token — there is no agent
 * yet to delegate from (T-APP-04). This mirrors `createInternalRevokeRoute`'s
 * verifier and configuration pattern (a Cloud Run identity checked against one
 * configured email, no DPoP) rather than inventing a second one.
 *
 * The carve-out is deliberately narrow: only `POST` at the exact `/documents`
 * path, only a body whose `type` is the literal `daily_report`, and only when the
 * caller resolves to the configured Automation App service account. Anything else
 * — a different method, a sub-path, an unrecognised caller — falls through to the
 * ordinary XAA-protected pipeline unconsumed, so `GET /documents` and
 * `GET /documents/{id}` never gain a service-identity path (never a read path;
 * `PATCH` is untouched the same way). The owner is `human_subject` from the body,
 * because a service identity carries no `sub` for `withAgentOwnership` to use.
 */
export function createInternalDocumentWriter(options: {
  verifier: ServiceIdentityVerifier;
  automationAppServiceAccount: string;
  create(input: InternalDocumentWriteInput): Promise<string>;
}): MiddlewareHandler<Env> {
  return async (context, next) => {
    if (context.req.method !== 'POST' || context.req.path !== '/documents') return next();
    const authorization = context.req.header('authorization');
    // A DPoP-bound Access Token never has this shape, so a real XAA caller always
    // falls straight through to `createResourceProtection` unaffected.
    if (!authorization?.startsWith('Bearer ')) return next();
    const caller = await options.verifier.verify(authorization);
    if (caller !== options.automationAppServiceAccount) return next();

    let parsed: unknown;
    try {
      parsed = await context.req.json();
      assertBody(parsed);
    } catch (error) {
      if (error instanceof SchemaValidationError || error instanceof SyntaxError) return context.json({ error: 'invalid_request' }, 400);
      throw error;
    }
    const documentId = await options.create({
      humanSubject: parsed.human_subject, title: parsed.title, body: parsed.body, occurredAt: parsed.occurred_at,
    });
    return context.json({ document_id: documentId }, 201);
  };
}
