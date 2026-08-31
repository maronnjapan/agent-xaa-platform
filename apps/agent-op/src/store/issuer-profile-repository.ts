import type { AgentOpConfig } from '../config.js';
import type { IssuerProfile } from './types.js';

/**
 * 00b: the `issuer_profiles` collection is not created. The issuer comes from the
 * ISSUER variable and the kid is derived from the key version, so the profile is
 * assembled from configuration rather than read from a database.
 */
export class IssuerProfileRepository {
  constructor(private readonly config: AgentOpConfig, private readonly kid: () => string) {}
  get(): IssuerProfile {
    return { issuer: this.config.issuer, kms_key_name: this.config.kmsIdjagKey, kid: this.kid() };
  }
}
