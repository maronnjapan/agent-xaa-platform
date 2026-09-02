export interface ConnectorDefinition {
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
}

/**
 * A connector is data, not code.
 *
 * docs 06 §1 says other OAuth SaaS are added "the same way". That is only true if
 * adding one is a Firestore row — so this schema is the whole of what a connector is,
 * and no vendor's name appears anywhere in the Bridge's source.
 *
 * `resource_uris` is not in the docs' field list but has to exist: `/token` carries no
 * connector id in its path, so the ID-JAG's `resource` claim is the only thing that
 * says which connector a request is about.
 */
export const connectorDefinitionSchema = {
  $id: 'connector-definition',
  type: 'object',
  additionalProperties: false,
  required: [
    'connector_id', 'display_name', 'authorization_endpoint', 'token_endpoint',
    'revocation_endpoint', 'userinfo_endpoint', 'client_id', 'secret_name',
    'default_scopes', 'subject_claim', 'connection_max_age_seconds', 'resource_uris',
  ],
  properties: {
    connector_id: { type: 'string', minLength: 1 },
    display_name: { type: 'string', minLength: 1 },
    // https only, all four: an http endpoint would put a client secret and an
    // authorization code on the wire in clear.
    authorization_endpoint: { type: 'string', pattern: '^https://' },
    token_endpoint: { type: 'string', pattern: '^https://' },
    revocation_endpoint: { type: 'string', pattern: '^https://' },
    userinfo_endpoint: { type: 'string', pattern: '^https://' },
    client_id: { type: 'string', minLength: 1 },
    // The name of a secret, never the secret: it is read from Secret Manager per call.
    secret_name: { type: 'string', minLength: 1 },
    default_scopes: { type: 'array', items: { type: 'string' } },
    subject_claim: { type: 'string', minLength: 1 },
    connection_max_age_seconds: { type: 'integer', minimum: 60 },
    resource_uris: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  },
} as const;
