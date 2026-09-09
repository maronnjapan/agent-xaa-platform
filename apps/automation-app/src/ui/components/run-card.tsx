import type { TimelineTask } from '../../activity/query.js';
import { agentPagePath } from '../../agents/page-link.js';
import { blockedCountOf, isSimulated, StageCard } from './stage-card.js';
import { LocalTime } from './local-time.js';
import type { Element } from '../element.js';

export const NO_AGENT_YET = 'Agent はまだ作られていません';
export const NO_PURPOSE = '（目的の記録がありません）';
export const OPEN_AGENT_PAGE = 'Agent の画面を開く';
export const ONLY_THIS_AGENT = 'この Agent だけ表示';
export const RUN_IDS_CAPTION = 'ID を表示';

/** One agent's story, as the page groups it: the tasks `readTimeline` filed under one run. */
export interface Run {
  runId: string;
  agentId: string | null;
  purpose: string;
  tasks: readonly TimelineTask[];
}

export interface RunSummary {
  /** Tasks with no terminal event yet. */
  running: number;
  /** Tasks whose events include a refusal, counted by the publishers' own `outcome`. */
  blocked: number;
  /** The agent's `lifecycle` task has ended: the story is over. */
  ended: boolean;
  /** Some task is a scripted one (RULE-58). */
  simulated: boolean;
  /** The earliest and latest recorded instants among the finished tasks. */
  startedAt: string | null;
  updatedAt: string | null;
}

/**
 * What the head of a run says, from the tasks and nothing else.
 *
 * Every number is a count of something the schema pins — a task without a terminal
 * event, an event whose `outcome` is `blocked`, a task id that is `lifecycle` — and
 * the screen never turns them into a verdict. It does not say the agent succeeded; it
 * says how many refusals there were and whether the story has ended (RULE-54).
 */
export function summariseRun(tasks: readonly TimelineTask[]): RunSummary {
  const instants: string[] = [];
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    for (const event of task.events) instants.push(event.occurred_at);
    instants.push(task.completed_at);
  }
  instants.sort();
  return {
    running: tasks.filter((task) => task.status === 'running').length,
    blocked: tasks.filter((task) => blockedCountOf(task) > 0).length,
    ended: tasks.some((task) => task.task_id === 'lifecycle' && task.status === 'completed'),
    simulated: tasks.some(isSimulated),
    startedAt: instants[0] ?? null,
    updatedAt: instants[instants.length - 1] ?? null,
  };
}

/**
 * Tasks belong to an agent; the grouping is the person's mental model, not ours.
 *
 * The heading is the work the agent was made for. The line under it says when the
 * story started and when it was last written to, how many tasks are still going, how
 * many ran into a refusal, and whether the agent has ended — the things a person wants
 * before deciding whether to open anything. The agent's own id is a thing a person
 * never needs to read and sometimes needs to copy, so it is behind a disclosure rather
 * than printed across the head.
 *
 * The tasks follow as a rail: provisioning, then the numbered tasks in the order they
 * finished, then lifecycle — the order `readTimeline` already put them in, which is
 * the order the work actually happened in. This only lays them out.
 */
export function RunCard(props: {
  run: Run;
  /**
   * Which finished tasks stand opened: all of them, none, or the ones with a refusal in
   * them. The newest agent's all do; the rest fold; the blocked view opens exactly the
   * cards a person switched to that view to find.
   */
  open: boolean | 'blocked';
  /** Offer the link that narrows the page to this agent. Off when it already is. */
  offerFilter: boolean;
}): Element {
  const { run } = props;
  const summary = summariseRun(run.tasks);
  return (
    <section className="run" data-run={run.runId} data-run-id={run.runId} data-agent-id={run.agentId ?? ''}>
      <header className="run-head">
        <div className="run-title">
          <h2 className="run-purpose" data-field="run-purpose">{run.purpose === '' ? NO_PURPOSE : run.purpose}</h2>
          <p className="run-chips" data-field="run-chips">
            {summary.running > 0 ? <span className="chip chip-running" data-chip="running">{`実行中 ${summary.running} 件`}</span> : null}
            {summary.blocked > 0 ? <span className="chip chip-blocked" data-chip="blocked">{`遮断あり ${summary.blocked} 件`}</span> : null}
            {summary.ended ? <span className="chip chip-ended" data-chip="ended">終了</span> : null}
            {summary.simulated ? <span className="chip chip-demo" data-chip="demo">デモ実行（模擬）</span> : null}
            {run.agentId === null ? <span className="chip chip-pending" data-field="agent-missing">{NO_AGENT_YET}</span> : null}
          </p>
        </div>
        <dl className="run-meta">
          {summary.startedAt === null ? null : (
            <div>
              <dt>開始</dt>
              <dd><LocalTime at={summary.startedAt} format="full" /></dd>
            </div>
          )}
          {summary.updatedAt === null ? null : (
            <div>
              <dt>最後の記録</dt>
              <dd><LocalTime at={summary.updatedAt} format="full" /></dd>
            </div>
          )}
          <div>
            <dt>作業</dt>
            <dd data-field="task-count">{`${run.tasks.length} 件`}</dd>
          </div>
        </dl>
        <p className="run-links">
          {run.agentId === null ? null : <a href={agentPagePath(run.agentId)} data-field="agent-link">{OPEN_AGENT_PAGE}</a>}
          {run.agentId !== null && props.offerFilter
            ? <a href={`/activity?agent_id=${encodeURIComponent(run.agentId)}`} data-field="filter-link">{ONLY_THIS_AGENT}</a>
            : null}
          <details className="run-ids" data-field="run-ids">
            <summary>{RUN_IDS_CAPTION}</summary>
            <dl>
              <dt>Agent ID</dt>
              <dd><code data-field="agent-id">{run.agentId ?? '—'}</code></dd>
              {run.agentId === run.runId ? null : (
                <>
                  <dt>まとまりの ID</dt>
                  <dd><code data-field="run-key">{run.runId}</code></dd>
                </>
              )}
            </dl>
          </details>
        </p>
      </header>
      <ol className="stages">
        {run.tasks.map((task) => (
          <StageCard
            key={task.task_id}
            task={task}
            open={props.open === 'blocked' ? blockedCountOf(task) > 0 : props.open}
          />
        ))}
      </ol>
    </section>
  );
}
