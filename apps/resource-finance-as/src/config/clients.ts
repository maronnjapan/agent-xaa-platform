import type { ClientResolver, TokenClientInfo, TokenClientResolver } from '@maronn-openid-connect/core';
import { PLATFORM_CLIENT_ID } from '@xaa/contracts';

/**
 * One registered client, and no secret anywhere (DEC-ID-14 / T-RES-07).
 *
 * `tokenEndpointAuthMethod` is declared as `client_secret_post` only because
 * `authorizeIdJagRedemptionClient` refuses a client marked `none`. The secret is
 * never set and never compared: the token route bypasses the secret pipeline for
 * this grant and authenticates by proof of possession of the key in `cnf.jkt`.
 */
export function createAsClientResolver(): ClientResolver & TokenClientResolver {
  const client: TokenClientInfo = {
    clientId: PLATFORM_CLIENT_ID,
    clientType: 'confidential',
    grantTypes: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
    tokenEndpointAuthMethod: 'client_secret_post',
    redirectUris: [],
  } as unknown as TokenClientInfo;
  return { async findClient(clientId: string) { return clientId === PLATFORM_CLIENT_ID ? client as never : null; } };
}
