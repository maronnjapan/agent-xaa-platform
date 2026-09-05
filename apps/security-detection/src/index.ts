import { Hono } from 'hono';
import { createLogger, type Logger } from '@xaa/logging';
import type { ActivityEvent } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import type { AgentBaseline } from './baseline/types.js';
import { createPipelineDeps, dispatch, runPipeline, type DispatchCounters } from './pipeline/index.js';
import type { NormalizedEvent } from './normalize/index.js';
import type { SecurityFinding } from './correlate/finding.js';
import type { AgentRegistrationView } from './rules/index.js';
import { buildAiInput, type RelatedEventSummary } from './ai/input.js';
import { fallbackResponse, parseAiOutput, type ResponseState } from './ai/output.js';
import { needsHumanReview } from './response/review.js';
import { requestTransition, type LifecycleSender, type TransitionOutcome } from './response/dispatch.js';
import { emitQuarantineEvent } from './activity/quarantine-event.js';
import { createInternalBatchRoutes } from './routes/internal-batch.js';
import type { RuleHitRow } from './batch/signing-key-misuse.js';

export interface SecurityDetectionDeps {
  documents: DocumentStore;
  /** Reached only through here; there is no other outbound call in this service. */
  sendToLifecycle: LifecycleSender;
  analyze?(input: ReturnType<typeof buildAiInput>): Promise<string | null>;
  logger?: Logger;
  now?: () => number;
  financeResourceUrl?: string;
  /** From `AGENT_MAX_LIFETIME_SECONDS` (DEC-IAC-16); never a literal in this app. */
  maxLifetimeSeconds?: number | null;
  callerVerify?(token: string): Promise<string | null>;
  /** Separate from `callerVerify`: approving a quarantine is not ingesting a log. */
  reviewerVerify?(token: string): Promise<string | null>;
  /** Cloud Scheduler's identity; `sa-scheduler` alone (T-SEC-15). */
  schedulerVerify?(token: string): Promise<string | null>;
  /** The five-minute ledger reconciliation; absent when BigQuery is not configured. */
  runSigningKeyMisuse?(now: Date): Promise<readonly RuleHitRow[]>;
  publishActivity?(event: ActivityEvent): Promise<void>;
}

export interface StoredFinding extends SecurityFinding {
  recommended_response?: ResponseState;
  confidence?: number;
}

/** One batch of raw log payloads, taken through the six stages and dispatched. */
export type DetectionRun = (payloads: readonly unknown[]) => Promise<void>;

/**
 * Collects what the platform's services logged, and decides whether anything is wrong.
 *
 * It reaches exactly one other service, the Lifecycle Manager, and only to ask. Nothing
 * here calls the Agent OP or a Resource AS: a detector that could act directly would be
 * a second authority over an agent's credentials, and the two would eventually disagree.
 *
 * The HTTP app and the ingestion run are built together and returned together, because
 * they share one set of counters: a service that scored a finding through the push route
 * and another through the pull loop would otherwise be keeping two separate tallies of
 * the same traffic.
 */
