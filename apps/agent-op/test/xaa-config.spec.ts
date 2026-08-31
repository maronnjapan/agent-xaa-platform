import { describe, expect, it } from 'vitest';
import { createFixture, exchange, DOCS_AS_ISSUER, DOCS_API_RESOURCE } from './helpers.js';

const OUT_OF_RANGE = 'The request is outside the static XAA configuration for this agent';

async function rejected(options: Record<string, string>) {
  const fixture = await createFixture();
  const response = await exchange(fixture, { form: options });
  return { fixture, response, body: await response.json() as { error: string; error_description: string } };
}

describe('static XAA configuration', () => {
  it('rejects an unregistered audience with invalid_scope', async () => {
    const { response, body, fixture } = await rejected({ audience: 'https://elsewhere.test' });
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_scope', error_description: OUT_OF_RANGE });
    expect(fixture.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('rejects an unregistered resource with invalid_scope', async () => {
    const { body, fixture } = await rejected({ resource: 'https://elsewhere.test' });
    expect(body.error).toBe('invalid_scope');
    expect(fixture.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('rejects a scope outside the configuration with invalid_scope', async () => {
    const { body, fixture } = await rejected({ scope: 'finance.tx.write' });
    expect(body.error).toBe('invalid_scope');
    expect(fixture.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('rejects an omitted resource: RFC 8707 absolute URI is mandatory here', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { resource: '' } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_scope');
  });

  it('resource matching rejects prefix and substring matches', async () => {
    for (const resource of [`${DOCS_API_RESOURCE}/documents`, DOCS_API_RESOURCE.slice(0, -1), `x${DOCS_API_RESOURCE}`]) {
      const { body } = await rejected({ resource });
      expect(body.error).toBe('invalid_scope');
    }
  });

  it('audience matching rejects a prefix of a registered audience', async () => {
    const { body } = await rejected({ audience: `${DOCS_AS_ISSUER}-staging` });
    expect(body.error).toBe('invalid_scope');
  });

  it('reports only the first failing field', async () => {
    const fixture = await createFixture();
    await exchange(fixture, { form: { audience: 'https://elsewhere.test', resource: 'https://also-wrong.test', scope: 'finance.tx.write' } });
    expect(fixture.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('never names the allow list in the description', async () => {
    const { body } = await rejected({ audience: 'https://elsewhere.test' });
    expect(body.error_description).not.toContain(DOCS_AS_ISSUER);
    expect(body.error_description).not.toContain(DOCS_API_RESOURCE);
  });
});
