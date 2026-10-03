/**
 * @jest-environment node
 */
// P187: the rules that turn "the iOS bundle built" into "the iOS bundle carries the right
// implementation of every module". `scripts/p187/ios-graph-check.cjs` feeds the real Metro graph into
// this analysis; here it is exercised with synthetic graphs, including the failure each rule exists
// to catch, so a mutation of a rule cannot pass unnoticed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { analyzeGraph, REQUIRED_MODULES } = require('../../scripts/p187/ios-graph-lib.cjs') as {
  analyzeGraph: (
    sources: string[],
    platform: 'ios' | 'android',
  ) => { violations: string[]; missing: string[]; moduleCount: number }
  REQUIRED_MODULES: string[]
}

/** A graph that satisfies every "must be present" rule, to be mutated by each test. */
const GOOD: string[] = [
  ...REQUIRED_MODULES.map((needle) =>
    needle.endsWith('/') || needle.includes('NativeSetup') ? `${needle}index.js` : needle,
  ),
  '/node_modules/react-native/Libraries/Components/DrawerAndroid/DrawerLayoutAndroidFallback.js',
  '/node_modules/react-native/Libraries/Components/Switch/AndroidSwitchNativeComponent.js',
  '/src/ui/keyboard.ts',
]

describe('analyzeGraph', () => {
  it('accepts a graph with the whole scanner chain and only React Native internals for Android', () => {
    const result = analyzeGraph(GOOD, 'ios')
    expect(result.violations).toEqual([])
    expect(result.missing).toEqual([])
  })

  it('flags an app module resolved to its Android implementation', () => {
    const result = analyzeGraph(
      [...GOOD, '/src/features/scanner-native/ocr-adapter.android.ts'],
      'ios',
    )
    expect(result.violations).toEqual([
      'app module for another platform: /src/features/scanner-native/ocr-adapter.android.ts',
    ])
  })

  it('flags an app module resolved to its web implementation', () => {
    expect(analyzeGraph([...GOOD, '/src/photo/store.web.ts'], 'ios').violations).toHaveLength(1)
  })

  it('flags build-time code (config plugins, scripts, tests) inside the runtime bundle', () => {
    for (const path of [
      '/plugins/with-release-packaging.js',
      '/scripts/p186/x.mjs',
      '/tests/unit/a.ts',
    ]) {
      expect(analyzeGraph([...GOOD, path], 'ios').violations).toHaveLength(1)
    }
  })

  it('flags a third-party Android or web implementation in the iOS bundle', () => {
    expect(
      analyzeGraph([...GOOD, '/node_modules/some-lib/src/android/Module.js'], 'ios').violations,
    ).toHaveLength(1)
    expect(
      analyzeGraph([...GOOD, '/node_modules/some-lib/src/Thing.android.js'], 'ios').violations,
    ).toHaveLength(1)
    expect(
      analyzeGraph([...GOOD, '/node_modules/some-lib/src/Thing.web.js'], 'ios').violations,
    ).toHaveLength(1)
  })

  it('does not flag React Native itself (its iOS bundle always contains its Android specs)', () => {
    expect(
      analyzeGraph(
        [...GOOD, '/node_modules/react-native/Libraries/PermissionsAndroid/PermissionsAndroid.js'],
        'ios',
      ).violations,
    ).toEqual([])
  })

  it('requires the scanner chain by name (a shortened list would make the next test vacuous)', () => {
    expect(REQUIRED_MODULES).toEqual(
      expect.arrayContaining([
        '/src/features/scanner-native/recognition-pipeline.ts',
        '/src/features/scanner-native/ocr-adapter.ts',
        '/src/features/scanner-native/visual-adapter.ts',
        '/src/features/scanner-native/image-decode.ts',
        '/src/features/scanner-native/model-assets.ts',
        '/node_modules/onnxruntime-react-native/',
        '/node_modules/@react-native-ml-kit/text-recognition/',
        '/node_modules/@shopify/react-native-skia/src/skia/NativeSetup',
        '/node_modules/expo-image-picker/',
      ]),
    )
  })

  it('reports each missing part of the scanner chain', () => {
    for (const needle of REQUIRED_MODULES) {
      const without = GOOD.filter((source) => !source.includes(needle))
      expect(analyzeGraph(without, 'ios').missing).toContain(needle)
    }
  })

  it('normalises Windows separators', () => {
    const backslashed = GOOD.map((source) => source.split('/').join(String.fromCharCode(92)))
    expect(analyzeGraph(backslashed, 'ios')).toMatchObject({ violations: [], missing: [] })
  })

  it('checks Android bundles against the iOS and web suffixes', () => {
    expect(analyzeGraph([...GOOD, '/src/ui/x.ios.tsx'], 'android').violations).toHaveLength(1)
  })

  it('rejects an unknown platform', () => {
    expect(() => analyzeGraph(GOOD, 'tvos' as never)).toThrow(/unsupported platform/)
  })
})
