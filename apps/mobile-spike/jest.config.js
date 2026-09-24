const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')
const babelConfig = path.resolve(__dirname, 'babel.config.js')
const jestExpo = path.resolve(__dirname, 'node_modules/jest-expo')
const vitestShim = path.resolve(__dirname, 'tests/support/vitest-shim.ts')
const transform = { '\\.[jt]sx?$': ['babel-jest', { configFile: babelConfig }] }

// The web app's own test files, run UNCHANGED. They import `vitest`; that module is mapped to a
// shim over Jest's globals (describe/it/expect are the only names these files use).
const SHARED_TESTS = [
  'tests/financial/money.test.ts',
  'tests/financial/cost-basis.test.ts',
  'tests/financial/fx.test.ts',
  'tests/financial/market-value.test.ts',
  'tests/financial/worked-examples.test.ts',
  'tests/data/money.test.ts',
  'tests/data/pricing.test.ts',
].map((f) => `<rootDir>/${f}`)

// The single path alias of the spike: `@shared/...` is the web app's `src/...`. Mirrored in
// tsconfig.json (paths) and metro.config.js (resolveRequest).
const sharedAlias = { '^@shared/(.*)$': path.resolve(repoRoot, 'src/$1') }
// The single seam: shared data modules import the web client singleton as './supabase-client'.
// Shared files live outside this package: their bare imports (e.g. Babel runtime helpers added by the
// transform) must resolve from THIS package's node_modules.
const appModules = ['node_modules', path.resolve(__dirname, 'node_modules')]
const seam = (file) => ({ '^\\./supabase-client$': path.resolve(__dirname, file) })

const sharedBase = {
  rootDir: repoRoot,
  setupFilesAfterEnv: [path.resolve(__dirname, 'tests/support/bigint-json.ts')],
  roots: [`${repoRoot}/tests/financial`, `${repoRoot}/tests/data`],
  testMatch: SHARED_TESTS,
  moduleNameMapper: {
    '^vitest$': vitestShim,
    ...seam('tests/support/unit-supabase-client.ts'),
  },
  moduleDirectories: appModules,
}

module.exports = {
  testTimeout: 120000,
  projects: [
    // Web domain tests, Node environment (same engine the web suite uses, different runner).
    { ...sharedBase, displayName: 'shared-node', testEnvironment: 'node', transform },
    // The same files under the React Native jest preset (jest-expo).
    { ...sharedBase, displayName: 'shared-rn', preset: jestExpo },
    // Native app: pure core + React Native component/navigation tests, fakes for all I/O.
    {
      displayName: 'unit',
      preset: jestExpo,
      rootDir: __dirname,
      testMatch: ['<rootDir>/tests/unit/**/*.test.{ts,tsx}'],
      moduleNameMapper: { ...seam('tests/support/unit-supabase-client.ts'), ...sharedAlias },
      moduleDirectories: appModules,
      setupFilesAfterEnv: [
        '<rootDir>/tests/support/bigint-json.ts',
        '<rootDir>/tests/support/setup-rn.ts',
      ],
      transformIgnorePatterns: [
        'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
      ],
    },
    // Real local Supabase (isolated stack). Runs only when P158_LOCAL_BACKEND=1 (see tests/backend).
    {
      displayName: 'backend',
      rootDir: __dirname,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/backend/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/support/bigint-json.ts'],
      transform,
      moduleNameMapper: { ...seam('tests/support/backend-supabase-client.ts'), ...sharedAlias },
      moduleDirectories: appModules,
    },
  ],
}
