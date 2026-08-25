import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Parallel milestone development once allocated the same decision numbers (three-way D-074
// collision between M13/P42/P43) and the same migration timestamp (P42 and P43 both stamped
// 20260901120000) on separate branches — collisions no branch's own CI could see, caught only
// at integration review. These checks make both collision classes fail loudly in every unit
// test run, on every branch, before a second integration ever has to repair them by hand.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function duplicates(values: string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i)
}

describe('repository namespace integrity', () => {
  it('DECISIONS.md allocates each D-number exactly once', () => {
    const text = readFileSync(join(repoRoot, 'docs', 'DECISIONS.md'), 'utf8')
    const ids = [...text.matchAll(/^## (D-\d+)/gm)].map((m) => m[1] as string)
    expect(ids.length).toBeGreaterThan(50)
    expect(duplicates(ids)).toEqual([])
  })

  it('no two migration files share a leading timestamp version', () => {
    const files = readdirSync(join(repoRoot, 'supabase', 'migrations')).filter((f) =>
      /^\d{14}_.+\.sql$/.test(f),
    )
    expect(files.length).toBeGreaterThan(50)
    const versions = files.map((f) => f.slice(0, 14))
    expect(duplicates(versions)).toEqual([])
  })
})
