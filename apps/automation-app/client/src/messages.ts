/**
 * What a refusal is called on screen.
 *
 * The codes are the server's, and each is said in the words of the step the person just
 * took. A code this table has not seen is shown as itself: inventing a friendlier
 * sentence for an unknown refusal would describe something nobody checked.
 */
const MESSAGES: Record<string, string> = {
  work_definition_not_confirmed: '先に作業内容を確定してください。',
  approval_required: '先に提示された権限を承認してください。',
  capabilities_changed: '提示した権限が変わりました。もう一度「必要な権限を調べる」からやり直してください。',
  already_approved: 'すでに承認済みです。',
  lifetime_out_of_range: '希望する稼働時間は 1〜24 の整数で指定してください。',
  agent_not_active: 'この Agent は動いていないため、指示を受け取れません。',
  not_found: '見つかりませんでした。画面を更新してください。',
  // The call to the Authorization Platform did not land. Naming it separately is
  // what stops an unreachable service from reading as a missing record.
  authorization_platform_unreachable: '権限を判定する仕組みに届きませんでした。少し時間をおいて、もう一度「必要な権限を調べる」を押してください。',
  invalid_request: '入力の形式が正しくありません。',
};

export function failureMessage(status: number, body: { error?: unknown }): string {
  const code = typeof body.error === 'string' ? body.error : String(status);
  return MESSAGES[code] ?? `うまくいきませんでした（${code}）`;
}
