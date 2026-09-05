import { publishActivityEvent, type ActivityEvent, type ActivityRecord, type ActivityRecordHop } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';
import type { TransactionStore } from '../transaction/store.js';

/**
 * REQ-11-016. The eleven events a person can see about one agent's creation and end.
 *
 * The last three belong to Lifecycle, which owns the agent once it is running; they
 * are listed here because the type is the vocabulary of the whole timeline, and a
 * reader that only knew about the seven provisioning ones would have to guess what a
 * gap in the sequence meant.
 */
export const PROVISIONING_EVENT_TYPES = [
  'provisioning.started',
  'provisioning.idp_consent_required',
  'provisioning.idp_connection_created',
  'provisioning.external_consent_required',
  'provisioning.binding_created',
  'provisioning.agent_registered',
  'provisioning.job_started',
  'agent.active',
  'agent.expired',
  'agent.revoked',
  'agent.destroyed',
] as const;

export type ProvisioningEventType = (typeof PROVISIONING_EVENT_TYPES)[number];

/**
 * What the screen groups an event under. Three of the eleven get a kind of their own
 * because the timeline treats them as moments the person has to act on or wait for;
 * the rest are steps of one operation and are drawn as such.
 */
export const ACTIVITY_KINDS: Readonly<Record<ProvisioningEventType, string>> = {
  'provisioning.started': 'PROVISIONING_STEP',
  'provisioning.idp_consent_required': 'IDP_CONSENT_REQUIRED',
  'provisioning.idp_connection_created': 'PROVISIONING_STEP',
  'provisioning.external_consent_required': 'CONSENT_REQUIRED',
  'provisioning.binding_created': 'PROVISIONING_STEP',
  'provisioning.agent_registered': 'PROVISIONING_STEP',
  'provisioning.job_started': 'PROVISIONING_STEP',
  'agent.active': 'AGENT_PROVISIONED',
  'agent.expired': 'PROVISIONING_STEP',
  'agent.revoked': 'PROVISIONING_STEP',
  'agent.destroyed': 'PROVISIONING_STEP',
};

const OUTCOMES: Readonly<Record<ProvisioningEventType, ActivityEvent['outcome']>> = {
  'provisioning.started': 'info',
  'provisioning.idp_consent_required': 'info',
  'provisioning.idp_connection_created': 'info',
  'provisioning.external_consent_required': 'info',
  'provisioning.binding_created': 'info',
  'provisioning.agent_registered': 'info',
  'provisioning.job_started': 'info',
  'agent.active': 'success',
  'agent.expired': 'info',
  'agent.revoked': 'blocked',
  'agent.destroyed': 'info',
};

/** The wording a person reads, written here rather than in the screen (RULE-55). */
const TITLES: Readonly<Record<ProvisioningEventType, string>> = {
  'provisioning.started': 'Agent の作成を始めました',
  'provisioning.idp_consent_required': 'ログインの同意が必要です',
  'provisioning.idp_connection_created': 'ログイン連携ができました',
  'provisioning.external_consent_required': '外部サービスの接続の同意が必要です',
  'provisioning.binding_created': '外部サービスと接続しました',
  'provisioning.agent_registered': 'Agent を登録しました',
  'provisioning.job_started': 'Agent の実行を開始しました',
  'agent.active': 'Agent が使えるようになりました',
  'agent.expired': '有効期限に達しました',
  'agent.revoked': 'Agent を失効しました',
  'agent.destroyed': 'Agent を破棄しました',
};

/**
 * The exchanges each step really makes, drawn by the replay and listed under the
 * written record (docs 11 §3.4, §5.2). The Provisioner talks to two boxes on the
 * diagram — the Agent OP, for the delegated login, and the Agent Runtime, when it
 * starts the Job — and every other step happens inside its own box, which the replay
 * shows by lighting the box rather than inventing an arrow.
 *
 * The words are written here, by the component that made the call (RULE-55).
 */
const HOPS: Readonly<Record<ProvisioningEventType, readonly ActivityRecordHop[]>> = {
  'provisioning.started': [],
  'provisioning.idp_consent_required': [
    { from: 'agent-provisioner', to: 'agent-op', label: 'ログイン連携を依頼', outcome: 'info', message: 'Agent が利用者の代理でログインできるよう、Agent OP に連携の作成を依頼しました。' },
    { from: 'agent-op', to: 'agent-provisioner', label: '同意が必要と回答', outcome: 'info', message: 'Agent OP は、利用者の同意が無いと連携を作れないと答えました。同意画面へ進みます。' },
  ],
  'provisioning.idp_connection_created': [
    { from: 'agent-provisioner', to: 'agent-op', label: 'ログイン連携を依頼', outcome: 'info', message: 'Agent が利用者の代理でログインできるよう、Agent OP に連携の作成を依頼しました。' },
    { from: 'agent-op', to: 'agent-provisioner', label: '連携を作成', outcome: 'success', message: 'Agent OP が連携を作り、利用者の代理としてのログインが使えるようになりました。' },
  ],
  'provisioning.external_consent_required': [],
  'provisioning.binding_created': [],
  'provisioning.agent_registered': [],
  'provisioning.job_started': [
    { from: 'agent-provisioner', to: 'agent-runtime', label: 'Job Execution を起動', outcome: 'info', message: 'Agent Runtime の Job Execution を起動しました。ここから先の Tool 呼び出しは Agent Runtime が記録します。' },
  ],
  'agent.active': [],
  'agent.expired': [],
  'agent.revoked': [],
  'agent.destroyed': [],
};

