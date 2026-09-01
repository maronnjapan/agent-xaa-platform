import { dedicatedNames, type IsolationLevel, type ToolManifest } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';
import { buildAgentBaseline, writeAgentBaseline } from '../baseline-hook.js';
import { buildToolManifest } from '../catalog/build-manifest.js';
import { buildXaaConfig } from '../catalog/build-xaa-config.js';
import { resolveAllowedTools } from '../catalog/resolve-tools.js';
import type { CatalogRepository } from '../catalog/repository.js';
import { computeExpiresAt, inheritExpiresAt } from '../agent/expiry.js';
import { createAgentClientCredential, newAgentId, type AgentClientCredential } from '../agent/identity.js';
import {
  createAgentRegistration, deleteAgentManifest, deleteAgentRegistration, setProvisioningStatus, writeAgentManifest,
} from '../agent/registration.js';
import { reserveFullIsolationSlot } from '../capacity.js';
import { createDedicatedLedger } from '../dedicated-ledger.js';
import { createActivityEmitter } from '../events/activity.js';
import { buildProvisioningLog, connectorStates, logProvisioningCompleted } from '../logging/provisioning-log.js';
import { ExecutionAlreadyRunning, startAgentExecution } from '../job/execute.js';
import {
  PreconditionFailed, ProvisioningHalted, runProvisioning,
  type ProvisioningStep, type Step, type StepContext,
} from '../orchestrator.js';
import { buildConsentResponse, type ConsentRequired } from '../routes/consent-response.js';
import type { ProvisionerDeps } from '../deps.js';

export interface FlowDeps extends ProvisionerDeps {
  catalogue: CatalogRepository;
  logger: Logger;
}

export interface ProvisionRequest {
  humanSubject: string;
  taskId: string;
  effectiveCapabilities: string[];
  isolationLevel: IsolationLevel;
  constraints: Record<string, Record<string, unknown>>;
  /** A fresh request names hours; a re-provisioning inherits the expiry it replaces. */
  lifetime: { kind: 'requested'; hours: number } | { kind: 'inherited'; expiresAt: string };
  previousAgentId?: string | null;
}

export interface ProvisionResponse {
  status: 200 | 201 | 400 | 409 | 500 | 503;
  body: Record<string, unknown> | ConsentRequired;
  headers?: Record<string, string>;
}

class CapacityExhausted extends Error {
  constructor(readonly active: number, readonly capacity: number) { super('full_isolation_capacity_reached'); }
}

/**
 * The one path from an approved decision to a running agent.
 *
 * `POST /provisioning` and `POST /internal/provisioning/reprovision` differ in who is
 * allowed to ask and in where the expiry comes from; everything after that is the one
 * ordered list of steps, so they share this function rather than each keeping their own
 * copy of the order and its compensations (T-PROV-16, T-PROV-28).
 *
 * Nothing is written until every check has passed (RULE-43, RULE-44). The subset check
 * and the tool resolution are therefore done before the first step runs: a request that
 * will be refused leaves no transaction, no reservation and nothing to clean up.
 */
