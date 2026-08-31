import { compile } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

export const AGENT_IDENTITY_DOMAIN_FIELDS = [
  'agent_id', 'human_subject', 'isolation_level', 'registration_id', 'kms_key_name',
  'dedicated_op', 'job_execution_name', 'idp_connection_id', 'bridge_binding_ids',
  'created_at', 'expires_at', 'status', 'cleanup_step_results',
] as const;

/**
 * docs 01 §3.4's `agent_identity_domains`, as one Firestore document.
 *
 * The design intent is that Cleanup can enumerate everything belonging to an agent by
 * reading a single record (RULE-27, RULE-41): its identity, its keys, its connection,
 * its running process. Splitting that across tables would mean a partial read leaves
 * something alive, and nothing would notice.
 *
 * `dedicated_op` and `isolation_level` are tied together by the schema: a standard
 * agent has no dedicated OP, and a full-isolation one must have a slot. A record that
 * disagreed would send Cleanup looking for resources that never existed, or past ones
 * that do.
 */
export const agentIdentityDomainSchema = {
  $id: 'agent-identity-domain',
  type: 'object',
  // Open on purpose. The document belongs to the Provisioner, which writes the
  // registration Agent OP reads, and the Lifecycle Manager adds its own status
  // bookkeeping to it. A closed schema here would be a third list of keys that has to
  // be kept in step with two writers, and it would break the moment either added a
  // field. What must never appear is checked explicitly below instead.
  required: [
    'agent_id', 'human_subject', 'isolation_level', 'dedicated_op',
    'job_execution_name', 'idp_connection_id', 'created_at', 'expires_at', 'status',
  ],
  properties: {
    agent_id: { type: 'string', pattern: '^agent-[0-9a-z]{26}$' },
    human_subject: { type: 'string', minLength: 1 },
    isolation_level: { enum: ['standard', 'full_isolation'] },
    registration_id: { type: 'string' },
    kms_key_name: { type: 'string' },
    // The Dedicated OP's URL for a full-isolation agent, null for a standard one.
    dedicated_op: { type: ['string', 'null'] },
    job_execution_name: { type: ['string', 'null'] },
    idp_connection_id: { type: ['string', 'null'] },
    bridge_binding_ids: { type: 'array', items: { type: 'string' } },
    created_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    status: {
      enum: ['CREATED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED'],
    },
    cleanup_step_results: { type: 'array' },
  },
  // The two must agree: a standard agent has no dedicated OP, and a full-isolation one
  // must have its URL, or cleanup would go looking for resources that never existed —
  // or walk past ones that do.
  if: { properties: { isolation_level: { const: 'standard' } }, required: ['isolation_level'] },
  then: { properties: { dedicated_op: { type: 'null' } } },
  else: { properties: { dedicated_op: { type: 'string', minLength: 1 } } },
} as const;

/**
 * RULE-16 / RULE-46: what an agent record must never carry. The Provisioner's own
 * schema refuses these on write; this is the read side saying the same thing, so a
 * record written by some future path is still checked before Cleanup acts on it.
 */
export const FORBIDDEN_DOMAIN_KEYS = [
  'issuer', 'subject', 'api_base_url', 'api_method', 'api_path', 'tool_id',
  'refresh_token', 'encrypted_refresh_token', 'private_key',
] as const;

export interface AgentIdentityDomain {
  agent_id: string;
  human_subject: string;
  isolation_level: 'standard' | 'full_isolation';
  registration_id?: string;
  kms_key_name?: string;
  dedicated_op: string | null;
  job_execution_name: string | null;
  idp_connection_id: string | null;
  bridge_binding_ids: string[];
  created_at: string;
  expires_at: string;
  status: string;
  cleanup_step_results: unknown[];
  [key: string]: unknown;
}

export class DomainSchemaViolation extends Error {
  readonly code = 'domain_schema_violation';
}

const assertDomain: (value: unknown) => asserts value is AgentIdentityDomain =
  compile<AgentIdentityDomain>(agentIdentityDomainSchema);

export async function loadDomain(documents: DocumentStore, agentId: string): Promise<AgentIdentityDomain> {
  const meta = await documents.get('agents', `${agentId}__meta`);
  if (!meta) throw new DomainSchemaViolation(`no domain for ${agentId}`);
  for (const forbidden of FORBIDDEN_DOMAIN_KEYS) {
    if (forbidden in meta) throw new DomainSchemaViolation(`agent record must not carry ${forbidden}`);
  }
  const withDefaults = {
    bridge_binding_ids: [], cleanup_step_results: [], ...meta,
  } as Record<string, unknown>;
  try {
    assertDomain(withDefaults);
  } catch (error) {
    // Its own type, so Cleanup can record it as a step result and carry on: a
    // malformed record is not a reason to leave an agent's credentials alive.
    throw new DomainSchemaViolation((error as Error).message);
  }
  return withDefaults;
}

export const DOMAIN_SUBDOCUMENTS = ['meta', 'state', 'instructions', 'manifest'] as const;

/**
 * Removes everything under `agents/{agent_id}`.
 *
 * Deleting only `meta` would leave the checkpoint and the manifest behind — the two
 * documents that describe what the agent was doing and what it was allowed to do.
 * Cleanup's promise is that nothing remains, so all four go.
 */
export async function deleteDomain(documents: DocumentStore, agentId: string): Promise<void> {
  for (const part of DOMAIN_SUBDOCUMENTS) {
    await documents.delete('agents', `${agentId}__${part}`).catch(() => undefined);
  }
  // Instructions live in their own collection so they can be queried; they belong to
  // the agent all the same, and leaving them would keep a person's words after the
  // agent that was meant to read them is gone.
  const pending = await documents.queryEqual('agent_instructions', [['agent_id', agentId]]).catch(() => []);
  for (const row of pending) await documents.delete('agent_instructions', row.id).catch(() => undefined);
}
