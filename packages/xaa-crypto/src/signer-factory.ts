import { decodeBase64UrlToString } from './base64url.js';
import { importPrivateJwk } from './keys.js';
import { createLocalEs256Signer } from './local-signer.js';
import type { Es256Signer } from './jws.js';

export async function createSignerFromEnv(env: NodeJS.ProcessEnv): Promise<Es256Signer> {
  switch (env.SIGNER_MODE) {
    case 'kms': {
      if (!env.KMS_KEY_VERSION || !env.KID_PREFIX) throw new Error('KMS signer configuration is incomplete');
      const { createKmsEs256Signer } = await import('./kms-signer.js');
      return createKmsEs256Signer({ keyVersionName: env.KMS_KEY_VERSION, kidPrefix: env.KID_PREFIX });
    }
    case 'local': {
      if (env.NODE_ENV === 'production') throw new Error('local signer is forbidden in production');
      if (!env.LOCAL_SIGNING_JWK || !env.KID_PREFIX) throw new Error('local signer configuration is incomplete');
      const jwk = JSON.parse(decodeBase64UrlToString(env.LOCAL_SIGNING_JWK));
      return createLocalEs256Signer({ privateKey: await importPrivateJwk(jwk), kid: env.KID_PREFIX });
    }
    default:
      throw new Error('invalid SIGNER_MODE');
  }
}
