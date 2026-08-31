import { compile } from '@xaa/contracts';

export interface BridgeTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export const tokenResponseSchema = {
  $id: 'bridge-token-response',
  type: 'object',
  additionalProperties: false,
  required: ['access_token', 'token_type', 'expires_in', 'scope'],
  properties: {
    access_token: { type: 'string', minLength: 1 },
    token_type: { const: 'Bearer' },
    expires_in: { type: 'integer', minimum: 1 },
    scope: { type: 'string' },
  },
} as const;

const assertResponse: (value: unknown) => asserts value is BridgeTokenResponse =
  compile<BridgeTokenResponse>(tokenResponseSchema);

/**
 * Four keys, built fresh.
 *
 * The SaaS response is not spread into this: a provider that returns a refresh token
 * alongside the access token would otherwise hand the agent a long-lived credential,
 * which is the one thing the Bridge exists to prevent (RULE-22).
 *
 * `token_type` is `Bearer` and the type says so. DEC-ID-13: DPoP is how this platform
 * binds its own tokens, and a token minted by an external SaaS is presented the way
 * that SaaS expects. There is no `cnf` here and no branch that adds one.
 */
export function buildTokenResponse(input: {
  accessToken: string;
  expiresIn: number;
  scope: readonly string[];
}): BridgeTokenResponse {
  const response: BridgeTokenResponse = {
    access_token: input.accessToken,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor(input.expiresIn)),
    scope: [...input.scope].sort().join(' '),
  };
  // Checked against its own schema before it leaves: a fifth key here would be a
  // credential leak, so the response is refused rather than sent.
  assertResponse(response);
  return response;
}
