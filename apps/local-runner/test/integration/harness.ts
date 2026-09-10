/**
 * What the two integration suites share: a browser and a scripted model.
 */
import type { VertexClient } from '@xaa/vertex';

/**
 * The model, scripted.
 *
 * Two calls make a decision (T-AUTHZ-12): the first structures the work into operations
 * and resources, the second proposes capabilities. Both answers are the ones
 * `infra/seed/human-permissions.yaml` grants `testuser`, so the decision under test is
 * the platform's intersection of proposal and entitlement rather than a refusal for
 * want of an answer.
 */
export function scriptedModel(): VertexClient {
  let calls = 0;
  return {
    async generateJson<T>(): Promise<T | null> {
      calls += 1;
      if (calls === 1) {
        return { operations: ['list_documents', 'read_document'], target_resources: ['documents'] } as T;
      }
      return {
        capabilities: ['document.read'],
        characteristics: { write_operation: false },
        confidence: 0.9,
      } as T;
    },
  };
}

/**
 * As much of a browser as these flows need: one cookie jar, redirects followed by
 * hand, and the two forms the Human IdP puts in front of a person filled in.
 *
 * It is a browser rather than a set of direct calls because the flows under test are
 * redirect flows. The login walks five authorization legs, and the provisioning walks
 * one more through the Agent OP's callback; skipping the hops would be testing a
 * different platform from the one a person uses.
 *
 * It sits beside the suites rather than inside one of them because both of them log in,
 * and a second copy of a cookie jar would be a second place for the login to be subtly
 * wrong.
 */
export function browser(idp: string): {
  jar: Map<string, string>;
  go(url: string, init?: RequestInit): Promise<Response>;
  walk(from: string): Promise<{ url: string; response: Response }>;
} {
  const jar = new Map<string, string>();
  const cookie = (): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const go = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string> | undefined), ...(jar.size ? { cookie: cookie() } : {}) },
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const index = pair!.indexOf('=');
      jar.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
    return response;
  };

  return {
    jar,
    go,
    /** Follows redirects, answering any IdP form on the way, until a page renders. */
    async walk(from: string) {
      let url = from;
      for (let hop = 0; hop < 40; hop += 1) {
        const response = await go(url);
        if (response.status >= 300 && response.status < 400) {
          url = new URL(response.headers.get('location')!, url).toString();
          continue;
        }
        if (!url.startsWith(idp)) return { url, response };
        const body = await response.text();
        const action = new URL(/<form[^>]*action="([^"]*)"/i.exec(body)?.[1] || url, url).toString();
        const payload = new URLSearchParams(Object.fromEntries(
          [...body.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)].map((match) => [
            /name="([^"]*)"/.exec(match[0])?.[1] ?? '', /value="([^"]*)"/.exec(match[0])?.[1] ?? '',
          ]),
        ));
        if (/type="password"/i.test(body)) {
          payload.set('username', 'testuser');
          payload.set('password', 'password');
        } else {
          payload.set('action', 'approve');
        }
        const posted = await go(action, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: payload.toString(),
        });
        if (posted.status < 300 || posted.status >= 400) throw new Error(`stalled at ${url} (${posted.status})`);
        url = new URL(posted.headers.get('location')!, action).toString();
      }
      throw new Error(`the walk from ${from} never settled`);
    },
  };
}

export interface Session {
  agent: ReturnType<typeof browser>;
  base: string;
}

export async function login(base: string, idp: string): Promise<Session> {
  const agent = browser(idp);
  await agent.walk(`${base}/login`);
  if (!agent.jar.has('xaa_session')) throw new Error('the login finished without a session cookie');
  return { agent, base };
}

export async function api(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  return session.agent.go(`${session.base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}
