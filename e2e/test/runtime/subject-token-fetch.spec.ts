import { describe, expect, it } from 'vitest';
import { executeTool } from '@xaa/agent-runtime/src/tool-executor/index';
import { fetchSubjectToken } from '@xaa/agent-runtime/src/tokens/subject-token';
import { seedDocument } from '../../harness/resource.js';
import { docsRuntime } from './runtime-flow-docs.spec.js';

/**
 * REQ-05-051 / REQ-01-008. The Runtime asking the real Agent OP for its subject token.
 *
 * Every other Runtime spec puts the ID Token straight into the token store, so
 * `fetchSubjectToken` was the one hop in the flow that no test ever made against the
 * service that answers it. Agent OP sends `subject_token`, the Runtime read
 * `id_token`, and both sides' own tests passed while every Cloud Run Job Execution
 * died at its first tool call with `subject token response has no id_token` — the
 * agent produced nothing, and the failure showed up only in production logs.
 *
 * So nothing here is seeded into the store: the token comes over the wire from
 * `/xaa/subject-token` or the test fails.
 */
describe('the subject token, fetched from the real Agent OP', () => {
  it('comes back from /xaa/subject-token with no token planted first', async () => {
    const { runtime, subjectToken } = await docsRuntime();
    expect(runtime.context.tokens.get('subject')).toBeUndefined();

    const fetched = await fetchSubjectToken(runtime.context, runtime.http);

    expect(fetched).toBe(subjectToken);
    // Cached for the next tool call, so one execution asks once.
    expect(runtime.context.tokens.get('subject')).toBe(subjectToken);
  });

  it('carries a tool call through to data without a planted token', async () => {
    const { runtime, docs } = await docsRuntime();
    await seedDocument(docs, 'testuser');

    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: (line) => runtime.stageLines.push(line),
    }, { tool_id: 'internal.document.list', parameters: {} });

    // The whole point: the execution that failed in production now reaches the API.
    expect(result).toMatchObject({ outcome: 'success' });
    expect((result as { data: { documents: unknown[] } }).data.documents).toHaveLength(1);
  });

  it('leaves the rotated refresh token on the Agent OP side of the wire', async () => {
    const { runtime, agentOp } = await docsRuntime();
    await fetchSubjectToken(runtime.context, runtime.http);

    // Human IdP rotated to `rt-2` during that call. The Runtime never saw it: it is
    // re-encrypted in the connection record and absent from everything the Runtime holds.
    const stored = await agentOp.documents.get<{ encrypted_refresh_token: string }>(
      'idp_connections', `idpconn-${agentOp.agentId}`,
    );
    expect(Buffer.from(stored!.encrypted_refresh_token, 'base64').toString('utf8')).toBe(`${agentOp.agentId}::rt-2`);
    expect(runtime.context.tokens.get('subject')).not.toContain('rt-2');
  });
});
