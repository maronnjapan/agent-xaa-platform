import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * What may not be imported into the file that talks to the model (T-SEC-18).
 *
 * Exported so that `apps/security-detection/test/lint/no-raw-log-to-ai.spec.ts` checks
 * the same list this configuration enforces, rather than a copy of it that can drift.
 */
export const AI_BOUNDARY_FORBIDDEN_IMPORTS = [
  '../normalize/*', '../normalize', '../pipeline/types', '@xaa/logging',
];

export default tseslint.config(
  // apps/*/src/oidc is committed generator output (DEC-APP-04); check-oidc-patches.mjs
  // pins it to the baseline, so it is not linted as hand-written code.
  { ignores: ['apps/automation-app/public/**', '**/dist/**', '**/node_modules/**', 'generated-baseline/**', 'apps/*/src/oidc/**'] },
  {
    languageOptions: {
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly',
        Request: 'readonly', Response: 'readonly', Headers: 'readonly', fetch: 'readonly',
        AbortSignal: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', structuredClone: 'readonly',
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/agent-op/**/*.ts', 'apps/agent-runtime/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          '@platform/security/rules',
          '@platform/security/correlation',
          '@platform/security/scoring',
          '@platform/security/ai',
        ],
      }],
    },
  },
  {
    files: ['apps/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['@xaa/crypto/dist/verifiers-internal'],
      }],
    },
  },
  // T-SEC-01. Every line an application writes goes through the shared logger, so that
  // the four required keys are present and the redactor has seen the values. A direct
  // console call bypasses both and puts an unredacted string on the security channel.
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['packages/xaa-logging/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  // RULE-39: whatever reaches the model is a summary this app built, never a log. The
  // client cannot import the normaliser, and the normaliser cannot import the client.
  {
    files: ['apps/security-detection/src/ai/vertex-client.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...AI_BOUNDARY_FORBIDDEN_IMPORTS] }],
    },
  },
  {
    files: ['apps/security-detection/src/normalize/**/*.ts', 'apps/security-detection/src/pipeline/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['../ai/*', '../../ai/*'] }],
    },
  },
  // RULE-54: the timeline shows what happened; it does not decide anything. Importing a
  // policy engine, a risk scorer or a detection module into the display code is how a
  // screen starts forming its own opinion about an event it was only meant to render.
  {
    files: ['apps/automation-app/src/activity/**/*.ts', 'apps/automation-app/src/ui/**/*.ts', 'apps/automation-app/src/ui/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['*policy-engine*', '*risk-scoring*', '*lifecycle-manager*', '*security-detection*'],
      }],
    },
  },
);
