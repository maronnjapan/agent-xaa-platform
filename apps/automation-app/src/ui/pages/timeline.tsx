import { useCallback, useState } from 'react';
import type { TimelineTask } from '../../activity/query.js';
import type { ActivityFocus } from '../activity-links.js';
import { taskLabelOf } from '../labels.js';
import { ActivityViewer } from '../components/activity-viewer.js';
import { RunCard, summariseRun, type Run } from '../components/run-card.js';
import type { Element } from '../element.js';

export const TIMELINE_TITLE = 'アクティビティ';
export const TIMELINE_LEAD = 'ログインから、権限の決定、Agent の作成、作業、終了までを Agent ごとにまとめています。新しい Agent が上です。区切りを選ぶと、その動きの図か、できごとの記録が1つずつ開きます。';
export const TIMELINE_EMPTY = 'まだ記録がありません。ToDo を書いて Agent を作ると、ここに並びます。';
export const TIMELINE_NO_MATCH = '検索に一致する Agent はありません。';
export const TIMELINE_FILTERED_NOTE = 'この Agent の記録だけを表示しています。';
export const SHOW_ALL_AGENTS = 'すべての Agent を表示';
export const REFRESH_LABEL = '最新の状態に更新';
export const REFRESH_FAILED = '更新できませんでした。表示は前回の内容のままです。';
export const SEARCH_LABEL = '検索';
export const SEARCH_PLACEHOLDER = '目的、Agent ID、作業の名前';
export const VIEW_ALL = 'すべて';
export const VIEW_ISSUES = '問題があったものだけ';

/** What the person is looking at: everything, or only the rows where something was refused or failed. */
export type TimelineView = 'all' | 'issues';

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

/** Whether an agent's card matches what a person typed: its purpose, its id, or a task's name. */
export function matchesSearch(run: Run, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (needle === '') return true;
  const haystack = [run.purpose, run.agentId ?? '', ...run.tasks.flatMap((task) => [task.task_id, taskLabelOf(task.task_id).label])]
    .join(' ').toLocaleLowerCase();
  return haystack.includes(needle);
}

/**
 * The activity screen: the list, or one agent in the viewer.
 *
 * The two are one page at one address, told apart by what the address names
 * (`activity-links.ts`). The list is where a person finds an agent and a task; the
 * viewer is where they look at one thing about it — the picture or the account — with
 * nothing else on the screen. A `focus` that names a run the tasks do not contain is
 * the list, not an error: the route already answered what this person may see.
 */
export function TimelinePage(props: { tasks: readonly TimelineTask[]; agentId?: string | null; focus?: ActivityFocus | null }): Element {
  const focus = props.focus ?? null;
  const agentId = props.agentId ?? null;
  const focused = focus === null ? null : groupRuns(props.tasks).find((run) => run.runId === focus.runId) ?? null;
  if (focus !== null && focused !== null) return <ActivityViewer run={focused} focus={focus} agentId={agentId} />;
  return <TimelineList tasks={props.tasks} agentId={agentId} />;
}

/**
 * The person's activity, as one list.
 *
 * It opens with the numbers a person wants before reading anything: how many agents,
 * how many still running, how many ran into a refusal or a failure. Then one card per
 * agent, newest first, each headed by the work it was made for and followed by its
 * tasks as one line each. Nothing on the list moves and nothing on it unfolds: a task's
 * picture and a task's account are each a screen of their own (`ActivityViewer`), so
 * ten agents are ten cards of lines rather than ten screens of pictures and logs.
 *
 * Nothing on the page is a sentence about what an event meant. The chips count the
 * publishers' own `outcome`, the lines print the publishers' own titles, and the words
 * the screen adds are names for kinds of things — a phase, a task, a part of the
 * platform (RULE-54).
 *
 * Refreshing is a button. The page asks once when it opens and once per press, and at
 * no other time: a timeline that streamed would need a live channel to the datastore,
 * and the browser is deliberately never given one (DEV-13). A page narrowed to one
 * agent stays narrowed when it refreshes — the subject still comes from the session,
 * and the narrowing is a filter over the person's own timeline, never a widening of it.
 *
 * The view switch hides nothing from the markup: every line is served, and 「問題が
 * あったものだけ」 is a stylesheet rule keyed on the page's `data-view` that hides the
 * lines with no refusal and no failure in them, so a person without script sees
 * everything and a person with it sees what they asked for. The search narrows the
 * cards the same way — by hiding, never by dropping.
 */
function TimelineList(props: { tasks: readonly TimelineTask[]; agentId: string | null }): Element {
  const [tasks, setTasks] = useState<readonly TimelineTask[]>(props.tasks);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [view, setView] = useState<TimelineView>('all');
  const [search, setSearch] = useState('');
  const agentId = props.agentId;

  const refresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { tasks: TimelineTask[] };
        setTasks(agentId === null ? body.tasks : body.tasks.filter((task) => task.agent_id === agentId));
        setUpdatedAt(new Date().toLocaleTimeString('ja-JP', { hour12: false }));
        setRefreshFailed(false);
      } catch {
        setRefreshFailed(true);
      } finally {
        setRefreshing(false);
      }
    })();
  }, [agentId]);

  const runs = groupRuns(tasks);
  const summaries = runs.map((run) => summariseRun(run.tasks));
  const running = summaries.reduce((sum, summary) => sum + summary.running, 0);
  const blocked = summaries.reduce((sum, summary) => sum + summary.blocked, 0);
  const failed = summaries.reduce((sum, summary) => sum + summary.failed, 0);
  const shown = runs.filter((run) => matchesSearch(run, search));

  return (
    <main className="timeline" data-page="timeline" data-view={view}>
      <header className="page-head">
        <div className="page-head-text">
          <h1>{TIMELINE_TITLE}</h1>
          <p className="lead">{TIMELINE_LEAD}</p>
        </div>
        <div className="page-tools">
          <button type="button" className="secondary" data-action="refresh" onClick={refresh} disabled={refreshing}>{REFRESH_LABEL}</button>
          <span className="updated-at" data-field="updated-at" role="status">
            {refreshFailed ? REFRESH_FAILED : updatedAt === null ? '' : `${updatedAt} に更新`}
          </span>
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
          <span className="chip chip-failed" data-summary="failed">{`失敗 ${failed} 件`}</span>
        </p>
        <div className="summary-tools">
          <label className="activity-search">
            <span>{SEARCH_LABEL}</span>
            <input
              type="search"
              data-filter="search"
              placeholder={SEARCH_PLACEHOLDER}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
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
              className={view === 'issues' ? 'is-selected' : ''}
              data-action="view-issues"
              aria-pressed={view === 'issues'}
              onClick={() => setView('issues')}
            >
              {VIEW_ISSUES}
            </button>
          </div>
        </div>
      </div>

      {runs.length === 0 ? <p className="timeline-empty" data-field="timeline-empty">{TIMELINE_EMPTY}</p> : null}
      {runs.length > 0 && shown.length === 0 ? <p className="timeline-empty" data-field="timeline-no-match">{TIMELINE_NO_MATCH}</p> : null}
      {runs.map((run) => (
        <div key={run.runId} data-run-shown={String(shown.includes(run))} {...(shown.includes(run) ? {} : { hidden: true })}>
          <RunCard run={run} offerFilter={agentId === null} narrowedTo={agentId} />
        </div>
      ))}
    </main>
  );
}
