/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Expo config plugins. */
// The two Windows/upstream workarounds P182 needed for the release build, as pure transforms
// (P184): they must be idempotent, must not carry a machine-specific path, and the CMake staging
// directory must differ per project so two checkouts on one machine never share build state.

const onnx = require('../../plugins/with-onnxruntime-package') as {
  registerOnnxruntimePackage: (source: string) => string
  IMPORT_LINE: string
  ADD_LINE: string
  MARKER: string
}
const cxx = require('../../plugins/with-short-cxx-build-path') as {
  stagingDirFor: (projectRoot: string, homedir?: string) => string
  injectStagingDir: (contents: string, dir: string) => string
  MARKER: string
}

const MAIN_APPLICATION = `package x

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication

class MainApplication {
  val packages =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        }
}
`

describe('with-onnxruntime-package', () => {
  it('adds the import and registers the package exactly once (idempotent)', () => {
    const once = onnx.registerOnnxruntimePackage(MAIN_APPLICATION)
    const twice = onnx.registerOnnxruntimePackage(once)
    expect(once).toContain(onnx.IMPORT_LINE)
    expect(once).toContain(onnx.ADD_LINE)
    expect(twice).toBe(once)
    expect(once.split(onnx.ADD_LINE).length - 1).toBe(1)
  })

  it('registers inside the documented manual-registration seam, after the comment', () => {
    const out = onnx.registerOnnxruntimePackage(MAIN_APPLICATION)
    expect(out.indexOf('can be added manually here')).toBeLessThan(out.indexOf(onnx.ADD_LINE))
    expect(out.indexOf(onnx.ADD_LINE)).toBeLessThan(out.indexOf('// add(MyReactNativePackage())'))
  })

  it('leaves a file without the seam unchanged instead of guessing (the build then fails loudly at runtime tests)', () => {
    const odd = 'class MainApplication {}\n'
    expect(onnx.registerOnnxruntimePackage(odd)).toBe(odd)
  })
})

describe('with-short-cxx-build-path', () => {
  const GRADLE = 'plugins { }\nandroid {\n    ndkVersion "27"\n}\n'

  it('keys the staging directory on the project root: two checkouts never share one', () => {
    const a = cxx.stagingDirFor('C:\\work\\one\\apps\\mobile-spike', 'C:\\Users\\dev')
    const b = cxx.stagingDirFor('C:\\work\\two\\apps\\mobile-spike', 'C:\\Users\\dev')
    expect(a).not.toBe(b)
    expect(cxx.stagingDirFor('C:\\work\\one\\apps\\mobile-spike', 'C:\\Users\\dev')).toBe(a)
  })

  it('is short (the whole point) and uses forward slashes so Gradle reads it correctly', () => {
    const dir = cxx.stagingDirFor(
      'C:\\some\\very\\long\\worktree\\path\\apps\\mobile-spike',
      'C:\\Users\\dev',
    )
    expect(dir.includes('\\')).toBe(false)
    expect(dir.length).toBeLessThan(45)
  })

  it('takes the home directory from its argument, never a literal user path', () => {
    const dir = cxx.stagingDirFor('/anywhere', '/home/ci')
    expect(dir.startsWith('/home/ci/')).toBe(true)
    const fs = require('node:fs') as typeof import('node:fs')
    const source = fs.readFileSync(
      require.resolve('../../plugins/with-short-cxx-build-path'),
      'utf8',
    )
    expect(source).not.toMatch(/C:[\\/]+Users[\\/]+Oskar/i)
  })

  it('injects the staging directory once (idempotent) into the android block', () => {
    const once = cxx.injectStagingDir(GRADLE, 'C:/Users/dev/.pokeportfolio-cxx/abcd1234')
    const twice = cxx.injectStagingDir(once, 'C:/Users/dev/.pokeportfolio-cxx/abcd1234')
    expect(once).toContain('buildStagingDirectory "C:/Users/dev/.pokeportfolio-cxx/abcd1234"')
    expect(once).toContain(cxx.MARKER)
    expect(twice).toBe(once)
    expect(once.indexOf('android {')).toBeLessThan(once.indexOf('buildStagingDirectory'))
  })
})
