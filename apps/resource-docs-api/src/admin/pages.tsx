import { AdminErrors, renderAdminPage, type AdminNavLink, type Element } from '@xaa/admin-ui';
import { DOCUMENT_TYPES, type StoredDocument } from '@xaa/contracts';
import type { DocumentSummary } from '../store/documents.js';
import { toLocalInputValue } from './document-input.js';

/**
 * The document console's screens (docs 04 §2.1).
 *
 * Every screen is scoped to one owner, and the owner travels in the query string and in
 * a hidden field rather than being remembered anywhere. A console that held "the person
 * I am currently looking at" in a cookie would be one back button away from writing a
 * document into somebody else's name.
 *
 * They render to finished HTML and every one of them is a form the browser posts, which
 * is what lets the console work through `gcloud run services proxy`: the proxy attaches
 * the administrator's identity token to whatever the page submits, and there is no
 * client-side code that would have to obtain that token for itself.
 */

const LIST_PATH = '/admin/documents';

function nav(ownerSubject: string): readonly AdminNavLink[] {
  const owner = ownerSubject === '' ? '' : `?owner_subject=${encodeURIComponent(ownerSubject)}`;
  return [
    { href: `${LIST_PATH}${owner}`, label: 'ドキュメント一覧' },
    { href: `${LIST_PATH}/new${owner}`, label: 'ドキュメントを作る' },
  ];
}

