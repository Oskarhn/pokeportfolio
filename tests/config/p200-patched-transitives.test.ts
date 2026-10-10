import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P200: transitive packages with a published advisory that are reachable from the shipped app or
 * its build, pinned past the fixed version through `pnpm.overrides`. This reads the lockfile, so a
 * lockfile regenerated without the override (or an override silently dropped) fails here instead
 * of reappearing in `pnpm audit`.
 *
 *   seroval        <1.6.3  memory exhaustion in JSON deserialisation (via @tanstack/router-core)
 *   source-map-js  <1.2.2  event-loop denial of service on crafted source maps (via tailwindcss)
 *
 * Not overridden on purpose: `sharp` / `sprintf-js` under @huggingface/transformers, which only
 * Node-side lab and benchmark scripts load (never the browser bundle); forcing a newer sharp would
 * change image decoding under the pinned scanner-index content id.
 */

const lock = readFileSync(join(import.meta.dirname, '../../pnpm-lock.yaml'), 'utf8')

function resolvedVersions(name: string): string[] {
  // Package entries sit at two-space indent in the lockfile: "  name@1.2.3:".
  const found = new Set<string>()
  for (const rawLine of lock.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.startsWith(`  ${name}@`) || !line.endsWith(':')) continue
    found.add(line.slice(name.length + 3, -1))
  }
  return [...found]
}

const atLeast = (version: string, minimum: string): boolean => {
  const a = version.split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

describe('patched transitive dependencies', () => {
  it('overrides are caret-bounded: a lockfile regeneration can never jump a major version', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { pnpm: { overrides: Record<string, string> } }
    for (const name of ['seroval', 'source-map-js']) {
      expect(pkg.pnpm.overrides[name], name).toMatch(/^\^\d+\.\d+\.\d+$/)
    }
    // The lockfile records the same specifiers it was generated with.
    expect(lock).toMatch(/^ {2}seroval: \^1\.6\.3$/m)
    expect(lock).toMatch(/^ {2}source-map-js: \^1\.2\.2$/m)
  })

  for (const [name, minimum] of [
    ['seroval', '1.6.3'],
    ['source-map-js', '1.2.2'],
  ] as const) {
    it(`${name} resolves only to >= ${minimum}`, () => {
      const versions = resolvedVersions(name)
      expect(versions.length).toBeGreaterThan(0)
      expect(versions.filter((v) => !atLeast(v, minimum))).toEqual([])
    })
  }

  it('package.json keeps the overrides that produce those resolutions', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { pnpm: { overrides: Record<string, string> } }
    expect(pkg.pnpm.overrides.seroval).toBe('^1.6.3')
    expect(pkg.pnpm.overrides['source-map-js']).toBe('^1.2.2')
  })
})
