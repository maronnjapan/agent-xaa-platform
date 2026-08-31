import { randomUUID } from 'node:crypto';
import type { DocumentStore } from '@xaa/gcp';

/**
 * The audiences a session ever holds a token for.
 *
 * Three of them are the control plane the screen calls on the user's behalf. The
 * fourth is this app itself, which is what `require-user` checks to answer "who is
 * this". Nothing else belongs here — in particular there is no `agent-platform` token
 * and no refresh token, because those are the credentials that would let this app act
 * as the user after they have gone (DEC-ID-13, path 3).
 */
export const SESSION_TOKEN_AUDIENCES = [
  'automation-app', 'authorization-platform', 'agent-provisioner', 'lifecycle-manager',
] as const;

export type SessionAudience = (typeof SESSION_TOKEN_AUDIENCES)[number];

export interface Session {
  session_id: string;
  human_subject: string;
  id_token: string;
  access_tokens: Record<SessionAudience, string>;
  dpop_private_jwk: JsonWebKey;
  created_at: string;
  expires_at: string;
}

export const SESSION_FIELDS = [
  'session_id', 'human_subject', 'id_token', 'access_tokens', 'dpop_private_jwk', 'created_at', 'expires_at',
] as const;

export const SESSION_COOKIE = 'xaa_session';
export const SESSION_TTL_SECONDS = 3600;

export interface SessionStore {
  create(input: Omit<Session, 'session_id' | 'created_at' | 'expires_at'>, now?: number): Promise<Session>;
  find(sessionId: string): Promise<Session | undefined>;
  destroy(sessionId: string): Promise<void>;
}

export function createSessionStore(documents: DocumentStore): SessionStore {
  return {
    async create(input, now = Date.now()) {
      const session: Session = {
        session_id: randomUUID(),
        ...input,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
      };
      await documents.set('sessions', session.session_id, session as unknown as Record<string, unknown>);
      return session;
    },
    async find(sessionId) {
      return documents.get<Session>('sessions', sessionId);
    },
    async destroy(sessionId) {
      await documents.delete('sessions', sessionId);
    },
  };
}

export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}
