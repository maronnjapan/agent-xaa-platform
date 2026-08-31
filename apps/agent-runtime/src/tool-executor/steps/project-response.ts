type Path = string[];

function parsePath(entry: string): Path {
  const arrayMatch = /^([a-z_][a-z0-9_]*)\[\]\.([a-z_][a-z0-9_]*)$/.exec(entry);
  return arrayMatch ? [arrayMatch[1]!, '[]', arrayMatch[2]!] : [entry];
}

function copyPath(source: unknown, path: Path, target: Record<string, unknown>): void {
  const [head, ...rest] = path;
  if (head === undefined || !source || typeof source !== 'object') return;
  const record = source as Record<string, unknown>;
  if (rest.length === 0) {
    if (head in record) target[head] = record[head];
    return;
  }
  const value = record[head];
  if (rest[0] === '[]') {
    if (!Array.isArray(value)) return;
    const existing = Array.isArray(target[head]) ? target[head] as Record<string, unknown>[] : [];
    value.forEach((element, index) => {
      existing[index] ??= {};
      copyPath(element, rest.slice(1), existing[index]!);
    });
    target[head] = existing;
    return;
  }
  const nested = (target[head] as Record<string, unknown>) ?? {};
  copyPath(value, rest, nested);
  target[head] = nested;
}

function pick(source: unknown, paths: Path[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const path of paths) copyPath(source, path, output);
  return output;
}

/**
 * step7. The model sees a new object built from the allow list, never the response
 * with fields removed.
 *
 * Copying rather than deleting is the whole design (REQ-04-023). A `delete`-based
 * filter has to enumerate everything it does not want, so a field the resource adds
 * next month reaches the model by default; a copy-based one reaches nothing it was
 * not told to reach. That is what keeps `attendees[].email` out of a calendar summary
 * without anyone having thought about email addresses.
 *
 * Traversal stops where the allow list stops: an unlisted branch is never even walked.
 */
export function projectResponse(
  schema: { type: string; allowlist: readonly string[] },
  body: unknown,
): unknown {
  const paths = schema.allowlist.map(parsePath);
  if (schema.type !== 'array') return pick(body, paths);

  if (Array.isArray(body)) return body.map((element) => pick(element, paths));
  if (!body || typeof body !== 'object') return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (Array.isArray(value)) output[key] = value.map((element) => pick(element, paths));
  }
  return output;
}
