import { randomUUID } from 'node:crypto';
import {
  publishActivityEvent, redactRecordText,
  type ActivityEvent, type ActivityRecord, type ActivityRecordField, type ActivityRecordHop,
} from '@xaa/contracts';

interface EmitContext {
  humanSubject: string;
  traceId?: string;
  occurredAt?: string;
}

/**
 * What this app writes about one piece of work, in the person's own words.
 *
 * It is the work definition's content, copied out by name rather than spread, so a
 * field the store gains later cannot ride onto a timeline uninvited (RULE-38).
 */
export interface DraftContent {
  purpose: string;
  description: string;
  operations: readonly string[];
  userConfirmations: readonly string[];
  safetyNotes: readonly string[];
  requestedLifetimeMinutes: number;
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

/** A list as one value, or a dash so an empty list does not read as a missing row. */
function joined(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.map((value) => redactRecordText(value)).join('、');
}

function draftFields(draft: DraftContent): ActivityRecordField[] {
  return [
    { label: '目的', value: redactRecordText(draft.purpose) },
    { label: '内容', value: redactRecordText(draft.description) },
    { label: '手順', value: joined(draft.operations) },
    { label: '確認したいこと', value: joined(draft.userConfirmations) },
    { label: '注意点', value: joined(draft.safetyNotes) },
    { label: '希望する稼働時間', value: `${draft.requestedLifetimeMinutes} 分` },
  ];
}

/** The person acting on the screen: the movement every one of their operations makes. */
function personHop(label: string, message: string, outcome: ActivityRecordHop['outcome'] = 'info'): ActivityRecordHop {
  return { from: 'human-user', to: 'automation-app', label, outcome, message };
}

/**
 * The events this app emits, and what each of them alone knows.
 *
 * Each application publishes only what it alone knows: this one knows that a person
 * logged in, what they wrote, what the Automation Design AI rewrote for them, that they
 * confirmed it, that it asked the Authorization Platform and what came back, that they
 * approved the permissions, that it asked the Provisioner, what it told the agent, and
 * that they pressed stop. What the Authorization Platform decided and why, and what the
 * agent then did, are theirs to say — this app names their ids so the timeline can join
 * the stories, and never restates their reasons.
 *
 * Titles, messages, labels and fields are written in Japanese at the moment they
 * happen. A timeline is a record of what was said at the time; if the screen composed
 * the wording later, a change to the renderer would rewrite events that are already in
 * the past.
 */
export async function emitLoggedIn(context: EmitContext): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'login', outcome: 'info',
    title: 'ログインしました',
    message: `${context.humanSubject} としてログインしました。`,
    detail: { event_type: 'LOGGED_IN' },
    record: {
      headline: `${context.humanSubject} がログインしました`,
      sections: [{
        id: 'login',
        label: 'ログイン',
        message: 'Human IdP でログインし、Automation App の画面に入りました。ここから先の操作はすべてこの人のものとして記録されます。',
        fields: [{ label: '利用者', value: context.humanSubject }],
      }],
      hops: [personHop('ログイン', `${context.humanSubject} が Human IdP でログインし、Automation App に入りました。`, 'success')],
    },
  });
}

export async function emitProposed(context: EmitContext, input: { purpose: string; workDefinitionId: string; draft?: DraftContent }): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'work_definition', outcome: 'info',
    title: '自動化したい作業を書きました',
    message: `「${input.purpose}」を自動化の候補として保存しました。`,
    // `purpose` is what the timeline heads the whole group with. Without it the list
    // fell back to the first event's title, so every agent's group was headed
    // 「ログインしました」 rather than the work it was created for.
    detail: { event_type: 'PROPOSED', work_definition_id: input.workDefinitionId, purpose: input.purpose },
    record: {
      headline: `「${input.purpose}」の下書きを保存しました`,
      sections: [{
        id: 'draft',
        label: '書いた作業',
        message: '利用者が画面で書いた内容そのままです。この時点では下書きで、まだ何も決まっていません。',
        ...(input.draft ? { fields: draftFields(input.draft) } : { fields: [{ label: '目的', value: input.purpose }] }),
      }],
      hops: [personHop('作業を書く', `利用者が「${input.purpose}」の作業を書き、下書きとして保存しました。`)],
    },
  });
}

/**
 * The one moment the Automation Design AI is visibly on the timeline: a person asked for
 * a rewrite, and the model answered with new wording. It changes words and nothing else
 * (RULE-08), which the message says outright.
 */
