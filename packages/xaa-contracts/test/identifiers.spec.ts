import { describe, expect, it } from 'vitest';
import { assertValidCapabilityId, CAPABILITIES, TOOL_BINDINGS, TOOL_IDS } from '../src/index.js';

describe('identifiers', () => {
  it('capability ids pass format check', () => expect(() => CAPABILITIES.forEach(assertValidCapabilityId)).not.toThrow());
  it('rejects vendor and method segments', () => {
    expect(() => assertValidCapabilityId('google.calendar.read')).toThrow();
    expect(() => assertValidCapabilityId('document.get')).toThrow();
  });
  it('tool bindings are exhaustive', () => expect(Object.keys(TOOL_BINDINGS).sort()).toEqual([...TOOL_IDS].sort()));
});
