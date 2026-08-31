import { compile } from '@xaa/contracts';
import type { RiskLevel } from '../correlate/finding.js';

export const RESPONSE_STATES = ['ACTIVE', 'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED'] as const;
export type ResponseState = (typeof RESPONSE_STATES)[number];

export interface AiOutput {
  deviation: { from_normal: string; capability_consistency: string };
  judgement: { compromise_likelihood: string; false_positive_likelihood: string; causality: string };
  impact: { scope: string; op_propagation: string };
  recommendation: { response: ResponseState; confidence: number };
}

export const securityAiOutputSchema = {
  $id: 'security-ai-output',
  type: 'object',
  additionalProperties: false,
  required: ['deviation', 'judgement', 'impact', 'recommendation'],
  properties: {
    deviation: {
      type: 'object', additionalProperties: false, required: ['from_normal', 'capability_consistency'],
      properties: { from_normal: { type: 'string' }, capability_consistency: { type: 'string' } },
    },
    judgement: {
      type: 'object', additionalProperties: false,
      required: ['compromise_likelihood', 'false_positive_likelihood', 'causality'],
      properties: {
        compromise_likelihood: { type: 'string' }, false_positive_likelihood: { type: 'string' },
        causality: { type: 'string' },
      },
    },
    impact: {
      type: 'object', additionalProperties: false, required: ['scope', 'op_propagation'],
      properties: { scope: { type: 'string' }, op_propagation: { type: 'string' } },
    },
    recommendation: {
      type: 'object', additionalProperties: false, required: ['response', 'confidence'],
      properties: { response: { enum: RESPONSE_STATES }, confidence: { type: 'number', minimum: 0, maximum: 1 } },
    },
  },
} as const;

const assertOutput: (value: unknown) => asserts value is AiOutput = compile<AiOutput>(securityAiOutputSchema);

/**
 * Reads the model's answer, or decides there isn't one.
 *
 * Never throws. A model that returns prose, or a fourth aspect nobody asked for, or a
 * confidence of 1.4, is a model that did not answer — and the response to that is the
 * fallback below, not an exception that takes the detection run down with it.
 */
export function parseAiOutput(raw: string): AiOutput | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  try {
    assertOutput(parsed);
  } catch { return null; }
  return parsed;
}

/**
 * What to do when the model said nothing usable.
 *
 * Decided from the risk level alone, which is a number the platform computed itself. It
 * is deliberately more cautious than nothing and less drastic than the model's own
 * ceiling: a CRITICAL finding quarantines, a HIGH one raises suspicion, and a MEDIUM one
 * is recorded. There is no retry, because a model that failed to produce JSON once will
 * usually do it again, and the delay costs more than the second attempt is worth.
 */
export function fallbackResponse(level: RiskLevel): ResponseState {
  if (level === 'CRITICAL') return 'QUARANTINED';
  if (level === 'HIGH') return 'SUSPICIOUS';
  return 'ACTIVE';
}
