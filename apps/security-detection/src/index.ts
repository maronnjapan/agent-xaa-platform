import { Hono } from 'hono';
import { createLogger, type Logger } from '@xaa/logging';
import type { DocumentStore } from '@xaa/gcp';
import type { AgentBaseline } from './baseline/types.js';
import { createPipelineDeps, dispatch, runPipeline, type DispatchCounters } from './pipeline/index.js';
import type { SecurityFinding } from './correlate/finding.js';
import { buildAiInput } from './ai/input.js';
import { fallbackResponse, parseAiOutput, type ResponseState } from './ai/output.js';
import { needsHumanReview } from './response/review.js';
import { requestTransition, type LifecycleSender } from './response/dispatch.js';

export interface SecurityDetectionDeps {
  documents: DocumentStore;
  /** Reached only through here; there is no other outbound call in this service. */
  sendToLifecycle: LifecycleSender;
  analyze?(input: ReturnType<typeof buildAiInput>): Promise<string | null>;
  logger?: Logger;
  now?: () => number;
  financeResourceUrl?: string;
  callerVerify?(token: string): Promise<string | null>;
}

export interface StoredFinding extends SecurityFinding {
  recommended_response?: ResponseState;
  confidence?: number;
}

/**
 * Collects what the platform's services logged, and decides whether anything is wrong.
 *
 * It reaches exactly one other service, the Lifecycle Manager, and only to ask. Nothing
 * here calls the Agent OP or a Resource AS: a detector that could act directly would be
 * a second authority over an agent's credentials, and the two would eventually disagree.
 */
function createApp(deps: SecurityDetectionDeps): Hono {
  const app = new Hono();
  const logger = deps.logger ?? createLogger('security-detection', 'agent_op');
  const now = deps.now ?? (() => Date.now());
  const counters: DispatchCounters = { low_events_total: 0, unmapped_code_total: 0 };

  app.get('/healthz', (context) => context.json({ status: 'ok', app: 'security-detection' }));

  app.post('/internal/review/:finding_id', async (context) => {
    const findingId = context.req.param('finding_id');
    const body = await context.req.json().catch(() => undefined) as { decision?: string; reviewer?: string } | undefined;
    if (!body || (body.decision !== 'approve' && body.decision !== 'reject') || typeof body.reviewer !== 'string') {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const finding = await deps.documents.get<StoredFinding>('security_findings', findingId);
    if (!finding) return context.json({ error: 'not_found' }, 404);
    // A decision already taken is not revisited: overwriting it would erase the record of
    // who decided what.
    if (finding.review_status === 'approved' || finding.review_status === 'rejected') {
      return context.json({ error: 'already_reviewed' }, 409);
    }
    if (body.decision === 'reject') {
      await deps.documents.update('security_findings', findingId, { review_status: 'rejected', reviewer: body.reviewer });
      return context.json({ review_status: 'rejected' }, 200);
    }
    await requestTransition({
      finding, from: 'ACTIVE', to: finding.recommended_response ?? 'SUSPICIOUS', send: deps.sendToLifecycle,
    });
    await deps.documents.update('security_findings', findingId, { review_status: 'approved', reviewer: body.reviewer });
    return context.json({ review_status: 'approved' }, 200);
  });

  return app;

  async function runOnce(entries: readonly unknown[], baselines: ReadonlyMap<string, AgentBaseline>): Promise<void> {
    const scored = runPipeline(entries, createPipelineDeps({
      baselines, counters, now,
      ...(deps.financeResourceUrl ? { financeResourceUrl: deps.financeResourceUrl } : {}),
    }));
    await dispatch(scored, {
      storeNormalized: async () => undefined,
      storeFinding: async (finding) => {
        await deps.documents.set('security_findings', finding.finding_id, finding as unknown as Record<string, unknown>);
      },
      analyze: async (finding) => {
        const baseline = baselines.get(finding.agent_id ?? '');
        if (!baseline || !deps.analyze) return;
        const input = buildAiInput({
          finding, baseline, registration: {}, relatedEvents: [],
          workDefinitionHash: '', operationKinds: [], agentAgeSeconds: 0,
        });
        const raw = await deps.analyze(input);
        const parsed = raw === null ? null : parseAiOutput(raw);
        const response = parsed?.recommendation.response ?? fallbackResponse(finding.risk_level ?? 'MEDIUM');
        const confidence = parsed?.recommendation.confidence ?? 0;
        const hold = needsHumanReview({ response, confidence, fromFallback: parsed === null });
        await deps.documents.update('security_findings', finding.finding_id, {
          review_status: hold ? 'pending' : 'none',
          recommended_response: response,
          confidence,
        });
        if (hold) {
          logger.warning('security_finding_pending_review', {
            request_id: 'security', trace_id: finding.finding_id,
            agent_id: finding.agent_id, human_subject: finding.human_subject,
          }, { finding_id: finding.finding_id, recommended_response: response, confidence });
          return;
        }
        await requestTransition({ finding, from: 'ACTIVE', to: response, send: deps.sendToLifecycle });
      },
    }, counters);
  }

  void runOnce;
}

export default createApp;
