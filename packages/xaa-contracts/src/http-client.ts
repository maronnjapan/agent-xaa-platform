import { createDpopProofForResource, type Es256KeyPair } from '@xaa/crypto';
import type { PlatformEndpoints } from './schema/platform-endpoints.schema.js';
import type { ServiceId } from './service-ids.js';

export type Transport = (serviceId: ServiceId, request: Request) => Promise<Response>;

export interface DpopOptions {
  accessToken: string;
  keyPair: Es256KeyPair;
  now?: () => number;
}

export interface HttpClient {
  request(serviceId: ServiceId, path: string, init?: RequestInit): Promise<Response>;
  requestUrl(url: string, path: string, init?: RequestInit): Promise<Response>;
}

const endpointKey: Record<ServiceId, keyof PlatformEndpoints> = {
  'human-idp': 'issuer',
  'shared-agent-op': 'xaa_token_url',
  'agent-op-callback': 'xaa_callback_url',
  'automation-app': 'issuer',
  provisioner: 'provisioner_url',
  authorization: 'authorization_url',
  lifecycle: 'lifecycle_url',
  'resource-docs-as': 'resource_docs_as_issuer',
  'resource-docs-api': 'resource_docs_api_url',
  'resource-finance-as': 'resource_finance_as_issuer',
  'resource-finance-api': 'resource_finance_api_url',
  'stub-saas-op': 'stub_saas_op_issuer',
  'google-bridge': 'bridge_internal_url',
};

let installedTransport: Transport | undefined;
export function setTransport(transport: Transport): void {
  if (installedTransport) throw new Error('transport already set');
  installedTransport = transport;
}
export function resetTransportForTesting(): void { installedTransport = undefined; }

export function createHttpClient(options: {
  endpoints: PlatformEndpoints;
  transport?: Transport;
  dpop?: DpopOptions;
  identityTokenProvider?: (audience: string) => Promise<string>;
  timeoutMs?: number;
}): HttpClient {
  async function build(url: URL, init: RequestInit = {}): Promise<Request> {
    const headers = new Headers(init.headers);
    if (options.dpop) {
      headers.set('Authorization', `DPoP ${options.dpop.accessToken}`);
      headers.set('DPoP', await createDpopProofForResource({
        method: init.method ?? 'GET', url: url.toString(), keyPair: options.dpop.keyPair,
        accessToken: options.dpop.accessToken, ...(options.dpop.now ? { now: options.dpop.now } : {}),
      }));
    } else if (options.identityTokenProvider) {
      headers.set('Authorization', `Bearer ${await options.identityTokenProvider(url.origin)}`);
    }
    return new Request(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  }
  return {
    async request(serviceId, path, init) {
      const base = options.endpoints[endpointKey[serviceId]];
      if (typeof base !== 'string') throw new Error(`endpoint unavailable: ${serviceId}`);
      const request = await build(new URL(path, base), init);
      return (options.transport ?? installedTransport ?? ((_, req) => globalThis.fetch(req)))(serviceId, request);
    },
    async requestUrl(url, path, init) {
      const request = await build(new URL(path, url), init);
      return globalThis.fetch(request);
    },
  };
}
