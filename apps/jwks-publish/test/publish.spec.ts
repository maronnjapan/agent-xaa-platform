import type { Storage } from '@google-cloud/storage';
import { describe, expect, it } from 'vitest';
import { IssuerKeyMissing, publishJwks, waitForIssuerJwks } from '../src/index.js';

/** Only the four calls `publishJwks` makes, over a map of `keys/<kid>.json` bodies. */
function storageDouble(objects: Record<string, string>) {
  const written: Record<string, string> = {};
  const storage = {
    bucket: () => ({
      getFiles: async ({ prefix }: { prefix: string }) => [
        Object.keys(objects).filter((path) => path.startsWith(prefix)).map((path) => ({
          async download(): Promise<[Buffer]> { return [Buffer.from(objects[path]!, 'utf8')]; },
          async getMetadata(): Promise<[{ updated: string }]> { return [{ updated: '2026-01-01T00:00:00.000Z' }]; },
        })),
      ],
      file: (path: string) => ({
        async save(body: string) { written[path] = body; },
      }),
    }),
  };
  return { storage: storage as unknown as Storage, written };
}

function jwk(kid: string): string {
  return JSON.stringify({ kty: 'RSA', kid, alg: 'RS256', use: 'sig' });
}

describe('the aggregate JWK Set', () => {
  it('is written when the issuer key is among the published keys', async () => {
    const { storage, written } = storageDouble({
      'keys/idp-abcd1234.json': jwk('idp-abcd1234'),
      'keys/op-shared-1.json': jwk('op-shared-1'),
    });
    await publishJwks('xaa-jwks', storage);
    expect(JSON.parse(written['jwks.json']!)).toEqual({
      keys: [JSON.parse(jwk('idp-abcd1234')), JSON.parse(jwk('op-shared-1'))],
    });
  });

  /**
   * The failure this whole path exists to stop. Publishing the smaller set would leave
   * a platform where logging in works and every Control Plane call answers
   * `invalid_token`, so the previous object stays where it is and the job fails.
   */
  it('is left alone when no idp- key has been published yet', async () => {
    const { storage, written } = storageDouble({ 'keys/op-shared-1.json': jwk('op-shared-1') });
    await expect(publishJwks('xaa-jwks', storage)).rejects.toBeInstanceOf(IssuerKeyMissing);
    expect(written).toEqual({});
  });
});

describe('waiting for the Human IdP', () => {
  it('keeps asking until the set has a key, because asking is what creates it', async () => {
    const answers = [
      new Response('', { status: 503 }),
      Response.json({ keys: [] }),
      Response.json({ keys: [JSON.parse(jwk('idp-abcd1234'))] }),
    ];
    const asked: string[] = [];
    await waitForIssuerJwks('https://human-idp.test/.well-known/jwks.json', {
      fetchImpl: async (url) => { asked.push(String(url)); return answers.shift()!; },
      sleep: async () => {},
      log: () => {},
    });
    expect(asked).toHaveLength(3);
  });

  it('gives up with a named error rather than publishing an issuer-less set', async () => {
    await expect(waitForIssuerJwks('https://human-idp.test/.well-known/jwks.json', {
      fetchImpl: async () => Response.json({ keys: [] }),
      attempts: 2,
      sleep: async () => {},
      log: () => {},
    })).rejects.toBeInstanceOf(IssuerKeyMissing);
  });
});
