import { BRIDGED_CONNECTOR_ID, type ConnectorDefinitionEnv } from './connector-definitions.js';
import type { ToolSeed } from './validate.js';

/**
 * Where Google serves the calendar the stub serves at `/calendar/events`.
 *
 * `primary` is the signed-in person's own calendar. The Bridge hands the Runtime an
 * Access Token minted for that person, so this is the one calendar the token opens and
 * there is nothing to parameterise.
 */
export const GOOGLE_CALENDAR_EVENTS_PATH = '/calendar/v3/calendars/primary/events';

/**
 * Google names an event `id`; the stub names it `event_id`.
 *
 * Added to the allow list rather than swapped for it. The list is a copy list, not a
 * deletion list (REQ-04-023): a name that is not in the response is simply not copied,
 * so carrying both leaves the stub's projection unchanged and does not make the file a
 * place where one SaaS's field names can quietly reach the other.
 */
export const GOOGLE_EVENT_ID_FIELD = 'id';

interface ShapedTool extends ToolSeed {
  api: { base_url: string; method: string; path: string };
  response_schema: { type: string; allowlist: string[] };
}

/**
 * The one bridged Tool, in the shape the SaaS this deployment points at actually serves.
 *
 * The catalogue holds one calendar Tool and 00b fixes the eight Tool ids, so `google`
 * mode cannot bring a Tool of its own — and until now it did not need to be able to,
 * because the call was never expected to land: the Tool kept the stub's path, Google
 * answered 404, and `google` mode was documented as proving the consent and stopping
 * there.
 *
 * What actually differs between the two SaaS is two strings, and neither is an identity:
 * where the events live under the host, and what the events call their own id. Both are
 * applied here, to the row the seed is about to write, so the Tool id, the connector id,
 * the required Capability and the scope the consent asks for stay exactly what the
 * catalogue says in both modes.
 *
 * `stub` mode is untouched, and so is every non-bridged Tool: this returns the rows it
 * was given unless the deployment is pointed at Google.
 */
export function applyBridgedToolShape(tools: ToolSeed[], env: ConnectorDefinitionEnv): ToolSeed[] {
  if (env.ENABLE_GOOGLE_BRIDGE !== 'true') return tools;
  if ((env.SAAS_CONNECTOR_MODE ?? 'stub') !== 'google') return tools;

  return tools.map((tool) => {
    if (tool.connector_id !== BRIDGED_CONNECTOR_ID) return tool;
    const shaped = tool as ShapedTool;
    const allowlist = shaped.response_schema.allowlist;
    return {
      ...shaped,
      api: { ...shaped.api, path: GOOGLE_CALENDAR_EVENTS_PATH },
      response_schema: {
        ...shaped.response_schema,
        allowlist: allowlist.includes(GOOGLE_EVENT_ID_FIELD) ? allowlist : [...allowlist, GOOGLE_EVENT_ID_FIELD],
      },
    };
  });
}
