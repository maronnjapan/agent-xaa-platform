import { LEVEL_BOUNDARIES, REVIEW_CONFIDENCE_FLOOR } from '@xaa/contracts/security-monitoring';
import type { DecisionTrace, EndTone, GateAnswer } from '../analysis/trace.js';
import type { Element } from '../element.js';

/**
 * How the platform decides what to do about a finding, drawn once.
 *
 * Security Detection's pipeline is a fixed sequence of stages and a fixed set of
 * questions after them, and the questions have thresholds that are numbers in
 * `@xaa/contracts` — the same numbers the detector decides with. This is that logic as
 * a picture: the stages along the top, the questions as diamonds, and the four places a
 * finding can end up. The picture is the same on every visit; what changes is which
 * path is lit, when a person asks to see one finding's route on it.
 *
 * The boxes sit at written-down coordinates, like the replay's, so the diagram is the
 * same shape whichever finding is traced on it and a reader learns it once.
 */

type NodeKind = 'stage' | 'gate' | 'box' | 'end';

interface FlowNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tone?: EndTone;
}

interface FlowEdge {
  from: string;
  to: string;
  answer?: 'yes' | 'no';
  d: string;
  label?: { x: number; y: number; text: string };
}

export const FLOW_VIEWBOX = '0 0 1080 340';

const STAGE_Y = 34;
const GATE_Y = 150;
const END_Y = 282;
const GATE_HW = 56;
const GATE_HH = 30;

const CONFIDENCE_PERCENT = Math.round(REVIEW_CONFIDENCE_FLOOR * 100);

export const FLOW_NODES: readonly FlowNode[] = [
  { id: 'collect', kind: 'stage', label: 'ログ受信', x: 70, y: STAGE_Y, w: 104, h: 30 },
  { id: 'normalize', kind: 'stage', label: '正規化', x: 190, y: STAGE_Y, w: 104, h: 30 },
  { id: 'validate', kind: 'stage', label: '違反確認', x: 310, y: STAGE_Y, w: 104, h: 30 },
  { id: 'rules', kind: 'stage', label: 'ルール検知', x: 430, y: STAGE_Y, w: 104, h: 30 },
  { id: 'correlate', kind: 'stage', label: '相関分析', x: 550, y: STAGE_Y, w: 104, h: 30 },
  { id: 'score', kind: 'stage', label: 'スコア判定', x: 670, y: STAGE_Y, w: 104, h: 30 },
  { id: 'threshold', kind: 'gate', label: 'スコアが', sub: `${LEVEL_BOUNDARIES.medium} 以上`, x: 80, y: GATE_Y, w: GATE_HW * 2, h: GATE_HH * 2 },
  { id: 'baseline', kind: 'gate', label: '比較基準', sub: 'がある', x: 212, y: GATE_Y, w: GATE_HW * 2, h: GATE_HH * 2 },
  { id: 'ai_configured', kind: 'gate', label: 'AI 接続', sub: 'がある', x: 344, y: GATE_Y, w: GATE_HW * 2, h: GATE_HH * 2 },
  { id: 'analyze', kind: 'box', label: 'AI 分析', x: 476, y: GATE_Y, w: 104, h: 34 },
  { id: 'answered', kind: 'gate', label: 'AI が', sub: '回答した', x: 608, y: GATE_Y, w: GATE_HW * 2, h: GATE_HH * 2 },
  { id: 'confidence', kind: 'gate', label: '確信度が', sub: `${CONFIDENCE_PERCENT}% 以上`, x: 740, y: GATE_Y, w: GATE_HW * 2, h: GATE_HH * 2 },
  { id: 'disruptive', kind: 'gate', label: '推奨が', sub: '停止を伴う', x: 872, y: GATE_Y, w: GATE_HW * 2, h: GATE_HH * 2 },
  { id: 'keep', kind: 'gate', label: '推奨が', sub: 'ACTIVE', x: 1004, y: GATE_Y, w: GATE_HW * 2, h: GATE_HH * 2 },
  { id: 'skip', kind: 'end', tone: 'skip', label: 'AI 分析を省略', sub: 'スコアが閾値未満 / 比較基準なし / AI 接続なし', x: 212, y: END_Y, w: 304, h: 36 },
  { id: 'review', kind: 'end', tone: 'review', label: '人の確認待ち', sub: '人が承認するまで状態は変えない', x: 740, y: END_Y, w: 320, h: 36 },
  { id: 'continue', kind: 'end', tone: 'continue', label: 'そのまま続行', x: 1004, y: 62, w: 130, h: 36 },
  { id: 'respond', kind: 'end', tone: 'respond', label: '状態変更を依頼', sub: 'Lifecycle Manager へ', x: 1004, y: END_Y, w: 130, h: 36 },
];

