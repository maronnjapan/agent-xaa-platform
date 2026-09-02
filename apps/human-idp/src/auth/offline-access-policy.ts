import {
  clientAllowsRefreshTokenGrant,
  type AuthorizationRequestParams,
  type ClientInfo,
  type OfflineAccessGrantedCallback,
} from '@maronn-openid-connect/core';
import type { BrowserSessionStorage, ConsentStorage } from '../oidc/store.js';
import { parseSessionId } from '../oidc/store.js';
import { AGENT_PLATFORM_CLIENT_ID } from '../config/clients.js';

export interface OfflineAccessDeps {
  consentStore: Pick<ConsentStorage, 'hasConsent'>;
  browserSessionStore: Pick<BrowserSessionStorage, 'get'>;
}

/**
 * RULE-51 / docs 05 §4.1. core grants offline_access only under prompt=consent.
 * Provisioning the second and every later agent must not re-show a consent screen,
 * so a recorded consent for `agent-platform` grants it too.
 *
 * The callback is built per request because the decision needs the session cookie,
 * which core's callback signature does not carry.
 *
 * Order: (1) client may hold refresh tokens, (2) prompt=consent, (3) only
 * agent-platform may skip the prompt, (4) a recorded consent covering the requested
 * scopes, (5) otherwise no.
 */
export interface OfflineAccessPolicy {
  forCookie(cookieHeader: string | null): OfflineAccessGrantedCallback;
  /**
   * True when the cookie resolves to a live browser session. "No session at all" is
   * login_required and belongs to core; only "session but no consent record" is the
   * interaction_required this policy is responsible for.
   */
  hasSession(cookieHeader: string | null): Promise<boolean>;
}

export function createOfflineAccessPolicy(deps: OfflineAccessDeps): OfflineAccessPolicy {
  const subjectOf = async (cookieHeader: string | null): Promise<string | undefined> => {
    const sessionId = parseSessionId(cookieHeader);
    if (!sessionId) return undefined;
    return (await deps.browserSessionStore.get(sessionId))?.subject;
  };
  return {
    forCookie: (cookieHeader) =>
      async (params: AuthorizationRequestParams, context: { promptValues: string[]; client: ClientInfo }) => {
        if (!clientAllowsRefreshTokenGrant(context.client)) return false;
        if (context.promptValues.includes('consent')) return true;
        if (context.client.clientId !== AGENT_PLATFORM_CLIENT_ID) return false;
        const subject = await subjectOf(cookieHeader);
        if (!subject) return false;
        const scopes = (params.scope ?? '').trim().split(/\s+/).filter(Boolean);
        return deps.consentStore.hasConsent(subject, context.client.clientId, scopes);
      },
    async hasSession(cookieHeader) { return (await subjectOf(cookieHeader)) !== undefined; },
  };
}
