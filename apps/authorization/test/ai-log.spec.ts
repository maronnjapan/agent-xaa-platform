import { describe, expect, it } from 'vitest';
import { workDefinitionHash } from '@xaa/contracts';
import { inferenceInputHash } from '../src/log/ai-log.js';
import { runDecision } from './helpers.js';

const DESCRIPTION = '請求書の支払い状況を確認して未処理のものを一覧にする';

function inferenceLines(logs: string[]) {
  return logs
    .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown>; human_subject: string | null; agent_id: string | null })
    .filter((line) => line.event === 'authz_ai.infer');
}

describe('the AI inference log', () => {
  it('writes one line per inference, with the seven fields', async () => {
    const result = await runDecision({
      humanPermissions: ['document.read'],
      model: { capabilities: ['document.read'], confidence: 0.42 },
      description: DESCRIPTION,
    });
    const lines = inferenceLines(result.logs);

    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!.fields).sort()).toEqual([
      'agent_draft_id', 'confidence', 'model_version', 'proposed_capabilities',
      'taxonomy_version', 'work_definition_hash', 'work_definition_id',
    ]);
    expect(lines[0]!.fields.confidence).toBe(0.42);
    expect(lines[0]!.fields.proposed_capabilities).toEqual(['document.read']);
    expect(lines[0]!.fields.model_version).toBe('gemini-2.5-flash');
    expect(lines[0]!.fields.taxonomy_version).toBe('v1');
  });

  it('carries the correlation keys every line carries', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'] });
    const line = inferenceLines(result.logs)[0]!;
    expect(line.human_subject).toBe('testuser');
    // No agent exists when the decision is taken, and the key is present rather than
    // absent so a query does not have to tell "no agent" from "field missing".
    expect(line.agent_id).toBeNull();
  });

  it('never writes the work definition itself', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], description: DESCRIPTION });
    expect(result.logs.join('\n')).not.toContain(DESCRIPTION);
    expect(result.logs.join('\n')).not.toContain('支払い確認');
  });

  it('hashes the description and the operations, and nothing else', async () => {
    const expected = await workDefinitionHash({ description: DESCRIPTION, operations: ['read_events'] });
    expect(await inferenceInputHash({ description: DESCRIPTION, operations: ['read_events'] })).toBe(expected);

    const result = await runDecision({ humanPermissions: ['document.read'], description: DESCRIPTION });
    expect(inferenceLines(result.logs)[0]!.fields.work_definition_hash).toBe(expected);
  });

  it('gives the same work the same hash twice', async () => {
    const first = await inferenceInputHash({ description: DESCRIPTION, operations: ['a', 'b'] });
    const second = await inferenceInputHash({ description: DESCRIPTION, operations: ['a', 'b'] });
    expect(first).toBe(second);
    expect(first).not.toBe(await inferenceInputHash({ description: DESCRIPTION, operations: ['b', 'a'] }));
  });
});
