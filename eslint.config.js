// ESLint 9 flat config. Strict-type-checked TypeScript rules at the floor;
// the constitution forbids any silencing comments, so the lint surface is
// deliberately loud. Every override carries a one-line reason.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '.conveyor/**',
      'data/**',
      'design/**', // claude.ai/design export, NOT our authoring surface
      'web/dist/**',
      // The config files themselves are JS, not in any tsconfig project,
      // so typed-linting rules cannot run on them.
      '*.js',
      '*.cjs',
      '*.mjs',
    ],
  },

  // Server / Node code (TS, strict-type-checked).
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // catch-log-continue is forbidden by constitution.md §3.
      // The rule that catches the common shape is no-useless-catch (built-in)
      // plus our own custom grep in scripts/vouch-grep-attacks.sh.
      'no-useless-catch': 'error',

      // Production paths should not console.log — use the project logger.
      // Tests and scripts can override locally.
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Constitution §3: no `// @ts-ignore` ever.
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore':     true,
        'ts-nocheck':    true,
        'ts-check':      false,
        // `ts-expect-error` is allowed ONLY with a description so the
        // reason for the suppression is in the source.
        'ts-expect-error': { descriptionFormat: '^: TS\\d+ because .+$' },
      }],

      // No `any` without explicit reason. Constitution §3.
      '@typescript-eslint/no-explicit-any': 'error',

      // The "throw new Error('failed')" anti-pattern (J-CAT-12). Keep the
      // string-throw rule strict; the lazy throw shape is what Vouch greps.
      '@typescript-eslint/only-throw-error': 'error',

      // Promise.reject(string) is the cousin of the previous one.
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
    },
  },

  // Tests: relax a couple of the strict-type-checked rules that fight
  // common Vitest patterns. Still no `any`, still no ts-ignore.
  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'off', // smoke tests log against real APIs intentionally
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': 'off', // chai-style assertions
    },
  },
);
