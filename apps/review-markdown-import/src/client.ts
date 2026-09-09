import type { WorkDefinition } from '@xaa/automation-app/src/work-definition/model';
import type { TodoRequest } from './todo.js';

/**
 * The one call this app makes: register a draft ToDo through the external API.
 *
 * The credential is an Access Token the Human IdP issued for this app (`aud=automation-app`,
 * scope `agent:operate`), presented on every call and nothing else — the same guard the
 * screen's session goes through, read from the `Authorization` header instead of a
 * cookie (docs 02 §6). This app neither obtains nor refreshes it; a person does that
 * once and hands it over, and an expired one is refused with a message that says so.
 *
 * Registration stops at the draft. Confirming the ToDo, approving what it may use and
 * creating the agent are each a person's click on the screen (RULE-08), and the API
 * offers no way to take them — which is why a token loose on a laptop cannot start an
 * agent, only propose work for one.
 */

export const TODOS_PATH = '/external/todos';

/** A refusal to report against one task, without stopping the run. */
export class AutomationAppRefusal extends Error {
  constructor(reason: string, readonly status?: number) {
    super(reason);
    this.name = 'AutomationAppRefusal';
  }
}

/**
 * What the app's refusal codes mean for someone running this command.
 *
 * The two that matter most are about the token, because it is the part that expires
 * while everything else stays correct, and "401" on its own sends people looking at the
 * wrong thing.
 */
const REASONS: Record<string, string> = {
  invalid_token: 'the access token is not valid any more; obtain a new one and set AUTOMATION_APP_ACCESS_TOKEN',
  insufficient_scope: 'the access token does not carry the agent:operate scope; request it and obtain a new token',
  invalid_request: 'the request body was not read as a ToDo',
  title_required: 'the task has no title',
  text_too_long: 'the task is longer than the ToDo allows',
  too_many_items: 'the task carries more items than the ToDo allows',
  invalid_priority: 'the priority is not one the app accepts',
  invalid_due_on: 'the due date is not a calendar day',
  lifetime_out_of_range: 'the requested lifetime is outside the platform bounds',
};

export interface AutomationApp {
  registerTodo(request: TodoRequest): Promise<WorkDefinition>;
}

export function createAutomationApp(options: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): AutomationApp {
  const call = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}${TODOS_PATH}`;
  return {
    async registerTodo(request) {
      let response: Response;
      try {
        response = await call(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
          body: JSON.stringify(request),
        });
      } catch (error) {
        throw new AutomationAppRefusal(`could not reach ${url}: ${(error as Error).message}`);
      }
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        const code = typeof body?.error === 'string' ? body.error : '';
        throw new AutomationAppRefusal(
          REASONS[code] ?? `the app refused the ToDo (${response.status}${code === '' ? '' : `: ${code}`})`,
          response.status,
        );
      }
      return body as unknown as WorkDefinition;
    },
  };
}