export function createSecurityDetection(deps: SecurityDetectionDeps): { app: Hono; runOnce: DetectionRun } {
  const app = new Hono();
  const logger = deps.logger ?? createLogger('security-detection', 'agent_op');
  const now = deps.now ?? (() => Date.now());
  const counters: DispatchCounters = { low_events_total: 0, unmapped_code_total: 0 };

  app.get('/livez', (context) => context.json({ status: 'ok', app: 'security-detection' }));

  /**
   * A person approving a quarantine is a request that moves an agent's state, so it is
   * gated exactly as the ingestion route is: closed unless a caller check is configured,
   * and refused unless the caller is one of the allowed service accounts. Left open, any
   * workload inside the perimeter could approve a pending finding — which is the whole of
   * the human review control, undone from inside.
   */
  app.post('/internal/review/:finding_id', async (context) => {
    const reviewer = await verifiedCaller(context.req.header('authorization'), deps.reviewerVerify);
    if (!reviewer) return context.json({ error: 'caller_not_allowed' }, 403);

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
    const to = finding.recommended_response ?? 'SUSPICIOUS';
    const outcome = await requestTransition({ finding, from: 'ACTIVE', to, send: deps.sendToLifecycle });
    await deps.documents.update('security_findings', findingId, { review_status: 'approved', reviewer: body.reviewer });
    await announceQuarantine(finding, to, outcome);
    return context.json({ review_status: 'approved' }, 200);
  });

  /**
   * The push half of DEC-SEC-03. Pull is the default because this service takes
   * INTERNAL_ONLY ingress; the route exists so that `security_events_delivery = "push"`
   * has somewhere to deliver, and it is closed unless a caller check is configured —
   * an open ingestion endpoint would let anything inside the perimeter write the
   * evidence the detector reasons about.
   */
  app.post('/internal/security-events/push', async (context) => {
    const caller = await verifiedCaller(context.req.header('authorization'), deps.callerVerify);
    if (!caller) return context.json({ error: 'caller_not_allowed' }, 403);

    const body = await context.req.json().catch(() => undefined) as { message?: { data?: unknown } } | undefined;
    const data = body?.message?.data;
    if (typeof data !== 'string') return context.json({ error: 'invalid_request' }, 400);
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    } catch {
      // A message this service cannot parse is not worth redelivering forever.
      return context.json({ error: 'invalid_request' }, 400);
    }
    // A throw here answers 500, which Pub/Sub reads as "redeliver": a detection run that
    // failed must come back rather than be acknowledged away.
    await runOnce([payload]);
    return context.body(null, 204);
  });

  // Mounted rather than declared inline: the batch has its own caller, its own schedule
  // and its own failure mode, and none of that belongs beside the ingestion routes.
  if (deps.runSigningKeyMisuse) {
    const run = deps.runSigningKeyMisuse;
    app.route('/', createInternalBatchRoutes({
      ...(deps.schedulerVerify ? { verifyScheduler: deps.schedulerVerify } : {}),
      runSigningKeyMisuse: async (at) => await run(at),
      now,
    }));
  }

  return { app, runOnce };

  async function runOnce(payloads: readonly unknown[]): Promise<void> {
    const entries = payloads.map(unwrapLogPayload);
    const agents = await loadAgents(deps.documents, entries);
    const scored = runPipeline(entries, createPipelineDeps({
      baselines: agents.baselines, registrations: agents.registrations, counters, now,
      maxLifetimeSeconds: deps.maxLifetimeSeconds ?? null,
      ...(deps.financeResourceUrl ? { financeResourceUrl: deps.financeResourceUrl } : {}),
    }));
    await dispatch(scored, {
      storeNormalized: async () => undefined,
      storeFinding: async (finding) => {
        await deps.documents.set('security_findings', finding.finding_id, finding as unknown as Record<string, unknown>);
      },
      analyze: async (finding, events) => {
        const baseline = agents.baselines.get(finding.agent_id ?? '');
        if (!baseline || !deps.analyze) return;
        const input = buildAiInput({
          finding, baseline,
          registration: agents.registrations.get(finding.agent_id ?? '') as Record<string, unknown> ?? {},
          relatedEvents: summarize(finding, events),
          workDefinitionHash: '', operationKinds: [], agentAgeSeconds: agentAge(finding, events),
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
        const outcome = await requestTransition({ finding, from: 'ACTIVE', to: response, send: deps.sendToLifecycle });
        await announceQuarantine(finding, response, outcome);
      },
    }, counters);
  }

  /**
   * The Activity Event for a quarantine, and only once the Lifecycle Manager was asked.
   *
   * Nothing is published for any other destination state: SUSPICIOUS is a change in how
   * the platform watches an agent, not something that happened to the person's work, and
   * putting it on their timeline would train them to ignore the row that matters.
   */
  async function announceQuarantine(
    finding: SecurityFinding, to: ResponseState, outcome: TransitionOutcome,
  ): Promise<void> {
    if (outcome === 'failed') {
      // The ask was made and not taken. Nothing is published, because the agent may
      // still be working; the line is here so the gap is visible in the logs.
      logger.error('transition_request_failed', {
        request_id: 'security', trace_id: finding.finding_id,
        agent_id: finding.agent_id, human_subject: finding.human_subject || null,
      }, { finding_id: finding.finding_id, requested_state: to });
      return;
    }
    if (to !== 'QUARANTINED' || outcome !== 'sent' || !finding.agent_id) return;
    if (finding.human_subject === '') {
      // No subject means no timeline to publish onto. The transition itself is already
      // recorded by the Lifecycle Manager, so nothing is lost but the display row.
      logger.warning('quarantine_event_skipped', {
        request_id: 'security', trace_id: finding.finding_id, agent_id: finding.agent_id, human_subject: null,
      }, { finding_id: finding.finding_id, reason: 'no_human_subject' });
      return;
    }
    await emitQuarantineEvent({
      payload: {
        agent_id: finding.agent_id,
        human_subject: finding.human_subject,
        related_finding_id: finding.finding_id,
        risk_level: finding.risk_level ?? 'CRITICAL',
        contributing_codes: [...finding.contributing_codes],
      },
      traceId: finding.finding_id,
      occurredAt: new Date(now()).toISOString(),
      ...(deps.publishActivity ? { publish: deps.publishActivity } : {}),
    });
  }
}

async function verifiedCaller(
  header: string | undefined,
  verify: ((token: string) => Promise<string | null>) | undefined,
): Promise<string | null> {
  if (!verify) return null;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  return token ? await verify(token).catch(() => null) : null;
}

/**
 * Cloud Logging delivers our line inside `jsonPayload`, wrapped in its own entry. The
 * in-process bus used by the tests delivers the line itself. Both arrive here.
 */
export function unwrapLogPayload(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'jsonPayload' in payload) {
    return (payload as { jsonPayload: unknown }).jsonPayload;
  }
  return payload;
}

