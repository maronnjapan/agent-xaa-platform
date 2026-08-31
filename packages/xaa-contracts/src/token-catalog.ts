export const TOKEN_CATALOG = {
  human_id_token_login: { typ: 'JWT', dpop: false },
  human_access_token: { typ: 'at+jwt', dpop: true },
  human_id_token_xaa: { typ: 'JWT', dpop: false },
  human_refresh_token_xaa: { typ: 'opaque', dpop: false },
  agent_assertion: { typ: 'agent-assertion+jwt', dpop: false },
  id_jag: { typ: 'oauth-id-jag+jwt', dpop: true },
  native_resource_access_token: { typ: 'at+jwt', dpop: true },
  saas_access_token: { typ: 'opaque', dpop: false },
} as const;

export type TokenCatalogKey = keyof typeof TOKEN_CATALOG;
