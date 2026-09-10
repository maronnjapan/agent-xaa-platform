import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { ACTIVITY_EVENT_PHASES, classifyTaskId } from '@xaa/contracts';
import { AGENT_STATUS_VALUES } from '../src/schemas/index.js';
import {
  AGENT_STATUS_LABELS, DEMO_SCENARIO_LABELS, PHASE_LABELS, agentStatusLabelOf, detailKeyLabelOf,
  durationBetween, formatDuration, formatRemaining, phaseLabelOf, taskLabelOf, toolOutcomeLabelOf,
} from '../src/ui/labels.js';
import { ACTOR_ROLES, labelOf, nameOf } from '../src/ui/roles.js';
import { ALLOWED_SCENARIOS } from '../src/demo/scenarios.js';
import { DetailDisclosure } from '../src/ui/components/detail-disclosure.js';
import { StatusPanel } from '../src/ui/components/status-panel.js';
import { html as render } from './render.js';

/**
 * The words the screens use for the platform's codes.
 *
 * Every table here is a fixed word for a fixed value — screen furniture in the sense
 * of `roles.ts` — and each is pinned to the vocabulary it captions, so a value the
 * platform adds shows up here as a missing word rather than as a code on a screen.
 */
describe('what a task is called', () => {
  it('names the four shapes the way a person would, and keeps the id of a fifth', () => {
    expect(taskLabelOf('provisioning')).toMatchObject({ kind: 'provisioning', label: '準備' });
    expect(taskLabelOf('task-1')).toMatchObject({ kind: 'task', label: '作業 1' });
    expect(taskLabelOf('task-12')).toMatchObject({ kind: 'task', label: '作業 12' });
    expect(taskLabelOf('lifecycle')).toMatchObject({ kind: 'lifecycle', label: '終了' });
    expect(taskLabelOf('demo-dpop-replay')).toMatchObject({ kind: 'demo', label: 'デモ：DPoP Proof の再送' });
    expect(taskLabelOf('demo-something-new')).toMatchObject({ kind: 'demo', label: 'デモ：something-new' });
    expect(taskLabelOf('wd_1')).toMatchObject({ kind: 'unknown', label: 'wd_1' });
    expect(taskLabelOf('task-0')).toMatchObject({ kind: 'unknown' });
  });

  /** The pattern is restated for the browser; it must agree with the contract's. */
  it('classifies every id exactly as @xaa/contracts does', () => {
    for (const id of ['provisioning', 'lifecycle', 'task-1', 'task-30', 'demo-dpop-replay', 'wd_1', 'task-0', 'task-', 'demo-', 'Provisioning']) {
      const contract = classifyTaskId(id);
      expect(taskLabelOf(id).kind, id).toBe(contract === null ? 'unknown' : contract);
    }
  });

  it('has a Japanese name for every scripted scenario the demo route accepts', () => {
    for (const scenario of ALLOWED_SCENARIOS) expect(DEMO_SCENARIO_LABELS[scenario], scenario).toBeTruthy();
  });
});

describe('what a value is called', () => {
  it('captions every phase of the Activity Event schema', () => {
    for (const phase of ACTIVITY_EVENT_PHASES) {
      expect(PHASE_LABELS[phase], phase).toBeTruthy();
      expect(phaseLabelOf(phase)).not.toBe(phase);
    }
    expect(phaseLabelOf('something_else')).toBe('something_else');
  });

  it('captions every agent status the status endpoint can answer with', () => {
    for (const status of AGENT_STATUS_VALUES) {
      expect(AGENT_STATUS_LABELS[status], status).toBeTruthy();
      expect(agentStatusLabelOf(status)).not.toBe(status);
    }
    expect(agentStatusLabelOf('UNKNOWN_STATE')).toBe('UNKNOWN_STATE');
  });

  it('captions a tool call\'s outcome and leaves an unknown one alone', () => {
    expect(toolOutcomeLabelOf('success')).toBe('成功');
    expect(toolOutcomeLabelOf('blocked')).toBe('遮断');
    expect(toolOutcomeLabelOf('failed')).toBe('失敗');
    expect(toolOutcomeLabelOf('reused')).toBe('reused');
  });

  it('gives every part of the platform a name a person can read, beside its formal one', () => {
    for (const actor of ACTOR_ROLES) {
      expect(actor.name.trim(), actor.id).not.toBe('');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(actor.name), actor.id).toBe(false);
      expect(nameOf(actor.id)).toBe(actor.name);
      expect(labelOf(actor.id)).toBe(actor.label);
    }
    expect(nameOf('authorization')).toBe('権限決定');
    expect(nameOf('something-unknown')).toBe('something-unknown');
  });
});

describe('how long something took', () => {
  it('says it in words', () => {
    expect(formatDuration(0)).toBe('1 秒未満');
    expect(formatDuration(999)).toBe('1 秒未満');
    expect(formatDuration(12_000)).toBe('12 秒');
    expect(formatDuration(192_000)).toBe('3 分 12 秒');
    expect(formatDuration(180_000)).toBe('3 分');
    expect(formatDuration(3_900_000)).toBe('1 時間 5 分');
    expect(formatDuration(7_200_000)).toBe('2 時間');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });

  it('reads the two instants of a task and says nothing for one it cannot read', () => {
    expect(durationBetween('2026-01-01T00:00:00.000Z', '2026-01-01T00:03:12.000Z')).toBe('3 分 12 秒');
    expect(durationBetween('not a time', '2026-01-01T00:03:12.000Z')).toBe('');
  });

  it('turns the seconds an agent has left into words, and never into a negative', () => {
    expect(formatRemaining(3480)).toBe('58 分');
    expect(formatRemaining(59)).toBe('59 秒');
    expect(formatRemaining(0)).toBe('0 秒');
    expect(formatRemaining(-5)).toBe('0 秒');
  });
});

describe('the technical detail, captioned', () => {
  it('captions the keys it knows, keeps every key, and prints every value as it came', () => {
    const html = render(DetailDisclosure({ detail: { decision_id: 'dec_1', tool_id: 'internal.document.list', something_new: 42 } }));
    expect(detailKeyLabelOf('decision_id')).toBe('決定の ID');
    expect(html).toContain('決定の ID');
    expect(html).toContain('<code class="detail-key">decision_id</code>');
    expect(html).toContain('ツール');
    expect(html).toContain('internal.document.list');
    // An unknown key is shown as it is, with no caption invented for it.
    expect(detailKeyLabelOf('something_new')).toBeNull();
    expect(html).toContain('<code class="detail-key">something_new</code>');
    expect(html).toContain('42');
  });
});

describe('the status panel in words', () => {
  it('prints the state, the time left and the task as a person would say them', () => {
    const html = render(createElement(StatusPanel, {
      status: {
        agent_status: 'QUARANTINED', remaining_seconds: 3661, current_task: 'task-2',
        tool_invocations: [{ tool_id: 'internal.finance.payment.approve', outcome: 'blocked', summary: 'not_in_allowed_tools' }],
        execution_log: [],
      },
    }));
    expect(html).toContain('隔離中');
    expect(html).toContain('data-value="QUARANTINED"');
    expect(html).toContain('1 時間 1 分');
    expect(html).toContain('作業 2');
    expect(html).toContain('data-value="task-2"');
    // The tool's outcome is a word; the tool's id and the reason code stay as they are.
    expect(html).toMatch(/data-field="tool-outcome">遮断</);
    expect(html).toContain('internal.finance.payment.approve');
    expect(html).toContain('not_in_allowed_tools');
  });
});