export async function emitDraftRevised(context: EmitContext, input: {
  workDefinitionId: string; purpose: string; request: string; revised: DraftContent;
}): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'work_definition', outcome: 'info',
    title: 'Automation Design AI が下書きを書き直しました',
    message: `利用者の依頼を受けて、Automation Design AI が「${input.purpose}」の内容を書き直しました。確定はしていません。`,
    detail: { event_type: 'DRAFT_REVISED', work_definition_id: input.workDefinitionId, purpose: input.purpose },
    record: {
      headline: `「${input.purpose}」の下書きを書き直しました`,
      sections: [
        {
          id: 'request',
          label: '利用者が頼んだこと',
          message: '利用者が「直してほしいところ」に書いた文章です。',
          text: redactRecordText(input.request),
          format: 'text',
        },
        {
          id: 'revised',
          label: '書き直した下書き',
          message: 'Automation Design AI が返した新しい下書きです。文面が変わっただけで、確定の状態は変わっていません。',
          fields: draftFields(input.revised),
        },
      ],
      hops: [personHop('書き直しを依頼', `利用者が「${input.purpose}」の下書きの書き直しを頼み、Automation Design AI が新しい文面を返しました。`)],
    },
  });
}

export async function emitConfirmed(context: EmitContext, input: { purpose: string; workDefinitionId: string; draft?: DraftContent }): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'work_definition', outcome: 'success',
    title: '作業内容を確定しました',
    message: `「${input.purpose}」を実行する内容で確定しました。`,
    detail: { event_type: 'CONFIRMED', work_definition_id: input.workDefinitionId, purpose: input.purpose },
    record: {
      headline: `「${input.purpose}」を確定しました`,
      sections: [{
        id: 'confirmed',
        label: '確定した作業',
        message: 'この内容が、次の段階で Authorization Platform へ送られます。確定した内容はあとから書き換えられません。',
        ...(input.draft ? { fields: draftFields(input.draft) } : { fields: [{ label: '目的', value: input.purpose }] }),
      }],
      hops: [personHop('確定', `利用者が「${input.purpose}」の内容を読み、この内容で確定しました。`, 'success')],
    },
  });
}

/**
 * The five business-language keys, as they were sent. No capability, scope or tool id
 * is in them (RULE-07), and the record says so, because a person reading the next
 * event — the decision — will otherwise wonder where the permissions came from.
 */
export async function emitDecisionRequested(context: EmitContext, input: {
  workDefinitionId: string;
  purpose: string;
  description: string;
  constraints: Record<string, boolean>;
  requestedLifetimeMinutes: number;
}): Promise<void> {
  const constraints = Object.entries(input.constraints).map(([key, value]) => `${key}=${String(value)}`);
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'authorization', outcome: 'info',
    title: '必要な権限の決定を求めました',
    message: `「${input.purpose}」の作業内容を Authorization Platform へ送り、必要な権限の決定を求めました。`,
    detail: {
      event_type: 'DECISION_REQUESTED', work_definition_id: input.workDefinitionId, purpose: input.purpose,
      target: 'authorization-platform',
    },
    record: {
      headline: 'Authorization Platform に権限の決定を求めました',
      sections: [{
        id: 'sent',
        label: '送った内容',
        message: 'Automation App が送ったのは業務の言葉だけです。どの権限やツールが要るかは書いておらず、それを決めるのは Authorization Platform です。',
        fields: [
          { label: '目的', value: redactRecordText(input.purpose) },
          { label: '内容', value: redactRecordText(input.description) },
          { label: '自己申告した条件', value: joined(constraints) },
          { label: '希望する稼働時間', value: `${input.requestedLifetimeMinutes} 分` },
        ],
      }],
      hops: [{
        from: 'automation-app', to: 'authorization-platform', label: '作業内容を送付', outcome: 'info',
        message: `「${input.purpose}」の作業内容を送り、必要な権限の決定を求めました。`,
      }],
    },
  });
}

/**
 * What came back, printed as opaque strings.
 *
 * This app does not know what a capability id or an isolation level means and must not
 * learn (RULE-07), so the values are listed as they arrived and nothing is said about
 * them. The `decision_id` is the one thing the timeline needs: it is how the
 * Authorization Platform's own account of the decision, and later the Provisioner's
 * events, are joined to this work.
 */
