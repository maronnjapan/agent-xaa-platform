import { webcrypto } from 'node:crypto';
import { encodeBase64Url, verifyGoogleServiceIdentity } from '@xaa/crypto';

export interface LocalServiceIdentity {
  /** A token for `audience`, asserting the caller is `email`. */
  mint(audience: string, email: string): Promise<string>;
  /** The provider shape the applications take: audience in, token out. */
  tokenProviderFor(email: string): (audience: string) => Promise<string>;
  /** Resolves a bearer token to the caller's service-account email, or null. */
  verify(token: string, audience: string): Promise<string | null>;
}

/**
 * Cloud Run's service-to-service identity, minted and checked on this machine.
 *
 * A caller on GCP asks the metadata server for a Google-signed ID Token naming the
 * destination as its audience, and the receiving app resolves it to a service-account
 * email through `verifyGoogleServiceIdentity`. There is no metadata server here, so the
 * tokens are signed with a key this process generates — and then verified by the very
 * same function the deployment uses, against a JWK Set served over `fetchImpl` rather
 * than fetched from Google.
 *
 * That distinction is the point. The audience check, the expiry check and the signature
 * check all still happen, so a local platform refuses the same calls the deployed one
 * refuses: a token minted for the Provisioner does not open the Lifecycle Manager, and
 * an email that is not on a service's allow-list is turned away.
 */
export async function createLocalServiceIdentity(): Promise<LocalServiceIdentity> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const kid = 'local-service-identity';
  const certs = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] };
  // Stands in for https://www.googleapis.com/oauth2/v3/certs and nothing else: it
  // answers one document and never reaches the network.
  const fetchImpl = (async () => Response.json(certs)) as unknown as typeof fetch;

  const mint = async (audience: string, email: string): Promise<string> => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const signingInput = [
      encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })),
      encodeBase64Url(JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: audience,
        azp: email,
        sub: email,
        email,
        email_verified: true,
        iat: issuedAt,
        exp: issuedAt + 3600,
      })),
    ].join('.');
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  };

  return {
    mint,
    tokenProviderFor: (email) => (audience) => mint(audience, email),
    async verify(token, audience) {
      try {
        const claims = await verifyGoogleServiceIdentity(token, { audience, fetchImpl });
        return typeof claims.email === 'string' ? claims.email : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The service accounts, spelled as they are on GCP.
 *
 * `infra/envs/demo/locals-sa.tf` names one per service and the applications compare
 * emails against those names, so the local platform uses the same shape: a check that
 * passed here because everything called itself `local` would not be the check the
 * deployment makes.
 */
export function serviceAccounts(projectId: string): Readonly<Record<string, string>> {
  const email = (name: string) => `sa-${name}@${projectId}.iam.gserviceaccount.com`;
  return {
    humanIdp: email('human-idp'),
    automationApp: email('automation-app'),
    analysisConsole: email('analysis-console'),
    authorization: email('authorization'),
    provisioner: email('provisioner'),
    lifecycle: email('lifecycle'),
    sharedAgentOp: email('shared-agent-op'),
    security: email('security'),
    scheduler: email('scheduler'),
    pubsubPush: email('pubsub-push'),
    agentRuntime: email('agent-runtime'),
    googleBridge: email('google-bridge'),
    resourceDocsAs: email('resource-docs-as'),
    resourceDocsApi: email('resource-docs-api'),
    resourceFinanceAs: email('resource-finance-as'),
    resourceFinanceApi: email('resource-finance-api'),
    seed: email('seed'),
  };
}
