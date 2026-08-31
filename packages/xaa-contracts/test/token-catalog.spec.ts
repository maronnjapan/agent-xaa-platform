import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { TOKEN_CATALOG, type TokenCatalogKey } from '../src/token-catalog.js';
import { JWT_TYP } from '../src/identifiers.js';

const docsPath = new URL('../../../docs/05-identity.md', import.meta.url).pathname;

/**
 * REQ-05-094. Under one issuer and one JWK Set, an ID Token, an Access Token and an
 * ID-JAG all verify against the same keys, and `typ` is the only thing separating them.
 * The table in docs 05 §9 and this constant must therefore agree exactly — a ninth kind
 * described in prose but absent here would be a token nothing checks the type of.
 */
describe('the token catalogue', () => {
  it('names eight kinds and no more', () => {
    expect(Object.keys(TOKEN_CATALOG)).toHaveLength(8);
    expect(Object.keys(TOKEN_CATALOG)).toEqual([
      'human_id_token_login', 'human_access_token', 'human_id_token_xaa', 'human_refresh_token_xaa',
      'agent_assertion', 'id_jag', 'native_resource_access_token', 'saas_access_token',
    ]);
  });

  it('agrees with the typ constants the platform verifies against', () => {
    expect(TOKEN_CATALOG.human_id_token_login.typ).toBe(JWT_TYP.ID_TOKEN);
    expect(TOKEN_CATALOG.human_access_token.typ).toBe(JWT_TYP.ACCESS_TOKEN);
    expect(TOKEN_CATALOG.id_jag.typ).toBe(JWT_TYP.ID_JAG);
    expect(TOKEN_CATALOG.agent_assertion.typ).toBe(JWT_TYP.ACTOR_TOKEN);
    expect(TOKEN_CATALOG.native_resource_access_token.typ).toBe(JWT_TYP.ACCESS_TOKEN);
  });

  it('requires DPoP on exactly the three kinds this platform binds', () => {
    const bound = Object.entries(TOKEN_CATALOG)
      .filter(([, value]) => value.dpop)
      .map(([key]) => key);
    // The Bridge's outbound SaaS token is deliberately absent: DEC-ID-13 keeps
    // proof-of-possession inside the platform.
    expect(bound.sort()).toEqual(['human_access_token', 'id_jag', 'native_resource_access_token']);
  });

  it('lists every constant key in the docs table, and nothing else', async () => {
    const section = (await readFile(docsPath, 'utf8')).split('### 9. Tokenの種類と保持ルール')[1]!;
    const table = section.split('\n\n')[2] ?? section;
    for (const key of Object.keys(TOKEN_CATALOG) as TokenCatalogKey[]) {
      expect(table).toContain(`\`${key}\``);
    }
    // And the other way round: the constant-key column names nothing this table does
    // not define, so a ninth kind cannot be introduced in prose alone.
    const keys = new Set<string>(Object.keys(TOKEN_CATALOG));
    const columns = section.split('\n')
      .filter((line) => line.startsWith('| ') && line.split('|').length >= 8)
      .map((line) => line.split('|')[7]!.trim().replaceAll('`', ''))
      .filter((value) => value !== '' && value !== '定数キー');
    expect(columns.sort()).toEqual([...keys].sort());
  });
});
