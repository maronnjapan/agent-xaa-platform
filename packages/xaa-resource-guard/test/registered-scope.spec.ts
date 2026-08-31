import { describe, expect, it } from 'vitest';
import { assertRegisteredScopes, DOCS_SCOPES, FINANCE_SCOPES, InvalidRegisteredScope } from '@xaa/contracts';

describe('registered scopes are the damage ceiling', () => {
  it('docs registers two scopes and finance registers two', () => {
    expect([...DOCS_SCOPES]).toEqual(['docs.read', 'docs.write']);
    expect([...FINANCE_SCOPES]).toEqual(['finance.tx.read', 'finance.tx.write']);
  });

  it('carries no wildcard and no admin value', () => {
    for (const scope of [...DOCS_SCOPES, ...FINANCE_SCOPES]) {
      expect(scope).not.toContain('*');
      expect(scope).not.toContain('admin');
    }
  });

  it('accepts a declaration that matches as a set, order aside', () => {
    expect(assertRegisteredScopes('docs.write docs.read', DOCS_SCOPES)).toEqual(DOCS_SCOPES);
  });

  it('rejects a widened declaration', () => {
    expect(() => assertRegisteredScopes('docs.read docs.admin', DOCS_SCOPES)).toThrow(InvalidRegisteredScope);
    expect(() => assertRegisteredScopes('docs.read *', DOCS_SCOPES)).toThrow(InvalidRegisteredScope);
    expect(() => assertRegisteredScopes('docs.read finance.tx.read', DOCS_SCOPES)).toThrow(InvalidRegisteredScope);
  });

  it('rejects a narrowed declaration', () => {
    expect(() => assertRegisteredScopes('docs.read', DOCS_SCOPES)).toThrow(InvalidRegisteredScope);
    expect(() => assertRegisteredScopes('', DOCS_SCOPES)).toThrow(InvalidRegisteredScope);
  });

  it('names the offending value so the operator can fix it', () => {
    try {
      assertRegisteredScopes('docs.read docs.admin', DOCS_SCOPES);
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidRegisteredScope).offending).toBe('docs.admin');
      expect((error as Error).message).toBe('invalid_registered_scope');
    }
  });
});
