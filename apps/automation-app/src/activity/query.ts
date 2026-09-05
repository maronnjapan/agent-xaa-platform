import { classifyTaskId, isTerminalEvent, type ActivityEvent } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { ACTIVITY_COLLECTION } from './subscriber.js';

export interface RunningTask {
  task_id: string;
  agent_id: string | null;
  purpose: string;
  status: 'running';
}

export interface CompletedTask {
  task_id: string;
  agent_id: string | null;
  purpose: string;
  status: 'completed';
  terminal_outcome: string;
  completed_at: string;
  events: ActivityEvent[];
}

export type TimelineTask = RunningTask | CompletedTask;

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

function orderEvents(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((left, right) => {
    const byTime = left.occurred_at.localeCompare(right.occurred_at);
    // A deterministic tie-break: two events with the same timestamp must replay in the
    // same order every time, or the animation would differ between viewings.
    return byTime !== 0 ? byTime : left.event_id.localeCompare(right.event_id);
  });
}

/**
 * Groups a person's events into tasks, and hands back the contents of the finished
 * ones only.
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
  const all = rows.map((row) => asEvent(row.data)).filter((event) => event.human_subject === input.humanSubject);

  const byTask = new Map<string, ActivityEvent[]>();
  for (const event of all) {
    if (input.taskId !== undefined && event.task_id !== input.taskId) continue;
    if (classifyTaskId(event.task_id) === null) continue;
    byTask.set(event.task_id, [...(byTask.get(event.task_id) ?? []), event]);
  }

  const tasks: TimelineTask[] = [];
  for (const [taskId, events] of byTask) {
    const ordered = orderEvents(events);
    const terminal = ordered.find((event) => isTerminalEvent(taskId, eventType(event)));
    const agentId = ordered.find((event) => event.agent_id !== null)?.agent_id ?? null;
    const purpose = purposeOf(ordered);
    if (!terminal) {
      tasks.push({ task_id: taskId, agent_id: agentId, purpose, status: 'running' });
      continue;
    }
    tasks.push({
      task_id: taskId, agent_id: agentId, purpose, status: 'completed',
      terminal_outcome: terminal.outcome, completed_at: terminal.occurred_at, events: ordered,
    });
  }
  return sortForDisplay(tasks);
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

function purposeOf(events: readonly ActivityEvent[]): string {
  for (const event of events) {
    const purpose = (event.detail as { purpose?: unknown } | undefined)?.purpose;
    if (typeof purpose === 'string' && purpose !== '') return purpose;
  }
  return events[0]?.title ?? '';
}

/**
 * `provisioning` first, `lifecycle` last, and the numbered tasks in between ordered by
 * when they finished — not by their number. An agent's second task can finish before
 * its first, and the timeline shows what happened, not what was planned.
 */
export function sortForDisplay(tasks: readonly TimelineTask[]): TimelineTask[] {
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
