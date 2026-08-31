import { defineProject } from 'vitest/config';

export default [
  defineProject({
    test: {
      name: 'unit',
      include: ['packages/*/test/**/*.spec.ts', 'apps/*/test/**/*.spec.ts'],
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
