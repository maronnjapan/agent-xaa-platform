import { describe, expect, it } from 'vitest';
import { IdJagError, type IdJagErrorCode } from '@maronn-openid-connect/experimental/id-jag';
import { mapIdJagError, oauthErrorResponse, OAUTH_ERROR_CODES } from '../src/oauth-errors.js';

describe('oauth error responses', () => {
  it('response body has only error key', async () => {
    const body = await oauthErrorResponse('invalid_grant', 400).json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('produces byte-identical bodies for different internal reasons', async () => {
    const bodies = await Promise.all([
      new IdJagError('invalid_grant', 'subject token bad'),
      new IdJagError('invalid_grant', 'actor token bad'),
      new IdJagError('invalid_grant', 'delegation mismatch'),
    ].map(async (error) => oauthErrorResponse(mapIdJagError(error).code, 400).text()));
    expect(new Set(bodies).size).toBe(1);
  });

  it('maps all IdJagError codes to invalid_grant or invalid_scope', () => {
    // Exhaustive by construction: a code added to IdJagErrorCode upstream makes this
    // record a compile error before it can slip through unmapped.
    const coverage: Record<IdJagErrorCode, true> = {
      invalid_request: true, invalid_grant: true, unauthorized_client: true, invalid_scope: true, invalid_target: true,
    };
    const codes = Object.keys(coverage) as IdJagErrorCode[];
    expect(codes).toHaveLength(5);
    for (const code of codes) {
      const mapped = mapIdJagError(new IdJagError(code, 'x'));
      expect(['invalid_grant', 'invalid_scope']).toContain(mapped.code);
    }
    expect(mapIdJagError(new IdJagError('invalid_scope', 'requested scope is out of range')).code).toBe('invalid_scope');
  });

  it('keeps the internal reason off the response', () => {
    const mapped = mapIdJagError(new IdJagError('invalid_grant', 'subject mismatch'));
    expect(mapped.internalReason).toContain('subject mismatch');
    // @ts-expect-error oauthErrorResponse accepts no description argument
    oauthErrorResponse('invalid_grant', 400, mapped.internalReason);
  });

  it('enumerates the fixed error code set', () => {
    expect(OAUTH_ERROR_CODES).toContain('insufficient_isolation');
    expect(OAUTH_ERROR_CODES).toContain('tool_not_allowed');
  });
});
