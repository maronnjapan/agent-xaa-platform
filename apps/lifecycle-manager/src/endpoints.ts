import { DISABLED_ENDPOINT, type PlatformEndpoints } from '@xaa/contracts';

export interface ResolvedEndpoints {
  agentOpUrl: string;
  provisionerUrl: string;
  docsAsUrl: string;
  financeAsUrl: string;
  bridgeUrl: string | null;
}

/**
 * Where the other services are, read once from the deployment's endpoints.json.
 *
 * No URL is written in this app's source. A hard-coded `*.run.app` would be wrong in
 * every environment but the one it was written for, and would silently address the
 * wrong project rather than failing.
 *
 * The Bridge may legitimately be absent: `enable_google_bridge=false` is the default,
 * and a missing URL there means "skip that step", not "misconfigured".
 */
export function resolveEndpoints(endpoints: PlatformEndpoints): ResolvedEndpoints {
  const read = (key: keyof PlatformEndpoints): string => {
    const value = endpoints[key];
    if (typeof value !== 'string') throw new Error(`endpoints.json is missing ${String(key)}`);
    return value;
  };
  const bridge = endpoints.bridge_internal_url;
  return {
    agentOpUrl: read('xaa_token_url').replace(/\/xaa\/token$/, ''),
    provisionerUrl: read('provisioner_url'),
    docsAsUrl: read('resource_docs_as_issuer'),
    financeAsUrl: read('resource_finance_as_issuer'),
    // `https://disabled.invalid` is how Terraform spells "no Bridge here": the schema
    // requires a URI, so absence cannot be an empty string. Taking it literally made
    // every quarantine and identity-disabled cleanup fail on a DNS lookup.
    bridgeUrl: typeof bridge === 'string' && bridge !== '' && bridge !== DISABLED_ENDPOINT ? bridge : null,
  };
}
