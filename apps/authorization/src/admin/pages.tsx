import { AdminErrors, renderAdminPage, type AdminNavLink, type Element } from '@xaa/admin-ui';
import { CAPABILITY_RISK_LEVELS } from '@xaa/contracts';
import { ADMIN_BOOLEAN_KEYS, type AdminBooleanKey } from './permission.js';
import type { PermissionView } from './permission-store.js';
import type { HolderView } from './holder-store.js';

/**
 * The console's screens, as React components.
 *
 * They render to finished HTML and every one of them is a form the browser posts. That
 * is what lets the console work through `gcloud run services proxy`, which attaches the
 * administrator's identity token to whatever the page submits: there is no client-side
 * code that would have to obtain that token for itself, and nowhere in a browser it
 * could safely keep one.
 */

const NAV: readonly AdminNavLink[] = [
  { href: '/admin/permissions', label: '権限一覧' },
  { href: '/admin/permissions/new', label: '権限を作る' },
  { href: '/admin/holders', label: '保有者を決める' },
];

export const ADMIN_LABELS: Record<AdminBooleanKey | 'delegatable', string> = {
  sensitive_resource: '機微なリソース',
  admin_permission: '管理者権限',
  personal_data_access: '個人データを扱う',
  financial_operation: '金銭処理（full_isolation を強制する）',
  delegatable: 'Agent へ委譲してよい',
};

/**
 * The permission list.
 *
 * "マッピング先" is the column an administrator reads after creating a permission: a
 * capability with no resource behind it is one the Policy Engine can grant and the
 * Provisioner then refuses to build an agent for (`no_tool_for_capability`), so the
 * empty cell is the screen saying the work is only half done.
 */
export function permissionListPage(permissions: readonly PermissionView[]): string {
  return renderAdminPage({
    title: '権限一覧',
    nav: NAV,
    body: <PermissionList permissions={permissions} />,
  });
}

