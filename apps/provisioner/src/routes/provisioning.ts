import { Hono } from 'hono';
import { PLATFORM_CLIENT_ID, type IsolationLevel } from '@xaa/contracts';
import type { ControlPlaneVariables } from '@xaa/control-plane-auth';
import type { Logger } from '@xaa/logging';
import { buildToolManifest } from '../catalog/build-manifest.js';
import { buildXaaConfig } from '../catalog/build-xaa-config.js';
import { resolveAllowedTools } from '../catalog/resolve-tools.js';
import type { CatalogRepository } from '../catalog/repository.js';
import { createAgentClientCredential, newAgentId } from '../agent/identity.js';
import { computeExpiresAt } from '../agent/expiry.js';
import { createAgentRegistration, setProvisioningStatus, deleteAgentRegistration } from '../agent/registration.js';
import { reserveFullIsolationSlot } from '../capacity.js';
import { createDedicatedLedger } from '../dedicated-ledger.js';
import { dedicatedNames } from '../dedicated-names.js';
import { startAgentExecution, ExecutionAlreadyRunning } from '../job/execute.js';
import { validateAgentDefinition, DefinitionRejected } from './agent-definition.js';
import { buildConsentResponse } from './consent-response.js';
import type { ProvisionerDeps } from '../deps.js';

type Env = { Variables: ControlPlaneVariables };

export interface DecisionRecord {
  decision_id: string;
  human_subject: string;
  effective_capabilities: string[];
  security_profile: { isolation_level: IsolationLevel };
  constraints: Record<string, Record<string, unknown>>;
}

/**
 * `POST /provisioning`. Turns an approved decision into a running agent.
 *
 * Nothing is written until every check has passed (RULE-43, RULE-44): the token, the
 * proof, the body shape, the decision's ownership and the capability subset are all
 * settled before the first Firestore write, so a rejected request leaves no trace to
 * clean up.
 */