/** The owner every screen is about, asked for the same way on each of them. */
function OwnerBar(props: { ownerSubject: string; type?: string }): Element {
  return (
    <form className="owner-bar" method="get" action={LIST_PATH}>
      <label>
        owner_subject
        {' '}
        <input type="text" name="owner_subject" defaultValue={props.ownerSubject} required />
      </label>
      <label>
        type
        {' '}
        <select name="type" defaultValue={props.type ?? ''}>
          <option value="">すべて</option>
          {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>
      <button type="submit">この人のドキュメントを見る</button>
    </form>
  );
}

export function documentListPage(options: {
  ownerSubject: string;
  type?: string;
  documents?: readonly DocumentSummary[];
  errors?: readonly string[];
}): string {
  const ownerSubject = options.ownerSubject;
  return renderAdminPage({
    title: 'ドキュメント',
    nav: nav(ownerSubject),
    body: (
      <>
        <AdminErrors errors={options.errors ?? []} />
        <OwnerBar ownerSubject={ownerSubject} {...(options.type ? { type: options.type } : {})} />
        {ownerSubject === ''
          ? <p>誰のドキュメントを見るのかを入れる。Human IdP の <code>sub</code> をそのまま使う。</p>
          : <OwnerDocuments ownerSubject={ownerSubject} documents={options.documents ?? []} />}
      </>
    ),
  });
}

function OwnerDocuments(props: { ownerSubject: string; documents: readonly DocumentSummary[] }): Element {
  const owner = `?owner_subject=${encodeURIComponent(props.ownerSubject)}`;
  return (
    <>
      <h2><code>{props.ownerSubject}</code> のドキュメント</h2>
      {props.documents.length === 0
        ? <p>この人のドキュメントはまだ1件もない。</p>
        : (
          <table>
            <thead>
              <tr><th>タイトル</th><th>type</th><th>occurred_at</th><th>document_id</th></tr>
            </thead>
            <tbody>
              {props.documents.map((document) => (
                <tr key={document.document_id}>
                  <td>
                    <a href={`${LIST_PATH}/${encodeURIComponent(document.document_id)}${owner}`}>
                      {document.title}
                    </a>
                  </td>
                  <td><code>{document.type}</code></td>
                  <td><time dateTime={document.occurred_at}>{document.occurred_at}</time></td>
                  <td><code>{document.document_id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <p><a href={`${LIST_PATH}/new${owner}`}>新しいドキュメントを作る</a></p>
      {/*
        * Japanese runs without spaces, and JSX turns a line break between two pieces of
        * text into one. Every sentence below is therefore its own expression: adjacent
        * expressions are joined exactly as written, so a paragraph can be wrapped for
        * reading without wrapping showing up on the screen.
        */}
      <p className="note">
        {'一覧は新しい順に最大 100 件までである。絞り込みは '}
        <code>type</code>
        {' で行う。'}
      </p>
    </>
  );
}

export function documentFormPage(options: {
  ownerSubject: string;
  document?: StoredDocument;
  values?: Record<string, string | undefined>;
  errors?: readonly string[];
}): string {
  const editing = options.document !== undefined;
  return renderAdminPage({
    title: editing ? `ドキュメントを編集する：${options.document!.title}` : 'ドキュメントを作る',
    nav: nav(options.ownerSubject),
    body: (
      <DocumentForm
        ownerSubject={options.ownerSubject}
        {...(options.document ? { document: options.document } : {})}
        values={options.values ?? valuesOf(options.document)}
        errors={options.errors ?? []}
      />
    ),
  });
}

function DocumentForm(props: {
  ownerSubject: string;
  document?: StoredDocument;
  values: Record<string, string | undefined>;
  errors: readonly string[];
}): Element {
  const document = props.document;
  const owner = `?owner_subject=${encodeURIComponent(props.ownerSubject)}`;
  const action = document ? `${LIST_PATH}/${encodeURIComponent(document.document_id)}` : LIST_PATH;
  return (
    <>
      <AdminErrors errors={props.errors} />
      <form className="stack" method="post" action={action}>
        <input type="hidden" name="owner_subject" value={props.ownerSubject} />
        {document
          ? (
            <>
              <input type="hidden" name="version" value={String(document.version)} />
              <p>
                <code>{document.document_id}</code>
                {'（owner: '}<code>{document.owner_subject}</code>
                {', type: '}<code>{document.type}</code>
                {`, version: ${document.version}）`}
              </p>
              <p className="note">
                {'変えられるのはタイトルと本文だけである。type と occurred_at は書いたときのままにする。'}
                {'API の PATCH がその2つを受け取らないので、画面だけが変えられると、画面と API が同じ行について違うことを言うことになる。'}
              </p>
            </>
          )
          : (
            <>
              <label>
                type
                {/*
                  * A closed list, because `type` is closed: the stored shape's `type` is
                  * an enum, so a free-text field would let somebody type a document this
                  * app then refuses to store.
                  */}
                <select name="type" defaultValue={props.values.type ?? DOCUMENT_TYPES[0]}>
                  {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label>
                occurred_at（空なら書いた時刻）
                <input type="datetime-local" name="occurred_at" defaultValue={props.values.occurred_at ?? ''} />
              </label>
            </>
          )}
        <label>
          タイトル
          <input type="text" name="title" defaultValue={props.values.title ?? ''} required />
        </label>
        <label>
          本文
          <textarea name="body" rows={12} defaultValue={props.values.body ?? ''} />
        </label>
        <button type="submit">{document ? '保存する' : '作る'}</button>
      </form>
      <p><a href={`${LIST_PATH}${owner}`}>一覧へ戻る</a></p>
      {document
        ? (
          <div className="danger">
            <p>
              <a href={`${LIST_PATH}/${encodeURIComponent(document.document_id)}/delete${owner}`}>
                このドキュメントを削除する
              </a>
            </p>
            <p className="note">
              {'削除できるのはこの画面だけである。Agent に委譲される '}
              <code>docs.write</code>
              {' は作成と更新までで、API に DELETE は無い。'}
            </p>
          </div>
        )
        : null}
    </>
  );
}

/**
 * The question before a deletion, on a page of its own.
 *
 * A document is the only thing in this app that cannot be got back, and a dialog raised
 * by a script is a confirmation that disappears with the script. A page can show what is
 * about to be lost, and it works in a browser running none.
 */
export function documentDeletePage(options: {
  ownerSubject: string;
  document: StoredDocument;
  errors?: readonly string[];
}): string {
  const document = options.document;
  const owner = `?owner_subject=${encodeURIComponent(options.ownerSubject)}`;
  return renderAdminPage({
    title: `ドキュメントを削除する：${document.title}`,
    nav: nav(options.ownerSubject),
    body: (
      <>
        <AdminErrors errors={options.errors ?? []} />
        <p>
          <code>{document.document_id}</code>
          {'（type: '}<code>{document.type}</code>
          {', owner: '}<code>{document.owner_subject}</code>
          {'）を削除する。元には戻せない。'}
        </p>
        <form className="inline" method="post" action={`${LIST_PATH}/${encodeURIComponent(document.document_id)}/delete`}>
          <input type="hidden" name="owner_subject" value={options.ownerSubject} />
          <button type="submit" className="destructive">削除する</button>
        </form>
        {' '}
        <a href={`${LIST_PATH}/${encodeURIComponent(document.document_id)}${owner}`}>やめる</a>
      </>
    ),
  });
}

/** An existing document, in the shape the form reads back. */
function valuesOf(document?: StoredDocument): Record<string, string | undefined> {
  if (!document) return {};
  return {
    type: document.type,
    title: document.title,
    body: document.body,
    occurred_at: toLocalInputValue(document.occurred_at),
  };
}
