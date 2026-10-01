/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS Expo config plugin. */
// The Expo modifiers are replaced by recorders so the plugin's WIRING can be asserted.
jest.mock('expo/config-plugins', () => {
  const record =
    (name: string) =>
    (config: { mods?: string[] }, _fnOrPlatform: unknown): { mods: string[] } => ({
      ...config,
      mods: [...(config.mods ?? []), name],
    })
  return {
    withGradleProperties: record('gradle-properties'),
    withAppBuildGradle: record('app-build-gradle'),
    withDangerousMod: record('dangerous-mod-proguard'),
  }
})
const shrink = require('../../plugins/with-release-packaging') as {
  applyShrinkingProperties: (
    items: { type: string; key?: string; value?: string }[],
  ) => { type: string; key?: string; value?: string }[]
  appendKeepRules: (contents: string) => string
  excludeUnusedOcrScripts: (contents: string) => string
  UNUSED_OCR_SCRIPT_MODULES: string[]
  EXCLUDE_MARKER: string
  MARKER: string
  PROPERTIES: Record<string, string>
}

// P186: release builds shrink code and resources. The keep rules protect the classes the scanner's
// native libraries reach by name; if one disappears, the scanner breaks only at runtime, so the
// rules are pinned here (and exercised for real by the release-APK recognition on the device).
describe('with-release-packaging', () => {
  it('turns on both shrinking properties, pins the ABIs and keeps unrelated properties', () => {
    const out = shrink.applyShrinkingProperties([
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2048m' },
      { type: 'comment', value: 'x' },
    ])
    expect(out.find((i) => i.key === 'android.enableMinifyInReleaseBuilds')?.value).toBe('true')
    expect(out.find((i) => i.key === 'android.enableShrinkResourcesInReleaseBuilds')?.value).toBe(
      'true',
    )
    expect(out.find((i) => i.key === 'org.gradle.jvmargs')?.value).toBe('-Xmx2048m')
    // Real devices (arm64) and emulators (x86_64); no armeabi-v7a / x86 copies of every native library.
    expect(out.find((i) => i.key === 'reactNativeArchitectures')?.value).toBe('arm64-v8a,x86_64')
    expect(out.find((i) => i.type === 'comment')).toBeDefined()
  })

  it('overrides an explicit false instead of duplicating the key', () => {
    const out = shrink.applyShrinkingProperties([
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'false' },
    ])
    const matches = out.filter((i) => i.key === 'android.enableMinifyInReleaseBuilds')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.value).toBe('true')
  })

  it('is idempotent for properties and for the keep rules', () => {
    const once = shrink.applyShrinkingProperties([])
    expect(shrink.applyShrinkingProperties(once)).toEqual(once)
    const rules = shrink.appendKeepRules('-keep class a.B { *; }\n')
    expect(shrink.appendKeepRules(rules)).toBe(rules)
    expect(rules.startsWith('-keep class a.B { *; }\n')).toBe(true)
  })

  it.each([
    'ai.onnxruntime',
    'com.microsoft.onnxruntime',
    'com.shopify.reactnative.skia',
    'com.rnmlkit',
    'com.google.mlkit.vision.text',
  ])('keeps %s (reached from native code or by reflection)', (pkg) => {
    expect(shrink.appendKeepRules('')).toContain(`-keep class ${pkg}.** { *; }`)
  })

  it('excludes exactly the four ML Kit script packages the scanner never requests', () => {
    expect(shrink.UNUSED_OCR_SCRIPT_MODULES).toEqual([
      'text-recognition-chinese',
      'text-recognition-devanagari',
      'text-recognition-japanese',
      'text-recognition-korean',
    ])
    const out = shrink.excludeUnusedOcrScripts("apply plugin: 'com.android.application'\n")
    for (const name of shrink.UNUSED_OCR_SCRIPT_MODULES)
      expect(out).toContain(`exclude group: 'com.google.mlkit', module: '${name}'`)
    // The Latin recognizer (module text-recognition) must never be excluded.
    expect(out).not.toMatch(/module: 'text-recognition'/)
    expect(out).toContain('configurations.configureEach')
  })

  it('the exclusion is idempotent and keeps the original build file first', () => {
    const base = "apply plugin: 'com.android.application'\n"
    const once = shrink.excludeUnusedOcrScripts(base)
    expect(once.startsWith(base)).toBe(true)
    expect(shrink.excludeUnusedOcrScripts(once)).toBe(once)
  })

  it('the keep rules silence the wrapper references to the excluded packages', () => {
    const rules = shrink.appendKeepRules('')
    for (const pkg of ['chinese', 'devanagari', 'japanese', 'korean'])
      expect(rules).toContain(`-dontwarn com.google.mlkit.vision.text.${pkg}.**`)
  })

  it('wires all three edits: gradle.properties, the app build file and the ProGuard rules', () => {
    const plugin = shrink as unknown as (config: object) => { mods?: string[] }
    expect(plugin({}).mods).toEqual([
      'gradle-properties',
      'app-build-gradle',
      'dangerous-mod-proguard',
    ])
  })

  it('is registered in app.json', () => {
    const app = require('../../app.json') as { expo: { plugins: unknown[] } }
    expect(app.expo.plugins).toContain('./plugins/with-release-packaging')
  })

  it('writes no literal user path', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const source = fs.readFileSync(require.resolve('../../plugins/with-release-packaging'), 'utf8')
    expect(source).not.toMatch(/C:[\\/]+Users[\\/]+Oskar/i)
  })
})
