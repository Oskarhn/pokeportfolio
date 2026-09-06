import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P111 §4 — this project has suffered a duplicate-decision-ID collision more than once now
 * (P106 vs P108 both independently minting D-116/D-117/D-118 from a shared ancestor, reconciled
 * this session by renumbering P108's pair to D-120/D-121). A permanent, cheap check that never
 * required running the DB or the app: parse every `## D-NNN` header in docs/DECISIONS.md and fail
 * if any number repeats. Catches the collision class at `pnpm test` time, long before a future
 * integration session has to untangle it by hand again.
 */
describe('docs/DECISIONS.md decision IDs are unique', () => {
  const text = readFileSync(join(process.cwd(), 'docs', 'DECISIONS.md'), 'utf-8')
  const ids = [...text.matchAll(/^## D-(\d+)\b/gm)].map((m) => Number(m[1]))

  it('parses at least one decision (sanity check the regex still matches the doc format)', () => {
    expect(ids.length).toBeGreaterThan(50)
  })

  it('no decision ID is used by more than one heading', () => {
    const seen = new Map<number, number>()
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1)
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)
    expect(duplicates, `duplicate D-${duplicates.join(', D-')}`).toEqual([])
  })
})
