import { describe, expect, it } from 'vitest';
import { assertAgentOwnership, assertPath, FirestoreGuardError } from '@xaa/gcp';
import { RUNTIME_ENV_KEYS } from '@xaa/contracts';
import {
  readAsDedicatedOp, readAsSharedOp, twoIsolatedAgents,
} from '../../src/fixtures/two-isolated-agents.js';

const { a, b } = twoIsolatedAgents();

/**
 * What the Agent Runtime process can and cannot reach.
 *
 * The three it cannot are held somewhere the Execution's service account has no role on:
 * the Human IdP Connection's refresh token is KMS-encrypted and `sa-agent-<short>` has
 * no decrypt permission, the ID-JAG signing key lives in KMS with no `cloudkms.signer`
 * binding, and the Resource AS signing key sits in a private GCS bucket the runtime
 * cannot read. On a deployed project each of those is a 403 from the API itself; the
 * table below is the same claim expressed as what the Execution is handed.
 */
const RUNTIME_REACH = {
  reachable: ['AGENT_CLIENT_PRIVATE_JWK', 'AGENT_OP_BASE_URL', 'TOOL_MANIFEST'],
  unreachable: ['KMS_IDP_CONNECTION_KEY', 'KMS_IDJAG_KEY', 'SIGNING_KEY_WRAP_KMS_KEY', 'KEY_BUCKET'],
} as const;

/**
 * T-SEC-37 / REQ-05-062. docs 05 §5, as assertions.
 *
 * Three cases, and the second is the interesting one: it passes because the platform
 * accepted the risk, not because the boundary holds. Writing it as a green test with the
 * words in its name is deliberate — an accepted risk that nobody wrote down becomes an
 * assumption, and an assumption becomes a surprise.
 *
 * The IAM half of case (c) is a live check: only a real project can answer 403. What is
 * fixed here is the shape — which credentials the Execution is given at all — so a
 * change that started handing a signing key to the runtime fails before deployment.
 */
describe('the blast radius of one compromised agent', () => {
  it('denies agent-a dedicated sa from reading agent-b registration', () => {
    // DEV-05: the refusal comes from the application's path guard, not from IAM. Both
    // dedicated OPs run the same image and the same service-account shape, so IAM cannot
    // tell one agent's OP from another's; the binding can.
    expect(readAsDedicatedOp(a.agentId, a.registrationPath)).toBe('allowed');
    expect(readAsDedicatedOp(a.agentId, b.registrationPath)).toBe('denied');
    expect(readAsDedicatedOp(a.agentId, `idp_connections/${b.idpConnectionId}`)).toBe('denied');

    // And the two identities really are distinct, which is what makes the pair separable.
    expect(a.opServiceAccount).not.toBe(b.opServiceAccount);
    expect(a.runtimeServiceAccount).not.toBe(b.runtimeServiceAccount);
  });

  it('allows shared op to read all standard registrations (accepted risk)', () => {
    // A STANDARD agent's OP is shared, so it is bound to no single agent and can read
    // every STANDARD registration. This is the accepted risk of not paying for a
    // dedicated OP per agent: isolation at this level is FULL_ISOLATION's job.
    expect(readAsSharedOp(a.registrationPath)).toBe('allowed');
    expect(readAsSharedOp(b.registrationPath)).toBe('allowed');
    // The boundary that does hold for the shared OP: collections that are not its own.
    expect(readAsSharedOp('documents/doc-1')).toBe('denied');
  });

  it('runtime cannot reach refresh token, id-jag signing key, resource as signing key', () => {
    for (const key of RUNTIME_REACH.unreachable) {
      // None of the three is among the values the Execution is given, so there is
      // nothing in the process to reach them with; on a deployed project the API answers
      // 403 to `sa-agent-<short>` for each.
      expect(RUNTIME_ENV_KEYS as readonly string[], key).not.toContain(key);
    }
    // Nor through Firestore: the runtime may not read another agent's anything, and the
    // connection collection is not in its matrix at all.
    expect(() => assertPath('agent-runtime', 'read', `idp_connections/${a.idpConnectionId}`))
      .toThrow(FirestoreGuardError);
    expect(() => assertAgentOwnership(a.agentId, b.agentId)).toThrow(FirestoreGuardError);
  });

  it('runtime can reach dpop key, client credential, access token', () => {
    // The Execution mints its own DPoP key in process, is handed the Agent Client
    // Credential, and holds the short-lived Access Token it exchanged for. All three
    // die with the Execution, which is what bounds the damage.
    for (const key of RUNTIME_REACH.reachable) {
      expect(RUNTIME_ENV_KEYS as readonly string[], key).toContain(key);
    }
    expect(() => assertPath('agent-runtime', 'read', `agents/${a.agentId}/meta`)).not.toThrow();
    expect(() => assertAgentOwnership(a.agentId, a.agentId)).not.toThrow();
  });
});
