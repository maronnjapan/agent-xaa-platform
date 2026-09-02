import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { AI_BOUNDARY_FORBIDDEN_IMPORTS } from '../../../../eslint.config.js';

const FIXTURE = 'apps/security-detection/test/lint/fixtures/violating-import.ts';
const repoRoot = new URL('../../../../', import.meta.url).pathname;

/** The boundary block of the repository config, applied to the fixture's path. */
function boundaryLinter(): ESLint {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [{
      files: [FIXTURE],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
      rules: { 'no-restricted-imports': ['error', { patterns: [...AI_BOUNDARY_FORBIDDEN_IMPORTS] }] },
    }],
  });
}

/**
 * T-SEC-18 / RULE-39. The model never receives a raw log, and that is enforced by the
 * build rather than by care.
 *
 * Two halves: the client cannot import the normaliser, and the normaliser cannot import
 * the client. The rule is checked here against a file that breaks it on purpose, because
 * a restriction that has never been observed rejecting anything is indistinguishable
 * from one whose `files` pattern stopped matching.
 */
describe('the Security AI import boundary', () => {
  it('violating fixture reports at least one error', async () => {
    const [result] = await boundaryLinter().lintFiles([FIXTURE]);
    expect(result!.errorCount).toBeGreaterThanOrEqual(1);
    const messages = result!.messages.map((message) => message.ruleId);
    expect(messages).toContain('no-restricted-imports');
  });

  it('names all four forbidden patterns', () => {
    expect([...AI_BOUNDARY_FORBIDDEN_IMPORTS].sort())
      .toEqual(['../normalize', '../normalize/*', '../pipeline/types', '@xaa/logging'].sort());
  });

  it('the client itself imports none of them', async () => {
    const source = await readFile(new URL('../../src/ai/vertex-client.ts', import.meta.url), 'utf8');
    for (const forbidden of ['../normalize', '../pipeline/types', '@xaa/logging']) {
      expect(source).not.toContain(`from '${forbidden}`);
    }
    // And the SDK lives only here, so no other file can reach the model at all.
    expect(source).not.toContain('@google-cloud/vertexai');
  });
});
