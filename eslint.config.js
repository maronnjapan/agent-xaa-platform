import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
    files: ['apps/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['@xaa/crypto/dist/verifiers-internal'],
      }],
    },
  },
  // RULE-20 / REQ-09-038: Agent OP decides nothing, so it never loads a model client or
  // a Security Detection module. This block comes after the apps-wide one on purpose:
  // flat config replaces a rule's options rather than merging them, so the narrower
  // list has to restate the platform-wide entry (the internal verifier ban) or it
  // would silently hand agent-op and agent-runtime back what every other app is denied.
  {
    files: ['apps/agent-op/**/*.ts', 'apps/agent-runtime/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          '@google-cloud/aiplatform',
          '@google-cloud/vertexai',
          '@platform/security/rules',
          '@platform/security/correlation',
          '@platform/security/scoring',
          '@platform/security/ai',
          '@xaa/crypto/dist/verifiers-internal',
        ],
      }],
    },
  },
  // RULE-39: whatever reaches the model is a summary this app built, never a log. The
  // client cannot import the normaliser, and the normaliser cannot import the client.
  {
    files: ['apps/security-detection/src/ai/vertex-client.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['../normalize/*', '../normalize', '../pipeline/types', '@xaa/logging'],
      }],
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
