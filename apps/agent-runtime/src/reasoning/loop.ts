import { generateJson, type VertexClient } from '@xaa/vertex';
import type { ActivityRecord } from '@xaa/contracts';
import type { LogContext, Logger } from '@xaa/logging';
import type { ExecutionContext } from '../context/execution-context.js';
import type { RuntimeHttpClient } from '../http/http-client.js';
import { writeCheckpoint, type Checkpoint } from '../state/checkpoint.js';
import { executeTool } from '../tool-executor/index.js';
import type { ToolResult } from '../tool-executor/errors.js';
import { readPendingInstructions } from '../instructions/read-pending.js';
import { appendRejection } from '../instructions/record-rejection.js';
import { createExecutionRecorder, reasoningRecord } from '../telemetry/execution-record.js';
import {
  publishToolBlocked, publishToolFailed, publishToolSucceeded, type ActivityContext,
} from '../telemetry/activity.js';
import { buildToolDeclarations } from './tool-declarations.js';
import { isInvalidToolCall, parseToolCall } from './parse-tool-call.js';

export const MAX_REASONING_STEPS = 8;

/**
 * The answer the model is constrained to give, in the subset Vertex can express.
 *
 * `responseSchema` is OpenAPI 3.0, not JSON Schema: an `object` there is its
 * `properties` and nothing else, so `tool_call: { type: 'object' }` described a value
 * with no fields. The model could only ever fill it with `{}`, `parseToolCall` read no
 * `tool_id` in that, and every step of every execution came back as
 * `unknown / failed / invalid_tool_call` — eight of them, then `reasoning_step_limit`.
 *
 * The parameters travel as JSON text because their shape is per-tool: the manifest
 * declares a different set for each, and one fixed `properties` map cannot describe all
 * of them at once. `parseToolCall` decodes the text, which keeps the two fields RULE-18
 * allows the model to decide — which tool, with what arguments — and adds no third.
 */
export const REASONING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done'],
  properties: {
    done: { type: 'boolean' },
    tool_call: {
      type: 'object',
      additionalProperties: false,
      required: ['tool_id', 'parameters_json'],
      properties: {
        tool_id: { type: 'string' },
        parameters_json: { type: 'string' },
      },
    },
    note: { type: 'string' },
  },
} as const;

interface ReasoningStep { done: boolean; tool_call?: unknown; note?: string }

