import { assertRegisteredScopes } from '@xaa/contracts';
import { REGISTERED_SCOPES } from './registered-scopes.js';

/**
 * The Resource AS reads its trusted issuer and its JWK Set location from the
 * deployment. Neither is ever derived from the assertion being verified, which is
 * what keeps this endpoint free of server-side request forgery (T-RES-05).
 */
export interface ResourceAsEnv {
  port: number;
  issuer: string;
  trustedIdpIssuer: string;
  trustedIdpJwksUri: string;
  accessTokenExpiresIn: number;
  registeredScopes: readonly string[];
  signingKeyBucket: string;
  signingKeyObject: string;
  signingKeyKmsKey: string;
  jwksBucket: string;
  jwksKeyPrefix: string;
  signerMode: 'local' | 'kms';
  storeMode: 'emulator' | 'gcp';
  resourceUri: string;
  asKind: 'docs' | 'finance';
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    process.stderr.write(`missing_trusted_idp_config: ${key}\n`);
    throw new Error(`missing environment variable: ${key}`);
  }
  return value;
}

export function loadResourceAsEnv(env: NodeJS.ProcessEnv, expected: readonly string[] = REGISTERED_SCOPES): ResourceAsEnv {
  return {
    port: Number(env.PORT ?? 8080),
    issuer: required(env, 'ISSUER'),
    trustedIdpIssuer: required(env, 'TRUSTED_IDP_ISSUER'),
    trustedIdpJwksUri: required(env, 'TRUSTED_IDP_JWKS_URI'),
    accessTokenExpiresIn: Number(env.ACCESS_TOKEN_EXPIRES_IN ?? '300'),
    registeredScopes: assertRegisteredScopes(env.REGISTERED_SCOPES, expected),
    signingKeyBucket: required(env, 'SIGNING_KEY_BUCKET'),
    signingKeyObject: required(env, 'SIGNING_KEY_OBJECT'),
    signingKeyKmsKey: required(env, 'SIGNING_KEY_KMS_KEY'),
    jwksBucket: required(env, 'JWKS_BUCKET'),
    jwksKeyPrefix: required(env, 'JWKS_KEY_PREFIX'),
    signerMode: (env.SIGNER_MODE === 'kms' ? 'kms' : 'local'),
    storeMode: (env.STORE_MODE === 'gcp' ? 'gcp' : 'emulator'),
    resourceUri: required(env, 'RESOURCE'),
    asKind: env.AS_KIND === 'finance' ? 'finance' : 'docs',
  };
}
