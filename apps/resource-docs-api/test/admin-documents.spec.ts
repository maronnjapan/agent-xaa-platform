import { describe, expect, it } from 'vitest';
import { DOCUMENT_TYPES, type StoredDocument } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createApp from '../src/app.js';
import { createDocumentRepository } from '../src/store/documents.js';
import { ADMIN_DOCUMENT_ROUTES } from '../src/routes/admin-documents.js';
import { parseDocumentCreate } from '../src/admin/document-input.js';

const BASE = 'https://resource-docs-api.test';
const ADMIN_PRINCIPAL = 'admin@example.test';
const OWNER = 'testuser';

interface Harness {
  documents: DocumentStore;
  logs: string[];
  /** The same request, carrying a token for whoever is named (the admin by default). */
  asAdmin(path: string, init?: RequestInit & { principal?: string }): Promise<Response>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  seed(input?: Partial<{ ownerSubject: string; type: string; title: string; body: string }>): Promise<string>;
}

function harness(options: { adminPrincipals?: string[] } = {}): Harness {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api');
  const logs: string[] = [];
  const app = createApp({
    documents,
    asIssuer: 'https://resource-docs-as.test',
    resourceUri: BASE,
    jwksUrl: 'https://storage.test/jwks.json',
    logger: createLogger('resource-docs-api', 'resource_api', (line) => { logs.push(line); }),
    publicBaseUrl: BASE,
    adminPrincipals: options.adminPrincipals ?? [ADMIN_PRINCIPAL],
    /**
     * Stands in for Google's OIDC verification: the token is the account it was minted
     * for, and a token minted for another service's URL resolves to nobody, so the
     * audience check the real verifier makes is still the thing being exercised.
     */
    verifyAdmin: async (token, audience) => (audience === BASE ? token : null),
  });
  const repository = createDocumentRepository(documents);
  return {
    documents,
    logs,
    fetch: (path, init) => app.fetch(new Request(new URL(path, BASE), init)),
    asAdmin: (path, init = {}) => {
      const { principal = ADMIN_PRINCIPAL, ...request } = init;
      return app.fetch(new Request(new URL(path, BASE), {
        ...request,
        headers: { ...(request.headers as Record<string, string> | undefined), Authorization: `Bearer ${principal}` },
      }));
    },
    seed: (input = {}) => repository.create({
      ownerSubject: input.ownerSubject ?? OWNER,
      type: input.type ?? 'note',
      title: input.title ?? '既にある文書',
      body: input.body ?? '本文',
    } as Parameters<typeof repository.create>[0]),
  };
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

function form(values: Record<string, string>): RequestInit {
  return { method: 'POST', headers: FORM, body: new URLSearchParams(values).toString() };
}

function json(values: Record<string, unknown>): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(values) };
}

function logLines(test: Harness): Array<{ event: string; fields: Record<string, unknown> }> {
  return test.logs.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });
}

async function stored(test: Harness, documentId: string): Promise<StoredDocument | undefined> {
  return test.documents.get<StoredDocument>('documents', documentId);
}

describe('the document console is reachable only by an administrator', () => {
  it('refuses a request with no token, an unlisted account, or a token for another service', async () => {
    const test = harness();
    const anonymous = await test.fetch('/admin/documents', { headers: { accept: 'application/json' } });
    const stranger = await test.asAdmin('/admin/documents', {
      headers: { accept: 'application/json' }, principal: 'sa-agent-runtime@xaa-test.iam.gserviceaccount.com',
    });

    expect(anonymous.status).toBe(403);
    expect(stranger.status).toBe(403);
    // The same body either way: the refusal must not answer whether an account is one
    // of the platform's administrators.
    expect(await anonymous.json()).toEqual({ error: 'admin_only' });
    expect(await stranger.json()).toEqual({ error: 'admin_only' });
    expect(logLines(test).filter((line) => line.event === 'admin.refused')).toHaveLength(2);
  });

  /**
   * An unconfigured deployment is closed, not open: `ADMIN_PRINCIPALS` is a list of who
   * may in, and an empty list names nobody rather than everybody.
   */
  it('is reachable by nobody when no principal is configured', async () => {
    const test = harness({ adminPrincipals: [] });
    expect((await test.asAdmin('/admin/documents', { headers: { accept: 'application/json' } })).status).toBe(403);
  });

  /**
   * The console is a second door on the same rows, not a hole in the first one: an
   * agent's path into this app is still the DPoP-protected `/documents`, and an
   * administrator's token gets nowhere near it.
   */
  it('leaves the XAA-protected surface untouched', async () => {
    const test = harness();
    const asAgent = await test.asAdmin('/documents', { headers: { accept: 'application/json' } });
    expect(asAgent.status).toBe(401);
    expect(ADMIN_DOCUMENT_ROUTES.every((route) => route.path.startsWith('/admin'))).toBe(true);
  });

  it('serves the stylesheet from behind the same guard', async () => {
    const test = harness();
    expect((await test.fetch('/admin/console.css')).status).toBe(403);
    const styled = await test.asAdmin('/admin/console.css');
    expect(styled.status).toBe(200);
    expect(styled.headers.get('content-type')).toContain('text/css');
  });
});

