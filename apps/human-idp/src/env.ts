import schema from '../env.schema.json' with { type: 'json' };
import { compile } from '@xaa/contracts';

/**
 * The 16 variables Terraform injects. Nothing here carries a default: a value the
 * deployment did not set must fail at startup, not be invented by the app
 * (constraint 1 — the GCP configuration is owned by IaC).
 */
export const ENV_KEYS = [
  'PORT', 'ISSUER', 'ISSUER_PROFILE', 'JWKS_BUCKET', 'JWKS_PUBLIC_BASE_URL', 'KEY_BUCKET',
  'KMS_SSO_KEY_NAME', 'SIGNER_MODE', 'STORE_MODE', 'FIRESTORE_DATABASE', 'DPOP_REQUIRED',
  'CLIENT_SECRET_AUTOMATION_APP', 'CLIENT_SECRET_AGENT_PLATFORM', 'AUTOMATION_APP_REDIRECT_URI',
  'AGENT_OP_CALLBACK_URI', 'ACCESS_TOKEN_EXPIRES_IN',
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

export interface HumanIdpEnv {
  port: number;
  issuer: string;
  issuerProfile: 'direct' | 'loadbalancer';
  jwksBucket: string;
  jwksPublicBaseUrl: string;
  keyBucket: string;
  kmsSsoKeyName: string;
  signerMode: 'local' | 'kms';
  storeMode: 'emulator' | 'gcp';
  firestoreDatabase: string;
  dpopRequired: boolean;
  clientSecretAutomationApp: string;
  clientSecretAgentPlatform: string;
  automationAppRedirectUri: string;
  agentOpCallbackUri: string;
  accessTokenExpiresIn: number;
}

export class EnvValidationError extends Error {
  constructor(readonly missingKeys: readonly string[]) {
    super('human-idp environment is invalid');
    this.name = 'EnvValidationError';
  }
}

const assertShape: (data: unknown) => asserts data is Record<EnvKey, string> = compile<Record<EnvKey, string>>(schema);

export function loadEnv(source: NodeJS.ProcessEnv = process.env): HumanIdpEnv {
  // DPOP_REQUIRED is the one variable with a documented interpretation for the
  // unset case (true); everything else must be present verbatim.
  const raw: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of ENV_KEYS) {
    const value = key === 'DPOP_REQUIRED' ? source[key] ?? 'true' : source[key];
    if (value === undefined || value === '') missing.push(key);
    else raw[key] = value;
  }
  if (missing.length > 0) throw new EnvValidationError(missing);
  try {
    assertShape(raw);
  } catch {
    // The value itself never reaches the log: only the key that failed.
    throw new EnvValidationError(ENV_KEYS.filter((key) => {
      try { assertShape({ ...raw, [key]: raw[key] }); return false; } catch { return true; }
    }));
  }
  const value = raw as Record<EnvKey, string>;
  return {
    port: Number(value.PORT),
    issuer: value.ISSUER,
    issuerProfile: value.ISSUER_PROFILE as 'direct' | 'loadbalancer',
    jwksBucket: value.JWKS_BUCKET,
    jwksPublicBaseUrl: value.JWKS_PUBLIC_BASE_URL,
    keyBucket: value.KEY_BUCKET,
    kmsSsoKeyName: value.KMS_SSO_KEY_NAME,
    signerMode: value.SIGNER_MODE as 'local' | 'kms',
    storeMode: value.STORE_MODE as 'emulator' | 'gcp',
    firestoreDatabase: value.FIRESTORE_DATABASE,
    dpopRequired: value.DPOP_REQUIRED === 'true',
    clientSecretAutomationApp: value.CLIENT_SECRET_AUTOMATION_APP,
    clientSecretAgentPlatform: value.CLIENT_SECRET_AGENT_PLATFORM,
    automationAppRedirectUri: value.AUTOMATION_APP_REDIRECT_URI,
    agentOpCallbackUri: value.AGENT_OP_CALLBACK_URI,
    accessTokenExpiresIn: Number(value.ACCESS_TOKEN_EXPIRES_IN),
  };
}
