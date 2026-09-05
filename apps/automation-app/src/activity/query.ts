import { classifyTaskId, isTerminalEvent, type ActivityEvent } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { ACTIVITY_COLLECTION } from './subscriber.js';

/**
 * The fields every row of the list carries.
 *
 * `run_id` is the agent the task belongs to once one exists, and a stand-in for the
 * agent it is on its way to becoming before then — see `runKeyOf`. Two agents each
 * have a `task-1`, so the pair (`run_id`, `task_id`) is what names a task uniquely, and
 * the page keys its canvases and logs by that pair rather than by `task_id` alone.
 */
interface TaskBase {
  run_id: string;
  task_id: string;
  agent_id: string | null;
  purpose: string;
}

export interface RunningTask extends TaskBase {
  status: 'running';
}

export interface CompletedTask extends TaskBase {
  status: 'completed';
  terminal_outcome: string;
  completed_at: string;
  events: ActivityEvent[];
}

export type TimelineTask = RunningTask | CompletedTask;

/** The one string the page and the browser both build to find a task's canvas. */
export function taskKeyOf(task: Pick<TimelineTask, 'run_id' | 'task_id'>): string {
  return `${task.run_id}:${task.task_id}`;
}

/**
 * The name the terminal table is written in, which two producers spell in two places.
 *
 * Most publishers put it in `detail.event_type`. The Agent Provisioner does not: its
 * `event_type` is its own step vocabulary — `provisioning.started`, `agent.active` —
 * and it names what the screen should file the event under in `detail.activity_kind`.
 * Reading only `event_type` meant `AGENT_PROVISIONED` never matched, so the
 * `provisioning` task of every real agent stayed "実行中" forever and its events were
 * never returned. Every test that exercised the finished path seeded the id by hand.
 *
 * `activity_kind` is consulted first because a publisher that sets it is stating the
 * grouping outright, rather than leaving it to be inferred from a step name.
 */
function eventType(event: ActivityEvent): string {
  const detail = event.detail as { event_type?: unknown; activity_kind?: unknown } | undefined;
  if (typeof detail?.activity_kind === 'string' && detail.activity_kind !== '') return detail.activity_kind;
  return String(detail?.event_type ?? '');
}

