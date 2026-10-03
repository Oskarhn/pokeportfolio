/**
 * Pure analysis of the module list Metro bundled for one platform (P187). Input: the `sources` of the
 * source map `expo export --dump-sourcemap` writes. Nothing here touches the filesystem or Metro, so
 * the rules are unit-tested with synthetic lists (tests/unit/p187-ios-graph.test.ts) and the CLI
 * (ios-graph-check.cjs) feeds it the real graph.
 *
 * What must NOT be in an iOS bundle:
 *   - a file of THIS app named for another platform (`*.android.*`, `*.web.*`): a platform adapter
 *     resolved to the wrong implementation, or an Android-only adapter loaded unconditionally;
 *   - the app's config plugins, build scripts or tests (build-time code, not runtime);
 *   - a THIRD-PARTY module's android/web implementation. React Native's own `*Android*` spec files are
 *     allowed: its iOS bundle always carries them (the cross-platform `Platform` switch), they are
 *     inert on iOS.
 * What MUST be in it: the scanner's whole native chain, so "the scanner screen bundles" is an
 * assertion and not an assumption.
 */

const REQUIRED_MODULES = [
  '/src/features/scanner-native/recognition-pipeline.ts',
  '/src/features/scanner-native/ocr-adapter.ts',
  '/src/features/scanner-native/visual-adapter.ts',
  '/src/features/scanner-native/image-decode.ts',
  '/src/features/scanner-native/model-assets.ts',
  '/src/features/price-check/PhotoEntryScreen.tsx',
  '/src/photo/expo-photo-port.ts',
  '/node_modules/onnxruntime-react-native/',
  '/node_modules/@react-native-ml-kit/text-recognition/',
  '/node_modules/@shopify/react-native-skia/src/skia/NativeSetup',
  '/node_modules/expo-image-picker/',
  '/node_modules/expo-secure-store/',
]

const OTHER_PLATFORM_SUFFIX = {
  ios: /\.(android|web)\.[cm]?[jt]sx?$/,
  android: /\.(ios|web)\.[cm]?[jt]sx?$/,
}

const BUILD_TIME_DIRS = ['/plugins/', '/scripts/', '/tests/']

function normalise(source) {
  return source.split(String.fromCharCode(92)).join('/') // backslash -> slash (Windows source maps)
}

function isNodeModule(source) {
  return source.includes('/node_modules/')
}

function isReactNativeInternal(source) {
  return (
    /\/node_modules\/react-native\//.test(source) ||
    /\/node_modules\/@react-native\//.test(source) ||
    /\/node_modules\/@expo\/cli\//.test(source)
  )
}

/** @returns {{ violations: string[], missing: string[], moduleCount: number }} */
function analyzeGraph(rawSources, platform) {
  const wrongSuffix = OTHER_PLATFORM_SUFFIX[platform]
  if (wrongSuffix === undefined) throw new Error(`unsupported platform: ${platform}`)
  const sources = rawSources.map(normalise).filter((s) => !s.startsWith('\u0000'))
  const violations = []
  for (const source of sources) {
    if (!isNodeModule(source)) {
      if (wrongSuffix.test(source)) violations.push(`app module for another platform: ${source}`)
      if (BUILD_TIME_DIRS.some((dir) => source.includes(dir)))
        violations.push(`build-time code in the runtime bundle: ${source}`)
      continue
    }
    if (isReactNativeInternal(source)) continue
    if (platform === 'ios' && /\/android\/|\.android\.[cm]?[jt]sx?$/.test(source)) {
      violations.push(`third-party Android implementation in the iOS bundle: ${source}`)
    }
    if (platform === 'ios' && /\.web\.[cm]?[jt]sx?$/.test(source)) {
      violations.push(`third-party web implementation in the iOS bundle: ${source}`)
    }
  }
  const missing = REQUIRED_MODULES.filter((needle) => !sources.some((s) => s.includes(needle)))
  return { violations, missing, moduleCount: sources.length }
}

module.exports = { analyzeGraph, REQUIRED_MODULES }
