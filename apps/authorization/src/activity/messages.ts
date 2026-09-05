import type { ReasonCode, ViolationCode } from '@xaa/contracts';

export interface DeniedCapability {
  capability_id: string;
  violation_code: ViolationCode | null;
}

/**
 * Why a proposed capability ended the way it did, in the words of the filter that
 * ended it. One sentence per reason code, so the record's checks (docs 11 §3.4) say
 * what happened rather than naming a code a person has to look up.
 */
export const REASON_MESSAGES: Readonly<Record<ReasonCode, string>> = {
  not_in_human_permission: '本人がこの権限を持っていないため却下しました。',
  not_delegatable: 'この権限は Agent へ委譲できないと定められているため却下しました。',
  org_policy_denied: '組織ポリシーが禁じているため却下しました。',
  risk_policy_denied: 'リスクポリシーが禁じているため却下しました。',
  allowed: '本人が持ち、委譲でき、組織ポリシーとリスクポリシーのどちらにも当たらなかったため許可しました。',
};

export const ACTIVITY_TITLES = {
  CAPABILITY_DECIDED: '権限を決定しました',
  ISOLATION_DECIDED: '分離レベルを決定しました',
  PERMISSION_CHANGE_IGNORED: '権限の追加は既存のAgentへ反映しません',
} as const;

/**
 * docs 11 §3.2, rendered here rather than in the reader. The timeline shows one line
 * per event, so what a person is told has to be decided where the event is built.
 *
 * "許可なし" is written out instead of an empty list: a blank where the allowed
 * capabilities should be reads as a rendering fault, not as a decision. The rejected
 * clause is omitted entirely when nothing was rejected, because "却下：" followed by
 * nothing invites the reader to look for what is missing.
 */
export function capabilityDecidedMessage(allowed: readonly string[], denied: readonly DeniedCapability[]): string {
  const allowedText = allowed.length > 0 ? allowed.join('、') : '許可なし';
  if (denied.length === 0) return `許可：${allowedText}`;
  const deniedText = denied.map((entry) => entry.capability_id).join('、');
  const reasons = [...new Set(denied.map((entry) => entry.violation_code ?? 'unknown'))].join('、');
  return `許可：${allowedText}／却下：${deniedText}（理由：${reasons}）`;
}

/** Both values appear as text: the level alone does not explain why it was chosen. */
export function isolationDecidedMessage(isolationLevel: string, riskScore: number): string {
  return `isolation_level=${isolationLevel}に決定（risk_score ${riskScore}）`;
}

/**
 * RULE-13. A widening is recorded and stops there, so the line has to say that
 * nothing happened to the agent and where the new permission does take effect.
 */
export function permissionChangeIgnoredMessage(agentId: string, added: readonly string[]): string {
  const addedText = added.length > 0 ? added.join('、') : '追加された権限';
  return `${addedText}は実行中のAgent（${agentId}）へ反映しません。次に作成するAgentから有効になります`;
}
