import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * P130-30: where each ONNX Runtime binary comes from, pinned and checked.
 *
 * - JS + native glue: the npm package `onnxruntime-react-native`, exact version, integrity in the lockfile.
 * - Android runtime: the Maven AAR `com.microsoft.onnxruntime:onnxruntime-android`. Upstream's
 *   android/build.gradle asks for `latest.integration` (whatever Maven Central serves that day —
 *   1.30.0 when this was written, against a 1.24.3 JS package). The pnpm patch pins it.
 * - iOS runtime: the CocoaPod `onnxruntime-c`, pinned to the package version by
 *   plugins/with-ios-onnxruntime-pin.js.
 * All three must be the same release. Nothing here claims upstream binary attestation: the pin
 * fixes WHICH release is built, and docs/security/P191_SECURITY_BOUNDARY_CLOSURE.md records the
 * SHA-256 of the 1.24.3 AAR observed on Maven Central for a future Gradle verification file.
 */
const root = join(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const pkg = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>
  onnxruntimeExtensionsEnabled?: unknown
}
const version = pkg.dependencies['onnxruntime-react-native']!
const patch = read('patches/onnxruntime-react-native.patch')
const lock = read('pnpm-lock.yaml')

describe('onnxruntime provenance (P130-30)', () => {
  it('the JS package is an exact version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('the Android runtime and QNN AARs are pinned to the package version, never latest', () => {
    expect(patch).toContain(
      `+    extractLibs "com.microsoft.onnxruntime:onnxruntime-android:${version}@aar"`,
    )
    expect(patch).toContain(
      `+    extractLibs "com.microsoft.onnxruntime:onnxruntime-android-qnn:${version}@aar"`,
    )
    // The removed upstream lines are the floating ones; no added line may reintroduce them.
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    for (const line of added) {
      if (/extractLibs/.test(line)) expect(line).not.toMatch(/latest|\+@|:\+/)
    }
  })

  it('the extensions AAR (a different release train) stays disabled, so its floating line is dead', () => {
    expect(pkg.onnxruntimeExtensionsEnabled).toBeUndefined()
  })

  it('the iOS pod pin follows the same package version', () => {
    const plugin = read('plugins/with-ios-onnxruntime-pin.js')
    expect(plugin).toMatch(/require\('onnxruntime-react-native\/package.json'\)/)
    expect(plugin).toMatch(/pod 'onnxruntime-c', '\$\{version\}'/)
  })

  it('the lockfile binds the exact patch content (patch_hash = sha256 of the patch file)', () => {
    const hash = createHash('sha256').update(patch).digest('hex')
    expect(lock).toContain(`hash: ${hash}`)
    expect(lock).toContain(`patch_hash=${hash}`)
  })

  it('the package integrity is recorded in the lockfile', () => {
    expect(lock).toMatch(
      new RegExp(
        `onnxruntime-react-native@${version.replace(/\./g, '\\.')}:\\n\\s+resolution: \\{integrity: sha512-`,
      ),
    )
  })
})
