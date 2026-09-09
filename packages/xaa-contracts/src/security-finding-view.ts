import type { FromSchema } from 'json-schema-to-ts';
import { compile } from './schema/validator.js';

/**
 * docs 09 §5.6 and §6, as a person is shown them.
 *
 * Security Detection decides; this is the account of one decision, handed to the screen
 * that displays it. It is deliberately not the stored finding: the stored document also
 * carries the correlation ids of the events it was made from and the deviation records
 * the model reasoned over, and neither belongs in a browser (RULE-38). What is here is
 * the judgement itself — how the platform scored the window, what the model said about
 * it in four aspects, what it recommended, and whether a person still has to agree.
 *
 * Every human-readable string in it was written by the analyser at the moment it judged.
 * The screen orders these fields and folds them; it composes no sentence of its own
 * (RULE-54), so the wording of a past judgement never changes because a renderer did.
 *
 * The four vocabularies are restated here rather than imported from `security-detection`:
 * a package that apps depend on cannot depend back on one of them. `finding-view.spec.ts`
 * in that app pins each list equal to the one the detector actually writes.
 */
export const SECURITY_FINDING_TYPES = [
  'anomalous_agent_activity', 'potential_agent_compromise',
  'cross_agent_lateral_movement', 'platform_wide_isolation_breach',
] as const;
export type SecurityFindingType = (typeof SECURITY_FINDING_TYPES)[number];

export const SECURITY_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type SecurityRiskLevel = (typeof SECURITY_RISK_LEVELS)[number];

export const SECURITY_REVIEW_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type SecurityReviewStatus = (typeof SECURITY_REVIEW_STATUSES)[number];

export const SECURITY_RESPONSE_STATES = [
  'ACTIVE', 'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED',
] as const;
export type SecurityResponseState = (typeof SECURITY_RESPONSE_STATES)[number];

/**
 * Which of the three wrote what the screen is showing.
 *
 * `fallback` means the model returned nothing usable and the risk level alone decided.
 * It is on the wire because a screen that showed the two identically would present a
 * default as a conclusion, and a person reading 「隔離を推奨」 would believe something
 * had reasoned about their agent when nothing had.
 *
 * `rules` means no model was asked at all: the window scored LOW, so the mechanical
 * passes are the whole of what is known about it (docs 09 §5.5). It is a third value
 * rather than a null because null already means 「まだ分析されていません」 — a row still
 * on its way to the model — and a LOW row is never on its way anywhere. Telling a person
 * 「まだ」 about a row that is finished is the same lie in the other direction.
 */
export const SECURITY_ANALYSIS_SOURCES = ['model', 'fallback', 'rules'] as const;
export type SecurityAnalysisSource = (typeof SECURITY_ANALYSIS_SOURCES)[number];

const analysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['deviation', 'judgement', 'impact'],
  properties: {
    deviation: {
      type: 'object', additionalProperties: false, required: ['from_normal', 'capability_consistency'],
      properties: { from_normal: { type: 'string' }, capability_consistency: { type: 'string' } },
    },
    judgement: {
      type: 'object', additionalProperties: false,
      required: ['compromise_likelihood', 'false_positive_likelihood', 'causality'],
      properties: {
        compromise_likelihood: { type: 'string' },
        false_positive_likelihood: { type: 'string' },
        causality: { type: 'string' },
      },
    },
    impact: {
      type: 'object', additionalProperties: false, required: ['scope', 'op_propagation'],
      properties: { scope: { type: 'string' }, op_propagation: { type: 'string' } },
    },
  },
} as const;

export const securityFindingViewSchema = {
  $id: 'security-finding-view',
  type: 'object',
  additionalProperties: false,
  required: [
    'finding_id', 'finding_type', 'agent_id', 'human_subject', 'detected_at',
    'window_start', 'window_end', 'risk_score', 'risk_level', 'contributing_codes',
    'review_status', 'recommended_response', 'confidence', 'analysis_source',
    'analyzed_at', 'analysis',
  ],
  properties: {
    finding_id: { type: 'string', minLength: 1 },
    finding_type: { enum: SECURITY_FINDING_TYPES },
    agent_id: { type: ['string', 'null'] },
    human_subject: { type: 'string' },
    detected_at: { type: 'string' },
    window_start: { type: 'string' },
    window_end: { type: 'string' },
    risk_score: { type: ['integer', 'null'] },
    risk_level: { anyOf: [{ enum: SECURITY_RISK_LEVELS }, { type: 'null' }] },
    /** The rule hits the correlation gathered, as codes. Never free text. */
    contributing_codes: { type: 'array', items: { type: 'string' } },
    review_status: { enum: SECURITY_REVIEW_STATUSES },
    /** Null until the analysis stage has run for this finding. */
    recommended_response: { anyOf: [{ enum: SECURITY_RESPONSE_STATES }, { type: 'null' }] },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    analysis_source: { anyOf: [{ enum: SECURITY_ANALYSIS_SOURCES }, { type: 'null' }] },
    analyzed_at: { type: ['string', 'null'] },
    /** Null when the model gave nothing usable, which `analysis_source` also says. */
    analysis: { anyOf: [analysisSchema, { type: 'null' }] },
  },
} as const;

export const securityFindingListSchema = {
  $id: 'security-finding-list',
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: { findings: { type: 'array', items: securityFindingViewSchema } },
} as const;

export type SecurityFindingView = FromSchema<typeof securityFindingViewSchema>;
export type SecurityFindingList = FromSchema<typeof securityFindingListSchema>;

export const assertSecurityFindingView: (value: unknown) => asserts value is SecurityFindingView =
  compile<SecurityFindingView>(securityFindingViewSchema);

export const assertSecurityFindingList: (value: unknown) => asserts value is SecurityFindingList =
  compile<SecurityFindingList>(securityFindingListSchema);
