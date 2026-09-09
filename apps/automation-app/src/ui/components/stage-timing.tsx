import { ANALYSIS_STAGES, type AnalysisRun, type AnalysisStage } from '@xaa/contracts/security-monitoring';
import { traceDecision } from '../analysis/trace.js';
import { formatDuration } from './visual.js';
import type { Element } from '../element.js';

/**
 * Where one analysis spent its time, as one bar cut into stages.
 *
 * Eight durations in a list say how long each stage took; a bar says which one took
 * the run's time, which is the question — 「AI 待ちなのか、それとも受信で詰まったのか」.
 * A stage still running grows with the clock, so a person watching sees the bar move
 * on the stage that is moving. Every segment names its stage and its duration in text.
 */
export function StageTiming(props: { run: AnalysisRun; now: number; labels: Readonly<Record<string, string>> }): Element {
  const run = props.run;
  const durations = ANALYSIS_STAGES.map((stage) => ({ stage, ms: durationOf(run, stage, props.now), state: stateOf(run, stage) }));
  const total = durations.reduce((sum, item) => sum + item.ms, 0);
  if (total === 0) return null;
  return (
    <div className="stage-timing" data-stage-timing="true">
      <div className="stage-timing-track" role="img" aria-label={`段階ごとの所要時間：${durations.filter((item) => item.ms > 0).map((item) => `${props.labels[item.stage]} ${formatDuration(item.ms)}`).join('、')}`}>
        {durations.map((item) => (item.ms === 0 ? null : (
          <span
            key={item.stage}
            className="stage-timing-segment"
            data-stage={item.stage}
            data-state={item.state}
            style={{ flexGrow: item.ms + total * 0.015 }}
            title={`${props.labels[item.stage]} ${formatDuration(item.ms)}`}
          />
        )))}
      </div>
      <ul className="stage-timing-legend">
        {durations.map((item) => (item.ms === 0 ? null : (
          <li key={item.stage} data-stage={item.stage} data-state={item.state}>
            <span className="stage-timing-swatch" aria-hidden="true" />
            {props.labels[item.stage]} <b>{formatDuration(item.ms)}</b>
          </li>
        )))}
      </ul>
    </div>
  );
}

function durationOf(run: AnalysisRun, stage: AnalysisStage, now: number): number {
  const recorded = run.stage_durations_ms?.[stage];
  if (typeof recorded === 'number') return recorded;
  if (run.status === 'running' && run.stage === stage && run.stage_started_at) return Math.max(0, now - Date.parse(run.stage_started_at));
  return 0;
}

function stateOf(run: AnalysisRun, stage: AnalysisStage): 'done' | 'running' | 'failed' | 'waiting' {
  if (run.completed_stages.includes(stage)) return 'done';
  if (run.stage === stage) return run.status === 'running' ? 'running' : run.status === 'failed' ? 'failed' : 'done';
  return 'waiting';
}

/**
 * How many things survived each stage: the counts the detector recorded, as bars.
 *
 * The numbers were already on the screen in a row; side by side as bars they show the
 * shape of a run at a glance — a thousand lines in, one rule hit, no AI call — which is
 * the answer to 「何も起きていないのは、見ていないからか、何もなかったからか」.
 */
export function CountFunnel(props: { run: AnalysisRun }): Element {
  const run = props.run;
  const analysed = run.decisions.filter((decision) => traceDecision(decision).path.includes('analyze')).length;
  const rows: ReadonlyArray<{ key: string; label: string; value: number }> = [
    { key: 'input', label: '受信', value: run.input_count },
    { key: 'normalized', label: '正規化', value: run.normalized_count },
    { key: 'violation', label: '違反', value: run.violation_count },
    { key: 'rule_hit', label: 'ルール一致', value: run.rule_hit_count },
    { key: 'finding', label: '検知', value: run.decisions.length },
    { key: 'analysed', label: 'AI 分析', value: analysed },
  ];
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <dl className="count-funnel" data-count-funnel="true">
      {rows.map((row) => (
        <div key={row.key} className="funnel-row" data-count={row.key}>
          <dt>{row.label}</dt>
          <dd>
            <span className="funnel-bar" aria-hidden="true"><span style={{ width: `${(row.value / max) * 100}%` }} /></span>
            <b>{row.value}</b>
          </dd>
        </div>
      ))}
      {run.unmapped_count > 0 ? <p className="funnel-note">未対応の形式 {run.unmapped_count} 件は正規化で落ちています。</p> : null}
    </dl>
  );
}
