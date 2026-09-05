import { REPLAY_STEP_MS, BLOCKED_STOP_RATIO } from './replay-config.js';

export interface ReplayHop {
  from: string;
  to: string;
  label: string;
  outcome: string;
  message: string;
}

export interface ReplayEvent {
  event_id: string;
  occurred_at: string;
  source: string;
  phase?: string;
  outcome: string;
  title?: string;
  message: string;
  detail?: Record<string, unknown>;
  record?: { hops?: readonly ReplayHop[] };
}

/**
 * Three shapes of step, and the picture each one draws.
 *
 * `move` is a dot travelling from one box to another. `self` is something that
 * happened inside one box — a decision, a registration — with no second endpoint, so
 * the box is lit rather than an arrow invented. `banner` is an event from something
 * with no box at all, written across the middle of the canvas.
 */
export type ReplayStepKind = 'move' | 'self' | 'banner';

export interface ReplayStep {
  index: number;
  eventId: string;
  kind: ReplayStepKind;
  from: string | null;
  to: string | null;
  /** The exchange's own name — the hop's label, or the event's title. */
  label: string;
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
 *
 * An event that carries hops becomes one step per hop. One tool call is four
 * exchanges — the Agent OP issues an identity, the Resource AS turns it into a token,
 * the resource answers — and drawing it as a single arrow said only that the agent
 * touched something. The hops are the publisher's own account of the path, so the
 * picture and the written log describe the same journey.
 *
 * An event with no hops and no declared target moves nothing. It used to be drawn as
 * an arrow back to wherever the story had last been, which invented a call from the
 * Authorization Platform to the Automation App every time a decision was recorded.
 * Now it lights the box it came from: the thing happened there, and nowhere else.
 */
export function buildReplayPlan(
  events: readonly ReplayEvent[],
  nodeIdFor: (source: string) => string | null,
): ReplayStep[] {
  const ordered = [...events].sort((left, right) =>
    left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id));

  const steps: ReplayStep[] = [];

  for (const event of ordered) {
    const phase = event.phase ?? '';
    const hops = event.record?.hops ?? [];
    if (hops.length > 0) {
      for (const hop of hops) {
        const from = nodeIdFor(hop.from);
        const to = nodeIdFor(hop.to);
        const blocked = hop.outcome === 'blocked' && to !== null;
        steps.push(step({
          index: steps.length,
          eventId: event.event_id,
          kind: from !== null && to !== null ? 'move' : (from !== null || to !== null ? 'self' : 'banner'),
          from,
          to,
          label: hop.label,
          message: hop.message,
          outcome: hop.outcome,
          phase,
          blocked,
        }));
      }
      continue;
    }

    const from = nodeIdFor(event.source);
    const target = event.detail?.target;
    const declared = typeof target === 'string';
    const to = declared ? nodeIdFor(target) : null;
    // "Blocked" is the picture of an arrow that did not arrive, so it needs somewhere
    // it was going. A step that only reports an outcome — a task's terminal event, say —
    // is drawn as a lit box even when that outcome was a refusal; the refusal is already
    // shown by the step that actually tried.
    const blocked = event.outcome === 'blocked' && declared && to !== null;
    steps.push(step({
      index: steps.length,
      eventId: event.event_id,
      kind: from === null && to === null ? 'banner' : (from !== null && to !== null ? 'move' : 'self'),
      from,
      to,
      label: event.title ?? '',
      message: event.message,
      outcome: event.outcome,
      phase,
      blocked,
    }));
  }

  return steps;
}

function step(input: Omit<ReplayStep, 'stopRatio' | 'delayMs'>): ReplayStep {
  return { ...input, stopRatio: input.blocked ? BLOCKED_STOP_RATIO : 1, delayMs: REPLAY_STEP_MS };
}

export function isFinished(plan: readonly ReplayStep[], playedIndex: number): boolean {
  return playedIndex >= plan.length - 1;
}
