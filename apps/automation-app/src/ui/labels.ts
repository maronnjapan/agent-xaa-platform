/**
 * The words the screens use for the platform's own codes, written down once.
 *
 * An Activity Event carries `task-1`, `provisioning`, `tool_call`, `ACTIVE`,
 * `not_in_allowed_tools` — names that are exact, stable and meaningless to the person
 * the screen is for. The screens kept printing them as they were, and the complaint was
 * the obvious one: 「ID とか英語がそのまま出てきて分かりにくい」.
 *
 * So every closed vocabulary the screens show gets one fixed Japanese word here, in the
 * sense of `roles.ts`: these say what a value is *called*, the same on every render,
 * and never what a particular event *means* (RULE-54). The code itself is kept beside
 * the word wherever a reader might need to match it against a log or a document, and
 * a value this table does not know is shown as it came rather than guessed at.
 *
 * Nothing here reads a datastore or a validator, because the browser bundle imports it
 * too (DEV-13): the task-id shapes are the four of `@xaa/contracts`, restated as a
 * pattern so the bundle does not carry the schema compiler along for one regex.
 */

export type TaskKind = 'provisioning' | 'task' | 'lifecycle' | 'demo' | 'unknown';

export interface TaskLabel {
  kind: TaskKind;
  /** The word on the row: 準備, 作業 1, 終了, デモ. */
  label: string;
  /** What that kind of task holds, for the reader who has not met one yet. */
  note: string;
}

/**
 * The four shapes a task id can take (docs 11 §3.3), mirrored from
 * `@xaa/contracts` `TASK_ID_PATTERN`; `labels.spec.ts` pins the two equal.
 */
const TASK_ID = /^(provisioning|lifecycle|task-([1-9][0-9]*)|demo-([a-z-]+))$/;

export const TASK_KIND_LABELS: Readonly<Record<Exclude<TaskKind, 'unknown'>, string>> = {
  provisioning: '準備',
  task: '作業',
  lifecycle: '終了',
  demo: 'デモ',
};

export const TASK_KIND_NOTES: Readonly<Record<Exclude<TaskKind, 'unknown'>, string>> = {
  provisioning: 'ログインから、ToDo の登録、権限の決定、Agent の作成まで',
  task: 'Agent が指示を読み、ツールを使って進めた作業',
  lifecycle: 'Agent の停止、期限切れ、失効',
  demo: '記録済みの台本を流し込んだもので、実際には起きていません',
};

/**
 * The four scripted scenarios (docs 11 §6.2), by the id the demo route accepts. A
 * scenario this list does not know keeps its id: a name invented for it here would be
 * the screen describing a script it has never read.
 */
export const DEMO_SCENARIO_LABELS: Readonly<Record<string, string>> = {
  'dpop-replay': 'DPoP Proof の再送',
  'cross-agent-isolation': '他の Agent への到達',
  'delegation-mismatch': '委譲関係の偽装',
  'signing-key-misuse': '署名鍵の目的外使用',
};

/** What a task is called on the screen, from its id and nothing else. */
export function taskLabelOf(taskId: string): TaskLabel {
  const match = TASK_ID.exec(taskId);
  if (!match) return { kind: 'unknown', label: taskId, note: '' };
  if (match[2] !== undefined) return { kind: 'task', label: `${TASK_KIND_LABELS.task} ${match[2]}`, note: TASK_KIND_NOTES.task };
  if (match[3] !== undefined) {
    const scenario = DEMO_SCENARIO_LABELS[match[3]];
    return {
      kind: 'demo',
      label: scenario ? `${TASK_KIND_LABELS.demo}：${scenario}` : `${TASK_KIND_LABELS.demo}：${match[3]}`,
      note: TASK_KIND_NOTES.demo,
    };
  }
  const kind = match[1] === 'provisioning' ? 'provisioning' : 'lifecycle';
  return { kind, label: TASK_KIND_LABELS[kind], note: TASK_KIND_NOTES[kind] };
}

