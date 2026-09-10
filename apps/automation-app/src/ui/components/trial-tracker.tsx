import type { FaultKind } from '@xaa/contracts/fault-injection';
import type { FaultTrial } from '../../agents/faults.js';
import type { Element } from '../element.js';

/** The exercise's three moments, named once for the tracker and the controls. */
export const TRIAL_STEPS = ['requested', 'received', 'confirmed'] as const;
export type TrialStep = (typeof TRIAL_STEPS)[number];
export type TrialStepState = 'done' | 'current' | 'waiting' | 'skipped';

/** What each kind of fault does, and what its confirmation looks like on the screen. */
export const FAULT_KIND_TEXT: Readonly<Record<FaultKind, { label: string; effect: string; confirmed: string; watch: string }>> = {
  runtime_crash: {
    label: 'Runtime を落とす',
    effect: '次の手の頭で Runtime が例外を投げ、実行がその場で終わります。モデルは呼ばれません。',
    confirmed: '実行の失敗を確認',
    watch: '状況確認に「直近の実行は失敗しました」、タイムラインに失敗のタスクが出ます。',
  },
  model_unavailable: {
    label: 'モデルが応答しない',
    effect: '次の手でモデルを呼ばず、応答なしとして打ち切ります。実行ログにその手が記録されます。',
    confirmed: '応答なしによる打ち切りを確認',
    watch: '実行ログに「モデルへの接続を失敗させました」の手、タイムラインに失敗のタスクが出ます。',
  },
  tool_failure: {
    label: 'ツール呼び出しを失敗させる',
    effect: '次に選ばれたツールを実行せず失敗として返します。Agent は続きを考え、実行は続きます。',
    confirmed: 'ツール呼び出しの失敗を確認',
    watch: '実行ログにその手が失敗として出て、Agent がどう立て直すかが次の手に出ます。',
  },
};

export const TRIAL_STEP_LABELS: Readonly<Record<TrialStep, string>> = {
  requested: '要求を登録',
  received: 'Runtime が読み取る',
  confirmed: '結果を確認',
};

/** Which of the three moments a request is at, from the state the reader computed. */
export function trialStepStates(state: FaultTrial['state']): Readonly<Record<TrialStep, TrialStepState>> {
  switch (state) {
    case 'queued': return { requested: 'done', received: 'current', confirmed: 'waiting' };
    case 'received': return { requested: 'done', received: 'done', confirmed: 'current' };
    case 'failed': return { requested: 'done', received: 'done', confirmed: 'done' };
    case 'not_applied': return { requested: 'done', received: 'skipped', confirmed: 'skipped' };
  }
}

/**
 * One request for a failure, as the three moments it passes through.
 *
 * A row that said 「適用待ち」 told a person the state and left them to work out what
 * comes next. Three dots in a line say where the request is and what is still to
 * happen, and the last one is named after the kind of failure asked for — so the
 * tracker for 「モデルが応答しない」 says what a confirmed one of those looks like.
 */
export function TrialTracker(props: { trial: FaultTrial }): Element {
  const states = trialStepStates(props.trial.state);
  const text = FAULT_KIND_TEXT[props.trial.kind];
  return (
    <ol className="trial-tracker" data-trial-tracker={props.trial.instruction_id} aria-label="異常系試験の進み具合">
      {TRIAL_STEPS.map((step) => (
        <li key={step} data-trial-step={step} data-step-state={states[step]}>
          <span className="trial-dot" aria-hidden="true" />
          <span className="trial-step-label">{step === 'confirmed' ? text.confirmed : TRIAL_STEP_LABELS[step]}</span>
          <span className="sr-only">{describe(states[step])}</span>
        </li>
      ))}
    </ol>
  );
}

function describe(state: TrialStepState): string {
  return { done: '済み', current: 'ここまで進んでいます', waiting: 'まだです', skipped: '対象の実行が終わったため行われません' }[state];
}
