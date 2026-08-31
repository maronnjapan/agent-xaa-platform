import { RESOURCE_SCOPES, type CatalogTool } from '@xaa/contracts';

export interface XaaStaticConfig {
  allowed_audiences: string[];
  resources: string[];
  scopes: string[];
}

export class InvalidXaaConfig extends Error {
  constructor(reason: string) { super(`invalid_xaa_config: ${reason}`); }
}

/**
 * RULE-19. The three sets an Agent OP will check every request against, derived
 * only from the tools the agent actually has.
 *
 * A value that appears in no tool cannot appear here, which is what keeps the
 * agent's reach equal to its tool list rather than to its capability list.
 *
 * `resource` is an RFC 8707 absolute URI: https and no fragment. A fragment would
 * make byte-for-byte comparison at the Resource AS unreliable (DEC-ID-05).
 */
export function buildXaaConfig(tools: CatalogTool[]): XaaStaticConfig {
  const config: XaaStaticConfig = {
    allowed_audiences: [...new Set(tools.map((tool) => tool.authorization.audience))].sort(),
    resources: [...new Set(tools.map((tool) => tool.authorization.resource))].sort(),
    scopes: [...new Set(tools.map((tool) => tool.authorization.scope))].sort(),
  };

  for (const value of [...config.allowed_audiences, ...config.resources]) {
    let url: URL;
    try { url = new URL(value); } catch { throw new InvalidXaaConfig(`not a URI: ${value}`); }
    if (url.protocol !== 'https:') throw new InvalidXaaConfig(`not https: ${value}`);
    if (url.hash !== '') throw new InvalidXaaConfig(`carries a fragment: ${value}`);
  }
  for (const scope of config.scopes) {
    if (!(RESOURCE_SCOPES as readonly string[]).includes(scope)) throw new InvalidXaaConfig(`unknown scope: ${scope}`);
  }
  return config;
}
