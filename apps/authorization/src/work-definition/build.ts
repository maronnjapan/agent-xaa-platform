import { randomUUID } from 'node:crypto';
import type { VertexClient } from '../ai/authorization-ai.js';

export interface WorkDefinition {
  work_definition_id: string;
  purpose: string;
  description: string;
  operations: string[];
  target_resources: string[];
  constraints: Record<string, unknown>;
  human_subject: string;
  created_at: string;
}

export interface DroppedValues {
  dropped_operation: string[];
  dropped_target_resource: string[];
}

const MAX_OPERATIONS = 10;

const workDefinitionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operations', 'target_resources'],
  properties: {
    operations: { type: 'array', items: { type: 'string' } },
    target_resources: { type: 'array', items: { type: 'string' } },
    /** How the model read the work, in Japanese, for the timeline. Decides nothing. */
    note: { type: 'string' },
  },
} as const;

/** Anything in the model's prose that would tell someone where or how to call something. */
const NOTE_TECHNICAL_MARKERS = ['https://', 'http://', 'endpoint', 'base_url', 'oauth', 'bearer', 'token_url'];
const NOTE_MAX_LENGTH = 1200;

/**
 * REQ-03-002. Turns the human's request into a work definition.
 *
 * `target_resources` is narrowed to the resource column of the capability taxonomy,
 * which is read once at the start of the request and passed in. Anything else the
 * model names is dropped and recorded — Automation App never learns the resource
 * list, and the model cannot introduce one.
 *
 * Dropping everything is allowed: whether that means "nothing to grant" is decided
 * later, by the taxonomy filter, not here.
 */
export async function buildWorkDefinition(
  request: { purpose: string; description: string; constraints?: Record<string, unknown>; humanSubject: string },
  deps: { vertex: VertexClient; allowedResources: Set<string>; now: () => number },
): Promise<{ workDefinition: WorkDefinition; dropped: DroppedValues; note?: string }> {
  const raw = await deps.vertex.generateJson<{ operations?: unknown; target_resources?: unknown; note?: unknown }>({
    prompt: [
      'あなたは業務内容を構造化する担当です。',
      '次の業務内容から、想定される操作と対象リソースを抽出してください。',
      'note には、どう読み取ったかを日本語で一文か二文で書いてください。URL や接続先は書かないでください。',
      `目的: ${request.purpose}`,
      `内容: ${request.description}`,
    ].join('\n'),
    schema: workDefinitionSchema,
    maxOutputTokens: 512,
    temperature: 0,
  });

  const dropped: DroppedValues = { dropped_operation: [], dropped_target_resource: [] };

  const seen = new Set<string>();
  const operations: string[] = [];
  for (const value of Array.isArray(raw?.operations) ? raw.operations : []) {
    if (typeof value !== 'string') continue;
    const normalised = value.trim().toLowerCase().replace(/[^a-z_]+/g, '_').replace(/^_+|_+$/g, '');
    if (normalised === '' || seen.has(normalised)) continue;
    if (operations.length >= MAX_OPERATIONS) { dropped.dropped_operation.push(value); continue; }
    seen.add(normalised);
    operations.push(normalised);
  }

  const targetResources: string[] = [];
  for (const value of Array.isArray(raw?.target_resources) ? raw.target_resources : []) {
    if (typeof value !== 'string') continue;
    if (deps.allowedResources.has(value)) targetResources.push(value);
    else dropped.dropped_target_resource.push(value);
  }

  // The model's own account of its reading, kept only when it says nothing technical.
  const note = typeof raw?.note === 'string' ? raw.note.trim().slice(0, NOTE_MAX_LENGTH) : '';
  const clean = note !== '' && !NOTE_TECHNICAL_MARKERS.some((marker) => note.toLowerCase().includes(marker));

  return {
    ...(clean ? { note } : {}),
    workDefinition: {
      work_definition_id: `wd_${randomUUID()}`,
      purpose: request.purpose,
      description: request.description,
      operations,
      target_resources: [...new Set(targetResources)],
      constraints: request.constraints ?? {},
      human_subject: request.humanSubject,
      created_at: new Date(deps.now()).toISOString(),
    },
    dropped,
  };
}
