/**
 * RULE-09. Whatever the model says, only capabilities that exist in the taxonomy
 * reach the Policy Engine.
 *
 * Matching is exact. No case folding and no fuzzy matching: `Calendar.Event.Read` is
 * not `calendar.event.read`, and treating them as the same would let a near-miss
 * become a real grant.
 */
export function filterToTaxonomy(capabilities: string[], taxonomy: Set<string>): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const capability of capabilities) {
    if (taxonomy.has(capability)) kept.push(capability);
    else dropped.push(capability);
  }
  return { kept, dropped };
}
