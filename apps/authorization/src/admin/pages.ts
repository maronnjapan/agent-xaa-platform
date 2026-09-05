import { CAPABILITY_RISK_LEVELS } from '@xaa/contracts';
import { ADMIN_BOOLEAN_KEYS, type AdminBooleanKey } from './permission.js';
import type { PermissionView } from './permission-store.js';

/**
 * The console's screens, as strings.
 *
 * No template engine and no client-side script: every screen is a form the browser
 * posts, so the console works through `gcloud run services proxy`, which attaches the
 * administrator's identity token to whatever the page submits. A page that fetched
 * with JavaScript would have to obtain that token itself, and there is nowhere in a
 * browser it could safely keep one.
 */

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 68rem; padding: 1.5rem; line-height: 1.6; }
h1 { font-size: 1.4rem; }
nav a { margin-right: 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #8884; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #8881; }
code { font-family: ui-monospace, monospace; }
form.stack label { display: block; margin: 0.8rem 0; }
input[type=text], select { width: 100%; max-width: 28rem; padding: 0.3rem; }
button { padding: 0.4rem 1rem; }
.errors { border: 1px solid #c00; padding: 0.6rem 1rem; }
.note { color: #666; font-size: 0.9rem; }
.danger { margin-top: 2rem; border-top: 1px solid #8884; padding-top: 1rem; }
`;

export const ADMIN_LABELS: Record<AdminBooleanKey | 'delegatable', string> = {
  sensitive_resource: '機微なリソース',
  admin_permission: '管理者権限',
  personal_data_access: '個人データを扱う',
  financial_operation: '金銭処理（full_isolation を強制する）',
  delegatable: 'Agent へ委譲してよい',
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(title)}｜Authorization Platform</title><style>${STYLE}</style></head>`
    + `<body><nav><a href="/admin/permissions">権限一覧</a>`
    + `<a href="/admin/permissions/new">権限を作る</a></nav>`
    + `<h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

/**
 * The permission list.
 *
 * "マッピング先" is the column an administrator reads after creating a permission: a
 * capability with no resource behind it is one the Policy Engine can grant and the
 * Provisioner then refuses to build an agent for (`no_tool_for_capability`), so the
 * empty cell is the screen saying the work is only half done.
 */
export function permissionListPage(permissions: readonly PermissionView[]): string {
  const rows = permissions.map((permission) => `<tr>
    <td><a href="/admin/permissions/${encodeURIComponent(permission.capability_id)}"><code>${escapeHtml(permission.capability_id)}</code></a></td>
    <td>${escapeHtml(permission.description)}</td>
    <td>${escapeHtml(String(permission.default_characteristics.capability_risk ?? '-'))}</td>
    <td>${escapeHtml(statedCharacteristics(permission))}</td>
    <td>${permission.delegatable ? '委譲可' : '委譲不可'}</td>
    <td>${permission.connector_ids.length === 0
      ? '<span class="note">未マッピング</span>'
      : permission.connector_ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('<br>')}</td>
    <td>${permission.holders}</td>
  </tr>`).join('');

  const table = permissions.length === 0
    ? '<p>権限がまだ1件もない。</p>'
    : `<table><thead><tr>
        <th>capability_id</th><th>説明</th><th>リスク</th><th>特性</th>
        <th>委譲</th><th>マッピング先リソース</th><th>保有者</th>
      </tr></thead><tbody>${rows}</tbody></table>`;

  return layout('権限一覧', `${table}
    <p><a href="/admin/permissions/new">新しい権限を作る</a></p>
    <p class="note">権限をリソースへ結び付けるのは Agent Provisioner の <code>/admin/mappings</code> である
    （Tool / Connector Catalog を持つのは Provisioner であり、Authorization Platform は API の接続先を持たない）。</p>
    <p class="note">誰がその権限を持つかは <code>pnpm perm:set &lt;human_subject&gt; &lt;capability_id&gt; grant</code> で変える。
    実行中の Agent の再評価は、その経路でだけ起きる。</p>
    <p class="note">seed をもう一度流すと、この画面での変更は <code>infra/seed/</code> の YAML の内容へ戻る。</p>`);
}

export function permissionFormPage(options: {
  permission?: PermissionView;
  values?: Record<string, string | undefined>;
  errors?: readonly string[];
}): string {
  const editing = options.permission !== undefined;
  const values = options.values ?? valuesOf(options.permission);
  const title = editing ? `権限を編集する：${options.permission!.capability_id}` : '権限を作る';
  const action = editing ? `/admin/permissions/${encodeURIComponent(options.permission!.capability_id)}` : '/admin/permissions';

  const errors = (options.errors ?? []).length === 0 ? '' : `<div class="errors"><ul>${
    (options.errors ?? []).map((error) => `<li>${escapeHtml(error)}</li>`).join('')
  }</ul></div>`;

  const riskOptions = CAPABILITY_RISK_LEVELS.map((level) =>
    `<option value="${level}"${values.capability_risk === level ? ' selected' : ''}>${level}</option>`).join('');

  const checkboxes = [...ADMIN_BOOLEAN_KEYS, 'delegatable' as const].map((key) =>
    `<label><input type="checkbox" name="${key}"${values[key] === 'on' ? ' checked' : ''}> ${escapeHtml(ADMIN_LABELS[key])}</label>`).join('');

  const identity = editing
    ? `<p><code>${escapeHtml(options.permission!.capability_id)}</code>
       （resource: <code>${escapeHtml(options.permission!.resource)}</code>,
        object: <code>${escapeHtml(options.permission!.object)}</code>,
        action: <code>${escapeHtml(options.permission!.action)}</code>）</p>
       <p class="note">capability_id は変えられない。別の id にするのは、別の権限を作ることである。</p>`
    : `<label>capability_id
        <input type="text" name="capability_id" value="${escapeHtml(values.capability_id ?? '')}"
               placeholder="resource.object.action" required>
       </label>
       <p class="note">resource.object.action か resource.action の形で入れる。小文字とアンダースコアだけを使い、
       ベンダー名（google など）と HTTP メソッド名は使わない。resource / object / action は id から決まる。</p>`;

  const remove = editing ? `<div class="danger">
      <form method="post" action="/admin/permissions/${encodeURIComponent(options.permission!.capability_id)}/delete"
            onsubmit="return confirm('${escapeHtml(options.permission!.capability_id)} を削除する。よいか。')">
        <button type="submit">この権限を削除する</button>
      </form>
      <p class="note">誰かが持っている権限、リソースへマッピング済みの権限は削除できない。先に外す。</p>
    </div>` : '';

  return layout(title, `${errors}
    <form class="stack" method="post" action="${action}">
      ${identity}
      <label>説明<input type="text" name="description" value="${escapeHtml(values.description ?? '')}" required></label>
      <label>capability_risk<select name="capability_risk">${riskOptions}</select></label>
      ${checkboxes}
      <p class="note">write_operation と external_communication はここにない。その2つは「この作業が何をするか」であり、
      Authorization AI が提案してよい唯一の範囲である（docs 03 §7）。</p>
      <button type="submit">${editing ? '保存する' : '作る'}</button>
    </form>
    <p><a href="/admin/permissions">一覧へ戻る</a></p>${remove}`);
}

/** The characteristics the taxonomy states, as the list page shows them. */
function statedCharacteristics(permission: PermissionView): string {
  const stated = ADMIN_BOOLEAN_KEYS.filter((key) => permission.default_characteristics[key] === true);
  return stated.length === 0 ? '-' : stated.map((key) => ADMIN_LABELS[key]).join('、');
}

/** An existing permission, in the shape the form reads back. */
function valuesOf(permission?: PermissionView): Record<string, string | undefined> {
  if (!permission) return { capability_risk: CAPABILITY_RISK_LEVELS[0] };
  const values: Record<string, string | undefined> = {
    capability_id: permission.capability_id,
    description: permission.description,
    capability_risk: permission.default_characteristics.capability_risk ?? CAPABILITY_RISK_LEVELS[0],
  };
  for (const key of ADMIN_BOOLEAN_KEYS) {
    if (permission.default_characteristics[key] === true) values[key] = 'on';
  }
  if (permission.delegatable) values.delegatable = 'on';
  return values;
}
