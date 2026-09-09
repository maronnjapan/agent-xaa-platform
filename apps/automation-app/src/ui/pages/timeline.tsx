import { useCallback, useState } from 'react';
import type { TimelineTask } from '../../activity/query.js';
import { CastPanel } from '../components/cast-panel.js';
import { RunCard, summariseRun, type Run } from '../components/run-card.js';
import { partiesIn } from '../roles.js';
import type { Element } from '../element.js';

export const TIMELINE_TITLE = 'アクティビティ';
export const TIMELINE_LEAD = 'ログインから、権限の決定、Agent の作成、作業、終了までを Agent ごとにまとめています。新しい Agent が上です。';
export const TIMELINE_EMPTY = 'まだ記録がありません。ToDo を書いて Agent を作ると、ここに並びます。';
export const TIMELINE_FILTERED_NOTE = 'この Agent の記録だけを表示しています。';
export const SHOW_ALL_AGENTS = 'すべての Agent を表示';
export const REFRESH_LABEL = '最新の状態に更新';
export const VIEW_ALL = 'すべて';
export const VIEW_BLOCKED = '遮断されたものだけ';

/** What the person is looking at: everything, or only the rows where something was refused. */
export type TimelineView = 'all' | 'blocked';

/**
 * Tasks grouped into agents, in the order `readTimeline` handed them over.
 *
 * A run is one agent's whole story — from the login that preceded it, through the
 * proposal and the decision, to its tasks and its end — and the grouping is by
 * `run_id`, which `readTimeline` has already resolved. Within a run the order is fixed:
 * provisioning, then the numbered tasks in the order they finished, then lifecycle,
 * which is the order the work actually happened in. This only groups.
 */
export function groupRuns(tasks: readonly TimelineTask[]): Run[] {
  const runs = new Map<string, Run>();
  for (const task of tasks) {
    const run = runs.get(task.run_id) ?? { runId: task.run_id, agentId: task.agent_id, purpose: task.purpose, tasks: [] };
    runs.set(task.run_id, { ...run, agentId: run.agentId ?? task.agent_id, tasks: [...run.tasks, task] });
  }
  return [...runs.values()];
}

/**
 * The person's activity, as one page.
 *
 * It opens with the numbers a person wants before reading anything: how many agents,
 * how many still running, how many ran into a refusal. Then one card per agent, newest
 * first, each headed by the work it was made for and followed by its tasks on a rail.
 * The newest agent's tasks start opened, because that is the one a person came to look
 * at; the rest fold to a line each, so ten agents are ten lines rather than ten screens.
 *
 * Nothing on the page is a sentence about what an event meant. The chips count the
 * publishers' own `outcome`, the heads print the publishers' own titles, and the words
 * the screen adds are names for kinds of things — a phase, a task, a part of the
 * platform (RULE-54).
 *
 * Refreshing is a button. The page asks once when it opens and once per press, and at
 * no other time: a timeline that streamed would need a live channel to the datastore,
 * and the browser is deliberately never given one (DEV-13). A page narrowed to one
 * agent stays narrowed when it refreshes — the subject still comes from the session,
 * and the narrowing is a filter over the person's own timeline, never a widening of it.
 *
 * The view switch hides nothing from the markup: every row is served, and 「遮断され
 * たものだけ」 is a stylesheet rule keyed on the page's `data-view`, so a person
 * without script sees everything and a person with it sees what they asked for. What
 * the switch does change is which cards stand open: the ones with a refusal in them,
 * and only those, so the page becomes the list of where things were stopped.
 */
export function TimelinePage(props: { tasks: readonly TimelineTask[]; agentId?: string | null }): Element {
  const [tasks, setTasks] = useState<readonly TimelineTask[]>(props.tasks);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [view, setView] = useState<TimelineView>('all');
  const agentId = props.agentId ?? null;

  const refresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
        if (!response.ok) return;
        const body = await response.json() as { tasks: TimelineTask[] };
        setTasks(agentId === null ? body.tasks : body.tasks.filter((task) => task.agent_id === agentId));
        setUpdatedAt(new Date().toLocaleTimeString('ja-JP', { hour12: false }));
      } finally {
        setRefreshing(false);
      }
    })();
  }, [agentId]);

  const runs = groupRuns(tasks);
  const summaries = runs.map((run) => summariseRun(run.tasks));
  const running = summaries.reduce((sum, summary) => sum + summary.running, 0);
  const blocked = summaries.reduce((sum, summary) => sum + summary.blocked, 0);
  const sources = partiesIn(tasks.flatMap((task) => (task.status === 'completed' ? task.events : [])));

  return (
    <main className="timeline" data-page="timeline" data-view={view}>
      <header className="page-head">
        <div className="page-head-text">
          <h1>{TIMELINE_TITLE}</h1>
          <p className="lead">{TIMELINE_LEAD}</p>
        </div>
        <div className="page-tools">
          <button type="button" className="secondary" data-action="refresh" onClick={refresh} disabled={refreshing}>{REFRESH_LABEL}</button>
          <span className="updated-at" data-field="updated-at">{updatedAt === null ? '' : `${updatedAt} に更新`}</span>
        </div>
      </header>

      {agentId === null ? null : (
        <p className="filter-note" data-field="filter-note">
          {TIMELINE_FILTERED_NOTE}
          <a href="/activity">{SHOW_ALL_AGENTS}</a>
        </p>
      )}

      <div className="summary-bar" data-section="summary">
        <p className="summary-chips">
          <span className="chip" data-summary="agent-count">{`Agent ${runs.length} 体`}</span>
          <span className="chip chip-running" data-summary="running">{`実行中 ${running} 件`}</span>
          <span className="chip chip-blocked" data-summary="blocked">{`遮断あり ${blocked} 件`}</span>
        </p>
        <div className="view-switch" role="group" aria-label="表示する内容">
          <button
            type="button"
            className={view === 'all' ? 'is-selected' : ''}
            data-action="view-all"
            aria-pressed={view === 'all'}
            onClick={() => setView('all')}
          >
            {VIEW_ALL}
          </button>
          <button
            type="button"
            className={view === 'blocked' ? 'is-selected' : ''}
            data-action="view-blocked"
            aria-pressed={view === 'blocked'}
            onClick={() => setView('blocked')}
          >
            {VIEW_BLOCKED}
          </button>
        </div>
      </div>

      <CastPanel sources={sources} />

      {runs.length === 0 ? <p className="timeline-empty" data-field="timeline-empty">{TIMELINE_EMPTY}</p> : null}
      {runs.map((run, index) => (
        <RunCard
          key={run.runId}
          run={run}
          open={view === 'blocked' ? 'blocked' : (index === 0 || agentId !== null)}
          offerFilter={agentId === null}
        />
      ))}
    </main>
  );
}
