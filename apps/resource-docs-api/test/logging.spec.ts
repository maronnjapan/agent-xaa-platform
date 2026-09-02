import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createLogger, expectLogFields } from '@xaa/logging';
import createApp from '../src/app.js';

/**
 * T-SEC-06. specs 5.1 asks the Resource API for seven fields on every access, and asks
 * for them on a refusal as loudly as on a success — a 403 with no line is a rule that
 * can never fire, because `authorization.status_error` counts exactly these rows.
 */
function api(lines: string[]) {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api');
  const app = createApp({
    documents,
    asIssuer: 'https://resource-docs-as.test',
    resourceUri: 'https://resource-docs-api.test',
    jwksUrl: 'https://storage.test/jwks.json',
    logger: createLogger('resource-docs-api', 'resource_api', (line) => { lines.push(line); }),
  });
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(new URL(path, 'https://resource-docs-api.test'), init));
}

describe('the Resource API access log', () => {
  it('emits seven access fields', async () => {
    const lines: string[] = [];
    // No Access Token: the guard refuses, and the log wraps the guard so the refusal is
    // written with the same seven fields a success would carry.
    const response = await api(lines)('/documents');
    expect(response.status).toBe(401);

    expect(lines).toHaveLength(1);
    const fields = expectLogFields(lines[0]!, 'resource_api.access');
    expect(Object.keys(fields).sort()).toEqual([
      'http_method', 'latency_ms', 'operation', 'outcome', 'resource', 'response_status', 'tool_id',
    ]);
    expect(fields.response_status).toBe(401);
    expect(fields.outcome).toBe('error:invalid_token');
  });

  it('names the subject as null rather than dropping the key when no token resolved', async () => {
    const lines: string[] = [];
    await api(lines)('/documents');
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.agent_id).toBeNull();
    expect(entry.human_subject).toBeNull();
    expect(entry.log_source).toBe('resource_api');
  });
});
