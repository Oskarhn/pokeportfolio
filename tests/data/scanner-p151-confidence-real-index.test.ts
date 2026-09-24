import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeVisualIndex,
  l2Normalize,
  searchVisualIndex,
  type DecodedVisualIndex,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'
import { matchScannerObservation } from '../../src/domain/scanner/engine'
import type { ScannerCandidateRecord, ScannerMatch } from '../../src/domain/scanner/types'

/**
 * P151 — the visual-only confidence rule, checked against the REAL production index generation
 * (read from `current.json`; f25fc05d569b7cca when written) through the REAL matcher. A fast, fixed-
 * seed slice of `pnpm scanner:confidence:audit` (which runs 1,500 samples across five distortion
 * regimes and is where the published before/after numbers come from).
 *
 * PROVENANCE: queries are a card's own auxiliary prototype (a centroid of six synthetic camera
 * distortions) searched against the PRISTINE prototypes only. No real photographs exist in the repo.
 * "ABSENT" leaves the true card out of the searched set — the situation of the ~7% of catalog cards
 * with no reference image, where the nearest indexed card is a same-art sibling printing.
 */

const GEN_ROOT = path.resolve(__dirname, '../../scripts/scanner-visual-index/generated/visual-v1')
const pointer = JSON.parse(readFileSync(path.join(GEN_ROOT, 'current.json'), 'utf-8')) as {
  contentId: string
}
const genDir = path.join(GEN_ROOT, 'generations', pointer.contentId)
const manifest = JSON.parse(
  readFileSync(path.join(genDir, 'manifest.json'), 'utf-8'),
) as VisualIndexManifest
const cardIds = JSON.parse(readFileSync(path.join(genDir, 'card-ids.json'), 'utf-8')) as string[]
const rawBytes = readFileSync(path.join(genDir, 'embeddings.bin'))
const int8 = new Int8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)
const DIM = manifest.embeddingDim
const PROTOS = manifest.prototypesPerCard ?? 1

function vector(cardIndex: number, proto: number): Float32Array {
  const start = (cardIndex * PROTOS + proto) * DIM
  const v = new Float32Array(DIM)
  for (let d = 0; d < DIM; d += 1) v[d] = (int8[start + d] ?? 0) / 127
  return l2Normalize(v)
}

function buildPristineOnlyIndex(): DecodedVisualIndex {
  const bytes = new Int8Array(cardIds.length * DIM)
  for (let c = 0; c < cardIds.length; c += 1) {
    bytes.set(int8.subarray(c * PROTOS * DIM, c * PROTOS * DIM + DIM), c * DIM)
  }
  return decodeVisualIndex(
    {
      ...manifest,
      prototypesPerCard: undefined,
      schemaVersion: undefined,
      payloadFormat: undefined,
      rowCount: undefined,
    },
    cardIds,
    bytes,
  )
}

function candidate(cardId: string): ScannerCandidateRecord {
  return {
    cardId,
    name: `card ${cardId}`,
    localId: '',
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: 'en',
    setId: 'audit',
    setName: 'audit',
    variantCount: 1,
  }
}

function match(
  hits: { cardId: string; similarity: number }[],
  rawNameText: string | null,
): ScannerMatch {
  return matchScannerObservation(
    { rawNameText, rawCollectorNumberText: null, rawSetText: null, languageHint: 'en' },
    hits.map((hit) => candidate(hit.cardId)),
    new Map(hits.map((hit) => [hit.cardId, hit.similarity])),
  )
}

/** A tier as it would have been BEFORE P151's visual-only cap. */
function uncapped(m: ScannerMatch): string {
  return m.notes.includes('visual-only-uncorroborated') ? 'high' : m.tier
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe(`P151 — visual-only confidence on the real index ${pointer.contentId}`, () => {
  const pristine = buildPristineOnlyIndex()
  const rng = mulberry32(151)
  const sample = new Set<number>()
  while (sample.size < 200) sample.add(Math.floor(rng() * cardIds.length))

  const rows = [...sample].map((cardIndex) => {
    const trueId = cardIds[cardIndex] as string
    const hits = searchVisualIndex(pristine, vector(cardIndex, 1), 31)
    return {
      trueId,
      present: hits.slice(0, 30),
      absent: hits.filter((hit) => hit.cardId !== trueId).slice(0, 30),
    }
  })

  it('ABSENT true printing: the old rule produced a confident wrong sibling on a measurable share of scans; now NONE is HIGH', () => {
    let before = 0
    let after = 0
    for (const row of rows) {
      const m = match(row.absent, null)
      if (uncapped(m) === 'high') before += 1
      if (m.tier === 'high') after += 1
    }
    // Every ABSENT result is wrong by construction. The proxy must actually exercise the failure
    // (>= 3 of 200; ~8% measured over 1,500), otherwise this test proves nothing.
    expect(before).toBeGreaterThanOrEqual(3)
    expect(after).toBe(0)
  })

  it('PRESENT true printing: the correct card is still found first, and never HIGH from vision alone', () => {
    let top1 = 0
    for (const row of rows) {
      const m = match(row.present, null)
      if (m.candidates[0]?.card.cardId === row.trueId) top1 += 1
      expect(m.tier).not.toBe('high')
    }
    expect(top1 / rows.length).toBeGreaterThanOrEqual(0.95)
  })

  it('PRESENT + a corroborating printed name: HIGH is still reachable for the correct card (accuracy of the two-channel path is not what was capped)', () => {
    let correctHigh = 0
    let wrongHigh = 0
    for (const row of rows) {
      const m = match(row.present, `card ${row.trueId}`)
      if (m.tier === 'high') {
        if (m.candidates[0]?.card.cardId === row.trueId) correctHigh += 1
        else wrongHigh += 1
      }
    }
    expect(wrongHigh).toBe(0)
    expect(correctHigh / rows.length).toBeGreaterThanOrEqual(0.7)
  })
})
