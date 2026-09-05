import { describe, expect, it } from 'vitest';
import {
  ID_JAG_TOKEN_TYPE, drainActivityQueueForTesting, resetActivityPublisherForTesting, validateActivityRecord,
  type ActivityRecord,
} from '@xaa/contracts';
import { executeTool } from '../src/tool-executor/index.js';
import { createExecutionRecorder, taskSummaryRecord } from '../src/telemetry/execution-record.js';
import { runReasoningLoop } from '../src/reasoning/loop.js';
import { sanitizeCheckpoint } from '../src/state/sanitize.js';
import {
  AGENT_ID, AGENT_OP, DOCS_API, DOCS_AS, docsManifest, json, logContext, memoryStore, silentLogger,
  subjectTokenResponse, testContext, testHttp,
} from './helpers.js';

const JWT_ANYWHERE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

function happyPath(body: unknown = { documents: [{ document_id: 'd1', title: '議事録', secret: 's' }] }) {
  return (url: string): Response => {
    if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json(subjectTokenResponse());
    if (url.startsWith(`${AGENT_OP}/xaa/token`)) {
      return json({ access_token: 'id.jag.token', issued_token_type: ID_JAG_TOKEN_TYPE, expires_in: 300 });
    }
    if (url.startsWith(`${DOCS_AS}/token`)) return json({ access_token: 'access.token.value', token_type: 'DPoP', expires_in: 300 });
    return json(body);
  };
}

async function recordOf(toolId: string, options: {
  parameters?: Record<string, unknown>;
  note?: string;
  handler?: (url: string) => Response;
} = {}): Promise<ActivityRecord> {
  const context = await testContext();
  const { http } = testHttp(context, options.handler ?? happyPath());
  const recorder = createExecutionRecorder({
    step: 1,
    toolId,
    intent: { ...(options.note ? { note: options.note } : {}), parameters: options.parameters ?? {} },
  });
  const result = await executeTool(
    { context, http, logger: silentLogger, logContext, stageWrite: () => {}, recorder },
    { tool_id: toolId, parameters: options.parameters ?? {} },
  );
  return recorder.build(result);
}

const sectionIds = (record: ActivityRecord): string[] => (record.sections ?? []).map((section) => section.id);
const checkOf = (record: ActivityRecord, id: string) => (record.checks ?? []).find((check) => check.id === id);
const sectionOf = (record: ActivityRecord, id: string) => (record.sections ?? []).find((section) => section.id === id);

describe('the record a successful tool call leaves behind', () => {
  it('answers where it went, what it sent, and what came back', async () => {
    const record = await recordOf('internal.document.list');
    expect(() => validateActivityRecord(record)).not.toThrow();

    const request = sectionOf(record, 'request')!;
    expect(request.fields).toContainEqual({ label: 'メソッド', value: 'GET' });
    expect(request.fields?.find((field) => field.label === '宛先')?.value).toContain(DOCS_API);

    const response = sectionOf(record, 'response')!;
    expect(response.fields).toContainEqual({ label: 'HTTP ステータス', value: '200' });
    // The projected body, not the raw one: `secret` was never on the allow list, so it
    // reached neither the model nor this record.
    expect(response.text).toContain('議事録');
    expect(response.text).not.toContain('secret');
  });

  it('names every check it made, including the one it did not need', async () => {
    const record = await recordOf('internal.document.list');
    expect((record.checks ?? []).map((check) => check.id)).toEqual([
      'allowed_tools', 'agent_lifetime', 'constraints', 'parameters', 'response_projection',
    ]);
    expect(checkOf(record, 'agent_lifetime')?.result).toBe('passed');
    // Nothing was declared, so nothing was checked — which is a different statement
    // from "the limits were satisfied".
    expect(checkOf(record, 'constraints')?.result).toBe('skipped');
  });

  it('draws the four exchanges one call really makes', async () => {
    const record = await recordOf('internal.document.list');
    expect((record.hops ?? []).map((hop) => [hop.from, hop.to])).toEqual([
      ['agent-runtime', 'agent-op'],
      ['agent-op', 'agent-runtime'],
      ['agent-runtime', 'resource-as'],
      ['resource-as', 'agent-runtime'],
      ['agent-runtime', 'resource-api'],
      ['resource-api', 'agent-runtime'],
    ]);
    expect((record.hops ?? []).every((hop) => hop.message.trim() !== '')).toBe(true);
  });

  it("keeps the agent's own words as the agent wrote them", async () => {
    const note = '先に一覧を取ってから、必要な文書だけ開きます。';
    const record = await recordOf('internal.document.list', { note });
    const intent = sectionOf(record, 'intent')!;
    expect(intent.text).toBe(note);
    expect(intent.format).toBe('text');
  });

  /** RULE-38. A record outlives every place a credential is allowed to be. */
  it('carries no token anywhere in it', async () => {
    const record = await recordOf('internal.document.list');
    expect(JSON.stringify(record)).not.toMatch(JWT_ANYWHERE);
    expect(JSON.stringify(record)).not.toContain('access.token.value');
    expect(JSON.stringify(record)).not.toContain('id.jag.token');
  });
});

