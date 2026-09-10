import { RESOURCE_SCOPES, type PlatformEndpoints } from '@xaa/contracts';

/**
 * The one bridged connector the catalogue has (00b: the three connector ids are fixed).
 *
 * Both SaaS modes write their definition under this id, because it is the id the
 * Provisioner names. The Provisioner reads `catalog_connectors`, finds the bridged
 * connector a Tool belongs to, and asks the Bridge for `stub-saas-calendar`; the Bridge
 * looks that up in `connector_definitions` and refuses `invalid_target` if the row is
 * called anything else. A definition written under a second name of its own — which is
 * what `google` mode did — is a row nothing ever asks for, and every Google consent
 * stopped at the first call with the catalogue and the definitions each holding half of
 * a connector.
 *
 * Which SaaS is behind the id is the row's own content: `display_name` says it to a
 * person, and the four endpoints, the client and the scope map say it to the Bridge.
 */
export const BRIDGED_CONNECTOR_ID = 'stub-saas-calendar';
export const CONNECTOR_DEFINITIONS = 'connector_definitions';

/**
 * The keys the Bridge reads (T-BRIDGE-02, apps/google-bridge/src/connectors/types.ts).
 * A definition never carries the client secret: `secret_name` is the Secret Manager
 * resource the Bridge reads on every call.
 */
export interface ConnectorDefinitionRow {
  connector_id: string;
  display_name: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  userinfo_endpoint: string;
  client_id: string;
  secret_name: string;
  default_scopes: string[];
  subject_claim: string;
  connection_max_age_seconds: number;
  resource_uris: string[];
  /** Optional thirteenth key: this platform's scope names to the SaaS's own. */
  scope_map?: Record<string, string>;
}

/**
 * The Job's environment (infra/envs/demo/jobs.tf). The keys read here are PROJECT_ID,
 * ENABLE_GOOGLE_BRIDGE, SAAS_CONNECTOR_MODE, GOOGLE_OAUTH_CLIENT_ID, STUB_BRIDGE_SECRET_ID
 * and GOOGLE_OAUTH_SECRET_ID; the type is process.env's so the Job can pass it through.
 */
export type ConnectorDefinitionEnv = Record<string, string | undefined>;

/** The client the stub SaaS accepts (apps/stub-saas-op/src/index.ts). */
export const STUB_BRIDGE_CLIENT_ID = 'stub-bridge-client';

const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** The scope the stub calendar tool asks for; the name lives in the shared table (00b), not here. */
const STUB_CALENDAR_SCOPE = RESOURCE_SCOPES.find((scope) => scope.startsWith('calendar.'))!;

/** What Google calls the same thing. The only vendor string in this file. */
const GOOGLE_CALENDAR_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * The rows the seed writes into `connector_definitions`.
 *
 * The Bridge only reads this collection (T-BRIDGE-02), so a deployment that enables it
 * has to be given its one destination by the same Job that gives the Provisioner its
 * catalogue; otherwise every consent starts with `invalid_target`. With the Bridge off
 * the list is empty and the collection is purged, the same way the bridged catalogue
 * rows are left out (DEC-SCOPE-04).
 *
 * The stub row points at the deployed stub SaaS, and its `resource_uris` is exactly the
 * `authorization.resource` of the stub calendar tool: `/token` carries no connector id,
 * so the ID-JAG's `resource` claim is how the Bridge finds the row.
 */
export function bridgeConnectorDefinitions(env: ConnectorDefinitionEnv, endpoints: PlatformEndpoints): ConnectorDefinitionRow[] {
  if (env.ENABLE_GOOGLE_BRIDGE !== 'true') return [];
  const projectId = env.PROJECT_ID;
  if (!projectId) throw new Error('PROJECT_ID is required to name the connector secrets');
  const mode = env.SAAS_CONNECTOR_MODE ?? 'stub';
  if (mode === 'stub') {
    const issuer = endpoints.stub_saas_op_issuer.replace(/\/$/, '');
    const secretId = env.STUB_BRIDGE_SECRET_ID;
    if (!secretId) throw new Error('STUB_BRIDGE_SECRET_ID is required in stub mode');
    return [{
      connector_id: BRIDGED_CONNECTOR_ID,
      display_name: 'Stub SaaS Calendar',
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      userinfo_endpoint: `${issuer}/userinfo`,
      client_id: STUB_BRIDGE_CLIENT_ID,
      secret_name: `projects/${projectId}/secrets/${secretId}`,
      default_scopes: [STUB_CALENDAR_SCOPE],
      subject_claim: 'sub',
      connection_max_age_seconds: THIRTY_DAYS,
      resource_uris: [`${issuer}/calendar`],
    }];
  }
  if (mode === 'google') {
    const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
    const secretId = env.GOOGLE_OAUTH_SECRET_ID;
    if (!clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID is required in google mode');
    if (!secretId) throw new Error('GOOGLE_OAUTH_SECRET_ID is required in google mode');
    // The same `resource_uris` the stub row carries, because it is the catalogue Tool's
    // `authorization.resource` and that claim is how `/token` finds this row — the
    // Bridge matches whole strings and has no other handle. Pointing it at Google's own
    // API host instead would name a resource no ID-JAG ever carries.
    const resource = `${endpoints.stub_saas_op_issuer.replace(/\/$/, '')}/calendar`;
    return [{
      connector_id: BRIDGED_CONNECTOR_ID,
      display_name: 'Google Calendar',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      client_id: clientId,
      secret_name: `projects/${projectId}/secrets/${secretId}`,
      default_scopes: [GOOGLE_CALENDAR_READONLY],
      subject_claim: 'sub',
      connection_max_age_seconds: THIRTY_DAYS,
      resource_uris: [resource],
      // Google has never heard of `calendar.read`, and answers a consent request
      // carrying it with `invalid_scope` — a screen the person cannot get past. The
      // Bridge translates at the boundary and keeps one vocabulary inside
      // (apps/google-bridge/src/scope/provider-scope.ts).
      scope_map: { [STUB_CALENDAR_SCOPE]: GOOGLE_CALENDAR_READONLY },
    }];
  }
  throw new Error(`unknown SAAS_CONNECTOR_MODE: ${mode}`);
}
