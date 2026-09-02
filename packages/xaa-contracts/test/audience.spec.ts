import { expect, it } from 'vitest';
import { audienceIncludes } from '../src/index.js';

it('element match, no prefix/substring match', () => {
  const aud = ['https://a.example', 'https://a.example/userinfo'];
  expect(audienceIncludes(aud, 'https://a.example')).toBe(true);
  expect(audienceIncludes(aud, 'https://a.example/user')).toBe(false);
  expect(audienceIncludes(aud, 'https://a')).toBe(false);

  // The Control Plane audiences are bare names, where a prefix or substring match
  // would hand `authorization-platform`'s token to anything called `authorization`.
  const controlPlane = ['authorization-platform', 'https://human-idp.test/userinfo'];
  expect(audienceIncludes(controlPlane, 'authorization-platform')).toBe(true);
  expect(audienceIncludes(controlPlane, 'authorization-platform-x')).toBe(false);
  expect(audienceIncludes(controlPlane, 'authorization')).toBe(false);
});
