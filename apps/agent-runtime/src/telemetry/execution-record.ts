import {
  redactRecordText,
  type ActivityRecord,
  type ActivityRecordCheck,
  type ActivityRecordHop,
  type ActivityRecordSection,
} from '@xaa/contracts';
import type { ToolResult } from '../tool-executor/errors.js';

/**
 * The Japanese a person reads about one tool call, written where the reason is known.
 *
 * Every sentence on the timeline and on the agent screen comes from here or from
 * `activity.ts`, and none of it is composed by a renderer (RULE-54). The distinction
 * matters more than it looks: this module can say "許可された 3 件に含まれていません"
 * because it is holding the manifest at the moment of the refusal. A screen looking at
 * the same record later holds only the record, and would have to guess.
 *
 * Nothing here decides anything. The executor has already decided; the recorder is
 * told what happened and writes it down in order.
 */

/** The four values `docs 11 §3.4` allows, restated as the type the executor passes. */
type CheckResult = ActivityRecordCheck['result'];

export interface ToolCallIntent {
  /** The model's own words for this step, when it wrote any. */
  note?: string;
  /** The arguments the model asked for, before the manifest was consulted. */
  parameters: Record<string, unknown>;
  /** The instructions the agent read at the head of this step, in the person's words. */
  instructions?: readonly string[];
}

export interface ExecutionRecorder {
  toolAllowed(input: { toolId: string; allowedCount: number; requiredCapability: string }): void;
  toolRefused(input: { toolId: string; allowedToolIds: readonly string[] }): void;
  lifetimeChecked(input: { expiresAt: string; expired: boolean }): void;
  constraintsChecked(input: { names: readonly string[]; violated: string | null }): void;
  authorizationMapped(input: { audience: string; resource: string; scope: string }): void;
  idJagIssued(input: { audience: string }): void;
  accessTokenBound(input: { audience: string; binding: string; expiresAt: string }): void;
  requestBuilt(input: { method: string; url: string; body?: string | undefined; dropped: readonly string[] }): void;
  responseReceived(input: { status: number; latencyMs: number; body: unknown; allowlist: readonly string[] }): void;
  stopped(input: { stage: string; errorCode: string; status?: number }): void;
  build(result: ToolResult): ActivityRecord;
}

/** How the stage names of docs 04 §6 read to someone who has not read docs 04 §6. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  tool_selection: 'ツールを選ぶところ',
  auth_mapping: '権限を対応づけるところ',
  agent_op: 'Agent OP に身元を示すところ',
  id_jag: 'ID-JAG を受け取るところ',
  token_endpoint: 'Access Token を受け取るところ',
  access_token: 'Access Token を使う準備',
  resource_api: '相手の API を呼ぶところ',
};

/** Why a call ended, in the words of the thing that ended it. */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  tool_not_allowed: 'この Agent に許可されていないツールでした。',
  agent_expired: 'Agent の有効期限が切れていました。',
  missing_required_parameter: '必須の引数が足りませんでした。',
  invalid_path_parameter: '宛先の組み立てに使えない引数でした。',
  constraint_violation: '人が付けた条件の範囲を超えていました。',
  agent_op_error: 'Agent OP が ID-JAG を発行しませんでした。',
  resource_as_error: 'Resource AS が Access Token を発行しませんでした。',
  bridge_error: 'Bridge が外部サービスの Access Token を用意できませんでした。',
  resource_api_error: '相手の API がエラーを返しました。',
  invalid_tool_call: 'エージェントの指定を読み取れませんでした。',
  unexpected_token_type: '受け取った Token の種類が想定と違いました。',
  unexpected_subject_response: 'Agent OP の応答が想定と違いました。',
  tool_execution_error: '想定していない失敗が起きました。',
};

