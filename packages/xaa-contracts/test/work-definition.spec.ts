import { describe, expect, it } from 'vitest';
import { workDefinitionHash } from '../src/index.js';

describe('work definition hash', () => {
  it('hash is deterministic', async () => expect(await workDefinitionHash({ purpose: 'x' })).toBe(await workDefinitionHash({ purpose: 'x' })));
});
