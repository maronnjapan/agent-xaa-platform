import { defineProject } from 'vitest/config';

export default [
  defineProject({
    test: {
      name: 'unit',
      // tests/docs checks the registers that describe the repository itself: the
      // requirement index, the deviation table, the rules and their traceability.
      include: ['packages/*/test/**/*.spec.ts', 'apps/*/test/**/*.spec.ts', 'tests/docs/**/*.spec.ts'],
      exclude: ['apps/*/test/integration/**/*.spec.ts'],
    },
  }),
  defineProject({
    test: {
      name: 'integration',
      include: ['apps/*/test/integration/**/*.spec.ts'],
    },
  }),
  defineProject({
    test: {
      name: 'e2e',
      include: ['e2e/test/**/*.spec.ts'],
      testTimeout: 60_000,
    },
  }),
];
