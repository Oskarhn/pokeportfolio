/**
 * Expo config plugin: Android release packaging (P186).
 *
 *   1. R8 code shrinking and resource shrinking for RELEASE builds, with keep rules for the classes
 *      native code reaches by name.
 *   2. The ABIs the app is built for: arm64-v8a (real devices) and x86_64 (emulators, ChromeOS).
 *   3. The ML Kit recognizers for scripts the scanner never requests (Chinese, Devanagari, Japanese,
 *      Korean): the React Native wrapper pulls all five script packages in, but the only call site is
 *      `TextRecognition.recognize(path, TextRecognitionScript.LATIN)` (pinned by a test that scans the
 *      sources). They cost ~2.4 MB of the compressed download. Adding a script later means removing
 *      its line here, which that test makes a deliberate act.
 *
 * The Expo template builds release with `minifyEnabled=false` and `shrinkResources=false` unless
 * `android.enableMinifyInReleaseBuilds` / `android.enableShrinkResourcesInReleaseBuilds` are set.
 * Measured (docs/mobile/P186_ANDROID_PACKAGING_PERFORMANCE.md): the unshrunk DEX is 27 MB raw /
 * 9.75 MB compressed; R8 takes it to 9.5 MB raw / 3.8 MB compressed.
 *
 * The template's default `reactNativeArchitectures` also builds armeabi-v7a and x86, which would put
 * two more copies of every native library (ONNX Runtime alone is 33-39 MB each) into a bundle no
 * supported device needs: the scanner holds a ~350 MB model session, which a 32-bit-only or
 * x86 phone cannot carry. A command-line `-PreactNativeArchitectures=...` still overrides this
 * (the proof/emulator builds pass x86_64 only).
 *
 * What must survive R8, and why (each is reached from native code or by reflection, which R8's
 * reachability analysis cannot see):
 *   - ONNX Runtime: its JNI layer calls `FindClass("ai/onnxruntime/...")` and the React Native
 *     binding is a TurboModule-like package registered by `with-onnxruntime-package.js`.
 *   - Skia: JNI into `com.shopify.reactnative.skia.*`.
 *   - ML Kit text recognition: the React Native wrapper and the Google ML Kit runtime resolve their
 *     option classes reflectively.
 * Nothing here is trusted on the strength of "the build passed": the device journey runs a real
 * scanner recognition on the release build (scripts/p186/).
 *
 * Pure transforms (`applyShrinkingProperties`, `appendKeepRules`) are exported for unit tests; both
 * are idempotent and carry no machine-specific path.
 */
const {
  withGradleProperties,
  withDangerousMod,
  withAppBuildGradle,
} = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

const MARKER = 'P186 release shrinking keep rules'

const PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  reactNativeArchitectures: 'arm64-v8a,x86_64',
}

const KEEP_RULES = `
# ${MARKER}
# JNI / reflection entry points of the scanner's native dependencies (see plugins/with-release-packaging.js).
-keep class ai.onnxruntime.** { *; }
-keep class com.microsoft.onnxruntime.** { *; }
-keep class com.shopify.reactnative.skia.** { *; }
-keep class com.rnmlkit.** { *; }
-keep class com.google.mlkit.vision.text.** { *; }
# The wrapper names the option classes of the excluded script packages (never reached at runtime).
-dontwarn com.google.mlkit.vision.text.chinese.**
-dontwarn com.google.mlkit.vision.text.devanagari.**
-dontwarn com.google.mlkit.vision.text.japanese.**
-dontwarn com.google.mlkit.vision.text.korean.**
`

/** ML Kit script packages the app never requests (group com.google.mlkit). */
const UNUSED_OCR_SCRIPT_MODULES = [
  'text-recognition-chinese',
  'text-recognition-devanagari',
  'text-recognition-japanese',
  'text-recognition-korean',
]

const EXCLUDE_MARKER = 'P186 unused ML Kit OCR scripts'

/**
 * Appends to app/build.gradle an exclusion of the unused ML Kit script packages from every
 * configuration of the APP module (the wrapper library still compiles against them: only what is
 * packaged changes). Idempotent.
 */
function excludeUnusedOcrScripts(contents) {
  if (contents.includes(EXCLUDE_MARKER)) return contents
  const lines = UNUSED_OCR_SCRIPT_MODULES.map(
    (name) => `    exclude group: 'com.google.mlkit', module: '${name}'`,
  ).join('\n')
  const block = `
// ${EXCLUDE_MARKER}
configurations.configureEach {
${lines}
}
`
  return contents.endsWith('\n') ? contents + block : `${contents}\n${block}`
}

/** Sets the two shrinking properties in an Expo `gradle.properties` item list (idempotent). */
function applyShrinkingProperties(items) {
  const next = items.filter((item) => !(item.type === 'property' && item.key in PROPERTIES))
  for (const [key, value] of Object.entries(PROPERTIES)) next.push({ type: 'property', key, value })
  return next
}

/** Appends the keep rules to a proguard-rules.pro text (idempotent). */
function appendKeepRules(contents) {
  if (contents.includes(MARKER)) return contents
  return `${contents.endsWith('\n') ? contents : `${contents}\n`}${KEEP_RULES}`
}

function withReleaseShrinking(config) {
  const withProps = withGradleProperties(config, (cfg) => {
    cfg.modResults = applyShrinkingProperties(cfg.modResults)
    return cfg
  })
  const withExclusions = withAppBuildGradle(withProps, (cfg) => {
    cfg.modResults.contents = excludeUnusedOcrScripts(cfg.modResults.contents)
    return cfg
  })
  return withDangerousMod(withExclusions, [
    'android',
    (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro')
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      fs.writeFileSync(file, appendKeepRules(current))
      return cfg
    },
  ])
}

module.exports = withReleaseShrinking
module.exports.applyShrinkingProperties = applyShrinkingProperties
module.exports.appendKeepRules = appendKeepRules
module.exports.excludeUnusedOcrScripts = excludeUnusedOcrScripts
module.exports.UNUSED_OCR_SCRIPT_MODULES = UNUSED_OCR_SCRIPT_MODULES
module.exports.EXCLUDE_MARKER = EXCLUDE_MARKER
module.exports.MARKER = MARKER
module.exports.PROPERTIES = PROPERTIES
