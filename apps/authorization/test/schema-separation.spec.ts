import { describe, expect, it } from 'vitest';
import { AUTHZ_COLLECTIONS } from '../src/store/collections.js';
import { runDecision } from './helpers.js';

/** What a Work Definition may never say (RULE-15): how the work would be carried out. */
const TECHNICAL_NAME = /(capability|tool|endpoint|scope|url|method)/i;

/**
 * REQ-01-006. What the work is, what is permitted, and how it is executed are three
 * separate records.
 *
 * The Work Definition describes the business intent and nothing else. If a
 * capability, a tool, a scope or an endpoint could be written into it, Automation App
 * would be able to state what an agent may do by describing the work — and the Policy
 * Engine would be deciding against an input the requester wrote.
 */
describe('the work definition names no permission and no endpoint', () => {
  it('has no property whose name mentions a capability, tool, endpoint, scope, url or method', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'] });
    const stored = await result.documents.listAll<Record<string, unknown>>(AUTHZ_COLLECTIONS.workDefinitions);

    expect(stored).toHaveLength(1);
    const properties = Object.keys(stored[0]!.data);
    expect(properties.filter((name) => TECHNICAL_NAME.test(name))).toEqual([]);
    // The whole property set, pinned: a new field is a deliberate decision, not a drift.
    expect(properties.sort()).toEqual([
      'constraints', 'created_at', 'description', 'human_subject', 'operations',
      'purpose', 'target_resources', 'work_definition_id',
    ]);
  });

  it('keeps the work, the permissions and the catalogue in different collections', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'] });
    const [work] = await result.documents.listAll<Record<string, unknown>>(AUTHZ_COLLECTIONS.workDefinitions);
    const capabilities = await result.documents.listAll(AUTHZ_COLLECTIONS.capabilityTaxonomy);
    const tools = await result.documents.listAll(AUTHZ_COLLECTIONS.catalogTools);

    // Three collections, three ids: the work definition refers to no capability and no
    // tool, so widening one record cannot widen another.
    expect(new Set([AUTHZ_COLLECTIONS.workDefinitions, AUTHZ_COLLECTIONS.capabilityTaxonomy, AUTHZ_COLLECTIONS.catalogTools]).size).toBe(3);
    expect(capabilities.length).toBeGreaterThan(0);
    expect(tools.length).toBeGreaterThan(0);
    const written = JSON.stringify(work!.data);
    for (const { id } of [...capabilities, ...tools]) expect(written).not.toContain(id);
  });
});
