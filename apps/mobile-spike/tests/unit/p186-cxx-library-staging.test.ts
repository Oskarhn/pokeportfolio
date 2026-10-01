/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS Expo config plugin. */
// The Expo modifiers are replaced by recorders so the plugin's WIRING (which build files it touches)
// can be asserted without running Expo.
jest.mock('expo/config-plugins', () => {
  const record =
    (name: string) =>
    (config: { mods?: string[] }, _fn: unknown): { mods: string[] } => ({
      ...config,
      mods: [...(config.mods ?? []), name],
    })
  return {
    withAppBuildGradle: record('app-build-gradle'),
    withProjectBuildGradle: record('root-build-gradle'),
  }
})
const cxx = require('../../plugins/with-short-cxx-build-path') as {
  injectLibraryStagingDirs: (contents: string, dir: string) => string
  LIBRARY_MARKER: string
}

// P186: onnxruntime-react-native's own CMake build (module `onnxruntime-react-native`) failed for
// arm64-v8a on Windows because its object path exceeded 260 characters. Every library module that
// declares a CMake build must get a short, module-specific staging directory.
describe('with-short-cxx-build-path: wiring', () => {
  const plugin = require('../../plugins/with-short-cxx-build-path') as (config: object) => {
    mods?: string[]
  }
  const os = require('node:os') as typeof import('node:os')
  afterEach(() => jest.restoreAllMocks())

  it('on Windows it edits BOTH the app module and the root project (library modules)', () => {
    jest.spyOn(os, 'platform').mockReturnValue('win32')
    expect(plugin({}).mods).toEqual(['app-build-gradle', 'root-build-gradle'])
  })

  it('elsewhere it leaves the build files alone (the path is short enough on macOS/Linux CI)', () => {
    jest.spyOn(os, 'platform').mockReturnValue('linux')
    expect(plugin({}).mods).toBeUndefined()
  })
})

describe('with-short-cxx-build-path: library modules', () => {
  const ROOT = "apply plugin: 'expo-root-project'\n"
  const DIR = 'C:/Users/dev/.pokeportfolio-cxx/abcd1234'

  it('adds one subprojects block that targets only library modules with a CMake build', () => {
    const out = cxx.injectLibraryStagingDirs(ROOT, DIR)
    expect(out).toContain(cxx.LIBRARY_MARKER)
    expect(out).toContain("subproject.plugins.hasPlugin('com.android.library')")
    expect(out).toContain('subproject.state.executed')
    expect(out).toContain('cmake.path != null')
    expect(out).toContain(`new File("${DIR}/" + subproject.name)`)
  })

  it('is idempotent', () => {
    const once = cxx.injectLibraryStagingDirs(ROOT, DIR)
    expect(cxx.injectLibraryStagingDirs(once, DIR)).toBe(once)
  })

  it('keeps the existing root file content first', () => {
    expect(cxx.injectLibraryStagingDirs(ROOT, DIR).startsWith(ROOT)).toBe(true)
  })

  it('writes no literal user path', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const source = fs.readFileSync(
      require.resolve('../../plugins/with-short-cxx-build-path'),
      'utf8',
    )
    expect(source).not.toMatch(/C:[\\/]+Users[\\/]+Oskar/i)
  })
})
