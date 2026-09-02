import { expect, it } from 'vitest';
import { audienceIncludes } from '../src/index.js';

it('element match, no prefix/substring match', () => {
  const aud = ['https://a.example', 'https://a.example/userinfo'];
  expect(audienceIncludes(aud, 'https://a.example')).toBe(true);
  expect(audienceIncludes(aud, 'https://a.example/user')).toBe(false);
  expect(audienceIncludes(aud, 'https://a')).toBe(false);
});

it('rejects non-string non-array aud', () => {
  for (const aud of [null, {}, 42]) expect(audienceIncludes(aud, 'https://a.example')).toBe(false);
});
