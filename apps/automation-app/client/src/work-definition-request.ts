/**
 * The one shape a work definition is sent in, and the one place a form is read into it.
 *
 * Two screens carry the same form — the home screen and the standalone page — and both
 * post the same JSON to the same API the person's later actions use. Keeping the
 * conversion here is what stops a second, subtly different body from appearing when one
 * of the two screens is edited.
 */

export interface WorkDefinitionBody {
  purpose: string;
  description: string;
  operations: string[];
  user_confirmations: string[];
  safety_notes: string[];
  requested_lifetime_minutes: number;
}

/** One item per line: a person describing their own work writes a list, not JSON. */
export function toWorkDefinitionBody(read: (name: string) => string): WorkDefinitionBody {
  const lines = (name: string): string[] =>
    read(name).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return {
    purpose: read('purpose'),
    description: read('description'),
    operations: lines('operations'),
    user_confirmations: lines('user_confirmations'),
    safety_notes: lines('safety_notes'),
    requested_lifetime_minutes: Number(read('requested_lifetime_minutes')),
  };
}

export function readWorkDefinitionForm(form: HTMLFormElement): WorkDefinitionBody {
  const values = new FormData(form);
  return toWorkDefinitionBody((name) => String(values.get(name) ?? ''));
}

export interface CreatedWorkDefinition {
  ok: boolean;
  status: number;
  body: { work_definition_id?: string; error?: string };
}

/**
 * The bounds on the lifetime, and every other rule, are the server's. The browser
 * reports what it was told; it never decides that a draft was acceptable.
 */
export async function createWorkDefinition(body: WorkDefinitionBody): Promise<CreatedWorkDefinition> {
  const response = await fetch('/api/work-definitions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => ({})) as { work_definition_id?: string; error?: string },
  };
}