const at = (id: string): FlowNode => {
  const node = FLOW_NODES.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`no flow node: ${id}`);
  return node;
};
const right = (id: string): string => { const n = at(id); return `M ${n.x + n.w / 2} ${n.y} H ${at(nextOf(id)).x - at(nextOf(id)).w / 2}`; };
const nextOf = (id: string): string => FLOW_NODES[FLOW_NODES.findIndex((node) => node.id === id) + 1]!.id;
const down = (from: string, to: string): string => { const a = at(from); const b = at(to); return `M ${a.x} ${a.y + a.h / 2} V ${b.y - b.h / 2}`; };
const up = (from: string, to: string): string => { const a = at(from); const b = at(to); return `M ${a.x} ${a.y - a.h / 2} V ${b.y + b.h / 2}`; };
const across = (from: string, to: string): string => { const a = at(from); const b = at(to); return `M ${a.x + a.w / 2} ${a.y} H ${b.x - b.w / 2}`; };

const YES = 'はい';
const NO = 'いいえ';

export const FLOW_EDGES: readonly FlowEdge[] = [
  { from: 'collect', to: 'normalize', d: right('collect') },
  { from: 'normalize', to: 'validate', d: right('normalize') },
  { from: 'validate', to: 'rules', d: right('validate') },
  { from: 'rules', to: 'correlate', d: right('rules') },
  { from: 'correlate', to: 'score', d: right('correlate') },
  { from: 'score', to: 'threshold', d: `M ${at('score').x} ${STAGE_Y + 15} V 92 H 80 V ${GATE_Y - GATE_HH}` },
  { from: 'threshold', to: 'baseline', answer: 'yes', d: across('threshold', 'baseline'), label: { x: 146, y: 139, text: YES } },
  { from: 'threshold', to: 'skip', answer: 'no', d: down('threshold', 'skip'), label: { x: 88, y: 226, text: NO } },
  { from: 'baseline', to: 'ai_configured', answer: 'yes', d: across('baseline', 'ai_configured'), label: { x: 278, y: 139, text: YES } },
  { from: 'baseline', to: 'skip', answer: 'no', d: down('baseline', 'skip'), label: { x: 220, y: 226, text: NO } },
  { from: 'ai_configured', to: 'analyze', answer: 'yes', d: across('ai_configured', 'analyze'), label: { x: 412, y: 139, text: YES } },
  { from: 'ai_configured', to: 'skip', answer: 'no', d: down('ai_configured', 'skip'), label: { x: 352, y: 226, text: NO } },
  { from: 'analyze', to: 'answered', d: across('analyze', 'answered') },
  { from: 'answered', to: 'confidence', answer: 'yes', d: across('answered', 'confidence'), label: { x: 674, y: 139, text: YES } },
  { from: 'answered', to: 'review', answer: 'no', d: down('answered', 'review'), label: { x: 616, y: 226, text: NO } },
  { from: 'confidence', to: 'disruptive', answer: 'yes', d: across('confidence', 'disruptive'), label: { x: 806, y: 139, text: YES } },
  { from: 'confidence', to: 'review', answer: 'no', d: down('confidence', 'review'), label: { x: 748, y: 226, text: NO } },
  { from: 'disruptive', to: 'keep', answer: 'no', d: across('disruptive', 'keep'), label: { x: 938, y: 139, text: NO } },
  { from: 'disruptive', to: 'review', answer: 'yes', d: down('disruptive', 'review'), label: { x: 880, y: 226, text: YES } },
  { from: 'keep', to: 'continue', answer: 'yes', d: up('keep', 'continue'), label: { x: 1012, y: 104, text: YES } },
  { from: 'keep', to: 'respond', answer: 'no', d: down('keep', 'respond'), label: { x: 1012, y: 226, text: NO } },
];

