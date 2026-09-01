export interface ReplayNode {
  id: string;
  label: string;
  x: number;
  y: number;
}

/**
 * The replay diagram, drawn once and never computed.
 *
 * Eight boxes in two rows of four, at coordinates written down here as numbers. A
 * layout engine would place them differently as the event set changes, and a person
 * watching two replays of the same system needs the picture to be in the same place
 * both times — that is what makes "the arrow stopped before the Finance API" a thing
 * they can recognise (DEC-APP-06).
 *
 * Nothing here imports a graph library; there is nothing to lay out.
 */
export const REPLAY_NODES: readonly ReplayNode[] = [
  { id: 'human-user', label: '利用者', x: 80, y: 60 },
  { id: 'automation-app', label: 'Automation App', x: 260, y: 60 },
  { id: 'authorization-platform', label: 'Authorization Platform', x: 440, y: 60 },
  { id: 'agent-provisioner', label: 'Agent Provisioner', x: 620, y: 60 },
  { id: 'agent-op', label: 'Agent OP', x: 80, y: 220 },
  { id: 'agent-runtime', label: 'Agent Runtime', x: 260, y: 220 },
  { id: 'resource-as', label: 'Resource AS', x: 440, y: 220 },
  { id: 'resource-api', label: 'Resource API', x: 620, y: 220 },
];

export const REPLAY_VIEWBOX = '0 0 720 300';

/**
 * Half a box, in the diagram's own units.
 *
 * Exported because the browser needs them too: an arrow has to end on the edge of the
 * destination rather than at its centre, or a step that stopped short would still be
 * drawn on top of the box it never reached. One pair of numbers, so the picture and
 * the geometry cannot disagree.
 */
export const NODE_HALF_WIDTH = 70;
export const NODE_HALF_HEIGHT = 22;

/**
 * `lifecycle-manager` and `security-detection` are deliberately absent.
 *
 * They act on an agent rather than talking to one, so drawing an arrow from them
 * would invent a call that never happened. Their events still appear — as a line of
 * text across the middle of the canvas — but they move nothing.
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

/** The nodes this particular task actually involved; the rest are hidden, not removed. */
export function visibleNodeIds(events: ReadonlyArray<{ source: string; detail?: Record<string, unknown> }>): Set<string> {
  const visible = new Set<string>();
  for (const event of events) {
    const source = nodeIdFor(event.source);
    if (source) visible.add(source);
    const target = event.detail?.target;
    if (typeof target === 'string' && SOURCE_TO_NODE[target]) visible.add(SOURCE_TO_NODE[target]!);
  }
  return visible;
}