export async function emitDecisionReceived(context: EmitContext, input: {
  workDefinitionId: string;
  agentDefinitionId: string;
  purpose: string;
  decisionId: string;
  status: string;
  effectiveCapabilities: readonly string[];
  deniedCount: number;
  isolationLevel: string;
}): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'authorization', outcome: 'info',
    title: '権限の決定を受け取りました',
    message: `Authorization Platform から決定 ${input.decisionId} が返りました。許可された操作は ${input.effectiveCapabilities.length} 件です。`,
    detail: {
      event_type: 'DECISION_RECEIVED', work_definition_id: input.workDefinitionId, decision_id: input.decisionId,
      agent_definition_id: input.agentDefinitionId, purpose: input.purpose,
    },
    record: {
      headline: `決定 ${input.decisionId} を受け取り、承認を待つ Agent Definition にしました`,
      sections: [{
        id: 'received',
        label: '返ってきた決定',
        message: '値は届いたまま並べています。なぜ許可され、なぜ却下されたかは、Authorization Platform 自身の記録（この前の行）に書いてあります。',
        fields: [
          { label: '決定 ID', value: input.decisionId },
          { label: '状態', value: input.status },
          { label: '許可された操作', value: joined(input.effectiveCapabilities) },
          { label: '却下された操作の数', value: `${input.deniedCount} 件` },
          { label: '隔離のレベル', value: redactRecordText(input.isolationLevel) },
        ],
      }],
      hops: [{
        from: 'authorization-platform', to: 'automation-app', label: '決定を受領', outcome: 'success',
        message: `決定 ${input.decisionId} が返りました。利用者に提示し、承認を待ちます。`,
      }],
    },
  });
}

/** The decision that did not come: refused on its merits, or never reached. */
export async function emitDecisionRefused(context: EmitContext, input: {
  workDefinitionId: string; purpose: string; error: string; refusedByPlatform: boolean;
}): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'authorization', outcome: input.refusedByPlatform ? 'blocked' : 'info',
    title: '権限の決定が返りませんでした',
    message: input.refusedByPlatform
      ? `Authorization Platform は「${input.purpose}」の依頼を ${input.error} として断りました。`
      : `Authorization Platform に届かなかったため、「${input.purpose}」の決定は得られませんでした（${input.error}）。`,
    detail: { event_type: 'DECISION_REFUSED', work_definition_id: input.workDefinitionId, purpose: input.purpose, error: input.error },
    record: {
      headline: '決定は得られませんでした',
      sections: [{
        id: 'refusal',
        label: '返ってきた答え',
        message: input.refusedByPlatform
          ? 'Authorization Platform が依頼を読んだうえで断りました。理由のコードは下のとおりです。'
          : '呼び出しが Authorization Platform に届かなかったか、答えが読めませんでした。作業内容の問題ではありません。',
        fields: [{ label: '理由', value: input.error }],
      }],
      hops: [{
        from: 'automation-app', to: 'authorization-platform', label: '作業内容を送付',
        outcome: input.refusedByPlatform ? 'blocked' : 'info',
        message: input.refusedByPlatform
          ? `Authorization Platform が ${input.error} として断りました。`
          : `Authorization Platform から決定が返りませんでした（${input.error}）。`,
      }],
    },
  });
}

export async function emitApproved(context: EmitContext, input: {
  workDefinitionId: string;
  decisionId: string;
  agentDefinitionId: string;
  purpose: string;
  capabilities: readonly string[];
  isolationLevel: string;
  approvedAt: string;
}): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'authorization', outcome: 'success',
    title: '提示された権限を承認しました',
    message: `「${input.purpose}」の Agent に許可する操作を、利用者が読んで承認しました。`,
    detail: {
      event_type: 'AGENT_DEFINITION_APPROVED', work_definition_id: input.workDefinitionId, decision_id: input.decisionId,
      agent_definition_id: input.agentDefinitionId, purpose: input.purpose,
    },
    record: {
      headline: '利用者が Agent Definition を承認しました',
      sections: [{
        id: 'approved',
        label: '承認した内容',
        message: '承認するまで Agent は作られません。承認したあとに内容が変わっていれば、作成は断られます（RULE-08）。',
        fields: [
          { label: '許可される操作', value: joined(input.capabilities) },
          { label: '隔離のレベル', value: redactRecordText(input.isolationLevel) },
          { label: '承認した時刻', value: input.approvedAt },
        ],
      }],
      hops: [personHop('承認', `利用者が提示された ${input.capabilities.length} 件の操作を読み、この権限で承認しました。`, 'success')],
    },
  });
}

export async function emitProvisionRequested(context: EmitContext, input: {
  workDefinitionId: string;
  decisionId: string;
  agentDefinitionId: string;
  purpose: string;
  requestedLifetimeMinutes: number;
}): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'provisioning', outcome: 'info',
    title: 'Agent の作成を依頼しました',
    message: `承認した内容で Agent を作るよう Agent Provisioner に依頼しました。稼働時間は ${input.requestedLifetimeMinutes} 分です。`,
    detail: {
      event_type: 'PROVISION_REQUESTED', work_definition_id: input.workDefinitionId, decision_id: input.decisionId,
      agent_definition_id: input.agentDefinitionId, purpose: input.purpose, target: 'agent-provisioner',
      requested_lifetime_minutes: input.requestedLifetimeMinutes,
    },
    record: {
      headline: 'Agent Provisioner に Agent の作成を依頼しました',
      sections: [{
        id: 'request',
        label: '依頼した内容',
        message: '送ったのは決定の ID と稼働時間だけです。権限そのものは Provisioner が決定を読み直して取り出します。',
        fields: [
          { label: '決定 ID', value: input.decisionId },
          { label: '希望する稼働時間', value: `${input.requestedLifetimeMinutes} 分` },
        ],
      }],
      hops: [{
        from: 'automation-app', to: 'agent-provisioner', label: 'Agent の作成を依頼', outcome: 'info',
        message: `決定 ${input.decisionId} で Agent を作るよう依頼しました。ここから先は Agent Provisioner が記録します。`,
      }],
    },
  });
}

