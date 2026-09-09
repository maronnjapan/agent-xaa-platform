import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { TOOL_IDS } from '@xaa/contracts';
import { applyBridgedToolShape, GOOGLE_CALENDAR_EVENTS_PATH, GOOGLE_EVENT_ID_FIELD } from '../src/bridged-tool.js';
import { BRIDGED_CONNECTOR_ID } from '../src/connector-definitions.js';
import { resolveSeedPlaceholders } from '../src/resolve.js';
import { validateSeed, type ConnectorSeed, type ToolSeed } from '../src/validate.js';

const seedRoot = new URL('../../../infra/seed/', import.meta.url).pathname;

/** The endpoints as Terraform writes them in each mode (infra/envs/demo/locals-endpoints.tf). */
function endpointsFor(saas: string) {
  return {
    issuer: 'https://human-idp.test', jwks_url: 'https://jwks.test/jwks.json',
    xaa_token_url: 'https://agent-op.test', xaa_callback_url: 'https://agent-op-callback.test',
    subject_token_url: 'https://agent-op.test/xaa/subject-token',
    authorization_url: 'https://authorization.test', provisioner_url: 'https://provisioner.test',
    lifecycle_url: 'https://lifecycle.test',
    resource_docs_as_issuer: 'https://docs-as.test', resource_docs_api_url: 'https://docs-api.test',
    resource_finance_as_issuer: 'https://finance-as.test', resource_finance_api_url: 'https://finance-api.test',
    bridge_internal_url: 'https://google-bridge.test',
    stub_saas_op_issuer: saas,
    agent_max_lifetime_seconds: 86400, vertex_model: 'test-model', vertex_location: 'asia-northeast1',
    enable_google_bridge: true,
  } as never;
}

function calendarTool(saas: string): ToolSeed {
  return parse(resolveSeedPlaceholders(
    readFileSync(`${seedRoot}tools/stub.calendar.events.list.yaml`, 'utf8'), endpointsFor(saas),
  )) as ToolSeed;
}

const GOOGLE_ENV = { ENABLE_GOOGLE_BRIDGE: 'true', SAAS_CONNECTOR_MODE: 'google' };
const STUB_ENV = { ENABLE_GOOGLE_BRIDGE: 'true', SAAS_CONNECTOR_MODE: 'stub' };

const shaped = (env: Record<string, string>, saas: string): ToolSeed =>
  applyBridgedToolShape([calendarTool(saas)], env)[0]!;

type Api = { base_url: string; method: string; path: string };
type Response = { type: string; allowlist: string[] };

/**
 * The bridged Tool, in the shape the SaaS it is pointed at actually serves.
 *
 * `google` mode used to keep the stub's path, so the consent succeeded and the first
 * Tool call answered 404 — the platform proved its OAuth client and then stopped one
 * request short of reading anything.
 */
describe('the bridged calendar tool', () => {
  it('asks Google where Google keeps the events', () => {
    const tool = shaped(GOOGLE_ENV, 'https://www.googleapis.com');
    expect((tool.api as Api).base_url).toBe('https://www.googleapis.com');
    expect((tool.api as Api).path).toBe(GOOGLE_CALENDAR_EVENTS_PATH);
    // The URL the Runtime builds from the two, which is the one Google serves.
    expect(new URL((tool.api as Api).path, (tool.api as Api).base_url).toString())
      .toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  });

  it("copies Google's own name for an event id, and keeps the stub's", () => {
    const allowlist = (shaped(GOOGLE_ENV, 'https://www.googleapis.com').response_schema as Response).allowlist;
    expect(allowlist).toContain(GOOGLE_EVENT_ID_FIELD);
    expect(allowlist).toContain('event_id');
    // A copy list, not a deletion list: nothing beyond the two names is opened up.
    expect(allowlist.sort()).toEqual(['end', 'event_id', 'id', 'start', 'summary']);
  });

  it('leaves the stub mode exactly as the catalogue wrote it', () => {
    const onDisk = calendarTool('https://stub-saas-op.test');
    expect(shaped(STUB_ENV, 'https://stub-saas-op.test')).toEqual(onDisk);
    expect((onDisk.api as Api).path).toBe('/calendar/events');
  });

  it('leaves every tool that is not the bridged one alone', () => {
    const native: ToolSeed = {
      tool_id: 'internal.document.list', connector_id: 'internal-docs-api',
      required_capability: 'document.read',
      authorization: { type: 'native_xaa', audience: 'https://docs-as.test', resource: 'https://docs-api.test', scope: 'docs.read' },
      token_provider: null, api: { base_url: 'https://docs-api.test', method: 'GET', path: '/documents' },
      parameters: {},
    };
    expect(applyBridgedToolShape([native], GOOGLE_ENV)).toEqual([native]);
  });

  it('adds no ninth tool id and no second connector', () => {
    const tool = shaped(GOOGLE_ENV, 'https://www.googleapis.com');
    expect(tool.tool_id).toBe('stub.calendar.events.list');
    expect(TOOL_IDS).toContain(tool.tool_id);
    expect(tool.connector_id).toBe(BRIDGED_CONNECTOR_ID);
    // And the consent still asks for the platform's own scope, which the connector
    // definition's `scope_map` is what translates.
    expect(tool.authorization.scope).toBe('calendar.read');
    expect(tool.required_capability).toBe('calendar.event.read');
  });

  it('still passes the seed validation it would have to pass on disk', () => {
    const connector = parse(resolveSeedPlaceholders(
      readFileSync(`${seedRoot}connectors/stub-saas-calendar.yaml`, 'utf8'),
      endpointsFor('https://www.googleapis.com'),
    )) as ConnectorSeed;
    expect(() => validateSeed([connector], [shaped(GOOGLE_ENV, 'https://www.googleapis.com')])).not.toThrow();
  });

  it('does nothing at all when the bridge is off', () => {
    const tool = calendarTool('https://stub-saas-op.test');
    expect(applyBridgedToolShape([tool], { ENABLE_GOOGLE_BRIDGE: 'false', SAAS_CONNECTOR_MODE: 'google' }))
      .toEqual([tool]);
  });
});
