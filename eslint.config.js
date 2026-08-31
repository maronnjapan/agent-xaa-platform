import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // apps/*/src/oidc is committed generator output (DEC-APP-04); check-oidc-patches.mjs
  // pins it to the baseline, so it is not linted as hand-written code.
  { ignores: ['**/dist/**', '**/node_modules/**', 'generated-baseline/**', 'apps/*/src/oidc/**'] },
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
);