/** The seven phases of `activityEventSchema`, as the rows caption them. */
export const PHASE_LABELS: Readonly<Record<string, string>> = {
  login: 'ログイン',
  work_definition: 'ToDo',
  authorization: '権限の決定',
  provisioning: 'Agent の作成',
  tool_call: 'ツールの実行',
  security: 'セキュリティ',
  lifecycle: '終了',
};

export function phaseLabelOf(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** The agent statuses of `agentStatusResponseSchema`, as the status panel names them. */
export const AGENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  CREATED: '作成中',
  PROVISIONING: '準備中',
  ACTIVE: '稼働中',
  EXPIRING: 'まもなく期限',
  EXPIRED: '期限切れ',
  SUSPICIOUS: '要注意',
  QUARANTINED: '隔離中',
  REVOKED: '失効',
  DESTROYED: '破棄済み',
};

export function agentStatusLabelOf(status: string): string {
  return AGENT_STATUS_LABELS[status] ?? status;
}

/** How the Runtime's checkpoint says a tool call ended. */
export const TOOL_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  success: '成功',
  blocked: '遮断',
  failed: '失敗',
};

export function toolOutcomeLabelOf(outcome: string): string {
  return TOOL_OUTCOME_LABELS[outcome] ?? outcome;
}

/**
 * The keys publishers put in `detail`, captioned. The value under each is shown as it
 * came: the caption names the field, it does not read it.
 */
export const DETAIL_KEY_LABELS: Readonly<Record<string, string>> = {
  event_type: 'できごとの種類',
  activity_kind: '区分',
  work_definition_id: 'ToDo の ID',
  decision_id: '決定の ID',
  agent_definition_id: 'Agent Definition の ID',
  agent_id: 'Agent の ID',
  old_agent_id: '元の Agent の ID',
  new_agent_id: '新しい Agent の ID',
  replaces_agent_id: '引き継いだ Agent の ID',
  instruction_id: '指示の ID',
  task_id: '作業の ID',
  purpose: '目的',
  source: '登録元',
  target: '宛先',
  tool_id: 'ツール',
  initial: '最初の指示',
  requested_lifetime_minutes: '希望する稼働時間（分）',
  expires_at: '有効期限',
  error: 'エラー',
  error_code: 'エラーの種別',
  reason: '理由',
  reason_code: '理由コード',
  violation_code: '違反コード',
  rule: 'ルール',
  effective_capabilities: '許可された操作',
  missing_capabilities: '足りない操作',
  allowed_tools: '使えるツール',
  scopes: 'スコープ',
  missing_scopes: '足りないスコープ',
  isolation_level: '隔離のレベル',
  status: '状態',
  connector_id: '接続先',
  idp_connection_id: 'ログイン連携の ID',
  finding_id: '検知の ID',
  risk_score: 'リスクスコア',
  policy_id: 'ポリシーの ID',
  capability_id: '操作',
  observed: '観測した値',
  expected: '期待した値',
  path: '経路',
  code: 'コード',
};

export function detailKeyLabelOf(key: string): string | null {
  return DETAIL_KEY_LABELS[key] ?? null;
}

/** A length of time in words: 1 秒未満, 12 秒, 3 分 12 秒, 1 時間 5 分. */
export function formatDuration(millis: number): string {
  if (!Number.isFinite(millis) || millis < 0) return '';
  const seconds = Math.floor(millis / 1000);
  if (seconds < 1) return '1 秒未満';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours} 時間 ${minutes} 分` : `${hours} 時間`;
  if (minutes > 0) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  return `${rest} 秒`;
}

/** The time an agent has left, from the seconds the status endpoint answers with. */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 秒';
  return formatDuration(seconds * 1000);
}

/** The duration between two recorded instants, or nothing if either cannot be read. */
export function durationBetween(from: string, to: string): string {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  return formatDuration(end - start);
}