export async function provisionAgent(deps: FlowDeps, request: ProvisionRequest): Promise<ProvisionResponse> {
  // RULE-11 at the moment of provisioning: permissions may have been revoked since the
  // decision, and a re-provisioning is asked for precisely because they changed.
  const held = new Set((await deps.documents.queryEqual<{ capability_id: string }>(
    'human_permissions', [['human_subject', request.humanSubject]],
  )).map(({ data }) => data.capability_id));
  const exceeded = request.effectiveCapabilities.filter((capability) => !held.has(capability));
  if (exceeded.length > 0) {
    return { status: 400, body: { error: 'capability_not_subset_of_human_permission', capabilities: exceeded } };
  }

  const resolved = resolveAllowedTools(request.effectiveCapabilities, await deps.catalogue.tools());
  if (!resolved.ok) return { status: 400, body: { error: resolved.code, capability_id: resolved.capability_id } };

  const expiry = request.lifetime.kind === 'requested'
    ? computeExpiresAt({
        requestedLifetimeHours: request.lifetime.hours,
        agentMaxLifetimeSeconds: deps.config.agentMaxLifetimeSeconds,
        now: deps.clock.now(),
      })
    : inheritExpiresAt({ inheritedExpiresAt: request.lifetime.expiresAt, now: deps.clock.now() });
  if (!expiry) return { status: 400, body: { error: 'invalid_request', field: 'inherited_expires_at' } };

  const ledger = createDedicatedLedger(deps.documents, () => deps.clock.now());
  const emit = createActivityEmitter({
    transactions: deps.transactions,
    logger: deps.logger,
    now: () => deps.clock.now(),
    ...(deps.publishActivity ? { publish: deps.publishActivity } : {}),
  });

  const agentId = newAgentId();
  const idpConnectionId = `idpconn-${agentId}`;
  const xaaConfig = buildXaaConfig(resolved.tools);
  const context: StepContext = { agentId, isolationLevel: request.isolationLevel, transactionId: '' };

  const state: {
    credential?: AgentClientCredential;
    idpStatus: string;
    idpReady: boolean;
    dedicatedOpUrl: string | null;
    jobName: string;
    consent?: ConsentRequired;
  } = { idpStatus: 'UNKNOWN', idpReady: false, dedicatedOpUrl: null, jobName: deps.config.standardJobName };

  /**
   * Hands the slot and the resources back to Lifecycle. The Provisioner never deletes
   * a GCP resource itself (00b §4: deletion is T-LIFE-09's), so failing the ledger is
   * how a half-built agent becomes something the sweep can finish.
   */
  const failLedger = async (message: string, onlyIfCreating: boolean): Promise<void> => {
    if (request.isolationLevel !== 'full_isolation') return;
    const record = await ledger.read(agentId);
    if (!record) return;
    if (onlyIfCreating && record.status !== 'CREATING') return;
    await ledger.markFailed(agentId, message);
  };

  const connectors = await deps.catalogue.connectors();
  let cachedManifest: ToolManifest | undefined;
  // Built once and used twice: the copy in Firestore and the copy in the job's
  // environment have to be the same bytes, or the Runtime's digest check fails.
  const manifest = (): ToolManifest => {
    cachedManifest ??= buildToolManifest({
      agentId, expiresAt: expiry.expiresAt, tools: resolved.tools,
      connectors, addedConstraints: request.constraints,
    });
    return cachedManifest;
  };

  const requireIdpReady = (step: ProvisioningStep): void => {
    // RULE-51. An agent whose refresh token is not usable must not be given anything
    // else: every later step would be building on a delegation that does not exist.
    if (!state.idpReady) throw new PreconditionFailed('verify_idp_connection', step);
  };

  const steps: Step[] = [
    {
      id: 'create_transaction',
      async run() {
        if (request.isolationLevel === 'full_isolation') {
          const capacity = await reserveFullIsolationSlot({
            documents: deps.documents, agentId, capacity: deps.config.maxFullIsolationAgents,
            expiresAt: expiry.expiresAt, now: () => deps.clock.now(),
          });
          if (!capacity.allowed) throw new CapacityExhausted(capacity.active, capacity.capacity);
        }
        const transaction = await deps.transactions.create({
          human_subject: request.humanSubject,
          agent_id: agentId,
          required_capabilities: request.effectiveCapabilities,
          required_connectors: resolved.connectorIds,
          isolation_level: request.isolationLevel,
          pending_step: 'resolve_tools',
          dedicated_short_id: request.isolationLevel === 'full_isolation' ? dedicatedNames(agentId).short : null,
        });
        context.transactionId = transaction.transaction_id;
        await emit({
          eventType: 'provisioning.started',
          transactionId: context.transactionId,
          humanSubject: request.humanSubject,
          agentId,
          message: request.previousAgentId
            ? `権限が変わったため、${request.effectiveCapabilities.length} 件の権限で Agent を作り直します。`
            : `${request.effectiveCapabilities.length} 件の権限で Agent の作成を始めました。`,
          detail: {
            isolation_level: request.isolationLevel,
            capabilities: request.effectiveCapabilities,
            // Present only for a replacement, so a timeline can join the new agent to
            // the one it took over from (RULE-29).
            ...(request.previousAgentId ? { replaces_agent_id: request.previousAgentId } : {}),
          },
        });
      },
      compensate: async () => failLedger('provisioning failed before the dedicated resources were built', true),
    },
    {
      id: 'resolve_tools',
      // The resolution itself happened before the first write; this records it as the
      // point the transaction has reached, which is where a resume starts from.
      async run() { await deps.transactions.markStep(context.transactionId, 'generate_agent_identity'); },
      compensate: 'noop',
    },
    {
      id: 'generate_agent_identity',
      async run() {
        state.credential = await createAgentClientCredential(agentId);
        await deps.transactions.markStep(context.transactionId, 'set_expires_at');
      },
      // The private key exists only in this process's memory (RULE-20); there is
      // nothing persisted to take back.
      compensate: 'noop',
    },
    {
      id: 'set_expires_at',
      async run() { await deps.transactions.markStep(context.transactionId, 'idp_consent'); },
      compensate: 'noop',
    },
    {
      id: 'idp_consent',
      async run() {
        const connection = await deps.agentOp.createIdpConnection({
          agentId, humanSubject: request.humanSubject, idpConnectionId,
          expiresAt: expiry.expiresAt, transactionId: context.transactionId,
        });
        state.idpStatus = connection.status;
        if (connection.status === 'CONSENT_REQUIRED') {
          await deps.transactions.advance(context.transactionId, 'WAITING_IDP_CONSENT', { pending_step: 'idp_consent' });
          state.consent = buildConsentResponse({
            status: 'IDP_CONSENT_REQUIRED',
            transactionId: context.transactionId,
            consentUrl: connection.consentUrl,
            provisionerHost: new URL(deps.config.publicBaseUrl).host,
          });
          await emit({
            eventType: 'provisioning.idp_consent_required',
            transactionId: context.transactionId,
            humanSubject: request.humanSubject,
            agentId,
            message: 'Agent が代理でログインするために、利用者の同意が必要です。',
          });
          throw new ProvisioningHalted('idp_consent');
        }
        await deps.transactions.markStep(context.transactionId, 'verify_idp_connection');
      },
      compensate: async () => { await deps.agentOp.revokeIdpConnection?.(idpConnectionId); },
    },
    {
      id: 'verify_idp_connection',
      async run() {
        // Asked for even when the connection was created READY a moment ago: the
        // creating call says the Agent OP accepted the request, and only this one says
        // the refresh token behind it is usable now (RULE-51).
        const { status } = await deps.agentOp.verifyIdpConnection(idpConnectionId);
        state.idpReady = status === 'READY';
        state.idpStatus = status;
        if (!state.idpReady) throw new PreconditionFailed('verify_idp_connection', 'register_agent');
        await deps.transactions.advance(context.transactionId, 'PROVISIONING', { pending_step: 'register_agent' });
        await emit({
          eventType: 'provisioning.idp_connection_created',
          transactionId: context.transactionId,
          humanSubject: request.humanSubject,
          agentId,
          message: 'Agent が利用者の代理でログインできるようになりました。',
          detail: { idp_connection_id: idpConnectionId },
        });
      },
      compensate: 'noop',
    },
    ...(request.isolationLevel === 'full_isolation' ? [{
      id: 'create_dedicated_resources' as const,
      async run() {
        requireIdpReady('create_dedicated_resources');
        try {
          const dedicated = await deps.createDedicated({
            agentId, expiresAt: expiry.expiresAt, taskTimeoutSeconds: expiry.lifetimeSeconds, ledger,
          });
          state.dedicatedOpUrl = dedicated.opServiceUri;
          state.jobName = dedicated.runtimeJobName;
          await ledger.markReady(agentId);
        } catch (error) {
          // Written here rather than in the compensation: a step's own compensation
          // does not run for the step that failed, and a ledger left at CREATING is
          // one the sweep has no reason to look at.
          await failLedger(error instanceof Error ? error.message : 'unknown', false);
          throw error;
        }
      },
      compensate: async () => failLedger('provisioning failed after the dedicated resources were built', false),
    }] : []),
    {
      id: 'register_agent',
      async run() {
        requireIdpReady('register_agent');
        await createAgentRegistration(deps.documents, {
          agent_id: agentId,
          human_subject: request.humanSubject,
          client_auth: {
            method: 'client_assertion_jwt',
            jwk_thumbprint: state.credential!.thumbprint,
            public_jwk: { ...state.credential!.publicJwk },
          },
          idp_connection_id: idpConnectionId,
          allowed_audiences: xaaConfig.allowed_audiences,
          resources: xaaConfig.resources,
          scopes: xaaConfig.scopes,
          trusted_resource_as: xaaConfig.allowed_audiences,
          created_at: expiry.createdAt,
          expires_at: expiry.expiresAt,
          status: 'PROVISIONING',
          dedicated_op: state.dedicatedOpUrl,
          isolation_level: request.isolationLevel,
          job_execution_name: null,
        });
        await writeAgentManifest(deps.documents, agentId, { ...manifest() });
        await deps.transactions.markStep(context.transactionId, 'start_job_execution');
        await emit({
          eventType: 'provisioning.agent_registered',
          transactionId: context.transactionId,
          humanSubject: request.humanSubject,
          agentId,
          message: `${resolved.tools.length} 件のツールを使える Agent として登録しました。`,
          detail: { allowed_tools: resolved.tools.map((tool) => tool.tool_id) },
        });
      },
      // An agent that will never run must not remain able to obtain grants.
      compensate: async () => {
        await deleteAgentRegistration(deps.documents, agentId);
        await deleteAgentManifest(deps.documents, agentId);
      },
    },
    {
      id: 'start_job_execution',
      async run() {
        await startAgentExecution({
          runner: deps.jobs, documents: deps.documents, agentId, jobName: state.jobName,
          overrides: {
            AGENT_ID: agentId,
            HUMAN_SUBJECT: request.humanSubject,
            TASK_ID: request.taskId,
            AGENT_CREATED_AT: expiry.createdAt,
            AGENT_EXPIRES_AT: expiry.expiresAt,
            AGENT_OP_BASE_URL: state.dedicatedOpUrl ?? deps.config.sharedAgentOpUrl,
            TOOL_MANIFEST: JSON.stringify(manifest()),
            AGENT_CLIENT_PRIVATE_JWK: state.credential!.privateJwkJson,
            ISOLATION_LEVEL: request.isolationLevel,
          },
        });
        await deps.transactions.markStep(context.transactionId, 'activate');
        await emit({
          eventType: 'provisioning.job_started',
          transactionId: context.transactionId,
          humanSubject: request.humanSubject,
          agentId,
          message: 'Agent の実行を開始しました。',
          detail: { task_id: request.taskId },
        });
      },
      compensate: 'noop',
    },
    {
      id: 'activate',
      async run() {
        await setProvisioningStatus(deps.documents, agentId, 'ACTIVE');
        await deps.transactions.advance(context.transactionId, 'COMPLETED', { pending_step: null });
        // Written once, and only now: the detector emits no rule hit for an agent it
        // has no baseline for, so a provisioning that succeeded without this leaves an
        // agent every rule is blind to (T-SEC-25).
        await writeAgentBaseline({
          documents: deps.documents,
          agentId,
          baseline: buildAgentBaseline({
            effectiveCapabilities: request.effectiveCapabilities,
            expectedTools: resolved.tools.map((tool) => tool.tool_id),
            expectedResources: resolved.tools.map((tool) => tool.authorization.resource),
            expiresAt: expiry.expiresAt,
          }),
        });
        await emit({
          eventType: 'agent.active',
          transactionId: context.transactionId,
          humanSubject: request.humanSubject,
          agentId,
          message: `Agent が使えるようになりました。有効期限は ${expiry.expiresAt} です。`,
          detail: { expires_at: expiry.expiresAt, allowed_tools: resolved.tools.map((tool) => tool.tool_id) },
        });
      },
      compensate: 'noop',
    },
  ];

  const result = await runProvisioning(steps, context, deps.logger);

  if (result.haltedAt !== undefined) return { status: 200, body: state.consent! };

  if (result.failedAt !== undefined) {
    const error = result.error;
    if (error instanceof CapacityExhausted) {
      deps.logger.warning('provisioner.capacity', {
        request_id: '', trace_id: '', agent_id: null, human_subject: request.humanSubject,
      }, { event: 'full_isolation_capacity_reached', active: error.active, capacity: error.capacity });
      return {
        status: 503,
        body: { error: 'full_isolation_capacity_reached', active: error.active, capacity: error.capacity },
        headers: { 'Retry-After': '60' },
      };
    }
    // Every failure after the transaction exists is recorded on it. A transaction left
    // in an intermediate state is one the sweep cannot tell from a consent still
    // pending (T-PROV-14).
    if (context.transactionId !== '') {
      await deps.transactions.advance(context.transactionId, 'FAILED', { pending_step: result.failedAt })
        .catch(() => undefined);
    }
    if (error instanceof ExecutionAlreadyRunning) return { status: 409, body: { error: 'execution_already_running' } };
    if (error instanceof PreconditionFailed) {
      return {
        status: 409,
        body: { error: 'precondition_failed', expected_step: error.expectedStep, actual_step: error.actualStep },
      };
    }
    return { status: 500, body: { error: 'internal_error' } };
  }

  // The order the steps actually ran in, on the record. docs 07 §3.3 fixes it, and a
  // reordering is the kind of change that keeps working until the day it does not.
  deps.logger.info('provisioner.steps', {
    request_id: '', trace_id: `prov-${context.transactionId}`, agent_id: agentId, human_subject: request.humanSubject,
  }, { completed: result.completed });

  logProvisioningCompleted(deps.logger, buildProvisioningLog({
    agent_id: agentId,
    human_subject: request.humanSubject,
    transaction_id: context.transactionId,
    isolation_level: request.isolationLevel,
    dedicated_op: state.dedicatedOpUrl !== null,
    dedicated_short_id: request.isolationLevel === 'full_isolation' ? dedicatedNames(agentId).short : null,
    provisioned_tools: resolved.tools.map((tool) => tool.tool_id),
    allowed_audiences: xaaConfig.allowed_audiences,
    resources: xaaConfig.resources,
    scopes: xaaConfig.scopes,
    idp_connection_status: state.idpStatus,
    connector_states: connectorStates(resolved.connectorIds, connectors),
    created_at: expiry.createdAt,
    expires_at: expiry.expiresAt,
  }));

  return {
    status: 201,
    body: {
      status: 'PROVISIONED',
      agent_id: agentId,
      transaction_id: context.transactionId,
      expires_at: expiry.expiresAt,
      allowed_tools: resolved.tools.map((tool) => tool.tool_id),
      isolation_level: request.isolationLevel,
    },
  };
}
