import { BridgeError } from '../errors.js';
import { difference, isSubset, parseScope } from '../scope/subset.js';

export type ScopeSink = (fields: Record<string, unknown>) => void;

/**
 * Which scopes this exchange is actually for, checked against two containments.
 *
 * The chain is: what was asked for ⊆ what the ID-JAG allows ⊆ what the binding allows ⊆
 * what the person granted. Each link narrows; none may widen. RULE-24 and RULE-52 are
 * the same rule seen from two ends, and this is where both are enforced.
 *
 * An empty scope is refused rather than read as "everything". Every OAuth deployment
 * that treated absence as a wildcard has regretted it.
 */
export function resolveEffectiveScope(input: {
  requestedScope: string | undefined;
  idJagScope: string;
  bindingScopes: readonly string[];
  connectionScopes: readonly string[];
  onViolation?: ScopeSink;
}): string[] {
  const allowedByIdJag = parseScope(input.idJagScope);
  const requested = input.requestedScope === undefined || input.requestedScope === ''
    ? allowedByIdJag
    : parseScope(input.requestedScope);

  const violation = (): never => {
    input.onViolation?.({
      requested: [...requested].sort(),
      binding: [...input.bindingScopes].sort(),
      connection: [...input.connectionScopes].sort(),
    });
    throw new BridgeError('invalid_scope', 400);
  };

  if (requested.size === 0) violation();
  // Narrowing only: a request may ask for less than the ID-JAG permits, never more.
  if (!isSubset(requested, allowedByIdJag)) violation();
  const binding = new Set(input.bindingScopes);
  if (!isSubset(requested, binding)) violation();
  const connection = new Set(input.connectionScopes);
  if (!isSubset(binding, connection)) violation();
  return [...requested].sort();
}

export { difference, isSubset, parseScope };
