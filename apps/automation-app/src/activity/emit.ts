import { randomUUID } from 'node:crypto';
import { publishActivityEvent, type ActivityEvent } from '@xaa/contracts';

interface EmitContext {
  humanSubject: string;
  traceId?: string;
  occurredAt?: string;
}

function base(context: EmitContext, agentId: string | null, taskId: string): Omit<ActivityEvent, 'phase' | 'outcome' | 'title' | 'message' | 'detail'> {
  return {
    event_id: randomUUID(),
    trace_id: context.traceId ?? randomUUID(),
    human_subject: context.humanSubject,
    agent_id: agentId,
    task_id: taskId,
    occurred_at: context.occurredAt ?? new Date().toISOString(),
    source: 'automation-app',
    related_finding_id: null,
    is_simulated: false,
  };
}

/**
 * The four events this app emits. There is no fifth.
 *
 * Each application publishes only what it alone knows: this one knows that a person
 * logged in, that a proposal was shown, that they confirmed it, and that they pressed
 * stop. What happened to the agent afterwards is the Runtime's and the Lifecycle
 * Manager's to say, and naming their event types here would invite this app to guess.
 *
 * Titles and messages are written in Japanese at the moment they happen. A timeline is
 * a record of what was said at the time; if the screen composed the wording later, a
 * change to the renderer would rewrite events that are already in the past.
 */
export async function emitLoggedIn(context: EmitContext): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'login', outcome: 'info',
    title: 'ログインしました',
    message: `${context.humanSubject} としてログインしました。`,
    detail: { event_type: 'LOGGED_IN' },
  });
}

export async function emitProposed(context: EmitContext, input: { purpose: string; workDefinitionId: string }): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'work_definition', outcome: 'info',
    title: '自動化の候補を提案しました',
    message: `Automation Design AI が「${input.purpose}」を提案しました`,
    // `purpose` is what the timeline heads the whole group with. Without it the list
    // fell back to the first event's title, so every agent's group was headed
    // 「ログインしました」 rather than the work it was created for.
    detail: { event_type: 'PROPOSED', work_definition_id: input.workDefinitionId, purpose: input.purpose },
  });
}

export async function emitConfirmed(context: EmitContext, input: { purpose: string; workDefinitionId: string }): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'work_definition', outcome: 'success',
    title: '作業内容を確定しました',
    message: `「${input.purpose}」を実行する内容で確定しました。`,
    detail: { event_type: 'CONFIRMED', work_definition_id: input.workDefinitionId, purpose: input.purpose },
  });
}

export async function emitAgentStopped(context: EmitContext, input: { agentId: string }): Promise<void> {
  await publishActivityEvent({
    ...base(context, input.agentId, 'lifecycle'),
    phase: 'lifecycle', outcome: 'success',
    title: 'Agent を停止しました',
    message: `${input.agentId} の停止を依頼し、受理されました。`,
    detail: { event_type: 'AGENT_STOPPED' },
  });
}
