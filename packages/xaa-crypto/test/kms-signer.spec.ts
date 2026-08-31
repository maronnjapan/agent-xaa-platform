import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createKmsEs256Signer, deriveKid } from '../src/kms-signer.js';

function derSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array) => {
    const body = (value[0]! & 0x80) === 0 ? value : Uint8Array.from([0, ...value]);
    return Uint8Array.from([0x02, body.length, ...body]);
  };
  const content = Uint8Array.from([...integer(r), ...integer(s)]);
  return Uint8Array.from([0x30, content.length, ...content]);
}

describe('KMS ES256 signer', () => {
  it('sends digest not raw data', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const signature = derSignature(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    const client = {
      asymmetricSign: async (request: Record<string, unknown>) => { seen.push(request); return [{ signature }]; },
    };
    const signer = createKmsEs256Signer({
      keyVersionName: 'projects/p/locations/l/keyRings/k/cryptoKeys/c/cryptoKeyVersions/3',
      kidPrefix: 'op-shared',
      client: client as never,
    });
    const data = new TextEncoder().encode('payload');
    const raw = await signer.sign(data);
    expect(raw.byteLength).toBe(64);
    const request = seen[0] as { digest: { sha256: Buffer }; data?: unknown };
    expect(Buffer.from(request.digest.sha256).toString('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    expect(request.data).toBeUndefined();
  });

  it('derives kid from the key version suffix', () => {
    expect(deriveKid('op-shared', 'projects/p/locations/l/keyRings/k/cryptoKeys/c/cryptoKeyVersions/1')).toBe('op-shared-1');
    expect(deriveKid('idjag-aaaaaaaaaaaa', 'projects/p/locations/l/keyRings/k/cryptoKeys/c/cryptoKeyVersions/2')).toBe('idjag-aaaaaaaaaaaa-2');
  });

  it('rejects a key name without a version suffix', () => {
    expect(() => deriveKid('op-shared', 'projects/p/cryptoKeys/c')).toThrow();
  });
});
