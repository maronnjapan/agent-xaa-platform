import { buildReplayPlan, isFinished, type ReplayEvent } from './replay-plan.js';
import { REPLAY_STEP_MS } from './replay-config.js';

const SOURCE_TO_NODE: Readonly<Record<string, string>> = {
  'human-user': 'human-user', 'automation-app': 'automation-app',
  'authorization-platform': 'authorization-platform', authorization: 'authorization-platform',
  'agent-provisioner': 'agent-provisioner', provisioner: 'agent-provisioner',
  'agent-op': 'agent-op', 'agent-runtime': 'agent-runtime',
  'resource-as': 'resource-as', 'resource-api': 'resource-api',
};

/**
 * Plays a finished task's events across the fixed diagram.
 *
 * The DOM work is all that lives here; the sequencing and the stop position come from
 * `replay-plan.ts`, which has no DOM in it and can therefore be tested directly.
 *
 * Messages accumulate rather than replace: a person who looks away for one step should
 * still be able to read what they missed. When the last step lands, the root is marked
 * `finished` and the timer is cleared — nothing loops, because a replay that restarted
 * on its own would make a viewer doubt what they just saw.
 */
export function playReplay(root: HTMLElement, events: readonly ReplayEvent[]): () => void {
  const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
  const messages = root.querySelector('[data-messages]');
  const banner = root.querySelector('[data-banner]');
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const step = (): void => {
    const current = plan[index];
    if (!current) return;
    if (current.from === null && current.to === null) {
      // An event with no node of its own: it says something happened to the agent
      // rather than between two services, so it gets the banner and no arrow.
      if (banner) banner.textContent = current.message;
    } else {
      drawArrow(root, current.from, current.to, current.blocked, current.index);
    }
    if (messages) {
      const line = root.ownerDocument.createElement('li');
      line.setAttribute('data-step-index', String(current.index));
      line.textContent = current.message;
      messages.appendChild(line);
    }
    if (isFinished(plan, index)) {
      root.setAttribute('data-replay-state', 'finished');
      return;
    }
    index += 1;
    timer = setTimeout(step, REPLAY_STEP_MS);
  };

  root.setAttribute('data-replay-state', 'playing');
  step();
  return () => { if (timer !== undefined) clearTimeout(timer); };
}

function drawArrow(root: HTMLElement, from: string | null, to: string | null, blocked: boolean, index: number): void {
  const arrows = root.querySelector('[data-arrows]');
  if (!arrows || !from) return;
  const dot = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('class', blocked ? 'replay-dot is-blocked' : 'replay-dot');
  dot.setAttribute('data-step-index', String(index));
  dot.setAttribute('data-from', from);
  if (to) dot.setAttribute('data-to', to);
  if (blocked) dot.setAttribute('data-blocked', 'true');
  dot.setAttribute('r', '6');
  arrows.appendChild(dot);

  const target = to ? root.querySelector(`[data-node="${to}"]`) : null;
  // A blocked step never arrives, so the destination stays explicitly unreached.
  if (target) target.setAttribute('data-reached', blocked ? 'false' : 'true');
}