export const FLOW_LEGEND = '太い枠と濃い線が、選んだ判定の通った経路です。薄いものは、その判定では通らなかった分岐です。';

export function DecisionFlow(props: { trace?: DecisionTrace | null; findingId?: string | null }): Element {
  const trace = props.trace ?? null;
  const taken = new Set(trace?.path ?? []);
  const answers: Partial<Record<string, GateAnswer>> = Object.fromEntries((trace?.gates ?? []).map((gate) => [gate.id, gate.answer]));
  const current = trace?.current ?? null;
  const edgeTaken = (edge: FlowEdge): boolean =>
    taken.has(edge.from) && taken.has(edge.to) && (edge.answer === undefined || answers[edge.from] === edge.answer);
  return (
    <figure className="decision-flow" data-decision-flow="true" data-traced={trace ? 'true' : 'false'} {...(props.findingId ? { 'data-traced-finding': props.findingId } : {})}>
      <svg viewBox={FLOW_VIEWBOX} className="decision-flow-canvas" role="img" aria-label="ログ分析の判断の流れ">
        <defs>
          <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#97a6b2" />
          </marker>
          <marker id="flow-arrow-taken" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#1a4f9c" />
          </marker>
        </defs>
        <g className="flow-edges">
          {FLOW_EDGES.map((edge) => {
            const lit = edgeTaken(edge);
            return (
              <g key={`${edge.from}-${edge.to}`} data-flow-edge={`${edge.from}-${edge.to}`} data-taken={lit ? 'true' : 'false'}>
                <path className="flow-edge" d={edge.d} markerEnd={lit ? 'url(#flow-arrow-taken)' : 'url(#flow-arrow)'} />
                {edge.label ? <text className="flow-edge-label" x={edge.label.x} y={edge.label.y} textAnchor={edge.label.y < GATE_Y ? 'middle' : 'start'}>{edge.label.text}</text> : null}
              </g>
            );
          })}
        </g>
        <g className="flow-nodes">
          {FLOW_NODES.map((node) => (
            <g
              key={node.id}
              className="flow-node"
              data-flow-node={node.id}
              data-kind={node.kind}
              data-taken={taken.has(node.id) ? 'true' : 'false'}
              data-current={current === node.id ? 'true' : 'false'}
              {...(node.tone ? { 'data-tone': node.tone } : {})}
              transform={`translate(${node.x},${node.y})`}
            >
              {node.kind === 'gate'
                ? <polygon points={`${-node.w / 2},0 0,${-node.h / 2} ${node.w / 2},0 0,${node.h / 2}`} />
                : <rect x={-node.w / 2} y={-node.h / 2} width={node.w} height={node.h} rx={node.kind === 'end' ? 18 : 6} />}
              <text className="flow-label" textAnchor="middle" dy={node.sub && node.kind === 'gate' ? -3 : 4}>{node.label}</text>
              {node.sub && node.kind === 'gate' ? <text className="flow-sub" textAnchor="middle" dy={12}>{node.sub}</text> : null}
              {node.sub && node.kind === 'end' ? <text className="flow-sub" textAnchor="middle" dy={node.h / 2 + 12}>{node.sub}</text> : null}
            </g>
          ))}
        </g>
      </svg>
      <figcaption className="flow-caption">
        {trace
          ? <span data-field="flow-traced">{props.findingId ? `検知 ${props.findingId} の経路を表示しています。` : '選んだ判定の経路を表示しています。'}{FLOW_LEGEND}</span>
          : <span data-field="flow-idle">各判定の「経路を図でたどる」を押すと、その判定が通った道筋がここに光ります。</span>}
      </figcaption>
    </figure>
  );
}
