/** What a console screen was sent, as plain strings, whatever encoding carried it. */
export type AdminInput = Record<string, string | undefined>;

/**
 * Whether the caller wants JSON.
 *
 * A browser's form post announces `text/html` and gets a redirect; `curl` sending or
 * asking for JSON gets JSON. Nothing about authorisation depends on this — it decides
 * the shape of an answer the caller has already been allowed to have.
 */
export function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return false;
  return accept.includes('application/json') || (request.headers.get('content-type') ?? '').includes('application/json');
}

/**
 * The submitted fields, from either encoding, as plain strings.
 *
 * The consoles answer a browser and a script from one handler, so they need one reading
 * of what was sent. A boolean in JSON becomes `on`, which is what an HTML checkbox sends,
 * so the parser below it never has to know which of the two it is looking at.
 */
export async function readFormInput(request: Request): Promise<AdminInput> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await request.clone().json().catch(() => ({})) as Record<string, unknown>;
    const input: AdminInput = {};
    for (const [key, value] of Object.entries(body)) {
      input[key] = typeof value === 'boolean' ? (value ? 'on' : '') : value === undefined || value === null ? undefined : String(value);
    }
    return input;
  }
  const form = await request.clone().formData().catch(() => new FormData());
  const input: AdminInput = {};
  form.forEach((value, key) => { input[key] = typeof value === 'string' ? value : undefined; });
  return input;
}

/** An HTML checkbox is absent when unticked, so anything but a positive value is false. */
export function isChecked(value: string | undefined): boolean {
  return value === 'on' || value === 'true' || value === '1';
}
