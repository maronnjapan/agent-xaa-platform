import type { Session } from '../../src/auth/session-store.js';

/**
 * Deliberately uncompilable. DEC-ID-13 path (3): the screen holds the person's Access
 * Tokens only while they are in front of it, and never a Refresh Token — a refresh
 * token here would let this app keep acting as them after they closed the tab.
 *
 * The rule is kept by the shape of `Session` rather than by a review comment: the type
 * has no such field, so a session literal carrying one does not compile.
 * `session-and-auth.spec.ts` runs `tsc --noEmit -p` over this directory and fails if
 * this file ever starts compiling.
 */
export const session: Session = {
  session_id: 's-1',
  human_subject: 'testuser',
  id_token: 'id',
  access_tokens: {
    'automation-app': 'a',
    'authorization-platform': 'b',
    'agent-provisioner': 'c',
    'lifecycle-manager': 'd',
  },
  dpop_private_jwk: { kty: 'EC' },
  created_at: '2026-01-01T00:00:00.000Z',
  expires_at: '2026-01-01T01:00:00.000Z',
  refresh_token: 'rt-1',
};
