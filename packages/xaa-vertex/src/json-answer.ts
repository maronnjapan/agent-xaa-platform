import AjvModule from 'ajv';
import type { GenerateJsonParams } from './index.js';

const Ajv = (AjvModule as unknown as { default?: new (options?: object) => import('ajv').default }).default ?? AjvModule as unknown as new (options?: object) => import('ajv').default;

/**
 * The one rule every provider answers to: a reply is the value the caller's schema
 * describes, or it is nothing.
 *
 * Each client parses its own transport and then comes here, so `null` means the same
 * thing whichever model was asked — the answer was unusable — and no caller has to
 * learn a second failure shape when the deployment switches provider.
 */
export function validateAnswer<T>(value: unknown, schema: object): T | null {
  const validate = new Ajv({ strict: false }).compile(schema);
  return validate(value) ? value as T : null;
}

/**
 * The JSON inside a reply that is not only JSON.
 *
 * An API that takes a response schema answers with the object and nothing else, and
 * this is a no-op for it. A command-line agent does not: `claude -p` and `codex exec`
 * write prose around the answer unless asked otherwise, and asking is not always
 * honoured. Scanning for the outermost balanced `{}` or `[]` recovers the answer
 * without a second round trip; a reply with none is `null`, which is the same
 * "unusable" every other failure produces.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try { return JSON.parse(trimmed); } catch { /* fall through to scanning */ }

  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through to scanning */ }
  }

  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = trimmed.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const character = trimmed[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === open) depth += 1;
      else if (character === close) {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

/**
 * What a provider without a schema-constrained response format has to say out loud.
 *
 * The Vertex, Anthropic and OpenAI clients hand the schema to the API and get a shape
 * back that already satisfies it. A command-line agent has no such channel, so the
 * schema travels in the prompt — and the instruction has to be blunt, because anything
 * the model adds around the object is text `extractJson` then has to guess at.
 */
export function jsonOnlyPrompt(params: GenerateJsonParams): string {
  return [
    params.prompt,
    '',
    '---',
    'Answer with one JSON value and nothing else: no explanation, no code fence, no preamble.',
    'It must validate against this JSON Schema:',
    JSON.stringify(params.schema),
  ].join('\n');
}
