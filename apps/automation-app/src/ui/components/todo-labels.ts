import type { TodoPriority, TodoSource, WorkDefinitionStatus } from '../../work-definition/model.js';

/**
 * The words the list uses for a ToDo's state, written down once.
 *
 * These are screen furniture in the sense of `roles.ts`: fixed strings for fixed
 * values, the same on every render. They say what a state is called, never what a
 * particular ToDo's state means.
 */
export const STATUS_LABELS: Readonly<Record<WorkDefinitionStatus, string>> = {
  DRAFT: '下書き',
  CONFIRMED: '実行待ち',
  IN_PROGRESS: '実行中',
  DONE: '完了',
  CANCELLED: '取り下げ',
};

/**
 * Whether a ToDo is still on the list, judged from its state alone.
 *
 * The model answers the same question, but the model also compiles its schema, and a
 * screen that imported it would carry the validator — and the server libraries behind
 * it — into the browser. The screen reads the state; it does not decide it.
 */
export function isClosedStatus(status: WorkDefinitionStatus): boolean {
  return status === 'DONE' || status === 'CANCELLED';
}

export const PRIORITY_LABELS: Readonly<Record<TodoPriority, string>> = { high: '高', normal: '中', low: '低' };

export const SOURCE_LABELS: Readonly<Record<TodoSource, string>> = { screen: '画面から登録', api: 'API から登録' };

/**
 * What the Agent Runtime's three verdicts are called, in the Runtime's own words.
 *
 * The Runtime writes these headlines onto its terminal event (apps/agent-runtime,
 * `TERMINAL_HEADLINES`); the card repeats them so the person does not have to open the
 * timeline to learn whether the agent finished. They restate the verdict, they do not
 * judge it (RULE-54).
 */
export const TERMINAL_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  TASK_COMPLETED: '指示された作業を最後まで行いました',
  TASK_BLOCKED: '権限の範囲外の操作があったため、そこで止めました',
  TASK_FAILED: '途中で問題が起きたため、作業を完了できませんでした',
};