/** The sentence each step's record opens with: what this step did, in its own words. */
const RECORD_MESSAGES: Readonly<Record<ProvisioningEventType, string>> = {
  'provisioning.started': '決定された権限を読み直し、Agent の作成に取りかかりました。ここで書かれた権限がこの Agent の全部で、あとから増えることはありません。',
  'provisioning.idp_consent_required': '利用者の同意画面へ進みます。同意が返ってくるまで、この作成は止まったままです。',
  'provisioning.idp_connection_created': 'Agent が利用者の代理でログインできる連携ができました。',
  'provisioning.external_consent_required': '外部サービスへの接続に、利用者の同意が必要です。同意が返ってくるまで、この作成は止まったままです。',
  'provisioning.binding_created': '外部サービスとの接続ができました。',
  'provisioning.agent_registered': 'Agent の登録と、使えるツールの一覧（Tool Manifest）の書き込みを終えました。',
  'provisioning.job_started': 'Agent Runtime の Job Execution を起動しました。',
  'agent.active': 'Agent が使える状態になりました。以降の作業は Agent Runtime が記録します。',
  'agent.expired': '有効期限に達しました。',
  'agent.revoked': 'Agent の資格情報を失効させました。',
  'agent.destroyed': 'Agent を破棄しました。',
};

/**
 * The record for one step: its own sentence, the values worth reading beside it, and
 * the hops the replay draws. Values are taken by name from `detail`, so a token that
 * reached a detail field could never be quoted here — and `redactTokens` runs over the
 * whole event afterwards in any case.
 */
function stepRecord(eventType: ProvisioningEventType, detail: Record<string, unknown> | undefined): ActivityRecord {
  const list = (value: unknown): string => (Array.isArray(value) && value.length > 0 ? value.map(String).join('、') : '—');
  const text = (value: unknown): string => (typeof value === 'string' && value !== '' ? value : '—');
  const fields = [
    ...(detail?.capabilities !== undefined ? [{ label: '許可された権限', value: list(detail.capabilities) }] : []),
    ...(detail?.isolation_level !== undefined ? [{ label: '分離レベル', value: text(detail.isolation_level) }] : []),
    ...(detail?.replaces_agent_id !== undefined ? [{ label: '作り直す前の Agent', value: text(detail.replaces_agent_id) }] : []),
    ...(detail?.allowed_tools !== undefined ? [{ label: '使えるツール', value: list(detail.allowed_tools) }] : []),
    ...(detail?.expires_at !== undefined ? [{ label: '有効期限', value: text(detail.expires_at) }] : []),
    ...(detail?.task_id !== undefined ? [{ label: '最初の Task', value: text(detail.task_id) }] : []),
  ];
  const hops = HOPS[eventType];
  return {
    headline: TITLES[eventType],
    sections: [{
      id: 'step',
      label: 'この段階でしたこと',
      message: RECORD_MESSAGES[eventType],
      ...(fields.length > 0 ? { fields } : {}),
    }],
    ...(hops.length > 0 ? { hops: [...hops] } : {}),
  };
}

const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * RULE-38. A timeline is shown to a person and stored for as long as their task
 * lasts, so a token that reached it would outlive every place it was allowed to be.
 * The scan is over the whole payload rather than a list of known fields, because the
 * fields that carry a token by accident are the ones nobody thought of.
 */
function redactTokens(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return JWT_SHAPE.test(value) ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map((item) => redactTokens(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactTokens(item, depth + 1)]));
  }
  return value;
}

export interface ActivityEmitterDeps {
  transactions: TransactionStore;
  logger: Logger;
  now: () => number;
  publish?: (event: ActivityEvent) => Promise<void>;
}

export interface ProvisioningActivityInput {
  eventType: ProvisioningEventType;
  transactionId: string;
  humanSubject: string;
  agentId: string | null;
  message: string;
  detail?: Record<string, unknown>;
}

export type ActivityEmitter = (input: ProvisioningActivityInput) => Promise<void>;

/**
 * One emitter per provisioning attempt.
 *
 * `sequence` is drawn from the transaction rather than counted in memory, so the
 * numbering survives the pause at a consent screen: the resume runs in a different
 * process and still continues the same series (RULE-59).
 *
 * A publish that fails is a warning and nothing more. The agent has been created; the
 * person losing a line on their timeline is not a reason to fail the provisioning and
 * destroy it again.
 */
export function createActivityEmitter(deps: ActivityEmitterDeps): ActivityEmitter {
  return async (input) => {
    try {
      const sequence = await deps.transactions.nextSequence(input.transactionId);
      const event = redactTokens({
        event_id: `evt-${input.transactionId}-${sequence}`,
        trace_id: `prov-${input.transactionId}`,
        human_subject: input.humanSubject,
        agent_id: input.agentId,
        // The provisioning of an agent is not yet the agent's own work, so every event
        // here shares one task id (T-PROV-32).
        task_id: 'provisioning',
        occurred_at: new Date(deps.now()).toISOString(),
        source: 'provisioner',
        phase: 'provisioning',
        outcome: OUTCOMES[input.eventType],
        title: TITLES[input.eventType],
        message: input.message,
        detail: {
          event_type: input.eventType,
          activity_kind: ACTIVITY_KINDS[input.eventType],
          sequence,
          transaction_id: input.transactionId,
          ...input.detail,
        },
        record: stepRecord(input.eventType, input.detail),
        related_finding_id: null,
        is_simulated: false,
      }) as ActivityEvent;
      await (deps.publish ?? publishActivityEvent)(event);
    } catch (error) {
      deps.logger.warning('activity_publish_failed', {
        request_id: '', trace_id: `prov-${input.transactionId}`, agent_id: input.agentId, human_subject: input.humanSubject,
      }, { event_type: input.eventType, reason: error instanceof Error ? error.message : 'unknown' });
    }
  };
}