function PermissionList(props: { permissions: readonly PermissionView[] }): Element {
  return (
    <>
      {props.permissions.length === 0
        ? <p>権限がまだ1件もない。</p>
        : (
          <table>
            <thead>
              <tr>
                <th>capability_id</th><th>説明</th><th>リスク</th><th>特性</th>
                <th>委譲</th><th>マッピング先リソース</th><th>保有者</th>
              </tr>
            </thead>
            <tbody>
              {props.permissions.map((permission) => (
                <tr key={permission.capability_id}>
                  <td>
                    <a href={`/admin/permissions/${encodeURIComponent(permission.capability_id)}`}>
                      <code>{permission.capability_id}</code>
                    </a>
                  </td>
                  <td>{permission.description}</td>
                  <td>{String(permission.default_characteristics.capability_risk ?? '-')}</td>
                  <td>{statedCharacteristics(permission)}</td>
                  <td>{permission.delegatable ? '委譲可' : '委譲不可'}</td>
                  <td>
                    {permission.connector_ids.length === 0
                      ? <span className="note">未マッピング</span>
                      : permission.connector_ids.map((id, index) => (
                        <span key={id}>{index > 0 ? <br /> : null}<code>{id}</code></span>
                      ))}
                  </td>
                  <td>{permission.holders}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <p><a href="/admin/permissions/new">新しい権限を作る</a></p>
      {/*
        * Japanese runs without spaces, and JSX turns a line break between two pieces of
        * text into one. Every sentence below is therefore its own expression: adjacent
        * expressions are joined exactly as written, so a paragraph can be wrapped for
        * reading without wrapping showing up on the screen.
        */}
      <p className="note">
        {'権限をリソースへ結び付けるのは Agent Provisioner の '}
        <code>/admin/mappings</code>
        {' である（Tool / Connector Catalog を持つのは Provisioner であり、Authorization Platform は API の接続先を持たない）。'}
      </p>
      <p className="note">
        {'誰がその権限を持つかは '}
        <a href="/admin/holders">保有者を決める</a>
        {' 画面で変える。同じことは '}
        <code>pnpm perm:set &lt;human_subject&gt; &lt;capability_id&gt; grant</code>
        {' でもできる。どちらの経路でも、実行中の Agent の再評価が起きる。'}
      </p>
      <p className="note">seed をもう一度流すと、この画面での変更は <code>infra/seed/</code> の YAML の内容へ戻る。</p>
    </>
  );
}

export function permissionFormPage(options: {
  permission?: PermissionView;
  values?: Record<string, string | undefined>;
  errors?: readonly string[];
}): string {
  const editing = options.permission !== undefined;
  return renderAdminPage({
    title: editing ? `権限を編集する：${options.permission!.capability_id}` : '権限を作る',
    nav: NAV,
    body: (
      <PermissionForm
        {...(options.permission ? { permission: options.permission } : {})}
        values={options.values ?? valuesOf(options.permission)}
        errors={options.errors ?? []}
      />
    ),
  });
}

function PermissionForm(props: {
  permission?: PermissionView;
  values: Record<string, string | undefined>;
  errors: readonly string[];
}): Element {
  const permission = props.permission;
  const action = permission ? `/admin/permissions/${encodeURIComponent(permission.capability_id)}` : '/admin/permissions';
  return (
    <>
      <AdminErrors errors={props.errors} />
      <form className="stack" method="post" action={action}>
        {permission
          ? (
            <>
              <p>
                <code>{permission.capability_id}</code>
                {'（resource: '}<code>{permission.resource}</code>
                {', object: '}<code>{permission.object}</code>
                {', action: '}<code>{permission.action}</code>
                {'）'}
              </p>
              <p className="note">capability_id は変えられない。別の id にするのは、別の権限を作ることである。</p>
            </>
          )
          : (
            <>
              <label>
                capability_id
                <input
                  type="text"
                  name="capability_id"
                  defaultValue={props.values.capability_id ?? ''}
                  placeholder="resource.object.action"
                  required
                />
              </label>
              <p className="note">
                {'resource.object.action か resource.action の形で入れる。'}
                {'小文字とアンダースコアだけを使い、ベンダー名（google など）と HTTP メソッド名は使わない。'}
                {'resource / object / action は id から決まる。'}
              </p>
            </>
          )}
        <label>
          説明
          <input type="text" name="description" defaultValue={props.values.description ?? ''} required />
        </label>
        <label>
          capability_risk
          <select name="capability_risk" defaultValue={props.values.capability_risk ?? CAPABILITY_RISK_LEVELS[0]}>
            {CAPABILITY_RISK_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
        {[...ADMIN_BOOLEAN_KEYS, 'delegatable' as const].map((key) => (
          <label key={key}>
            <input type="checkbox" name={key} defaultChecked={props.values[key] === 'on'} />
            {` ${ADMIN_LABELS[key]}`}
          </label>
        ))}
        <p className="note">
          {'write_operation と external_communication はここにない。'}
          {'その2つは「この作業が何をするか」であり、Authorization AI が提案してよい唯一の範囲である（docs 03 §7）。'}
        </p>
        <button type="submit">{permission ? '保存する' : '作る'}</button>
      </form>
      <p><a href="/admin/permissions">一覧へ戻る</a></p>
      {permission
        ? (
          <div className="danger">
            <p>
              <a href={`/admin/permissions/${encodeURIComponent(permission.capability_id)}/delete`}>
                この権限を削除する
              </a>
            </p>
            <p className="note">誰かが持っている権限、リソースへマッピング済みの権限は削除できない。先に外す。</p>
          </div>
        )
        : null}
    </>
  );
}

/**
 * The question before a deletion, on a page of its own.
 *
 * The old console asked it with `confirm()` in an inline script, which is the one thing
 * on these screens that needed JavaScript to be safe. A page is better than a dialog
 * anyway: it can say what is about to be lost, and it survives a browser that runs no
 * script at all.
 */
export function permissionDeletePage(options: {
  permission: PermissionView;
  errors?: readonly string[];
}): string {
  const permission = options.permission;
  return renderAdminPage({
    title: `権限を削除する：${permission.capability_id}`,
    nav: NAV,
    body: (
      <>
        <AdminErrors errors={options.errors ?? []} />
        <p>
          <code>{permission.capability_id}</code>
          {`（${permission.description}）を削除する。`}
          {`保有者は ${permission.holders} 人、マッピング先は ${permission.connector_ids.length} 件である。`}
        </p>
        <p className="note">誰かが持っている権限、リソースへマッピング済みの権限は削除できない。先に外す。</p>
        <form className="inline" method="post" action={`/admin/permissions/${encodeURIComponent(permission.capability_id)}/delete`}>
          <button type="submit" className="destructive">削除する</button>
        </form>
        {' '}
        <a href={`/admin/permissions/${encodeURIComponent(permission.capability_id)}`}>やめる</a>
      </>
    ),
  });
}

/**
 * Who holds which permission, for one person at a time.
 *
 * The screen takes a subject rather than showing everybody's rows at once. A permission
 * is granted to a person, and every question an administrator has here — what may this
 * person delegate, what did I just take away — is asked about one person; a table of
 * every grant in the platform would answer none of them and would print the whole
 * membership of every capability to anyone who opened the page.
 */
export function holderPage(options: {
  humanSubject: string;
  holders?: readonly HolderView[];
  errors?: readonly string[];
  message?: string;
}): string {
  return renderAdminPage({
    title: '権限の保有者を決める',
    nav: NAV,
    body: (
      <HolderScreen
        humanSubject={options.humanSubject}
        holders={options.holders ?? []}
        errors={options.errors ?? []}
        {...(options.message ? { message: options.message } : {})}
      />
    ),
  });
}

function HolderScreen(props: {
  humanSubject: string;
  holders: readonly HolderView[];
  errors: readonly string[];
  message?: string;
}): Element {
  return (
    <>
      <AdminErrors errors={props.errors} />
      {props.message ? <p className="note">{props.message}</p> : null}
      <form className="owner-bar" method="get" action="/admin/holders">
        <label>
          human_subject
          {' '}
          <input type="text" name="human_subject" defaultValue={props.humanSubject} required />
        </label>
        <button type="submit">この人の権限を見る</button>
      </form>
      {props.humanSubject === ''
        ? <p>誰の権限を見るのかを入れる。Human IdP の <code>sub</code> をそのまま使う。</p>
        : (
          <>
            <h2><code>{props.humanSubject}</code> の権限</h2>
            <table>
              <thead>
                <tr><th>capability_id</th><th>説明</th><th>委譲</th><th>保有</th><th></th></tr>
              </thead>
              <tbody>
                {props.holders.map((holder) => (
                  <tr key={holder.capability_id}>
                    <td><code>{holder.capability_id}</code></td>
                    <td>{holder.description}</td>
                    <td>{holder.delegatable ? '委譲可' : '委譲不可'}</td>
                    <td>{holder.held ? `保有（${holder.granted_at ?? ''}）` : '未保有'}</td>
                    <td>
                      <form className="inline" method="post" action="/admin/holders">
                        <input type="hidden" name="human_subject" value={props.humanSubject} />
                        <input type="hidden" name="capability_id" value={holder.capability_id} />
                        <input type="hidden" name="action" value={holder.held ? 'revoke' : 'grant'} />
                        <button type="submit" className={holder.held ? 'destructive' : undefined}>
                          {holder.held ? '取り上げる' : '与える'}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">
              {'権限を取り上げると、その人の実行中の Agent はその場で再評価される（RULE-14）。'}
              {'与えたぶんは実行中の Agent には入らない。より広い権限で動かすには Agent を作り直す（RULE-13）。'}
            </p>
            <p className="note">
              {'一覧に出るのは Capability Taxonomy にある権限だけである。無い権限は先に'}
              <a href="/admin/permissions/new">権限を作る</a>
              {'。'}
            </p>
          </>
        )}
    </>
  );
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
