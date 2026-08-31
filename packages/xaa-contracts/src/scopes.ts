import { RESOURCE_SCOPES, type ResourceScope } from './identifiers.js';

/**
 * RULE-52. What a Resource AS registers is the ceiling on what a leaked ID-JAG
 * signing key could obtain there, so each list is the minimum that resource needs.
 * No wildcard and no `admin` value exists in either.
 */
export const DOCS_SCOPES = ['docs.read', 'docs.write'] as const satisfies readonly ResourceScope[];
export const FINANCE_SCOPES = ['finance.tx.read', 'finance.tx.write'] as const satisfies readonly ResourceScope[];

export class InvalidRegisteredScope extends Error {
  constructor(readonly offending: string) {
    super('invalid_registered_scope');
    this.name = 'InvalidRegisteredScope';
  }
}

/**
 * Compares the injected REGISTERED_SCOPES against the compiled-in list as sets. A
 * deployment that widens the list fails at startup rather than at the first request.
 */
export function assertRegisteredScopes(declared: string | undefined, expected: readonly string[]): readonly string[] {
  const parsed = (declared ?? '').trim().split(/\s+/).filter(Boolean);
  for (const scope of parsed) {
    if (scope === '*' || scope.endsWith('.admin') || scope === 'admin') throw new InvalidRegisteredScope(scope);
    if (!(RESOURCE_SCOPES as readonly string[]).includes(scope)) throw new InvalidRegisteredScope(scope);
  }
  const declaredSet = new Set(parsed);
  const expectedSet = new Set(expected);
  if (declaredSet.size !== expectedSet.size || [...expectedSet].some((scope) => !declaredSet.has(scope))) {
    throw new InvalidRegisteredScope(parsed.join(' '));
  }
  return expected;
}
