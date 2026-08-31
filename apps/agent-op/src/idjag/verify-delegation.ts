import { IdJagError } from '@maronn-openid-connect/experimental/id-jag';
import { AGENT_URN_PREFIX } from '@xaa/contracts';
import type { AgentRegistration } from '../store/types.js';

export const DELEGATION_FAILED = 'The delegation relationship could not be verified';

export interface DelegationInput {
  subjectSub: string;
  actorSub: string;
  registration: AgentRegistration;
  onMismatch?: (detail: { agentId: string; subjectSub: string; actorSub: string }) => void;
}

/**
 * RULE-49 / REQ-05-071, the check the ID-JAG draft §9.7 warns about by name: a valid
 * subject_token for user A must not be combined with an actor_token for an agent
 * delegated by user B.
 *
 * It cannot live inside actorTokenResolver — IdJagActorTokenResolverInput carries no
 * subject — so it sits at step 5, where subject and actor are both known (DEC-ID-07).
 * The registration is the one client authentication already fetched; Firestore is not
 * read a second time. There is no flag that skips this.
 */
export function verifyDelegation(input: DelegationInput): true {
  const agentId = input.actorSub.startsWith(AGENT_URN_PREFIX)
    ? input.actorSub.slice(AGENT_URN_PREFIX.length) : input.actorSub;
  if (input.registration.human_subject !== input.subjectSub) {
    input.onMismatch?.({ agentId, subjectSub: input.subjectSub, actorSub: input.actorSub });
    throw new IdJagError('invalid_grant', DELEGATION_FAILED);
  }
  return true;
}
