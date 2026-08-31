import type { ResponseState } from '../ai/output.js';

export const REVIEW_CONFIDENCE_FLOOR = 0.7;
export const REVIEW_REQUIRED_RESPONSES: readonly ResponseState[] = ['QUARANTINED', 'REVOKED', 'DESTROYED'];

/**
 * Which recommendations a person has to approve first.
 *
 * Two conditions, either of which is enough: the model was not confident, or the action
 * is one that stops an agent's work. Quarantining a legitimate agent costs somebody
 * their afternoon, and a model that is 60% sure is not a good enough reason to spend it.
 *
 * A fallback — the model gave nothing usable — is also held. Acting decisively on an
 * answer nobody produced is the worst of both.
 */
export function needsHumanReview(input: {
  response: ResponseState;
  confidence: number;
  fromFallback: boolean;
}): boolean {
  if (input.fromFallback) return true;
  if (input.confidence < REVIEW_CONFIDENCE_FLOOR) return true;
  return REVIEW_REQUIRED_RESPONSES.includes(input.response);
}
