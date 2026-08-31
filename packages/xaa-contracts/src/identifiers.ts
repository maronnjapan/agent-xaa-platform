export const CAPABILITIES = [
  'calendar.event.read',
  'calendar.event.write',
  'mail.message.read',
  'mail.message.send',
  'document.read',
  'document.write',
  'finance.payment.read',
  'finance.payment.approve',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const RESOURCE_SCOPES = [
  'docs.read',
  'docs.write',
  'finance.tx.read',
  'finance.tx.write',
  'calendar.read',
  'gmail.read',
  'gmail.send',
] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export const TOOL_IDS = [
  'internal.document.list',
  'internal.document.get',
  'internal.document.create',
  'internal.document.update',
  'internal.finance.payment.list',
  'internal.finance.payment.get',
  'internal.finance.payment.approve',
  'stub.calendar.events.list',
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export interface ToolBinding {
  capability: Capability;
  scope: ResourceScope;
  method: 'GET' | 'POST' | 'PATCH';
  pathTemplate: string;
}

export const TOOL_BINDINGS: Record<ToolId, ToolBinding> = {
  'internal.document.list': { capability: 'document.read', scope: 'docs.read', method: 'GET', pathTemplate: '/documents' },
  'internal.document.get': { capability: 'document.read', scope: 'docs.read', method: 'GET', pathTemplate: '/documents/{id}' },
  'internal.document.create': { capability: 'document.write', scope: 'docs.write', method: 'POST', pathTemplate: '/documents' },
  'internal.document.update': { capability: 'document.write', scope: 'docs.write', method: 'PATCH', pathTemplate: '/documents/{id}' },
  'internal.finance.payment.list': { capability: 'finance.payment.read', scope: 'finance.tx.read', method: 'GET', pathTemplate: '/payments' },
  'internal.finance.payment.get': { capability: 'finance.payment.read', scope: 'finance.tx.read', method: 'GET', pathTemplate: '/payments/{id}' },
  'internal.finance.payment.approve': { capability: 'finance.payment.approve', scope: 'finance.tx.write', method: 'POST', pathTemplate: '/payments/{id}/approve' },
  'stub.calendar.events.list': { capability: 'calendar.event.read', scope: 'calendar.read', method: 'GET', pathTemplate: '/events' },
};

export const CAPABILITY_TO_SCOPE: Record<Capability, ResourceScope[]> = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, [...new Set(Object.values(TOOL_BINDINGS).filter((binding) => binding.capability === capability).map((binding) => binding.scope))]]),
) as Record<Capability, ResourceScope[]>;

/**
 * DEC-ID-22 / RULE-50: there is exactly one registered client. An agent is never a
 * client; individual agents are identified by cnf.jkt, act and the audit log.
 */
export const PLATFORM_CLIENT_ID = 'agent-platform';

export const JWT_TYP = {
  ID_TOKEN: 'JWT',
  ACCESS_TOKEN: 'at+jwt',
  ID_JAG: 'oauth-id-jag+jwt',
  DPOP_PROOF: 'dpop+jwt',
  ACTOR_TOKEN: 'agent-assertion+jwt',
  CLIENT_ASSERTION: 'agent-client-auth+jwt',
} as const;

const FORBIDDEN_SEGMENTS = new Set(['google', 'microsoft', 'github', 'slack', 'get', 'post', 'put', 'patch', 'delete']);
const CAPABILITY_PATTERN = /^[a-z]+(\.[a-z_]+){1,2}$/;

export function assertValidCapabilityId(value: string): asserts value is Capability {
  if (!CAPABILITY_PATTERN.test(value) || value.split('.').some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(`invalid capability_id: ${value}`);
  }
}
