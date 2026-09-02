import { describe, expect, it, vi } from 'vitest';
import { buildWorkDefinition } from '../src/work-definition/build.js';
import type { VertexClient } from '../src/ai/authorization-ai.js';
import { AUTHZ_COLLECTIONS } from '../src/store/collections.js';
import { runDecision, TAXONOMY } from './helpers.js';

const DESCRIPTION = 'Google Calendarから当日の予定を取得し、重要な予定を抽出して整理する';

/** The resource column of the seeded taxonomy — the only values a model may name. */
const allowedResources = new Set(TAXONOMY.map((entry) => entry.resource));

/**
 * One spy behind both names: the client's method is `generateJson`, and `generate` is
 * the same function so the call count reads as the number of times the model was asked.
 */
function model(response: unknown): VertexClient & { generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(async () => response);
  return { generate, generateJson: generate as VertexClient['generateJson'] };
}

async function build(response: unknown) {
  const vertex = model(response);
  const result = await buildWorkDefinition({
    purpose: '予定整理', description: DESCRIPTION, humanSubject: 'testuser', constraints: {},
  }, { vertex, allowedResources, now: () => Date.parse('2026-03-01T00:00:00Z') });
  return { ...result, vertex };
}

/**
 * REQ-03-002. The request is turned into a work definition by one model call, and the
 * resources it may name are the taxonomy's own — Automation App never learns that
 * list, and the model cannot introduce a resource this deployment does not have.
 */
describe('building the work definition', () => {
  it('derives the operations and keeps only calendar as the target resource', async () => {
    const { workDefinition } = await build({
      operations: ['fetch_events', 'select_important', 'summarise'],
      target_resources: ['calendar'],
    });

    expect(workDefinition.operations.length).toBeGreaterThanOrEqual(3);
    expect(workDefinition.target_resources).toEqual(['calendar']);
  });

  it('drops a resource the taxonomy does not have, and records what it dropped', async () => {
    const { workDefinition, dropped } = await build({
      operations: ['fetch_events'], target_resources: ['calendar', 'salesforce'],
    });

    expect(workDefinition.target_resources).toEqual(['calendar']);
    expect(dropped.dropped_target_resource).toEqual(['salesforce']);
    expect(dropped.dropped_target_resource).toHaveLength(1);
  });

  it('asks the model exactly once', async () => {
    const { vertex } = await build({ operations: ['fetch_events'], target_resources: ['calendar'] });
    expect(vertex.generate).toHaveBeenCalledTimes(1);
  });

  it('stores operations with no duplicate and no blank', async () => {
    const result = await runDecision({
      humanPermissions: ['calendar.event.read'],
      model: { operations: ['Fetch Events', 'fetch_events', '', '  ', 'summarise'], targetResources: ['calendar'] },
    });

    const [stored] = await result.documents.listAll<{ operations: string[] }>(AUTHZ_COLLECTIONS.workDefinitions);
    expect(stored!.data.operations).toEqual(['fetch_events', 'summarise']);
  });
});
