import { PhaseIcon } from './phase-icon.js';
import type { TaskRowProps } from './task-row.js';
import { ResultMark, phaseLabel } from './visual.js';
import type { Element } from '../element.js';

/** The four shapes a task id takes (docs 11 §3.3), and the phase each one is about. */
export function phaseOfTask(taskId: string, terminalPhase?: string): string {
  if (taskId === 'provisioning') return 'provisioning';
  if (taskId === 'lifecycle') return 'lifecycle';
  if (taskId.startsWith('demo-')) return terminalPhase ?? 'security';
  return 'tool_call';
}

export function journeyLabel(taskId: string): string {
  if (taskId === 'provisioning') return 'Agent の準備';
  if (taskId === 'lifecycle') return 'Agent の終了';
  return taskId;
}

const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  running: '実行中', success: '成功', blocked: '遮断', failed: '失敗', info: '情報',
};

/**
 * One agent's story as a line of stops: the preparation, each task, the end.
 *
 * The rows below say the same things one per line; this says them in one glance, in
 * the order they happened, with the mark of how each one ended. A person looking for
 * 「どこで止まったか」 finds the amber stop on the line before they have read a row.
 * Pressing a stop goes to that task's replay, exactly as pressing its row does.
 *
 * Every word is the task's own — its id, its phase, its outcome — and the outcome is
 * spelled out beside the mark rather than left to the colour.
 */
export function JourneyStrip(props: { tasks: readonly TaskRowProps[] }): Element {
  if (props.tasks.length === 0) return null;
  return (
    <ol className="journey" data-journey="true" aria-label="この Agent の処理の並び">
      {props.tasks.map((task) => {
        const running = task.status === 'running';
        const outcome = running ? 'running' : task.terminal_outcome ?? 'info';
        const key = task.run_id ? `${task.run_id}:${task.task_id}` : task.task_id;
        const phase = phaseOfTask(task.task_id, task.phase);
        return (
          <li key={task.task_id} className="journey-stop" data-journey-task={task.task_id} data-outcome={outcome} data-phase={phase}>
            <button
              type="button"
              className="journey-node"
              data-journey-target={key}
              {...(running ? { disabled: true } : {})}
              onClick={() => scrollTo(Array.from(document.querySelectorAll<HTMLElement>('[data-replay-for]'))
                .find((panel) => panel.dataset.replayFor === key))}
            >
              <span className="journey-glyph"><PhaseIcon phase={phase} /></span>
              <span className="journey-label">{journeyLabel(task.task_id)}</span>
              <span className="journey-outcome"><ResultMark outcome={outcome} />{OUTCOME_TEXT[outcome] ?? outcome}</span>
              <small className="journey-meta">
                {phaseLabel(phase)}
                {task.event_count !== undefined && task.event_count > 0 ? ` · ${task.event_count} 件` : ''}
              </small>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Scrolls when the document can; a document without the method is a test's, and stays put. */
function scrollTo(target: HTMLElement | null | undefined): void {
  if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
