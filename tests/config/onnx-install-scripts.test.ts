import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * P130-30: `onnxruntime-node`'s postinstall downloads the CUDA execution-provider binaries from
 * NuGet on linux/x64 — which is exactly the GitHub runner — with no integrity check (its
 * install-utils.js only does an https GET). This project never uses CUDA (the scanner runs on CPU;
 * onnxruntime-node is a transitive dependency of @huggingface/transformers for offline Node
 * tooling), and the CPU binaries are bundled in the npm tarball, which the lockfile integrity
 * covers. So the install script is simply not allowed to run: pnpm only runs dependency build
 * scripts for packages named in `pnpm.onlyBuiltDependencies`.
 */
describe('onnxruntime-node install script', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    pnpm: { onlyBuiltDependencies: string[] }
  }

  it('is not permitted to run (no unverified NuGet download at install time)', () => {
    expect(pkg.pnpm.onlyBuiltDependencies).not.toContain('onnxruntime-node')
  })

  it('the build-script allowlist is exactly what was reviewed', () => {
    expect([...pkg.pnpm.onlyBuiltDependencies].sort()).toEqual(['esbuild', 'sharp'])
  })

  it('mutation: allowing it again is what this test exists to catch', () => {
    expect([...pkg.pnpm.onlyBuiltDependencies, 'onnxruntime-node']).toContain('onnxruntime-node')
  })
})
