// Native spike lint config. Run from the repo root's ESLint installation:
//   pnpm --dir ../.. exec eslint --config apps/mobile-spike/eslint.config.js apps/mobile-spike/src ...
// (the root config ignores this package on purpose; see eslint.config.js there).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      '.build',
      '.local-backend',
      'babel.config.js',
      'metro.config.js',
      'jest.config.js',
      'scripts/*.mjs',
      'eslint.config.js',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Money is exact bigint. A Number() call in code that handles money is how 2^53 bugs are made
    // (P154 risk table; the web app's src/ui/money-format.ts documents the P114 instance).
    files: [
      'src/money/**/*.ts',
      'src/collection/**/*.ts',
      'src/price-check/**/*.ts',
      'src/state/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'Do not convert money through Number(): use bigint/string (see src/money).',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'Do not parse money as a float.',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
)
