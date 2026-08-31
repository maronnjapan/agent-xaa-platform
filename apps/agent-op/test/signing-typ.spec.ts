import { describe, expect, it, vi } from 'vitest';
import { createLocalEs256Signer, generateEs256KeyPair, type Es256Signer } from '@xaa/crypto';
import { signIdJag, ID_JAG_TYP } from '../src/idjag/sign-id-jag.js';
import { attachCnf } from '../src/idjag/attach-cnf.js';
import { createFixture, decodeHeader, exchange } from './helpers.js';

const claims = { iss: 'https://human-idp.test', sub: 'user-1', aud: 'https://docs-as.test', jti: 'j1', exp: 2, iat: 1 };

async function signer(): Promise<Es256Signer> {
  const pair = await generateEs256KeyPair();
  return createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'op-shared-1' });
}

describe('ID-JAG signing', () => {
  it('takes no typ or alg parameter', () => {
    expect(signIdJag.length).toBe(2);
    // @ts-expect-error a third argument would reopen what the key may sign
    void (() => signIdJag(claims, undefined as never, 'JWT'));
  });

  it('always emits typ oauth-id-jag+jwt', async () => {
    const token = await signIdJag({ ...claims, cnf: { jkt: 'thumb' } }, await signer());
    expect(decodeHeader(token).typ).toBe(ID_JAG_TYP);
    expect(decodeHeader(token).alg).toBe('ES256');
  });

  it('never signs without cnf', async () => {
    const sign = vi.fn();
    const spy: Es256Signer = { kid: 'op-shared-1', sign };
    await expect(signIdJag(claims, spy)).rejects.toThrow(/cnf\.jkt/);
    await expect(signIdJag({ ...claims, cnf: { jkt: '' } }, spy)).rejects.toThrow(/cnf\.jkt/);
    expect(sign).toHaveBeenCalledTimes(0);
  });

  it('attachCnf refuses an empty thumbprint', () => {
    expect(() => attachCnf(claims as never, '')).toThrow(/cnf\.jkt/);
  });

  it('produces a 64-byte raw ES256 signature', async () => {
    const token = await signIdJag({ ...claims, cnf: { jkt: 'thumb' } }, await signer());
    expect(Buffer.from(token.split('.')[2]!, 'base64url')).toHaveLength(64);
  });

  it('assigns cnf in exactly one module', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = new URL('../src', import.meta.url).pathname;
    const assigning: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (/\bcnf:\s*\{/.test(await readFile(full, 'utf8'))) assigning.push(entry.name);
      }
    };
    await walk(root);
    expect(assigning).toEqual(['attach-cnf.ts']);
  });

  it('signs every issued grant with the ID-JAG type', async () => {
    const fixture = await createFixture();
    const body = await (await exchange(fixture)).json() as { access_token: string };
    expect(decodeHeader(body.access_token).typ).toBe(ID_JAG_TYP);
  });
});
