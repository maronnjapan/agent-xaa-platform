import { describe, expect, it } from 'vitest';
import { toPlatformScopes, toProviderScopes } from '../src/scope/provider-scope.js';
import type { ConnectorDefinition } from '../src/connectors/types.js';

const base: ConnectorDefinition = {
  connector_id: 'stub-saas-calendar',
  display_name: 'Google Calendar',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  client_id: '123.apps.googleusercontent.com',
  secret_name: 'projects/p/secrets/s',
  default_scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  subject_claim: 'sub',
  connection_max_age_seconds: 2_592_000,
  resource_uris: ['https://www.googleapis.com/calendar'],
  scope_map: { 'calendar.read': 'https://www.googleapis.com/auth/calendar.readonly' },
};

/**
 * The vocabulary boundary. Inside the platform a scope is `calendar.read` and every
 * containment check in `effective-scope.ts` is computed in those names; a real SaaS has
 * its own, and answers a consent request carrying ours with `invalid_scope`.
 */
describe('translating a scope at the SaaS boundary', () => {
  it('sends the SaaS its own name for a scope', () => {
    expect(toProviderScopes(base, ['calendar.read']))
      .toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
  });

  it('reads what the SaaS granted back into the platform name', () => {
    expect(toPlatformScopes(base, ['https://www.googleapis.com/auth/calendar.readonly']))
      .toEqual(['calendar.read']);
  });

  it('is a round trip, so a connection covers what the binding was checked against', () => {
    const platform = ['calendar.read'];
    expect(toPlatformScopes(base, toProviderScopes(base, platform))).toEqual(platform);
  });

  /**
   * A connector whose OP is this platform's own already speaks these names. Requiring an
   * identity map on every row would make the stub carry a table that says nothing.
   */
  it('translates to itself when the connector declares no map', () => {
    const stub: ConnectorDefinition = { ...base };
    delete stub.scope_map;
    expect(toProviderScopes(stub, ['calendar.read'])).toEqual(['calendar.read']);
    expect(toPlatformScopes(stub, ['calendar.read'])).toEqual(['calendar.read']);
  });

  /**
   * Dropping an unmapped scope would narrow a consent silently: the person would approve
   * less than the agent needs and neither of them would be told. It travels unchanged,
   * and the SaaS refuses it in the open if it is wrong.
   */
  it('passes a scope the map does not name through unchanged', () => {
    expect(toProviderScopes(base, ['calendar.read', 'gmail.read']))
      .toEqual(['https://www.googleapis.com/auth/calendar.readonly', 'gmail.read']);
  });

  /** An OAuth server may grant more than it was asked for, and that has to be visible. */
  it('keeps a granted scope the map does not name', () => {
    expect(toPlatformScopes(base, ['https://www.googleapis.com/auth/calendar.readonly', 'openid']))
      .toEqual(['calendar.read', 'openid']);
  });
});