function describeError(code: string): string {
  return ERROR_MESSAGES[code] ?? `${code} で終わりました。`;
}

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/**
 * Values go on screen as text; a number, an array and an object must all survive it.
 *
 * Nothing in this module may throw. A recorder call sits inside `runSteps`, where an
 * exception is caught and reported as `tool_execution_error` — so a value this could
 * not serialise would turn a tool call that worked into one that failed, for the sake
 * of a line on a screen.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return redactRecordText(value);
  try {
    return redactRecordText(JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    return '（この値は表示できませんでした）';
  }
}

/** The path alone, for an arrow label that has to fit inside a box. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function joinOrDash(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.join('、');
}

/**
 * One recorder per tool call.
 *
 * It is handed to `executeTool` and called beside every `stage.emit`, which is why the
 * two never disagree about how far a call got. The stage log is for the detection
 * queries and carries no bodies; this is for a person and carries the request and the
 * answer — the same sequence, told to two different readers (RULE-55).
 */
export function createExecutionRecorder(input: { step: number; toolId: string; intent: ToolCallIntent }): ExecutionRecorder {
  const checks: ActivityRecordCheck[] = [];
  const sections: ActivityRecordSection[] = [];
  const hops: ActivityRecordHop[] = [];
  let headline = `${input.toolId} を実行しました`;

  const check = (id: string, label: string, result: CheckResult, message: string): void => {
    checks.push({ id, label, result, message });
  };

  const received = receivedSection(input.intent.instructions);
  if (received) sections.push(received);
  sections.push({
    id: 'intent',
    label: 'エージェントが決めたこと',
    message: `${input.step} 手目に ${input.toolId} を選びました。`,
    ...(input.intent.note ? { text: redactRecordText(input.intent.note), format: 'text' as const } : {}),
    fields: [
      { label: '選んだツール', value: input.toolId },
      { label: '渡そうとした引数', value: asText(input.intent.parameters) },
    ],
  });

  return {
    toolAllowed({ toolId, allowedCount, requiredCapability }) {
      check('allowed_tools', '許可されたツールに入っているか', 'passed',
        `${toolId} は、この Agent に渡された ${allowedCount} 件のツールに含まれていました。`);
      sections.push({
        id: 'capability',
        label: 'このツールが要求する権限',
        message: `${toolId} を使うには ${requiredCapability} が要ります。この Agent は持っていました。`,
        fields: [{ label: '必要な Capability', value: requiredCapability }],
      });
    },

    toolRefused({ toolId, allowedToolIds }) {
      headline = `${toolId} の実行を拒否しました`;
      check('allowed_tools', '許可されたツールに入っているか', 'blocked',
        `${toolId} は、この Agent に渡されたツールに含まれていません。`);
      sections.push({
        id: 'allowed_tools',
        label: 'この Agent が使えるツール',
        message: '実行できるのは次のツールだけです。ここに無いものは、要求された時点で止まります。',
        fields: [{ label: '使えるツール', value: joinOrDash(allowedToolIds) }],
      });
      // Nothing left the process, so the only movement worth drawing is the one that
      // did not happen: the agent set off for the resource and was stopped at once.
      hops.push({
        from: 'agent-runtime',
        to: 'resource-api',
        label: '実行の要求',
        outcome: 'blocked',
        message: `${toolId} は許可されたツールに含まれないため、Tool Executor が要求を止めました。外部へは何も送っていません。`,
      });
    },

    lifetimeChecked({ expiresAt, expired }) {
      check('agent_lifetime', 'Agent の有効期限内か', expired ? 'blocked' : 'passed',
        expired
          ? `有効期限 ${expiresAt} を過ぎていたため実行しませんでした。`
          : `有効期限は ${expiresAt} で、まだ残っていました。`);
    },

    constraintsChecked({ names, violated }) {
      if (names.length === 0) {
        check('constraints', '人が付けた条件を満たすか', 'skipped', 'このツールに条件は付いていません。');
        return;
      }
      check('constraints', '人が付けた条件を満たすか', violated ? 'blocked' : 'passed',
        violated
          ? `${violated} の条件を満たさなかったため、要求を送る前に止めました。`
          : `${joinOrDash(names)} の条件を確かめ、いずれも満たしていました。`);
      if (violated) {
        headline = `${input.toolId} を条件違反として拒否しました`;
        hops.push({
          from: 'agent-runtime',
          to: 'resource-api',
          label: '実行の要求',
          outcome: 'blocked',
          message: `${violated} の条件に反していたため、Tool Executor が要求を止めました。外部へは何も送っていません。`,
        });
      }
    },

    authorizationMapped({ audience, resource, scope }) {
      sections.push({
        id: 'authorization',
        label: '使った権限',
        message: 'ツールごとに Catalog で決まっている宛先と権限です。エージェントが選んだものではありません。',
        fields: [
          { label: '要求先（audience）', value: audience },
          { label: '対象（resource）', value: resource },
          { label: '範囲（scope）', value: scope },
        ],
      });
    },

    idJagIssued({ audience }) {
      hops.push({
        from: 'agent-runtime',
        to: 'agent-op',
        label: 'ID-JAG を要求',
        outcome: 'info',
        message: `${audience} 向けの ID-JAG を Agent OP に求めました。誰の代理かを示す身元です。`,
      });
      hops.push({
        from: 'agent-op',
        to: 'agent-runtime',
        label: 'ID-JAG を受領',
        outcome: 'success',
        message: 'Agent OP が ID-JAG を発行しました。この Execution の鍵に結び付いています。',
      });
    },

    accessTokenBound({ audience, binding, expiresAt }) {
      hops.push({
        from: 'agent-runtime',
        to: 'resource-as',
        label: 'Access Token と交換',
        outcome: 'info',
        message: `ID-JAG を ${audience} の Access Token と交換しました。`,
      });
      hops.push({
        from: 'resource-as',
        to: 'agent-runtime',
        label: 'Access Token を受領',
        outcome: 'success',
        message: `${expiresAt} まで有効な Access Token を受け取りました。提示方法は ${binding} です。`,
      });
      sections.push({
        id: 'access_token',
        label: '受け取った Access Token',
        message: 'Token そのものは記録しません。いつまで有効で、どう提示したかだけを残します。',
        fields: [
          { label: '有効期限', value: expiresAt },
          { label: '提示方法', value: binding },
        ],
      });
    },

    requestBuilt({ method, url, body, dropped }) {
      check('parameters', '宣言された引数だけを送ったか', 'passed',
        dropped.length === 0
          ? 'ツールが宣言していない引数はありませんでした。'
          : `${joinOrDash(dropped)} はこのツールが宣言していない引数のため、送らずに落としました。`);
      sections.push({
        id: 'request',
        label: '送ったリクエスト',
        message: `${method} で ${url} を呼びました。宛先は Catalog が決めたもので、エージェントは組み立てていません。`,
        fields: [
          { label: 'メソッド', value: method },
          { label: '宛先', value: redactRecordText(url) },
          { label: '落とした引数', value: joinOrDash([...dropped]) },
        ],
        ...(body === undefined ? {} : { text: redactRecordText(body), format: 'json' as const }),
      });
      hops.push({
        from: 'agent-runtime',
        to: 'resource-api',
        label: `${method} ${pathOf(url)}`,
        outcome: 'info',
        message: `${method} ${redactRecordText(url)} を送りました。`,
      });
    },

    responseReceived({ status, latencyMs, body, allowlist }) {
      check('response_projection', '返り値を許可された項目だけに絞ったか', 'passed',
        `応答から ${joinOrDash([...allowlist])} だけを取り出し、それ以外はエージェントに渡していません。`);
      sections.push({
        id: 'response',
        label: '返ってきた値',
        message: `HTTP ${status} が ${latencyMs} ミリ秒で返りました。下に出ているのは、許可された項目だけを取り出した後の値です。`,
        fields: [
          { label: 'HTTP ステータス', value: String(status) },
          { label: '所要時間', value: `${latencyMs} ミリ秒` },
          { label: 'エージェントに渡した項目', value: joinOrDash([...allowlist]) },
        ],
        text: asText(body),
        format: 'json',
      });
      hops.push({
        from: 'resource-api',
        to: 'agent-runtime',
        label: `HTTP ${status}`,
        outcome: 'success',
        message: `HTTP ${status} を受け取り、許可された項目だけをエージェントに渡しました。`,
      });
    },

    stopped({ stage, errorCode, status }) {
      headline = `${input.toolId} は ${stageLabel(stage)} で止まりました`;
      sections.push({
        id: 'failure',
        label: '止まったところ',
        message: describeError(errorCode),
        fields: [
          { label: '止まった段階', value: stageLabel(stage) },
          { label: '種別', value: errorCode },
          ...(status === undefined ? [] : [{ label: '相手が返した HTTP ステータス', value: String(status) }]),
        ],
      });
    },

    build(result) {
      if (result.outcome === 'success') headline = `${result.tool_id} を実行しました`;
      return {
        headline,
        step: input.step,
        checks,
        sections,
        ...(hops.length > 0 ? { hops } : {}),
      };
    },
  };
}

