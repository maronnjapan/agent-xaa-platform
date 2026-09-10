import { roleOf, type ActorRole } from '../roles.js';

export interface ReplayNode {
  id: string;
  label: string;
  /** What this box is for, in one phrase. Part of the picture, not of any event. */
  role: string;
  x: number;
  y: number;
  /** The rest of what this box is, for the panel a person opens beside the picture. */
  actor: ActorRole;
}

/** Where each box sits. The only thing about a box that is not in `roles.ts`. */
const COORDINATES: ReadonlyArray<readonly [string, number, number]> = [
  ['human-user', 80, 60],
  ['automation-app', 260, 60],
  ['authorization-platform', 440, 60],
  ['agent-provisioner', 620, 60],
  ['agent-op', 80, 220],
  ['agent-runtime', 260, 220],
  ['resource-as', 440, 220],
  ['resource-api', 620, 220],
];

/**
 * The replay diagram, drawn once and never computed.
 *
 * Eight boxes in two rows of four, at coordinates written down here as numbers. A
 * layout engine would place them differently as the event set changes, and a person
 * watching two replays of the same system needs the picture to be in the same place
 * both times — that is what makes "the arrow stopped before the Finance API" a thing
 * they can recognise (DEC-APP-06).
 *
 * The name and the phrase inside each box are not written here: they come from
 * `roles.ts`, which is also where the written log gets the name it prints and where
 * the panel beside the picture gets the longer description. One dictionary, so the
 * picture, the log and the panel cannot end up calling the same part three things.
 *
 * Nothing here imports a graph library; there is nothing to lay out.
 */
export const REPLAY_NODES: readonly ReplayNode[] = COORDINATES.map(([id, x, y]) => {
  const actor = roleOf(id);
  // A coordinate for a part the dictionary does not have is a typo, and one that would
  // otherwise show as an unlabelled box on every replay.
  if (!actor) throw new Error(`no role for replay node: ${id}`);
  return { id, label: actor.label, role: actor.role, x, y, actor };
});

/**
 * The frame the boxes sit in.
 *
 * Written as numbers rather than as one string because the browser measures against
 * them too: a label is kept away from the left and right edges, and the lane an arrow
 * detours through is found from the gap between the rows. One set of numbers, so the
 * picture and the things placed on it cannot disagree about how big it is.
 */
export const REPLAY_WIDTH = 720;
export const REPLAY_HEIGHT = 300;
export const REPLAY_VIEWBOX = `0 0 ${REPLAY_WIDTH} ${REPLAY_HEIGHT}`;

/**
 * Half a box, in the diagram's own units.
 *
 * Exported because the geometry needs them too: an arrow has to end on the edge of the
 * destination rather than at its centre, or a step that stopped short would still be
 * drawn on top of the box it never reached. One pair of numbers, so the picture and
 * the geometry cannot disagree.
 *
 * The height is what it is because each box carries two lines. The coordinates are
 * unchanged, so the rows still sit clear of each other and of the banner between them.
 */
export const NODE_HALF_WIDTH = 70;
export const NODE_HALF_HEIGHT = 30;

/**
 * `lifecycle-manager` and `security-detection` are deliberately absent.
 *
 * They act on an agent rather than talking to one, so drawing an arrow from them
 * would invent a call that never happened. Their events still appear — as a line of
 * text across the middle of the canvas, and as a named part in the panel beside it —
 * but they move nothing.
 */
export const SOURCE_TO_NODE: Readonly<Record<string, string>> = {
  'human-user': 'human-user',
  'automation-app': 'automation-app',
  'authorization-platform': 'authorization-platform',
  authorization: 'authorization-platform',
  'agent-provisioner': 'agent-provisioner',
  provisioner: 'agent-provisioner',
  'agent-op': 'agent-op',
  'agent-runtime': 'agent-runtime',
  'resource-as': 'resource-as',
  'resource-api': 'resource-api',
};

export function nodeIdFor(source: string): string | null {
  return SOURCE_TO_NODE[source] ?? null;
}

/** Where a box's centre is, by id. */
export function nodeAt(id: string): ReplayNode | null {
  return REPLAY_NODES.find((node) => node.id === id) ?? null;
}

interface NodeSourceEvent {
  source: string;
  detail?: Record<string, unknown>;
  record?: { hops?: ReadonlyArray<{ from: string; to: string }> };
}

/**
 * The nodes this particular task actually involved; the rest are hidden, not removed.
 *
 * The hops are read as well as the event's own source and target, because one tool
 * call now draws the four exchanges it really made. Leaving them out would hide the
 * Agent OP and the Resource AS on exactly the replays that pass through them — which
 * is every replay of a tool call that worked.
 */
export function visibleNodeIds(events: readonly NodeSourceEvent[]): Set<string> {
  const visible = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const id = SOURCE_TO_NODE[value];
    if (id) visible.add(id);
  };
  for (const event of events) {
    add(event.source);
    add(event.detail?.target);
    for (const hop of event.record?.hops ?? []) {
      add(hop.from);
      add(hop.to);
    }
  }
  return visible;
}
