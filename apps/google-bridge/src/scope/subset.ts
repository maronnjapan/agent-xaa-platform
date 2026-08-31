export function parseScope(value: string): Set<string> {
  return new Set(value.split(' ').filter(Boolean));
}

/**
 * Set containment, computed as sets.
 *
 * Scope comparison written with `includes` on a space-joined string gets `calendar.read`
 * wrong when the granted set contains `calendar.readonly`, and gets order-dependent
 * answers for the same two sets. Doing it with `Set` makes both classes of bug
 * impossible rather than unlikely.
 */
export function isSubset(candidate: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const value of candidate) if (!superset.has(value)) return false;
  return true;
}

export function difference(candidate: ReadonlySet<string>, superset: ReadonlySet<string>): string[] {
  return [...candidate].filter((value) => !superset.has(value)).sort();
}
