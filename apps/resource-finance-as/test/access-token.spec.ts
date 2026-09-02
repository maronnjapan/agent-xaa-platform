import { describe, expect, it } from 'vitest';
import { decodeJwsUnverified } from '@xaa/crypto';
import { AS_ISSUER, createRedeemableAs } from './helpers.js';

async function issued(response: Response) {
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  return { body, token: decodeJwsUnverified(body.access_token as string) };
}

describe('the Access Token the finance AS mints', () => {
  it('is an at+jwt bound to the presented proof and naming the acting agent', async () => {
    const chain = await createRedeemableAs();
    const { token } = await issued(await chain.redeem());
    expect(token.header.typ).toBe('at+jwt');
    expect(token.header.kid).toBe(chain.as.signingKey.kid);
    expect((token.payload.cnf as { jkt: string }).jkt).toBe(chain.jkt);
    expect((token.payload.act as { sub: string }).sub.startsWith('urn:xaa:agent:')).toBe(true);
    expect(token.payload.iss).toBe(AS_ISSUER);
  });

  it('answers with token_type DPoP and neither a refresh token nor an ID Token', async () => {
    const chain = await createRedeemableAs();
    const { body } = await issued(await chain.redeem());
    expect(body.token_type).toBe('DPoP');
    expect(Object.keys(body)).not.toContain('refresh_token');
    expect(Object.keys(body)).not.toContain('id_token');
  });

  it('keeps the audience as an element list rather than one value', async () => {
    const chain = await createRedeemableAs();
    const { token } = await issued(await chain.redeem());
    expect(token.payload.aud).toEqual([`${AS_ISSUER}/userinfo`, 'https://resource-finance-api.test']);
  });

  it('uses the configured lifetime, not what is left of the ID-JAG', async () => {
    const chain = await createRedeemableAs();
    const { body, token } = await issued(await chain.redeem({ assertion: await chain.mint({ expiresIn: 60 }) }));
    expect(body.expires_in).toBe(300);
    expect((token.payload.exp as number) - (token.payload.iat as number)).toBe(300);
  });

  it('drops offline_access from the granted scope', async () => {
    const chain = await createRedeemableAs();
    const { body, token } = await issued(await chain.redeem({
      assertion: await chain.mint({ scope: 'finance.tx.read finance.tx.write offline_access' }),
    }));
    expect(body.scope).toBe('finance.tx.read finance.tx.write');
    expect(token.payload.scope).not.toContain('offline_access');
  });

  it('narrows the response to the scope the ID-JAG carries', async () => {
    const chain = await createRedeemableAs();
    const { body } = await issued(await chain.redeem({ assertion: await chain.mint({ scope: 'finance.tx.read' }) }));
    expect(body.scope).toBe('finance.tx.read');
  });

  it('refuses a scope this resource never registered', async () => {
    const chain = await createRedeemableAs();
    const response = await chain.redeem({ assertion: await chain.mint({ scope: 'finance.tx.read finance.admin' }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_scope');
  });
});

describe('what finance adds to the token', () => {
  it('carries the isolation level forward so the API can re-check it', async () => {
    const chain = await createRedeemableAs();
    const { token } = await issued(await chain.redeem());
    expect(token.payload.isolation_level).toBe('full_isolation');
  });

  it('forwards only the approval tool constraint and drops the rest', async () => {
    const chain = await createRedeemableAs();
    const { token } = await issued(await chain.redeem({
      assertion: await chain.mint({
        constraints: {
          'internal.finance.payment.approve': { max_amount: 50000 },
          'internal.document.update': { max_length: 10 },
        },
      }),
    }));
    expect(token.payload.xaa_constraints).toEqual({ max_amount: 50000 });
  });

  it('carries no constraint claim when the assertion has none', async () => {
    const chain = await createRedeemableAs();
    const { token } = await issued(await chain.redeem());
    expect(Object.keys(token.payload)).not.toContain('xaa_constraints');
  });
});
