import { randomUUID } from 'node:crypto';
import type { DocumentStore } from '@xaa/gcp';

/**
 * A session that holds who the person is, and nothing they could act with.
 *
 * The Automation App's session carries four DPoP-bound Access Tokens, because that app
 * calls the Control Plane on the person's behalf. This one calls nothing: it reads the
 * detector's findings out of Firestore as itself and shows them. So the session is a
 * subject and an expiry, and there is no token in it to leak, misuse or have to refresh.
 *
 * Its own collection, not the Automation App's `sessions`. Two apps sharing one session
 * collection means a session id minted by either is honoured by both, which quietly
 * turns one login into access to the other screen — and the access matrix could no
 * longer tell the two apart.
 */
export interface ConsoleSession {
  session_id: string;
  human_subject: string;
  created_at: string;
  expires_at: string;
}

export const SESSION_COOKIE = 'xaa_console_session';
export const SESSION_TTL_SECONDS = 3600;

export interface SessionStore {
  create(humanSubject: string, now?: number): Promise<ConsoleSession>;
  find(sessionId: string): Promise<ConsoleSession | undefined>;
  destroy(sessionId: string): Promise<void>;
}

export function createSessionStore(documents: DocumentStore): SessionStore {
  return {
    async create(humanSubject, now = Date.now()) {
      const session: ConsoleSession = {
        session_id: randomUUID(),
        human_subject: humanSubject,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
      };
      await documents.set('console_sessions', session.session_id, session as unknown as Record<string, unknown>);
      return session;
    },
    async find(sessionId) {
      return documents.get<ConsoleSession>('console_sessions', sessionId);
    },
    async destroy(sessionId) {
      await documents.delete('console_sessions', sessionId);
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

export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}
