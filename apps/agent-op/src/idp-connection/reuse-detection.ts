import type { DocumentStore } from '@xaa/gcp';
import { refreshTokenFingerprint } from './crypto.js';

/**
 * REQ-09-025. Agent OP is the only holder of an agent's refresh token, so a rotated
 * token coming back is evidence of a leak rather than a race.
 *
 * Only the SHA-256 of the retired token is kept; neither the plaintext nor the
 * ciphertext is recorded.
 */
export class RotationHistory {
  constructor(private readonly store: DocumentStore, private readonly ttlSeconds: number) {}

  async remember(connectionId: string, retiredRefreshToken: string): Promise<void> {
    const hash = await refreshTokenFingerprint(retiredRefreshToken);
    await this.store.set('idp_connection_rotations', `${connectionId}__${hash}`, {
      connection_id: connectionId,
      expire_at: this.store.expiryFromNow(this.ttlSeconds),
    });
  }

  async wasRotated(connectionId: string, presentedRefreshToken: string): Promise<boolean> {
    const hash = await refreshTokenFingerprint(presentedRefreshToken);
    return (await this.store.get('idp_connection_rotations', `${connectionId}__${hash}`)) !== undefined;
  }
}