describe('the record a refusal leaves behind', () => {
  it('says what was refused, what was allowed instead, and that nothing was sent', async () => {
    const record = await recordOf('internal.finance.payment.approve');
    expect(record.headline).toContain('拒否');
    expect(checkOf(record, 'allowed_tools')?.result).toBe('blocked');
    expect(sectionOf(record, 'allowed_tools')?.fields?.[0]?.value).toContain('internal.document.list');
    // Nothing left the process, so there is no request and no answer to show.
    expect(sectionIds(record)).not.toContain('request');
    expect(sectionIds(record)).not.toContain('response');
  });

  /**
   * RULE-54's picture of a refusal: one movement, towards the resource, that does not
   * arrive. Without a destination the canvas draws an ordinary return and the refusal
   * looks like every other step.
   */
  it('leaves exactly one blocked hop, pointed at the resource', async () => {
    const record = await recordOf('internal.finance.payment.approve');
    expect(record.hops).toEqual([{
      from: 'agent-runtime',
      to: 'resource-api',
      label: '実行の要求',
      outcome: 'blocked',
      message: expect.stringContaining('外部へは何も送っていません'),
    }]);
  });

  it('reports where a call stopped when the resource answered badly', async () => {
    const record = await recordOf('internal.document.list', {
      handler: (url) => (url.startsWith(DOCS_API) ? json({ error: 'boom' }, 503) : happyPath()(url)),
    });
    const failure = sectionOf(record, 'failure')!;
    expect(failure.fields).toContainEqual({ label: '相手が返した HTTP ステータス', value: '503' });
    expect(record.headline).toContain('相手の API を呼ぶところ');
  });
});

