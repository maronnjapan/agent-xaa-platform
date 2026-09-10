import { describe, expect, it } from 'vitest';
import { audienceIncludes } from '@xaa/contracts';
import { decideAudience, SCOPE_TO_AUDIENCE } from '../src/config/audience-map.js';
import { DPOP_REQUIRED_AUDIENCES, requiresDpop } from '../src/config/dpop-required-audiences.js';

describe('scope to audience', () => {
  it('maps each operation scope to one audience', () => {
    expect(SCOPE_TO_AUDIENCE).toEqual({
      'workdef:submit': 'authorization-platform',
      'agent:provision': 'agent-provisioner',
      'agent:revoke': 'lifecycle-manager',
      'agent:operate': 'automation-app',
    });
  });

  it('leaves the audience unset when no operation scope is requested', () => {
    expect(decideAudience(['openid'], undefined)).toEqual({ outcome: 'none' });
    expect(decideAudience(['openid', 'offline_access'], undefined)).toEqual({ outcome: 'none' });
  });

  it('gives two operation scopes no audience rather than one of them', () => {
    // The consent request the Automation App makes: every scope it will need, named
    // once. No Access Token audience follows from it, so the token it produces is
    // addressed to the UserInfo endpoint alone and opens no Control Plane app.
    expect(decideAudience(['openid', 'workdef:submit', 'agent:provision'], undefined))
      .toEqual({ outcome: 'none' });
    expect(decideAudience(['openid', 'agent:operate', 'workdef:submit', 'agent:provision', 'agent:revoke'], undefined))
      .toEqual({ outcome: 'none' });
  });

  it('still refuses to address two operation scopes to one named audience', () => {
    expect(decideAudience(['openid', 'workdef:submit', 'agent:provision'], ['agent-provisioner']))
      .toEqual({ outcome: 'error', error: 'invalid_scope' });
  });

  it('rejects an audience parameter that disagrees with the mapped value', () => {
    expect(decideAudience(['openid', 'agent:provision'], ['lifecycle-manager']))
      .toEqual({ outcome: 'error', error: 'invalid_target' });
    expect(decideAudience(['openid', 'agent:provision'], ['agent-provisioner']))
      .toEqual({ outcome: 'audience', audience: 'agent-provisioner' });
  });

  it('matches an audience by element, never by prefix or substring', () => {
    const aud = ['authorization-platform', 'https://human-idp.test/userinfo'];
    expect(audienceIncludes(aud, 'authorization-platform')).toBe(true);
    expect(audienceIncludes(aud, 'authorization-platform-x')).toBe(false);
    expect(audienceIncludes(aud, 'authorization')).toBe(false);
    expect(aud).toHaveLength(2);
  });

  it('requires DPoP for the three Control Plane audiences only', () => {
    for (const audience of DPOP_REQUIRED_AUDIENCES) expect(requiresDpop([audience, 'https://x/userinfo'])).toBe(true);
    expect(requiresDpop(['automation-app'])).toBe(false);
    expect(requiresDpop(undefined)).toBe(false);
  });
});