/**
 * What the agent was told at the head of this step, in the words it was told.
 *
 * The first step's is the confirmed work itself; a later one is something the person
 * added while the agent ran. A reader who sees the agent refuse a tool two lines down
 * needs to see the instruction that asked for it, and a reader who sees it do the right
 * thing needs to see what "right" was.
 */
function receivedSection(instructions: readonly string[] | undefined): ActivityRecordSection | null {
  if (!instructions || instructions.length === 0) return null;
  return {
    id: 'received',
    label: 'この手で読んだ指示',
    message: `Agent Runtime が ${instructions.length} 件の指示を読み取り、会話に加えました。指示は言葉だけで、使えるツールを増やすことはありません。`,
    text: redactRecordText(instructions.join('\n\n')),
    format: 'text',
  };
}

/**
 * The record for a step in which no tool ran at all.
 *
 * A model that answered with something unreadable, or that said it was finished, still
 * did something a person is entitled to see. Leaving these steps out made a run of
 * eight reasoning steps look like a run of two tool calls.
 */
export function reasoningRecord(input: {
  step: number; headline: string; message: string; note?: string; instructions?: readonly string[];
}): ActivityRecord {
  const received = receivedSection(input.instructions);
  return {
    headline: input.headline,
    step: input.step,
    sections: [
      ...(received ? [received] : []),
      {
        id: 'intent',
        label: 'エージェントが決めたこと',
        message: input.message,
        ...(input.note ? { text: redactRecordText(input.note), format: 'text' as const } : {}),
      },
    ],
  };
}