describe('the reasoning loop as a publisher', () => {
  it('puts one row on the timeline for every tool call, with its record attached', async () => {
    resetActivityPublisherForTesting();
    const context = await testContext();
    const { http } = testHttp(context, happyPath());
    let step = 0;
    const loop = await runReasoningLoop({
      context,
      http,
      logger: silentLogger,
      logContext,
      stageWrite: () => {},
      activity: {
        humanSubject: 'testuser', agentId: AGENT_ID, taskId: 'task-1', traceId: 'tr-1', manifest: context.manifest,
      },
      vertex: {
        generateJson: async () => {
          step += 1;
          if (step === 1) {
            return { done: false, note: '一覧を取ります。', tool_call: { tool_id: 'internal.document.list', parameters_json: '{}' } } as never;
          }
          return { done: true, note: '取得できたので終わります。' } as never;
        },
      },
    });

    const published = drainActivityQueueForTesting();
    expect(published.map((event) => (event.detail as { event_type: string }).event_type)).toEqual(['TOOL_SUCCEEDED']);
    // The arrow needs somewhere to go, and nothing wrote `detail.target` before.
    expect((published[0]!.detail as { target: string }).target).toBe('resource-api');
    expect(published[0]!.record?.hops).toHaveLength(6);

    // One entry per reasoning step, not per tool call: the step where the agent said it
    // was finished is a step somebody watching wants accounted for.
    expect(loop.records).toHaveLength(2);
    expect(loop.finalNote).toBe('取得できたので終わります。');
  });

  it('writes the same records into the checkpoint, so the agent screen can read them', async () => {
    const { store, documents } = memoryStore();
    const context = await testContext();
    const contextWithStore = { ...context, store } as typeof context;
    const { http } = testHttp(context, happyPath());
    let step = 0;
    await runReasoningLoop({
      context: contextWithStore,
      http,
      logger: silentLogger,
      logContext,
      stageWrite: () => {},
      vertex: {
        generateJson: async () => {
          step += 1;
          return step === 1
            ? { done: false, tool_call: { tool_id: 'internal.document.list', parameters_json: '{}' } } as never
            : { done: true } as never;
        },
      },
    });

    const state = await documents.get<{ execution_log?: ActivityRecord[]; pending_tool_calls?: Array<{ tool_id?: string }> }>(
      'agents', `${AGENT_ID}__state`,
    );
    expect(state?.execution_log?.[0]?.headline).toContain('internal.document.list');
    for (const record of state?.execution_log ?? []) expect(() => validateActivityRecord(record)).not.toThrow();
    // The sanitiser used to match any three dotted segments, so the tool id itself was
    // dropped from the checkpoint and the agent screen showed a blank name.
    expect(state?.pending_tool_calls?.[0]?.tool_id).toBe('internal.document.list');
  });
});

describe('the checkpoint sanitiser and a dotted identifier', () => {
  it('keeps a tool id and still drops a token', () => {
    const removed: string[][] = [];
    const output = sanitizeCheckpoint(
      { execution_state: { tool_id: 'internal.document.list', leaked: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signature' } },
      (event) => removed.push(event.removed_keys),
    );
    expect(output).toEqual({ execution_state: { tool_id: 'internal.document.list' } });
    expect(removed).toEqual([['leaked']]);
  });
});

describe("the summary on a task's last row", () => {
  it("counts the steps and keeps the agent's closing words", () => {
    const summary = taskSummaryRecord({
      headline: '指示された作業を最後まで行いました',
      stoppedBy: 'done',
      steps: [{ headline: '一手目', step: 1, sections: [] }, { headline: '二手目', step: 2, sections: [] }],
      toolCalls: { succeeded: 1, blocked: 0, failed: 0 },
      finalNote: '必要な文書はすべて読みました。',
    });
    expect(() => validateActivityRecord(summary)).not.toThrow();
    const steps = summary.sections?.find((section) => section.id === 'steps');
    expect(steps?.fields).toEqual([
      { label: '1 手目', value: '一手目' },
      { label: '2 手目', value: '二手目' },
    ]);
    expect(summary.sections?.find((section) => section.id === 'final_note')?.text)
      .toBe('必要な文書はすべて読みました。');
  });

  /**
   * An agent that hit its step bound and one that crashed both ended as TASK_FAILED.
   * The summary is where the difference is now stated.
   */
  it('says which of the four ways the run ended', () => {
    const reason = (stoppedBy: string): string =>
      taskSummaryRecord({
        headline: 'h', stoppedBy, steps: [], toolCalls: { succeeded: 0, blocked: 0, failed: 0 },
      }).sections?.find((section) => section.id === 'summary')?.message ?? '';
    expect(new Set([
      reason('done'), reason('no_decision'), reason('reasoning_step_limit'), reason('agent_expired'),
    ]).size).toBe(4);
  });
});
