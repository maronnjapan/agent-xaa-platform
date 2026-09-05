export interface ReplayNode {
  id: string;
  label: string;
  /** What this box is for, in one phrase. Part of the picture, not of any event. */
  role: string;
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
 * `role` is the second line inside each box. It describes the platform's own parts and
 * is the same on every replay, which is what keeps it a caption rather than an opinion
 * about an event: a person who has never read docs 05 cannot otherwise tell why an
 * arrow going to "Agent OP" matters, and a diagram nobody can read is not a diagram.
 *
 * Nothing here imports a graph library; there is nothing to lay out.
 */
export const REPLAY_NODES: readonly ReplayNode[] = [
  { id: 'human-user', label: '利用者', role: '指示する人', x: 80, y: 60 },
  { id: 'automation-app', label: 'Automation App', role: '画面と記録', x: 260, y: 60 },
  { id: 'authorization-platform', label: 'Authorization Platform', role: '権限を決める', x: 440, y: 60 },
  { id: 'agent-provisioner', label: 'Agent Provisioner', role: 'Agent を作る', x: 620, y: 60 },
  { id: 'agent-op', label: 'Agent OP', role: '身元を発行する', x: 80, y: 220 },
  { id: 'agent-runtime', label: 'Agent Runtime', role: 'Agent が動く場所', x: 260, y: 220 },
  { id: 'resource-as', label: 'Resource AS', role: 'Access Token を出す', x: 440, y: 220 },
  { id: 'resource-api', label: 'Resource API', role: 'データを持つ', x: 620, y: 220 },
];

export const REPLAY_VIEWBOX = '0 0 720 300';

/**
 * Half a box, in the diagram's own units.
 *
 * Exported because the browser needs them too: an arrow has to end on the edge of the
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
