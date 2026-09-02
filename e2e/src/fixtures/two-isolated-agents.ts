import { assertPath, FirestoreGuardError } from '@xaa/gcp';

export const AGENT_A = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const AGENT_B = 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb';

/** `<short>` is the last twelve characters of the random part (00b §1). */
export const shortOf = (agentId: string): string => agentId.slice(-12);

export interface IsolatedAgent {
  agentId: string;
  /** The dedicated OP's runtime identity, `sa-op-<short>` (T-PROV-24). */
  opServiceAccount: string;
  /** The Execution's identity, `sa-agent-<short>`. */
  runtimeServiceAccount: string;
  idpConnectionId: string;
  registrationPath: string;
}

export function isolatedAgent(agentId: string): IsolatedAgent {
  const short = shortOf(agentId);
  return {
    agentId,
    opServiceAccount: `sa-op-${short}`,
    runtimeServiceAccount: `sa-agent-${short}`,
    idpConnectionId: `idpconn-${agentId}`,
    registrationPath: `agents/${agentId}/meta`,
  };
}

/** Two FULL_ISOLATION agents belonging to the same person, as docs 05 §5 poses it. */
export function twoIsolatedAgents(): { a: IsolatedAgent; b: IsolatedAgent; humanSubject: string } {
  return { a: isolatedAgent(AGENT_A), b: isolatedAgent(AGENT_B), humanSubject: 'testuser' };
}

/**
 * What a dedicated OP process may touch, given the agent it was created for.
 *
 * DEV-05: the refusal is the application's own path guard, not IAM. Both dedicated OPs
 * run the same image under the `agent-op` entry in the access matrix, so the matrix
 * alone permits every agent's registration path — the boundary between one agent and
 * another is the
 * binding this function applies on top of it.
 */
export function readAsDedicatedOp(boundAgentId: string, path: string): 'allowed' | 'denied' {
  try {
    assertPath('agent-op', 'read', path);
  } catch (error) {
    if (error instanceof FirestoreGuardError) return 'denied';
    throw error;
  }
  // The binding an OP carries is its own agent id; anything addressed to another agent
  // is refused before the read happens (`assertAgentBinding`).
  const owner = path.split('/')[1];
  return owner === undefined || owner === boundAgentId ? 'allowed' : 'denied';
}

/** The same read attempted by the shared OP, which is bound to no single agent. */
export function readAsSharedOp(path: string): 'allowed' | 'denied' {
  try {
    assertPath('agent-op', 'read', path);
    return 'allowed';
  } catch (error) {
    if (error instanceof FirestoreGuardError) return 'denied';
    throw error;
  }
}
