import { isSignalKind, type WorkSignal, type WorkSignalSource } from './work-signal-source.js';

interface DocumentSummary {
  document_id: string;
  type: string;
  title: string;
  occurred_at: string;
}

/**
 * Reads the user's own documents as work signals.
 *
 * The call goes out with the Automation App's own service identity, not through an
 * agent's ID-JAG: this is the app reading on behalf of the person in front of it,
 * before any agent exists. Routing it through the XAA path would need an agent to
 * delegate from, which is the thing being decided.
 *
 * The list endpoint omits `body`, so a second request per document fetches it — only
 * when the caller asked for bodies, since a suggestion run over a month of documents
 * would otherwise make a request per row.
 */
export function createDocumentRsSource(input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  authorization(): Promise<string>;
  withBody?: boolean;
}): WorkSignalSource {
  const send = input.fetchImpl ?? globalThis.fetch;
  return {
    async fetch(params) {
      const url = new URL('/documents', input.baseUrl);
      url.searchParams.set('from', params.from);
      url.searchParams.set('to', params.to);
      const authorization = await input.authorization();
      const response = await send(url.toString(), { headers: { Authorization: authorization } });
      if (!response.ok) return [];
      const body = await response.json() as { documents?: DocumentSummary[] };
      const signals: WorkSignal[] = [];
      for (const summary of body.documents ?? []) {
        if (!isSignalKind(summary.type)) continue;
        signals.push({
          source_kind: summary.type,
          occurred_at: summary.occurred_at,
          human_subject: params.humanSubject,
          title: summary.title,
          body: input.withBody === false ? '' : await readBody(summary.document_id),
          metadata: { document_id: summary.document_id },
        });
      }
      return signals;

      async function readBody(documentId: string): Promise<string> {
        const detail = await send(new URL(`/documents/${documentId}`, input.baseUrl).toString(), {
          headers: { Authorization: authorization },
        });
        if (!detail.ok) return '';
        return (await detail.json() as { body?: string }).body ?? '';
      }
    },
  };
}