describe('the document list', () => {
  it('shows one owner\'s documents and nobody else\'s', async () => {
    const test = harness();
    await test.seed({ title: '本人のもの' });
    await test.seed({ ownerSubject: 'someone-else', title: '他人のもの' });

    const response = await test.asAdmin(`/admin/documents?owner_subject=${OWNER}`, { headers: { accept: 'application/json' } });
    const body = await response.json() as { owner_subject: string; documents: Array<{ title: string }> };

    expect(response.status).toBe(200);
    expect(body.owner_subject).toBe(OWNER);
    expect(body.documents.map((document) => document.title)).toEqual(['本人のもの']);
  });

  it('narrows by type', async () => {
    const test = harness();
    await test.seed({ type: 'note', title: 'メモ' });
    await test.seed({ type: 'daily_report', title: '日報' });

    const response = await test.asAdmin(`/admin/documents?owner_subject=${OWNER}&type=daily_report`, {
      headers: { accept: 'application/json' },
    });
    const body = await response.json() as { documents: Array<{ title: string }> };
    expect(body.documents.map((document) => document.title)).toEqual(['日報']);
  });

  it('renders the list as a page a browser can use', async () => {
    const test = harness();
    await test.seed({ title: '読める文書' });
    const response = await test.asAdmin(`/admin/documents?owner_subject=${OWNER}`, { headers: { accept: 'text/html' } });
    const html = await response.text();

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('読める文書');
    expect(html).toContain('/admin/documents/new');
  });

  it('asks for an owner instead of listing everybody', async () => {
    const test = harness();
    await test.seed();
    const html = await (await test.asAdmin('/admin/documents', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('owner_subject');
    expect(html).not.toContain('既にある文書');
  });
});

describe('creating a document', () => {
  it('writes it under the owner the screen names, at version 1', async () => {
    const test = harness();
    const response = await test.asAdmin('/admin/documents', json({
      owner_subject: OWNER, type: 'note', title: '手で書いた文書', body: '中身',
    }));

    expect(response.status).toBe(201);
    const { document_id: documentId } = await response.json() as { document_id: string };
    const document = await stored(test, documentId);
    expect(document).toMatchObject({ owner_subject: OWNER, type: 'note', title: '手で書いた文書', body: '中身', version: 1 });
  });

  it('sends a browser back to that owner\'s list', async () => {
    const test = harness();
    const response = await test.asAdmin('/admin/documents', form({
      owner_subject: OWNER, type: 'note', title: 'フォームから', body: '',
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/admin/documents?owner_subject=${OWNER}`);
  });

  /**
   * `type` is an enum in the stored shape, so a value outside it is not a document that
   * gets written and refused — it is an assertion failing under the console. The screen
   * has to be the thing that says no.
   */
  it('refuses a type the stored shape does not have, writing nothing', async () => {
    const test = harness();
    const response = await test.asAdmin('/admin/documents', json({
      owner_subject: OWNER, type: 'invoice', title: 't', body: 'b',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(await test.documents.listAll('documents')).toHaveLength(0);
  });

  it('reports every problem at once rather than the first', () => {
    const parsed = parseDocumentCreate({ owner_subject: '', type: 'invoice', title: '' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.errors).toHaveLength(3);
  });

  it('offers only the types the stored shape has', () => {
    const parsed = parseDocumentCreate({ owner_subject: OWNER, type: DOCUMENT_TYPES[0], title: 't', body: 'b' });
    expect(parsed.ok).toBe(true);
  });

  it('records who made the change and whose document it was', async () => {
    const test = harness();
    await test.asAdmin('/admin/documents', json({ owner_subject: OWNER, type: 'note', title: 't', body: 'b' }));
    const line = logLines(test).find((entry) => entry.event === 'admin.document_changed')!;
    expect(line.fields).toMatchObject({ action: 'create', admin_principal: ADMIN_PRINCIPAL });
  });
});

describe('editing a document', () => {
  it('changes the title and the body, and moves the version on', async () => {
    const test = harness();
    const documentId = await test.seed({ title: '前', body: '前の本文' });

    const response = await test.asAdmin(`/admin/documents/${documentId}`, json({
      owner_subject: OWNER, version: 1, title: '後', body: '後の本文',
    }));

    expect(response.status).toBe(200);
    expect(await stored(test, documentId)).toMatchObject({ title: '後', body: '後の本文', version: 2 });
  });

  /**
   * Two administrators with the same document open. The second save must not be the one
   * that silently wins: it is refused, and the screen shows what is stored now.
   */
  it('refuses a save written against a version that has moved', async () => {
    const test = harness();
    const documentId = await test.seed({ title: '前' });
    await test.asAdmin(`/admin/documents/${documentId}`, json({ owner_subject: OWNER, version: 1, title: '一人目', body: '' }));

    const late = await test.asAdmin(`/admin/documents/${documentId}`, json({
      owner_subject: OWNER, version: 1, title: '二人目', body: '',
    }));

    expect(late.status).toBe(409);
    expect(await stored(test, documentId)).toMatchObject({ title: '一人目' });
  });

  it('will not edit another owner\'s document, and does not confirm it exists', async () => {
    const test = harness();
    const documentId = await test.seed({ ownerSubject: 'someone-else', title: '他人のもの' });

    const read = await test.asAdmin(`/admin/documents/${documentId}?owner_subject=${OWNER}`, { headers: JSON_HEADERS });
    const written = await test.asAdmin(`/admin/documents/${documentId}`, json({
      owner_subject: OWNER, version: 1, title: '奪う', body: '',
    }));

    expect(read.status).toBe(404);
    expect(written.status).toBe(404);
    expect(await stored(test, documentId)).toMatchObject({ title: '他人のもの' });
  });
});

describe('deleting a document', () => {
  it('asks before it deletes, and the asking changes nothing', async () => {
    const test = harness();
    const documentId = await test.seed({ title: '消される文書' });

    const question = await test.asAdmin(`/admin/documents/${documentId}/delete?owner_subject=${OWNER}`, {
      headers: { accept: 'text/html' },
    });

    expect(question.status).toBe(200);
    expect(await question.text()).toContain('消される文書');
    expect(await stored(test, documentId)).toBeDefined();
  });

  it('removes the row, and says so once', async () => {
    const test = harness();
    const documentId = await test.seed();

    const first = await test.asAdmin(`/admin/documents/${documentId}/delete`, json({ owner_subject: OWNER }));
    const second = await test.asAdmin(`/admin/documents/${documentId}/delete`, json({ owner_subject: OWNER }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(await stored(test, documentId)).toBeUndefined();
    expect(logLines(test).filter((line) => line.fields.action === 'delete')).toHaveLength(1);
  });

  /**
   * Every form carries the owner in a hidden field, so a write that arrives without one
   * did not come from a screen — and is a request that cannot be carried out rather than
   * a question about whose documents to show.
   */
  it('refuses a write that names no owner', async () => {
    const test = harness();
    const documentId = await test.seed();
    const html = await test.asAdmin(`/admin/documents/${documentId}/delete`, {
      method: 'POST', headers: FORM, body: '',
    });

    expect(html.status).toBe(400);
    expect(await stored(test, documentId)).toBeDefined();
  });

  it('will not delete another owner\'s document', async () => {
    const test = harness();
    const documentId = await test.seed({ ownerSubject: 'someone-else' });
    const response = await test.asAdmin(`/admin/documents/${documentId}/delete`, json({ owner_subject: OWNER }));

    expect(response.status).toBe(404);
    expect(await stored(test, documentId)).toBeDefined();
  });
});
