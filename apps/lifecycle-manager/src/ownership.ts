import type { DocumentStore } from '@xaa/gcp';

export class ForbiddenSubject extends Error {
  readonly code = 'forbidden_subject';
}

export { AgentNotFound } from './status-writer.js';
import { AgentNotFound } from './status-writer.js';

/**
 * Whose agent this is, read before anything else happens to it.
 *
 * Unlike the Automation App — which answers 404 for both cases so nobody can probe for
 * other people's agents — the revoke API distinguishes them (REQ-07-025). The caller
 * here already holds a token for this platform and is asking about an id they were
 * given; telling them "that is not yours" is more useful than pretending it does not
 * exist, and reveals nothing they could not already infer.
 */
export async function assertAgentOwnership(input: {
  documents: DocumentStore;
  agentId: string;
  subject: string;
}): Promise<{ human_subject: string; status: string }> {
  const meta = await input.documents.get<{ human_subject?: string; status?: string }>(
    'agents', `${input.agentId}__meta`,
  );
  if (!meta) throw new AgentNotFound(input.agentId);
  if (meta.human_subject !== input.subject) throw new ForbiddenSubject(`forbidden_subject: ${input.agentId}`);
  return { human_subject: meta.human_subject, status: meta.status ?? 'CREATED' };
}