export function createProvisioningRoute(deps: ProvisionerDeps & { catalogue: CatalogRepository; logger: Logger }): Hono<Env> {
  const app = new Hono<Env>();
  const ledger = createDedicatedLedger(deps.documents, () => deps.clock.now());

  app.post('/', async (context) => {
    const humanSubject = context.get('humanSubject');
    let definition;
    try {
      definition = validateAgentDefinition(context.get('validatedBody'), Math.floor(deps.config.agentMaxLifetimeSeconds / 3600));
    } catch (error) {
      if (error instanceof DefinitionRejected) return context.json({ error: error.code }, 400);
      throw error;
    }

    // The decision is re-read rather than trusted from the body, and its owner must
    // be the caller: a decision id is not a bearer token.
    const decision = await deps.documents.get<DecisionRecord>('authorization_decisions', definition.decision_id);
    if (!decision) return context.json({ error: 'decision_mismatch' }, 400);
    if (decision.human_subject !== humanSubject) return context.json({ error: 'decision_owner_mismatch' }, 403);

    // RULE-11 once more, at the moment of provisioning: permissions may have been
    // revoked between the decision and this request.
    const held = new Set((await deps.documents.queryEqual<{ capability_id: string }>(
      'human_permissions', [['human_subject', humanSubject]],
    )).map(({ data }) => data.capability_id));
    const exceeded = decision.effective_capabilities.filter((capability) => !held.has(capability));
    if (exceeded.length > 0) return context.json({ error: 'capability_not_subset_of_human_permission' }, 400);

    const resolved = resolveAllowedTools(decision.effective_capabilities, await deps.catalogue.tools());
    if (!resolved.ok) {
      return context.json({ error: resolved.code, capability_id: resolved.capability_id }, 400);
    }

    const isolationLevel = decision.security_profile.isolation_level;
    const agentId = newAgentId();
    const { createdAt, expiresAt, lifetimeSeconds } = computeExpiresAt({
      requestedLifetimeHours: definition.requested_lifetime_hours,
      agentMaxLifetimeSeconds: deps.config.agentMaxLifetimeSeconds,
      now: deps.clock.now(),
    });

    // The capacity gate runs before the transaction is created, so a refused request
    // leaves no transaction behind either (T-PROV-25 ordering).
    if (isolationLevel === 'full_isolation') {
      const capacity = await reserveFullIsolationSlot({
        documents: deps.documents, agentId, capacity: deps.config.maxFullIsolationAgents,
        expiresAt, now: () => deps.clock.now(),
      });
      if (!capacity.allowed) {
        deps.logger.warning('provisioner.capacity', {
          request_id: '', trace_id: '', agent_id: null, human_subject: humanSubject,
        }, { event: 'full_isolation_capacity_reached', active: capacity.active, capacity: capacity.capacity });
        return context.json(
          { error: 'full_isolation_capacity_reached', active: capacity.active, capacity: capacity.capacity },
          503, { 'Retry-After': '60' },
        );
      }
    }

    const transaction = await deps.transactions.create({
      human_subject: humanSubject,
      agent_id: agentId,
      required_capabilities: decision.effective_capabilities,
      required_connectors: resolved.connectorIds,
      isolation_level: isolationLevel,
      pending_step: 'resolve_tools',
      dedicated_short_id: isolationLevel === 'full_isolation' ? dedicatedNames(agentId).short : null,
    });

    const xaaConfig = buildXaaConfig(resolved.tools);
    const credential = await createAgentClientCredential(agentId);
    const idpConnectionId = `idpconn-${agentId}`;

    // The IdP connection comes first: without a refresh token the agent cannot
    // obtain a subject token, and every later step would be wasted (RULE-51).
    const connection = await deps.agentOp.createIdpConnection({
      agentId, humanSubject, idpConnectionId, expiresAt,
    });
    if (connection.status === 'CONSENT_REQUIRED') {
      await deps.transactions.advance(transaction.transaction_id, 'WAITING_IDP_CONSENT', { pending_step: 'idp_consent' });
      return context.json(buildConsentResponse({
        status: 'IDP_CONSENT_REQUIRED',
        transactionId: transaction.transaction_id,
        consentUrl: connection.consentUrl,
        provisionerHost: new URL(deps.config.publicBaseUrl).host,
      }));
    }

    await deps.transactions.advance(transaction.transaction_id, 'PROVISIONING', { pending_step: 'register_agent' });

    let dedicatedOpUrl: string | null = null;
    let jobName = deps.config.standardJobName;
    if (isolationLevel === 'full_isolation') {
      await ledger.open(agentId, expiresAt);
      const dedicated = await deps.createDedicated({ agentId, expiresAt, taskTimeoutSeconds: lifetimeSeconds, ledger });
      dedicatedOpUrl = dedicated.opServiceUri;
      jobName = dedicated.runtimeJobName;
      await ledger.markReady(agentId);
    }

    await createAgentRegistration(deps.documents, {
      agent_id: agentId,
      human_subject: humanSubject,
      client_auth: { method: 'client_assertion_jwt', jwk_thumbprint: credential.thumbprint, public_jwk: { ...credential.publicJwk } },
      idp_connection_id: idpConnectionId,
      allowed_audiences: xaaConfig.allowed_audiences,
      resources: xaaConfig.resources,
      scopes: xaaConfig.scopes,
      trusted_resource_as: xaaConfig.allowed_audiences,
      created_at: createdAt,
      expires_at: expiresAt,
      status: 'PROVISIONING',
      dedicated_op: dedicatedOpUrl,
      isolation_level: isolationLevel,
      job_execution_name: null,
    });

    const manifest = buildToolManifest({
      agentId, expiresAt, tools: resolved.tools,
      connectors: await deps.catalogue.connectors(),
      addedConstraints: decision.constraints ?? {},
    });

    try {
      await startAgentExecution({
        runner: deps.jobs, documents: deps.documents, agentId, jobName,
        overrides: {
          AGENT_ID: agentId,
          HUMAN_SUBJECT: humanSubject,
          TASK_ID: definition.task_id,
          AGENT_CREATED_AT: createdAt,
          AGENT_EXPIRES_AT: expiresAt,
          AGENT_OP_BASE_URL: dedicatedOpUrl ?? deps.config.sharedAgentOpUrl,
          TOOL_MANIFEST: JSON.stringify(manifest),
          AGENT_CLIENT_PRIVATE_JWK: credential.privateJwkJson,
          ISOLATION_LEVEL: isolationLevel,
        },
      });
    } catch (error) {
      // The registration is removed rather than left orphaned: an agent that will
      // never run must not remain able to obtain grants.
      await deleteAgentRegistration(deps.documents, agentId);
      await deps.transactions.advance(transaction.transaction_id, 'FAILED', { pending_step: 'start_job_execution' });
      if (error instanceof ExecutionAlreadyRunning) return context.json({ error: 'execution_already_running' }, 409);
      throw error;
    }

    await setProvisioningStatus(deps.documents, agentId, 'ACTIVE');
    await deps.transactions.advance(transaction.transaction_id, 'COMPLETED', { pending_step: null });

    await deps.publishActivity?.({
      event_type: 'AGENT_PROVISIONED',
      phase: 'provisioning',
      outcome: 'allowed',
      agent_id: agentId,
      human_subject: humanSubject,
      task_id: definition.task_id,
      detail: { isolation_level: isolationLevel, allowed_tools: resolved.tools.map((tool) => tool.tool_id) },
      occurred_at: new Date(deps.clock.now()).toISOString(),
    });

    deps.logger.info('provisioner.provision', {
      request_id: '', trace_id: '', agent_id: agentId, human_subject: humanSubject,
    }, {
      isolation_level: isolationLevel,
      dedicated_op: dedicatedOpUrl !== null,
      provisioned_tools: resolved.tools.map((tool) => tool.tool_id),
      static_xaa: xaaConfig,
      idp_connection_state: connection.status,
      created_at: createdAt,
      expires_at: expiresAt,
    });

    return context.json({
      status: 'PROVISIONED',
      agent_id: agentId,
      transaction_id: transaction.transaction_id,
      expires_at: expiresAt,
      allowed_tools: resolved.tools.map((tool) => tool.tool_id),
      isolation_level: isolationLevel,
    }, 201);
  });

  return app;
}

export { PLATFORM_CLIENT_ID };
