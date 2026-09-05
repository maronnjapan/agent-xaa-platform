/**
 * What each button on the home screen asks the server to do, and what to make of the
 * answer.
 *
 * The mapping is a table rather than a set of handlers so the four steps of the flow
 * read in one place, and so the browser half can be checked without a browser. Every
 * entry is a POST under `/api`, which is the same door the person's own session opens;
 * there is no second, form-encoded route into any of them.
 */

export type HomeAction = 'confirm' | 'submit' | 'approve' | 'provision';

const ACTION_PATHS: Record<HomeAction, (id: string) => string> = {
  confirm: (id) => `/api/work-definitions/${encodeURIComponent(id)}/confirm`,
  submit: (id) => `/api/work-definitions/${encodeURIComponent(id)}/submit`,
  approve: (id) => `/api/agent-definitions/${encodeURIComponent(id)}/approve`,
  provision: (id) => `/api/agent-definitions/${encodeURIComponent(id)}/provision`,
};

export function isHomeAction(value: string | null): value is HomeAction {
  return value !== null && value in ACTION_PATHS;
}

export function actionUrl(action: HomeAction, id: string): string {
  return ACTION_PATHS[action](id);
}

export interface ProvisionOutcome {
  kind: 'navigate' | 'reload';
  url?: string;
}

/**
 * Where the browser goes once the Provisioner has answered.
 *
 * A consent URL is followed rather than inspected: the Provisioner names it, and this
 * app never builds one of its own (RULE-37). An agent id means the agent exists, so the
 * person is taken to it. Anything else leaves the page to re-read its own state.
 */
export function afterProvision(body: { consent_url?: unknown; agent_id?: unknown }): ProvisionOutcome {
  if (typeof body.consent_url === 'string' && body.consent_url !== '') {
    return { kind: 'navigate', url: body.consent_url };
  }
  if (typeof body.agent_id === 'string' && body.agent_id !== '') {
    return { kind: 'navigate', url: `/agents/${encodeURIComponent(body.agent_id)}` };
  }
  return { kind: 'reload' };
}

/** A whole day, inclusive: the field holds a date and the documents hold instants. */
export function dayRange(from: string, to: string): { from: string; to: string } {
  return { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` };
}