function detailString(event: ActivityEvent, key: string): string | null {
  const value = (event.detail as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function orderEvents(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((left, right) => {
    const byTime = left.occurred_at.localeCompare(right.occurred_at);
    // A deterministic tie-break: two events with the same timestamp must replay in the
    // same order every time, or the animation would differ between viewings.
    return byTime !== 0 ? byTime : left.event_id.localeCompare(right.event_id);
  });
}

/**
 * Which agent's story an event belongs to — including the events that happened
 * before the agent existed.
 *
 * Every task id is one of four shapes (docs 11 §3.3), and every agent has a
 * `provisioning`, a `task-1` and a `lifecycle`. Grouping by `task_id` alone therefore
 * put a person's second login inside their first agent's provisioning, played the
 * second agent's `task-1` as a continuation of the first's, and ended the shared
 * `provisioning` task at whichever `AGENT_PROVISIONED` came first — after which every
 * later login, proposal and decision was shown as having happened after that agent
 * was already running. That was the "時系列がバグっている" a person saw.
 *
 * The events that precede an agent carry the ids that lead to it: a proposal names its
 * `work_definition_id`, the decision the Automation App received names both that and
 * the `decision_id`, and the Provisioner's first event names the `decision_id` beside
 * the `agent_id` it minted. Following that chain is what joins a login-to-agent story
 * into one run. Until the chain reaches an agent the run is keyed by the furthest id it
 * has, so work that is still being decided or provisioned shows as a run of its own
 * rather than nowhere.
 *
 * A login carries no id at all; `attachLogins` gives it to the run that began next.
 */
function buildLinks(events: readonly ActivityEvent[]): {
  decisionToAgent: Map<string, string>;
  workToDecision: Map<string, string>;
} {
  const decisionToAgent = new Map<string, string>();
  const workToDecision = new Map<string, string>();
  for (const event of events) {
    const decision = detailString(event, 'decision_id');
    const work = detailString(event, 'work_definition_id');
    if (decision && event.agent_id !== null) decisionToAgent.set(decision, event.agent_id);
    if (decision && work) workToDecision.set(work, decision);
  }
  return { decisionToAgent, workToDecision };
}

function runKeyOf(event: ActivityEvent, links: ReturnType<typeof buildLinks>): string | null {
  if (event.agent_id !== null) return event.agent_id;
  if (classifyTaskId(event.task_id) === 'demo') return `demo:${event.task_id}`;
  const work = detailString(event, 'work_definition_id');
  const decision = detailString(event, 'decision_id') ?? (work ? links.workToDecision.get(work) : undefined);
  if (decision) return links.decisionToAgent.get(decision) ?? `decision:${decision}`;
  if (work) return `work:${work}`;
  if (eventType(event) === 'LOGGED_IN') return null;
  return 'unlinked';
}

interface Run {
  key: string;
  agentId: string | null;
  events: ActivityEvent[];
}

/**
 * A login belongs to the run that started next.
 *
 * The person logged in and then wrote the work, so the login is the first line of that
 * agent's story. A login followed by no work at all belongs to nobody's story and is
 * left out rather than shown as a run that never went anywhere.
 */
function attachLogins(runs: Map<string, Run>, logins: readonly ActivityEvent[]): void {
  const ordered = [...runs.values()]
    .map((run) => ({ run, firstAt: orderEvents(run.events)[0]?.occurred_at ?? '' }))
    .sort((left, right) => left.firstAt.localeCompare(right.firstAt));
  const pending = orderEvents([...logins]);
  for (const { run, firstAt } of ordered) {
    while (pending.length > 0 && pending[0]!.occurred_at.localeCompare(firstAt) <= 0) {
      run.events.push(pending.shift()!);
    }
  }
}

function groupIntoRuns(events: readonly ActivityEvent[]): Run[] {
  const links = buildLinks(events);
  const runs = new Map<string, Run>();
  const logins: ActivityEvent[] = [];
  for (const event of events) {
    const key = runKeyOf(event, links);
    if (key === null) { logins.push(event); continue; }
    const run = runs.get(key) ?? { key, agentId: null, events: [] };
    if (event.agent_id !== null) run.agentId = event.agent_id;
    run.events.push(event);
    runs.set(key, run);
  }
  attachLogins(runs, logins);
  return [...runs.values()];
}

/**
 * Groups a person's events into agents, then into tasks, and hands back the contents
 * of the finished tasks only.
 *
 * RULE-59: a task is replayable when its terminal event has arrived. Until then the
 * row exists — the person can see something is running — but carries no `events` key
 * at all, because a partial replay of a task still in flight would show a story that
 * has not happened yet. The absence of the key, rather than an empty array, is what
 * makes that unambiguous to the renderer.
 *
 * The path is built from the caller's own subject. There is no parameter for whose
 * timeline to read (RULE-56).
 */
export async function readTimeline(input: {
  documents: DocumentStore;
  humanSubject: string;
  taskId?: string;
}): Promise<TimelineTask[]> {
  const rows = await input.documents.queryEqual<ActivityEvent>(ACTIVITY_COLLECTION, [['human_subject', input.humanSubject]]);
  // Filtered again on the way out. The query already scopes by subject; re-checking
  // costs nothing and means a future change to the query cannot widen the result.
  const all = rows
    .map((row) => asEvent(row.data))
    .filter((event) => event.human_subject === input.humanSubject)
    .filter((event) => classifyTaskId(event.task_id) !== null);

  const runs = groupIntoRuns(all);
  const purposes = new Map(runs.map((run) => [run.key, purposeOf(run.events)]));
  const tasks: TimelineTask[] = [];
  for (const run of sortRuns(runs)) {
    const purpose = purposes.get(run.key) || inheritedPurpose(run, runs, purposes) || (orderEvents(run.events)[0]?.title ?? '');
    const byTask = new Map<string, ActivityEvent[]>();
    for (const event of run.events) byTask.set(event.task_id, [...(byTask.get(event.task_id) ?? []), event]);

    const own: TimelineTask[] = [];
    for (const [taskId, events] of byTask) {
      if (input.taskId !== undefined && taskId !== input.taskId) continue;
      const ordered = orderEvents(events);
      const terminal = ordered.find((event) => isTerminalEvent(taskId, eventType(event)));
      const base = { run_id: run.key, task_id: taskId, agent_id: run.agentId, purpose };
      if (!terminal) {
        own.push({ ...base, status: 'running' });
        continue;
      }
      own.push({
        ...base, status: 'completed',
        terminal_outcome: terminal.outcome, completed_at: terminal.occurred_at, events: ordered,
      });
    }
    tasks.push(...sortWithinRun(own));
  }
  return tasks;
}

/**
 * The stored row as the event it was, without what the store added to it.
 *
 * `storeActivityEvent` writes `{ ...event, expire_at }`, and the response schema
 * declares `events` as a bare array — so the retention timestamp travelled all the way
 * to the browser, and so would anything else the store gains later. Rebuilding the
 * event by name rather than deleting the key means a new storage field is invisible
 * here until someone adds it deliberately, which is the same rule the agent status
 * endpoint follows (RULE-38).
 */
function asEvent(row: ActivityEvent): ActivityEvent {
  return {
    event_id: row.event_id,
    trace_id: row.trace_id,
    human_subject: row.human_subject,
    agent_id: row.agent_id,
    task_id: row.task_id,
    occurred_at: row.occurred_at,
    source: row.source,
    phase: row.phase,
    outcome: row.outcome,
    title: row.title,
    message: row.message,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.record ? { record: row.record } : {}),
    related_finding_id: row.related_finding_id,
    is_simulated: row.is_simulated,
  };
}

/** The work an agent was made for, from the first event of its story that names it. */
function purposeOf(events: readonly ActivityEvent[]): string {
  for (const event of orderEvents([...events])) {
    const purpose = detailString(event, 'purpose');
    if (purpose) return purpose;
  }
  return '';
}

/**
 * A replacement agent (RULE-29) starts with a Provisioner event and no proposal of its
 * own; its purpose is the one of the agent it took over from.
 */
function inheritedPurpose(run: Run, runs: readonly Run[], purposes: Map<string, string>): string {
  for (const event of run.events) {
    const previous = detailString(event, 'replaces_agent_id');
    if (!previous) continue;
    const inherited = purposes.get(previous) || runs.find((candidate) => candidate.key === previous)?.events[0]?.title;
    if (inherited) return inherited;
  }
  return '';
}

/**
 * Newest agent first. Within an agent the order is chronological (`sortWithinRun`);
 * between agents the one a person most recently started is the one they came to look
 * at, so it is at the top.
 */
function sortRuns(runs: readonly Run[]): Run[] {
  const firstAt = (run: Run): string => orderEvents(run.events)[0]?.occurred_at ?? '';
  return [...runs].sort((left, right) => firstAt(right).localeCompare(firstAt(left)) || left.key.localeCompare(right.key));
}

/**
 * `provisioning` first, `lifecycle` last, and the numbered tasks in between ordered by
 * when they finished — not by their number. An agent's second task can finish before
 * its first, and the timeline shows what happened, not what was planned.
 */
export function sortWithinRun(tasks: readonly TimelineTask[]): TimelineTask[] {
  const rank = (task: TimelineTask): number => {
    const kind = classifyTaskId(task.task_id);
    if (kind === 'provisioning') return 0;
    if (kind === 'lifecycle') return 2;
    return 1;
  };
  return [...tasks].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    const leftAt = left.status === 'completed' ? left.completed_at : '￿';
    const rightAt = right.status === 'completed' ? right.completed_at : '￿';
    return leftAt.localeCompare(rightAt) || left.task_id.localeCompare(right.task_id);
  });
}
