/**
 * What a refusal is called on screen.
 *
 * The codes are the server's, and each is said in the words of the step the person just
 * took. A code this table has not seen is shown as itself: inventing a friendlier
 * sentence for an unknown refusal would describe something nobody checked.
 */
const MESSAGES: Record<string, string> = {
  work_definition_not_confirmed: '先に ToDo の内容を確定してください。',
  todo_not_draft: 'この ToDo は確定済みのため、内容は書き換えられません。',
  todo_closed: 'この ToDo はすでに完了か取り下げになっています。',
  agent_still_running: 'Agent がまだ動いています。先に Agent の画面で止めてから取り下げてください。',
  approval_required: '先に提示された権限を承認してください。',
  capabilities_changed: '提示した権限が変わりました。もう一度「必要な権限を調べる」からやり直してください。',
  already_approved: 'すでに承認済みです。',
  lifetime_out_of_range: '希望する稼働時間は 1〜1440 の整数（分）で指定してください。',
  title_required: 'タイトルを書いてください。',
  text_too_long: '文章が長すぎます。短くしてください。',
  too_many_items: '項目が多すぎます。50 件までにしてください。',
  invalid_priority: '優先度は 高・中・低 のどれかです。',
  invalid_due_on: '期限は日付（YYYY-MM-DD）で指定してください。',
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
