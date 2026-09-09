import { CAPABILITY_TO_SCOPE, type Capability } from '@xaa/contracts';
import type { NormalizedEvent } from '../normalize/index.js';
import type { AgentRegistrationView, RuleContext } from './context.js';
import { asList, hitFromEvent, withAgent } from './hit.js';
import { THRESHOLDS } from './thresholds.js';
import type { RuleHit } from './types.js';
import { groupByWindow, parseWindowKey } from './window.js';

export const STATUS_ERRORS: readonly string[] = ['401', '403'];

/**
 * REQ-09-031. Refusals the platform handed out, and requests it should never have seen.
 *
 * Three conditions with deliberately different shapes. A single 403 is ordinary — a
 * person revoked a permission a minute ago and the agent has not noticed yet — so that
 * one is counted. A scope the agent's capabilities cannot produce, or an audience its
 * registration does not list, is not ordinary at any count: the Runtime cannot have
 * derived either from anything it was given, so one is already the whole story.
 *
 * The scope check reads the agent's own registration, which holds the scopes the
 * Provisioner injected when it built the manifest, and falls back to
 * `CAPABILITY_TO_SCOPE` (DEC-SCOPE-03) for an agent whose registration this service
 * cannot read. Neither is a second mapping of its own: a table here would drift from
 * the one the Provisioner used, and a drifted mapping accuses agents of asking for what
 * they were issued — which is exactly what a static table does once an administrator
 * maps a capability of their own to a resource.
 */
export function detectAuthorizationHits(context: RuleContext): RuleHit[] {
  return [...statusErrorHits(context), ...requestShapeHits(context)];
}

function statusErrorHits(context: RuleContext): RuleHit[] {
  const limits = THRESHOLDS.authorization?.status_error;
  if (!limits) return [];
  const refusals = withAgent(context.events).filter((event) => STATUS_ERRORS.includes(event.api.status));
  const hits: RuleHit[] = [];

  for (const [key, group] of groupByWindow(refusals, (event) => event.actor.agent_id!, (event) => event.time)) {
    const count = group.length;
    // Strictly greater, as everywhere else: an agent sitting exactly on the line is at
    // its limit rather than over it.
    const level = count > limits.high ? 'HIGH' : count > limits.medium ? 'MEDIUM' : null;
    if (!level) continue;
    const { subject } = parseWindowKey(key);
    hits.push(hitFromEvent({
      ruleId: `authorization.status_error.${level.toLowerCase()}`,
      category: 'authorization', level, event: group.at(-1)!,
      relatedEvents: group.map((event) => event.metadata.correlation_uid),
      detail: { observed: count, expected: [limits.medium, limits.high], agent_id: subject },
    }));
  }
  return hits;
}

function requestShapeHits(context: RuleContext): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const event of withAgent(context.events)) {
    const agentId = event.actor.agent_id!;
    const baseline = context.baselines.get(agentId);
    const registration = context.registrations.get(agentId);

    if (baseline) {
      const granted = grantedScopes(registration, baseline.effective_capabilities);
      const requested = asList(event.attributes.requested_scope);
      const outside = requested.filter((scope) => !granted.has(scope));
      if (outside.length > 0) {
        hits.push(hitFromEvent({
          ruleId: 'authorization.scope_out_of_range', category: 'authorization', level: 'MEDIUM',
          event, detail: { observed: outside, expected: [...granted].sort() },
        }));
      }
    }

    // Byte equality, never a prefix (DEV-12): a host built by appending a further
    // label to the registered audience shares a prefix with it and is a different host.
    hits.push(...exactMatchHits({
      event, ruleId: 'authorization.unknown_audience',
      observed: asList(event.attributes.requested_audience), expected: registration?.allowed_audiences,
    }));
    hits.push(...exactMatchHits({
      event, ruleId: 'authorization.unknown_resource',
      observed: asList(event.attributes.requested_resource), expected: registration?.resources,
    }));
  }
  return hits;
}

function exactMatchHits(input: {
  event: NormalizedEvent;
  ruleId: string;
  observed: readonly string[];
  expected: readonly string[] | undefined;
}): RuleHit[] {
  // No registration, or one that lists nothing: there is no static configuration to
  // compare against, and calling every request unknown would accuse the agent of the
  // detector's own missing read.
  if (!input.expected || input.expected.length === 0) return [];
  const outside = input.observed.filter((value) => !input.expected!.includes(value));
  if (outside.length === 0) return [];
  return [hitFromEvent({
    ruleId: input.ruleId, category: 'authorization', level: 'MEDIUM', event: input.event,
    detail: { observed: outside, expected: [...input.expected] },
  })];
}

/**
 * What the agent was actually issued, in order of authority: the registration first,
 * because it is the configuration the Agent OP itself checks each request against.
 */
function grantedScopes(registration: AgentRegistrationView | undefined, capabilities: readonly string[]): Set<string> {
  if (registration?.scopes && registration.scopes.length > 0) return new Set(registration.scopes);
  return scopesFor(capabilities);
}

function scopesFor(capabilities: readonly string[]): Set<string> {
  const scopes = new Set<string>();
  for (const capability of capabilities) {
    for (const scope of CAPABILITY_TO_SCOPE[capability as Capability] ?? []) scopes.add(scope);
  }
  return scopes;
}
