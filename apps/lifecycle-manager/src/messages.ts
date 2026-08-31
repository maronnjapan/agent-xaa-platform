import type { LifecycleEventType } from './events.js';

/**
 * The wording a person reads, written here rather than in the screen (RULE-55).
 *
 * A timeline is a record of what was said at the time. If the renderer composed these
 * sentences, changing the renderer would change what happened months ago.
 */
export const LIFECYCLE_MESSAGES: Readonly<Record<LifecycleEventType, {
  outcome: 'info' | 'success' | 'blocked';
  title: string;
  message: string;
}>> = {
  AGENT_EXPIRED: {
    outcome: 'info',
    title: '有効期限に達したため終了しました',
    message: 'Agent の有効期限に達したため、資格情報を失効させて終了しました。',
  },
  RE_PROVISIONED: {
    outcome: 'info',
    title: '権限変更によりAgentを作り直しました',
    message: '権限が変わったため、以前の Agent を破棄して新しい Agent を作成しました。',
  },
  AGENT_REVOKED_SECURITY: {
    outcome: 'blocked',
    title: 'セキュリティ上の理由でAgentを失効しました',
    message: 'セキュリティ上の理由により、Agent の資格情報をすべて失効させました。',
  },
  AGENT_REPROVISION_FAILED: {
    outcome: 'blocked',
    title: '権限が足りないためAgentを作り直せませんでした',
    message: '縮小後の権限では作業を続けられないため、Agent を破棄して再作成は行いませんでした。',
  },
};