export async function emitProvisionRefused(context: EmitContext, input: {
  workDefinitionId: string; decisionId: string; purpose: string; error: string;
}): Promise<void> {
  await publishActivityEvent({
    ...base(context, null, 'provisioning'),
    phase: 'provisioning', outcome: 'blocked',
    title: 'Agent を作れませんでした',
    message: `Agent Provisioner は「${input.purpose}」の Agent の作成を ${input.error} として断りました。`,
    detail: {
      event_type: 'PROVISION_REFUSED', work_definition_id: input.workDefinitionId, decision_id: input.decisionId,
      purpose: input.purpose, error: input.error,
    },
    record: {
      headline: 'Agent の作成は断られました',
      sections: [{
        id: 'refusal',
        label: '返ってきた答え',
        message: 'Agent Provisioner が依頼を読んだうえで断りました。何も作られていません。',
        fields: [{ label: '理由', value: input.error }],
      }],
      hops: [{
        from: 'automation-app', to: 'agent-provisioner', label: 'Agent の作成を依頼', outcome: 'blocked',
        message: `Agent Provisioner が ${input.error} として断りました。`,
      }],
    },
  });
}

/**
 * Words handed to a running agent, in the task that agent is on.
 *
 * The first instruction is the confirmed work itself, and it is the only way the agent
 * learns what it is for; a later one is something the person added. Both are words and
 * nothing else — the record says so, because a reader who sees an instruction naming a
 * tool the agent then refuses needs to know the instruction could not have granted it.
 */
export async function emitInstructionAdded(context: EmitContext, input: {
  agentId: string;
  taskId: string;
  instructionId: string;
  text: string;
  initial: boolean;
  workDefinitionId?: string;
  decisionId?: string;
}): Promise<void> {
  await publishActivityEvent({
    ...base(context, input.agentId, input.taskId),
    phase: 'work_definition', outcome: 'info',
    title: input.initial ? 'Agent に作業内容を伝えました' : 'Agent に追加の指示を出しました',
    message: input.initial
      ? '確定した作業内容を、最初の指示として Agent に渡しました。Agent は次の手の前にこれを読みます。'
      : '利用者が追加の指示を書きました。Agent は次の手の前にこれを読みます。承認した権限の外の操作は、指示しても実行されません。',
    detail: {
      event_type: 'INSTRUCTION_ADDED', instruction_id: input.instructionId, initial: input.initial,
      ...(input.workDefinitionId ? { work_definition_id: input.workDefinitionId } : {}),
      ...(input.decisionId ? { decision_id: input.decisionId } : {}),
    },
    record: {
      headline: input.initial ? '最初の指示を Agent に渡しました' : '追加の指示を Agent に渡しました',
      sections: [{
        id: 'instruction',
        label: 'Agent に渡した指示',
        message: '指示は言葉だけで、権限を変える力はありません。指示に含まれる操作が許可の外なら、Agent Runtime が実行の手前で止めます。',
        text: redactRecordText(input.text),
        format: 'text',
      }],
      hops: [
        ...(input.initial ? [] : [personHop('指示を書く', '利用者が Agent への追加の指示を書きました。')]),
        {
          from: 'automation-app', to: 'agent-runtime', label: '指示を渡す', outcome: 'info',
          message: '指示を agent_instructions に書き込みました。Agent Runtime は次の手の前にこれを読み取ります。',
        },
      ],
    },
  });
}

export async function emitAgentStopped(context: EmitContext, input: { agentId: string }): Promise<void> {
  await publishActivityEvent({
    ...base(context, input.agentId, 'lifecycle'),
    phase: 'lifecycle', outcome: 'success',
    title: 'Agent を停止しました',
    message: `${input.agentId} の停止を依頼し、受理されました。`,
    detail: { event_type: 'AGENT_STOPPED' },
    record: {
      headline: '利用者が Agent を止めました',
      sections: [{
        id: 'stop',
        label: '停止の依頼',
        message: 'Lifecycle Manager に停止を依頼し、受理されました。止めた Agent は元に戻せません。',
        fields: [{ label: 'Agent', value: input.agentId }],
      }],
      hops: [personHop('停止を押す', `利用者が ${input.agentId} の停止を押し、Lifecycle Manager が受理しました。`, 'success')],
    },
  });
}

export type { ActivityRecord };