/**
 * A description of the finding's own events, for the Security AI.
 *
 * Built from the batch that produced the finding rather than from a second query, and
 * reduced to five fields per event on the way (RULE-39): the model reasons about a
 * summary, and there is no code path that could hand it a raw log line.
 */
export function summarize(finding: SecurityFinding, events: readonly NormalizedEvent[]): RelatedEventSummary[] {
  const related = new Set(finding.related_events);
  return events
    .filter((event) => related.has(event.metadata.correlation_uid))
    .map((event) => ({
      occurred_at: event.time,
      code: String(event.attributes.validation ?? event.api.operation),
      tool_id: String(event.attributes.tool_id ?? ''),
      resource: event.api.resource,
      status: event.api.status,
    }));
}

/** The age the Runtime itself reported, never one computed from the detector's clock. */
function agentAge(finding: SecurityFinding, events: readonly NormalizedEvent[]): number {
  const related = new Set(finding.related_events);
  for (const event of events) {
    if (!related.has(event.metadata.correlation_uid)) continue;
    const age = event.attributes.agent_age_seconds;
    if (typeof age === 'number' && Number.isFinite(age) && age >= 0) return Math.floor(age);
  }
  return 0;
}

/**
 * The baselines and registrations for the agents this batch mentions, and no others.
 *
 * Read per batch rather than held in memory: a baseline is written once when the agent
 * is provisioned and a registration changes as it is quarantined or revoked, so a
 * long-lived cache here would answer for a state the platform has already left.
 */
async function loadAgents(documents: DocumentStore, entries: readonly unknown[]): Promise<{
  baselines: ReadonlyMap<string, AgentBaseline>;
  registrations: ReadonlyMap<string, AgentRegistrationView>;
}> {
  const agentIds = new Set<string>();
  for (const entry of entries) {
    const agentId = (entry as { agent_id?: unknown } | null)?.agent_id;
    if (typeof agentId === 'string' && agentId) agentIds.add(agentId);
  }
  const baselines = new Map<string, AgentBaseline>();
  const registrations = new Map<string, AgentRegistrationView>();
  for (const agentId of agentIds) {
    const baseline = await documents.get<AgentBaseline>('agents', `${agentId}__baseline`);
    if (baseline) baselines.set(agentId, baseline);
    // A registration this service cannot read leaves the comparison rules silent rather
    // than guessing; the access matrix grants it `agents/*/meta` and nothing more.
    const meta = await documents.get<AgentRegistrationView>('agents', `${agentId}__meta`).catch(() => undefined);
    if (meta) registrations.set(agentId, meta);
  }
  return { baselines, registrations };
}

function createApp(deps: SecurityDetectionDeps): Hono {
  return createSecurityDetection(deps).app;
}

export default createApp;
