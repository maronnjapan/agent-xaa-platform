import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { jwkThumbprint } from '@xaa/crypto';
import { executeTool } from '@xaa/agent-runtime/src/tool-executor/index';
import { decodeJwtPayload } from '../../harness/oauth-flow.js';
import { AGENT_OP_BASE, FINANCE_API_RESOURCE, FINANCE_AS_ISSUER, startAgentOp } from '../../harness/agent-op.js';
import { HUMAN_IDP_ISSUER, idpPublicJwk } from '../../harness/human-idp.js';
import { seedPayment, startResource } from '../../harness/resource.js';
import { nativeManifest, startAgentRuntime } from '../../harness/agent-runtime.js';
import { humanIdToken } from './native-xaa-path.spec.js';

/**
 * REQ-05-093, Finance side. The same ten steps as the Document flow, run at
 * FULL_ISOLATION: the shape of the path does not change with the isolation level,
 * only which OP signs and which key the agent holds. The one behavioural difference
 * the Finance resource enforces is that a standard agent is refused outright.
 */
async function financeRuntime(options: { isolationLevel: 'standard' | 'full_isolation' }) {
  const humanSubject = 'testuser';
  const subjectToken = await humanIdToken();
  const agentOp = await startAgentOp({
    idpPublicJwk: await idpPublicJwk(), humanSubject,
    isolationLevel: options.isolationLevel,
    allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
    scopes: ['finance.tx.read', 'finance.tx.write'],
  });
  const finance = await startResource({
    kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER,
  });
  const runtime = await startAgentRuntime({
    agentOp, agentOpBaseUrl: AGENT_OP_BASE, resources: [finance], humanSubject,
    manifest: nativeManifest({ agentId: agentOp.agentId, resource: finance, kind: 'finance' }),
    agentClientPrivateJwk: JSON.stringify(await webcrypto.subtle.exportKey('jwk', agentOp.agentKeyPair.privateKey)),
  });
  await agentOp.documents.set('idp_connections', `idpconn-${agentOp.agentId}`, {
    idp_connection_id: `idpconn-${agentOp.agentId}`, agent_id: agentOp.agentId, human_subject: humanSubject,
    id_token: subjectToken, refresh_token_ciphertext: 'x', status: 'ACTIVE',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  runtime.context.tokens.set('subject', subjectToken, Date.now() + 3_600_000);
  return { runtime, agentOp, finance };
}

describe('the Runtime Flow, Finance side', () => {
  it('carries the delegation through all four hops', async () => {
    const { runtime, agentOp, finance } = await financeRuntime({ isolationLevel: 'full_isolation' });
    await seedPayment(finance, 'testuser');

    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: (line) => runtime.stageLines.push(line),
    }, { tool_id: 'internal.finance.payment.list', parameters: {} });
    expect(result).toMatchObject({ outcome: 'success' });

    const jkt = await jwkThumbprint(runtime.context.dpop.publicJwk);
    const idJag = decodeJwtPayload(runtime.context.tokens.get('idjag:internal.finance.payment.list', Date.now())!);
    const accessToken = decodeJwtPayload(
      runtime.context.tokens.get(`at:${finance.asIssuer}|${finance.resourceUri}|finance.tx.read`, Date.now())!,
    );

    expect(idJag.sub).toBe('testuser');
    expect((idJag.act as { sub: string }).sub).toBe(`urn:xaa:agent:${agentOp.agentId}`);
    expect(idJag.aud).toBe(finance.asIssuer);
    expect((idJag.cnf as { jkt: string }).jkt).toBe(jkt);
    expect((accessToken.cnf as { jkt: string }).jkt).toBe(jkt);
    expect(accessToken.act).toEqual(idJag.act);
  });

  it('refuses a standard agent with insufficient_isolation', async () => {
    const { runtime, finance } = await financeRuntime({ isolationLevel: 'standard' });
    await seedPayment(finance, 'testuser');
    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: () => {},
    }, { tool_id: 'internal.finance.payment.list', parameters: {} });
    // The refusal comes from the Resource AS, before an Access Token exists.
    expect(result).toMatchObject({ outcome: 'failed', error_code: 'resource_as_error', status: 403 });
  });

  it('stops an over-limit approval before it reaches the resource', async () => {
    const { runtime, finance } = await financeRuntime({ isolationLevel: 'full_isolation' });
    const paymentId = await seedPayment(finance, 'testuser', { amount: 900000 });
    const before = runtime.hostCalls.length;
    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: () => {},
    }, { tool_id: 'internal.finance.payment.approve', parameters: { id: paymentId, amount: 900000 } });
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'constraint_violation', constraint: 'max_amount' });
    expect(runtime.hostCalls.length).toBe(before);
  });

  it('approves within the limit and records the agent as the approver', async () => {
    const { runtime, agentOp, finance } = await financeRuntime({ isolationLevel: 'full_isolation' });
    const paymentId = await seedPayment(finance, 'testuser', { amount: 120000 });
    const result = await executeTool({
      context: runtime.context, http: runtime.http, logger: runtime.logger,
      logContext: runtime.logContext, stageWrite: () => {},
    }, { tool_id: 'internal.finance.payment.approve', parameters: { id: paymentId, amount: 120000 } });
    expect(result).toMatchObject({ outcome: 'success' });
    const stored = await finance.seedStore.get<{ approved_by: string; approved_by_agent: string }>('payments', paymentId);
    expect(stored!.approved_by).toBe('testuser');
    expect(stored!.approved_by_agent).toBe(`urn:xaa:agent:${agentOp.agentId}`);
  });
});
