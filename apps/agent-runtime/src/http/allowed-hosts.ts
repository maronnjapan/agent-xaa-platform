import type { ToolManifest } from '@xaa/contracts';

export class HostNotAllowed extends Error {
  readonly code = 'host_not_allowed';
  constructor(readonly host: string) { super(`host_not_allowed: ${host}`); }
}

/** Google's own endpoints: reachable, but not something an agent decides to call. */
export const PLATFORM_HOSTS = ['firestore.googleapis.com', 'aiplatform.googleapis.com'] as const;

/**
 * Where an Execution may go, decided once from the manifest.
 *
 * REQ-04-015 and REQ-07-008 both forbid resolving a destination at run time; this is
 * the shape of that prohibition. The set is derived from values that were fixed at
 * provisioning — the Agent OP, and the audiences and base URLs the manifest names —
 * then frozen. No function adds to it, so a reasoning step cannot talk the Runtime
 * into a new destination, and the Human IdP and the Provisioner are absent because
 * no manifest names them.
 */
/**
 * Object.freeze does not reach a Set's internal storage, so a frozen Set still accepts
 * `add`. Wrapping one in a frozen object whose mutators throw makes "fixed at startup"
 * a fact rather than a comment.
 */
function freezeSet(hosts: Set<string>, label: string): ReadonlySet<string> {
  const refuse = (): never => { throw new Error(`the ${label} is fixed at startup`); };
  return Object.freeze({
    has: (host: string) => hosts.has(host),
    get size() { return hosts.size; },
    keys: () => hosts.keys(),
    values: () => hosts.values(),
    entries: () => hosts.entries(),
    forEach: (callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown) => {
      for (const value of hosts) callback.call(thisArg, value, value, hosts);
    },
    [Symbol.iterator]: () => hosts[Symbol.iterator](),
    add: refuse,
    delete: refuse,
    clear: refuse,
  }) as ReadonlySet<string>;
}

export function buildAllowedHosts(env: { AGENT_OP_BASE_URL: string }, manifest: ToolManifest): ReadonlySet<string> {
  const hosts = new Set<string>(PLATFORM_HOSTS);
  hosts.add(new URL(env.AGENT_OP_BASE_URL).host);
  for (const tool of manifest.tools) {
    hosts.add(new URL(tool.authorization.audience).host);
    hosts.add(new URL(tool.api.base_url).host);
    if (tool.token_provider !== null) hosts.add(new URL(tool.token_provider).host);
  }
  return freezeSet(hosts, 'allowed host set');
}

/**
 * Which of those destinations are this platform's own Cloud Run services.
 *
 * Cloud Run's IAM check runs in front of the container: a service this Execution is
 * entitled to call still answers `403 Empty Authorization header value` unless the
 * request carries an invoker ID Token, and the agent's own credentials are never
 * read. Being allowed to go somewhere and being let in are two different questions,
 * and the second is answered here — from the same manifest, in the same shape, next
 * to the first, because the failure this fixes was one set gaining a destination
 * while the other did not.
 *
 * A `native_xaa` tool contributes both of its hops. Both are services of this
 * platform, and `infra/envs/demo/locals-invoker.tf` grants `sa-agent-runtime`
 * `roles/run.invoker` on the Native AS and the Resource API of every one of them —
 * the same four docs 08 lists for `sa-agent-runtime`, with the Shared OP and the
 * Bridge. A grant the Runtime never presents a token against is a door that stays
 * shut: an Access Token in hand and nowhere to spend it.
 *
 * An `xaa_bridge` tool contributes only its `token_provider`, which is the Bridge.
 * Its `api.base_url` is the SaaS itself and its `audience` names that SaaS; a
 * Google-signed token carrying this platform's Service Account must not be handed to
 * a third party, and what an external API is shown is the Bearer the Bridge obtained
 * for it (DEC-ID-13).
 */
export function buildInternalOrigins(env: { AGENT_OP_BASE_URL: string }, manifest: ToolManifest): ReadonlySet<string> {
  const origins = new Set<string>([new URL(env.AGENT_OP_BASE_URL).origin]);
  for (const tool of manifest.tools) {
    if (tool.token_provider !== null) origins.add(new URL(tool.token_provider).origin);
    if (tool.authorization.type !== 'native_xaa') continue;
    origins.add(new URL(tool.authorization.audience).origin);
    origins.add(new URL(tool.api.base_url).origin);
  }
  return freezeSet(origins, 'internal origin set');
}

export function assertHostAllowed(allowed: ReadonlySet<string>, url: string): void {
  let host: string;
  // The host name in the URL, never a resolved address: a DNS answer can change
  // between the check and the connection.
  try { host = new URL(url).host; } catch { throw new HostNotAllowed(url); }
  if (!allowed.has(host)) throw new HostNotAllowed(host);
}
