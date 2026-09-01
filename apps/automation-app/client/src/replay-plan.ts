import { REPLAY_STEP_MS, BLOCKED_STOP_RATIO } from './replay-config.js';

export interface ReplayEvent {
  event_id: string;
  occurred_at: string;
  source: string;
  phase?: string;
  outcome: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ReplayStep {
  index: number;
  eventId: string;
  from: string | null;
  to: string | null;
  message: string;
  outcome: string;
  phase: string;
  blocked: boolean;
  stopRatio: number;
  delayMs: number;
}

/**
 * Turns a task's events into the steps the canvas will play.
 *
 * Two decisions live here rather than in the DOM code, so they can be tested without a
 * browser. First, the order: `occurred_at` ascending with `event_id` as a tie-break, so
 * the same task always replays identically. Second, the pacing: every step waits
 * exactly REPLAY_STEP_MS. Using the real gaps would make a replay of a three-minute
 * provisioning run take three minutes, and a person watching a demo needs to see the
 * sequence, not sit through it (REQ-11-025).
 *
 * A blocked step stops short of its destination and stays there — the picture of a
 * refusal is the arrow that never arrives (RULE-54).
 */
export function buildReplayPlan(
  events: readonly ReplayEvent[],
  nodeIdFor: (source: string) => string | null,
): ReplayStep[] {
  const ordered = [...events].sort((left, right) =>
    left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id));

  let previous: string | null = null;
  return ordered.map((event, index) => {
    const from = nodeIdFor(event.source);
    const target = event.detail?.target;
    // With no declared target the movement returns to where the story was: an event
    // that only reports something has no second endpoint to invent.
    const declared = typeof target === 'string';
    const to = declared ? nodeIdFor(target) : previous;
    // "Blocked" is the picture of an arrow that did not arrive, so it needs somewhere
    // it was going. A step that only reports an outcome — a task's terminal event, say —
    // is drawn as an ordinary return even when that outcome was a refusal; the refusal
    // is already shown by the step that actually tried.
    const blocked = event.outcome === 'blocked' && declared;
    if (from) previous = from;
    return {
      index,
      eventId: event.event_id,
      from,
      to,
      message: event.message,
      outcome: event.outcome,
      phase: event.phase ?? '',
      blocked,
      stopRatio: blocked ? BLOCKED_STOP_RATIO : 1,
      delayMs: REPLAY_STEP_MS,
    };
  });
}

export function isFinished(plan: readonly ReplayStep[], playedIndex: number): boolean {
  return playedIndex >= plan.length - 1;
}
