import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { jwkThumbprint } from '@xaa/crypto';
import { executeTool } from '@xaa/agent-runtime/src/tool-executor/index';
import { decodeJwtPayload } from '../../harness/oauth-flow.js';
import { AGENT_OP_BASE, startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';
import { HUMAN_IDP_ISSUER, idpPublicJwk } from '../../harness/human-idp.js';
import { seedDocument, startResource, type ResourceHarness } from '../../harness/resource.js';
import { nativeManifest, startAgentRuntime, type RuntimeHarness } from '../../harness/agent-runtime.js';
import { humanIdToken } from './native-xaa-path.spec.js';

/**
 * REQ-05-093, Document side. docs 05 §7's Runtime Flow driven by the real Tool
 * Executor: the ten steps happen because the code runs them, not because the spec
 * calls them in order.
 */
export async function docsRuntime(options: { humanSubject?: string } = {}): Promise<{
  runtime: RuntimeHarness; agentOp: AgentOpHarness; docs: ResourceHarness; subjectToken: string;
}> {
  const humanSubject = options.humanSubject ?? 'testuser';
  const subjectToken = await humanIdToken();
  const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanSubject });
  const docs = await startResource({
    kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER,
  });
  const runtime = await startAgentRuntime({
    agentOp, agentOpBaseUrl: AGENT_OP_BASE, resources: [docs], humanSubject,
    manifest: nativeManifest({ agentId: agentOp.agentId, resource: docs, kind: 'docs' }),
    agentClientPrivateJwk: JSON.stringify(await webcrypto.subtle.exportKey('jwk', agentOp.agentKeyPair.privateKey)),
  });
  // The Agent OP mints subject tokens from its stored IdP connection; the harness
  // seeds the one the Runtime will ask for.
  await agentOp.documents.set('idp_connections', `idpconn-${agentOp.agentId}`, {
    idp_connection_id: `idpconn-${agentOp.agentId}`, agent_id: agentOp.agentId, human_subject: humanSubject,
    id_token: subjectToken, refresh_token_ciphertext: 'x', status: 'ACTIVE',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return { runtime, agentOp, docs, subjectToken };
}

describe('the Runtime Flow, Document side', () => {
  it('carries the delegation through all four hops', async () => {
    const { runtime, agentOp, docs, subjectToken } = await docsRuntime();
    runtime.context.tokens.set('subject', subjectToken, Date.now() + 3_600_000);
    await seedDocument(docs, 'testuser');

    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: (line) => runtime.stageLines.push(line),
    }, { tool_id: 'internal.document.list', parameters: {} });

    expect(result).toMatchObject({ outcome: 'success' });

    const accessToken = runtime.context.tokens.get(
      `at:${docs.asIssuer}|${docs.resourceUri}|docs.read`, Date.now(),
    )!;
    const claims = decodeJwtPayload(accessToken);
    const jkt = await jwkThumbprint(runtime.context.dpop.publicJwk);

    // (1) the ID-JAG's subject is the delegating human, (2) its actor is this agent,
    // (3) it is addressed to this Resource AS, (4) it is bound to the execution key,
    // (5) the Access Token carries the same binding and (6) the same actor.
    const rawIdJag = runtime.context.tokens.get(`idjag:internal.document.list`, Date.now())!;
    const idJagClaims = decodeJwtPayload(rawIdJag);
    expect(idJagClaims.sub).toBe('testuser');
    expect((idJagClaims.act as { sub: string }).sub).toBe(`urn:xaa:agent:${agentOp.agentId}`);
    expect(idJagClaims.aud).toBe(docs.asIssuer);
    expect((idJagClaims.cnf as { jkt: string }).jkt).toBe(jkt);
    expect((claims.cnf as { jkt: string }).jkt).toBe(jkt);
    expect(claims.act).toEqual(idJagClaims.act);
  });

  it('hands the model only the fields the allow list names', async () => {
    const { runtime, docs, subjectToken } = await docsRuntime();
    runtime.context.tokens.set('subject', subjectToken, Date.now() + 3_600_000);
    await seedDocument(docs, 'testuser', { title: '週次レポート', body: '社外秘の本文' });

    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: () => {},
    }, { tool_id: 'internal.document.list', parameters: {} });

    expect(result).toMatchObject({ outcome: 'success' });
    expect(JSON.stringify(result)).toContain('週次レポート');
    expect(JSON.stringify(result)).not.toContain('社外秘の本文');
  });

  it('emits the stage log without a token in it', async () => {
    const { runtime, docs, subjectToken } = await docsRuntime();
    runtime.context.tokens.set('subject', subjectToken, Date.now() + 3_600_000);
    await seedDocument(docs, 'testuser');
    await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: (line) => runtime.stageLines.push(line),
    }, { tool_id: 'internal.document.list', parameters: {} });

    const stages = runtime.stageLines.map((line) => (JSON.parse(line) as { stage: string }).stage);
    expect(stages).toEqual([
      'agent_intent', 'tool_selection', 'required_capability', 'auth_mapping',
      'agent_op', 'id_jag', 'token_endpoint', 'access_token', 'resource_api',
    ]);
    for (const line of runtime.stageLines) expect(line).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./);
  });
});