export interface LoopResult {
  results: ToolResult[];
  /**
   * What a person is shown about each step, in the order the steps happened.
   *
   * One entry per reasoning step, not per tool call: a step where the model answered
   * with something unreadable, or said it was finished, is still a step somebody
   * watching wants accounted for. Without them a run of eight steps that produced two
   * calls looked, from the timeline, like a run of two.
   */
  records: ActivityRecord[];
  /** The agent's own closing words, when it wrote any before saying it was done. */
  finalNote?: string;
  /**
   * `no_decision` is separate from `done` because the two look identical from the
   * outside and mean opposite things. `generateJson` answers `null` for every way a
   * generation can fail — a refused schema, a timeout, an answer that did not validate —
   * and treating that as "the agent says it is finished" reported TASK_COMPLETED with
   * no tool call for a model that was never reached.
   */
  stoppedBy: 'done' | 'no_decision' | 'reasoning_step_limit' | 'agent_expired';
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
  /**
   * Where the per-tool Activity Events go, when this Execution is publishing any.
   *
   * Optional so the loop stays testable without a topic. It is also the reason these
   * events exist at all: they were written and then never called, so until now a task
   * put exactly one row — its own ending — on the person's timeline.
   */
  activity?: ActivityContext;
}): Promise<LoopResult> {
  const now = input.now ?? (() => Date.now());
  const maxSteps = input.maxSteps ?? MAX_REASONING_STEPS;
  const generate = input.vertex?.generateJson.bind(input.vertex)
    ?? (<T>(params: Parameters<typeof generateJson>[0]) => generateJson<T>(params));

  const results: ToolResult[] = [];
  const records: ActivityRecord[] = [];
  const conversation: unknown[] = [];
  let executionState: Record<string, unknown> = {};
  let stoppedBy: LoopResult['stoppedBy'] = 'reasoning_step_limit';
  let finalNote: string | undefined;

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
    if (!decision) {
      stoppedBy = 'no_decision';
      records.push(reasoningRecord({
        step: step + 1,
        headline: 'エージェントから応答がありませんでした',
        message: 'モデルが答えを返さなかったため、この手で打ち切りました。作業は完了していません。',
      }));
      break;
    }
    if (decision.done) {
      stoppedBy = 'done';
      finalNote = decision.note;
      records.push(reasoningRecord({
        step: step + 1,
        headline: 'エージェントが作業の終わりを判断しました',
        message: 'これ以上ツールで進めることは無いと判断しました。以下はエージェント自身の言葉です。',
        ...(decision.note ? { note: decision.note } : {}),
      }));
      break;
    }

    const call = parseToolCall(decision.tool_call);
    if (isInvalidToolCall(call)) {
      results.push({ ...call, tool_id: 'unknown', stage: 'tool_selection' });
      records.push(reasoningRecord({
        step: step + 1,
        headline: 'ツールの指定を読み取れませんでした',
        message: 'エージェントの答えに、実行できる形のツール指定がありませんでした。何も実行していません。',
        ...(decision.note ? { note: decision.note } : {}),
      }));
      await checkpoint();
      continue;
    }

    const recorder = createExecutionRecorder({
      step: step + 1,
      toolId: call.tool_id,
      intent: { ...(decision.note ? { note: decision.note } : {}), parameters: call.parameters },
    });
    const result = await executeTool({
      context: input.context, http: input.http, logger: input.logger, logContext: input.logContext,
      now, recorder, ...(input.stageWrite ? { stageWrite: input.stageWrite } : {}),
    }, call);
    results.push(result);
    const record = recorder.build(result);
    records.push(record);
    await publishToolEvent(result, record);
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

  return { results, records, stoppedBy, ...(finalNote ? { finalNote } : {}) };

  async function checkpoint(): Promise<void> {
    const state: Checkpoint = {
      task_context: { task_id: input.context.taskId, agent_id: input.context.agentId },
      conversation_context: conversation,
      execution_state: executionState,
      pending_tool_calls: results,
      // The same records the timeline will replay, written on every step so the agent
      // screen can show what is happening while it is still happening. The timeline
      // waits for the task to finish (RULE-59); the screen does not, and the two must
      // not end up telling the story from two different sources.
      execution_log: records,
      agent_status: 'ACTIVE',
      updated_at: new Date(now()).toISOString(),
    };
    await writeCheckpoint(input.context.store, state, input.logger, input.logContext);
  }

  /**
   * One Activity Event per tool call, published beside the checkpoint.
   *
   * A publish that fails is already swallowed inside `activity.ts`; what is guarded
   * here is the absence of a context, which is how the loop stays runnable in a test
   * with no topic behind it.
   */
  async function publishToolEvent(result: ToolResult, record: ActivityRecord): Promise<void> {
    const context = input.activity;
    if (!context) return;
    const common = { context, logger: input.logger, ctx: input.logContext, record };
    if (result.outcome === 'success') {
      await publishToolSucceeded({ ...common, toolId: result.tool_id });
      return;
    }
    if (result.outcome === 'blocked') {
      await publishToolBlocked({ ...common, toolId: result.tool_id, reason: result.reason });
      return;
    }
    await publishToolFailed({ ...common, toolId: result.tool_id, errorCode: result.error_code });
  }
}

function lastInstructionId(conversation: readonly unknown[]): string | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index] as { source?: string; instruction_id?: string };
    if (entry?.source === 'instruction' && typeof entry.instruction_id === 'string') return entry.instruction_id;
  }
  return undefined;
}

/**
 * What the model is told, and in what form it must answer.
 *
 * The response shape is spelled out because the schema alone does not say what belongs
 * in `parameters_json`: an OpenAPI `string` is satisfied by any text, including prose,
 * and text that is not a JSON object decodes to nothing here. Naming the tool's own
 * declared parameters as the source is what turns the free-form field back into the
 * `parameters` map RULE-18 lets the model choose.
 *
 * The work itself arrives as an instruction, never from here: this file has no channel
 * to a work definition, and the one thing that tells an agent what it was created for is
 * the text the person wrote, which the Automation App writes to `agent_instructions`.
 */
function buildPrompt(context: ExecutionContext, conversation: readonly unknown[]): string {
  return [
    'あなたは委譲された権限の範囲内でのみ動作するエージェントです。',
    `task_id: ${context.taskId}`,
    `使用できるツール: ${JSON.stringify(buildToolDeclarations(context.manifest))}`,
    `これまでの経過: ${JSON.stringify(conversation)}`,
    '指示に書かれた作業を、上のツールだけで進めてください。',
    'まだ終わっていなければ done を false にし、tool_call に次に実行するツールを1つ書いてください。',
    'tool_call.tool_id は上の一覧の name をそのまま使います。',
    'tool_call.parameters_json は、そのツールの parameters に宣言されたキーだけを持つ'
      + ' JSON オブジェクトを文字列にしたものです。引数が無いときは "{}" と書きます。',
    '作業が完了している、またはこれ以上ツールで進められない場合は done を true にしてください。',
  ].join('\n');
}
