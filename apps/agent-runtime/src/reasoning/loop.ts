import { generateJson, type VertexClient } from '@xaa/vertex';
import type { LogContext, Logger } from '@xaa/logging';
import type { ExecutionContext } from '../context/execution-context.js';
import type { RuntimeHttpClient } from '../http/http-client.js';
import { writeCheckpoint, type Checkpoint } from '../state/checkpoint.js';
import { executeTool } from '../tool-executor/index.js';
import type { ToolResult } from '../tool-executor/errors.js';
import { readPendingInstructions } from '../instructions/read-pending.js';
import { appendRejection } from '../instructions/record-rejection.js';
import { buildToolDeclarations } from './tool-declarations.js';
import { isInvalidToolCall, parseToolCall } from './parse-tool-call.js';

export const MAX_REASONING_STEPS = 8;

const REASONING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done'],
  properties: {
    done: { type: 'boolean' },
    tool_call: { type: 'object' },
    note: { type: 'string' },
  },
} as const;

interface ReasoningStep { done: boolean; tool_call?: unknown; note?: string }

export interface LoopResult {
  results: ToolResult[];
  stoppedBy: 'done' | 'reasoning_step_limit' | 'agent_expired';
}

/**
 * The reasoning loop: read new instructions, ask the model what to do, execute it,
 * checkpoint, repeat.
 *
 * The bound exists because a Job's task timeout is not a safety net — an agent that
 * loops until the platform kills it looks, from the outside, exactly like one that is
 * working. Stopping at a counted limit turns that into a stated failure.
 *
 * Only two things enter the conversation: the projected tool result (T-RUN-18) and the
 * text of an instruction. A raw API response never does, so the model cannot read a
 * field the allow list excluded, and an instruction never becomes a tool parameter
 * without passing through the model's own reasoning first.
 */
export async function runReasoningLoop(input: {
  context: ExecutionContext;
  http: RuntimeHttpClient;
  logger: Logger;
  logContext: LogContext;
  vertex?: Pick<VertexClient, 'generateJson'>;
  maxSteps?: number;
  now?: () => number;
  stageWrite?: (line: string) => void;
}): Promise<LoopResult> {
  const now = input.now ?? (() => Date.now());
  const maxSteps = input.maxSteps ?? MAX_REASONING_STEPS;
  const generate = input.vertex?.generateJson.bind(input.vertex)
    ?? (<T>(params: Parameters<typeof generateJson>[0]) => generateJson<T>(params));

  const results: ToolResult[] = [];
  const conversation: unknown[] = [];
  let executionState: Record<string, unknown> = {};
  let stoppedBy: LoopResult['stoppedBy'] = 'reasoning_step_limit';

  for (let step = 0; step < maxSteps; step += 1) {
    for (const instruction of await readPendingInstructions(input.context.store, new Date(now()).toISOString())) {
      conversation.push(instruction);
    }

    const decision = await generate<ReasoningStep>({
      prompt: buildPrompt(input.context, conversation),
      schema: REASONING_SCHEMA,
      maxOutputTokens: 2048,
      temperature: 0,
    });
    if (!decision || decision.done) { stoppedBy = 'done'; break; }

    const call = parseToolCall(decision.tool_call);
    if (isInvalidToolCall(call)) {
      results.push({ ...call, tool_id: 'unknown', stage: 'tool_selection' });
      await checkpoint();
      continue;
    }

    const result = await executeTool({
      context: input.context, http: input.http, logger: input.logger, logContext: input.logContext,
      now, ...(input.stageWrite ? { stageWrite: input.stageWrite } : {}),
    }, call);
    results.push(result);
    conversation.push({ role: 'tool', tool_id: call.tool_id, result: result.outcome === 'success' ? result.data : result });

    if (result.outcome === 'blocked' && result.reason === 'not_in_allowed_tools') {
      const instruction = lastInstructionId(conversation);
      executionState = appendRejection(executionState, {
        instruction_id: instruction ?? 'reasoning',
        requested_tool_id: call.tool_id,
        reason: 'not_in_allowed_tools',
        rejected_at: new Date(now()).toISOString(),
      });
    }
    await checkpoint();
    if (result.outcome === 'failed' && result.error_code === 'agent_expired') { stoppedBy = 'agent_expired'; break; }
  }

  return { results, stoppedBy };

  async function checkpoint(): Promise<void> {
    const state: Checkpoint = {
      task_context: { task_id: input.context.taskId, agent_id: input.context.agentId },
      conversation_context: conversation,
      execution_state: executionState,
      pending_tool_calls: results,
      agent_status: 'ACTIVE',
      updated_at: new Date(now()).toISOString(),
    };
    await writeCheckpoint(input.context.store, state, input.logger, input.logContext);
  }
}

function lastInstructionId(conversation: readonly unknown[]): string | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index] as { source?: string; instruction_id?: string };
    if (entry?.source === 'instruction' && typeof entry.instruction_id === 'string') return entry.instruction_id;
  }
  return undefined;
}

function buildPrompt(context: ExecutionContext, conversation: readonly unknown[]): string {
  return [
    'あなたは委譲された権限の範囲内でのみ動作するエージェントです。',
    `task_id: ${context.taskId}`,
    `使用できるツール: ${JSON.stringify(buildToolDeclarations(context.manifest))}`,
    `これまでの経過: ${JSON.stringify(conversation)}`,
    '次に実行するツールを1つ選ぶか、作業が完了していれば done を true にしてください。',
  ].join('\n');
}
