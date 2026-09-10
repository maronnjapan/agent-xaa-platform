import type { ConnectorDefinition } from '../connectors/types.js';

/**
 * The one place a scope changes vocabulary.
 *
 * Everything inside this platform speaks its own scope names — `calendar.read` is what
 * the taxonomy, the catalogue, the ID-JAG, the binding and the connection all carry, and
 * every containment check in `effective-scope.ts` is computed in that vocabulary. A real
 * SaaS speaks its own: Google will not recognise `calendar.read` and answers the consent
 * request with `invalid_scope`, which is a screen the person cannot get past.
 *
 * So the translation happens at the boundary and nowhere else: on the way out to the
 * SaaS's authorization and token endpoints, and on the way back in when what the person
 * granted is written down. Between those two points there is one vocabulary, which is
 * why no subset check had to learn about this.
 *
 * The map is part of the connector definition, so adding a SaaS whose names differ is
 * still a seeded row and not a change here (docs 06 §1). A connector without one — the
 * stub, whose OP is this platform's own and already speaks its scope names — translates
 * to itself.
 *
 * A scope with no entry travels unchanged rather than being dropped. Dropping one would
 * narrow a consent silently, and the person would approve less than the agent needs
 * without either of them being told.
 */
export function toProviderScopes(connector: ConnectorDefinition, scopes: readonly string[]): string[] {
  const map = connector.scope_map ?? {};
  return [...new Set(scopes.map((scope) => map[scope] ?? scope))];
}

/**
 * The same map read backwards, for the `scope` a SaaS returns.
 *
 * A provider scope with no entry is kept as it is: an OAuth server may grant more than
 * it was asked for, and a value nobody can name is still a fact about the connection
 * that a later subset check has to be able to see.
 */
export function toPlatformScopes(connector: ConnectorDefinition, scopes: readonly string[]): string[] {
  const reverse = new Map(Object.entries(connector.scope_map ?? {}).map(([platform, provider]) => [provider, platform]));
  return [...new Set(scopes.map((scope) => reverse.get(scope) ?? scope))];
}