/**
 * The whole task in one record: how many steps it took, what each of them did, why it
 * stopped, and the agent's own closing words.
 *
 * It hangs off the terminal event, which is the row a person opens first — often the
 * only one they open. A terminal event that said "作業が完了しました" and nothing else
 * left them to reconstruct the run from the rows above it, in reverse.
 */
export function taskSummaryRecord(input: {
  headline: string;
  stoppedBy: string;
  steps: readonly ActivityRecord[];
  toolCalls: { succeeded: number; blocked: number; failed: number };
  finalNote?: string;
}): ActivityRecord {
  const stopped = STOP_REASONS[input.stoppedBy] ?? `${input.stoppedBy} で終わりました。`;
  const sections: ActivityRecordSection[] = [
    {
      id: 'summary',
      label: 'この作業の要約',
      message: stopped,
      fields: [
        { label: '考えた回数', value: `${input.steps.length} 手` },
        { label: '実行できたツール', value: `${input.toolCalls.succeeded} 件` },
        { label: '権限外として断ったツール', value: `${input.toolCalls.blocked} 件` },
        { label: '失敗したツール', value: `${input.toolCalls.failed} 件` },
      ],
    },
    {
      id: 'steps',
      label: '手順',
      message: '上から順に、エージェントがこの作業で行ったことです。',
      fields: input.steps.map((step, index) => ({
        label: `${step.step ?? index + 1} 手目`,
        value: step.headline,
      })),
    },
  ];
  if (input.finalNote) {
    sections.push({
      id: 'final_note',
      label: 'エージェントが最後に述べたこと',
      message: 'エージェント自身が書いた文章です。プラットフォームは内容に手を入れていません。',
      text: redactRecordText(input.finalNote),
      format: 'text',
    });
  }
  return { headline: input.headline, sections };
}

/** Why the loop stopped, said once here rather than at each of the four call sites. */
const STOP_REASONS: Readonly<Record<string, string>> = {
  done: 'エージェントが、これ以上ツールで進めることは無いと判断して終わりました。',
  no_decision: 'モデルから答えが返らなかったため、途中で打ち切りました。',
  reasoning_step_limit: '考える回数の上限に達したため、途中で打ち切りました。',
  agent_expired: 'Agent の有効期限が切れたため、途中で打ち切りました。',
};
