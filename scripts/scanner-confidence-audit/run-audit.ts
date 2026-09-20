/**
 * P151 confidence audit — how often does the VISUAL-ONLY confidence path say HIGH, and how often is
 * that HIGH wrong?
 *
 * Runs entirely offline against the REAL committed production index generation (content id read from
 * `current.json`; f25fc05d569b7cca at the time of writing: 19,500 cards x 2 prototypes x 384 dims),
 * through the REAL matcher (`matchScannerObservation`) — no re-implementation of scoring.
 *
 * PROVENANCE, stated plainly because it bounds every conclusion: there is NO real-capture set in this
 * repository (see scripts/scanner-recognition-lab/real-capture/validate-real-captures.ts). Queries
 * here are synthetic proxies built from the index itself:
 *   - "aux"  = a card's own auxiliary prototype (the centroid of six synthetic camera distortions:
 *              clean-resize, perspective-rotate, brightness/contrast, blur+jpeg, glare, shadow — see
 *              scripts/scanner-visual-index/lib/prototype-augmentation.mjs);
 *   - noise  = that vector plus seeded Gaussian noise, renormalised, to walk the same-card similarity
 *              down into the regimes P84 measured on real-ish distortions (clean geometry: same-card
 *              mean 0.812, nearest-wrong mean 0.674) and below.
 * The searched index is the PRISTINE prototypes only (prototype 0), so the query never finds its own
 * row (which would be similarity 1.0 by construction).
 *
 * Two scenarios per regime:
 *   PRESENT — the true card is in the index. Outcome classes: correct-HIGH, wrong-HIGH (= false-HIGH),
 *             manual (MEDIUM/LOW/none, i.e. the user confirms anyway).
 *   ABSENT  — the true card is removed from the searched set (leave-one-out): the catalog printing has
 *             no reference image, exactly the situation of the 1,446 of 20,946 cards that are not
 *             indexed. Every candidate is wrong by construction, so ANY HIGH is a false-HIGH.
 *
 * What this does NOT measure: text (OCR) evidence, real glare/sleeves/angle, real photographs.
 * Usage:  pnpm scanner:confidence:audit [--samples 1500] [--seed 151] [--out report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeVisualIndex,
  l2Normalize,
  searchVisualIndex,
  type DecodedVisualIndex,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'
import { matchScannerObservation } from '../../src/domain/scanner/engine'
import type {
  ScannerCandidateRecord,
  ScannerConfidenceTier,
  ScannerMatch,
} from '../../src/domain/scanner/types'

const GEN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scanner-visual-index/generated/visual-v1',
)

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback
}

const SAMPLES = Number(arg('samples', '1500'))
const SEED = Number(arg('seed', '151'))
const OUT = arg('out', '')

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
const rng = mulberry32(SEED)
function gaussian(): number {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// --- load the real generation ---------------------------------------------------------------
const pointer = JSON.parse(readFileSync(path.join(GEN_ROOT, 'current.json'), 'utf-8')) as {
  contentId: string
}
const genDir = path.join(GEN_ROOT, 'generations', pointer.contentId)
const manifest = JSON.parse(
  readFileSync(path.join(genDir, 'manifest.json'), 'utf-8'),
) as VisualIndexManifest
const cardIds = JSON.parse(readFileSync(path.join(genDir, 'card-ids.json'), 'utf-8')) as string[]
const raw = readFileSync(path.join(genDir, 'embeddings.bin'))
const int8 = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength)
const full: DecodedVisualIndex = decodeVisualIndex(manifest, cardIds, int8)
const DIM = manifest.embeddingDim
const PROTOS = full.prototypesPerCard
if (PROTOS < 2) throw new Error('This audit needs a dual-prototype (aux) index.')

function rowVector(cardIndex: number, proto: number): Float32Array {
  const start = (cardIndex * PROTOS + proto) * DIM
  const v = new Float32Array(DIM)
  for (let d = 0; d < DIM; d += 1) v[d] = (int8[start + d] ?? 0) / 127
  return l2Normalize(v)
}

// Pristine-only searchable index (prototype 0 of every card).
const pristineBytes = new Int8Array(cardIds.length * DIM)
for (let c = 0; c < cardIds.length; c += 1) {
  pristineBytes.set(int8.subarray(c * PROTOS * DIM, c * PROTOS * DIM + DIM), c * DIM)
}
const pristine: DecodedVisualIndex = decodeVisualIndex(
  {
    ...manifest,
    prototypesPerCard: undefined,
    schemaVersion: undefined,
    payloadFormat: undefined,
    rowCount: undefined,
  },
  cardIds,
  pristineBytes,
)

const TOP_K = 30

function record(cardId: string): ScannerCandidateRecord {
  return {
    cardId,
    name: `card-${cardId}`,
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

/** Visual-only evidence -> the real matcher, exactly as controller.ts builds it with no OCR text. */
function matchVisualOnly(hits: { cardId: string; similarity: number }[]): ScannerMatch {
  const scores = new Map(hits.map((h) => [h.cardId, h.similarity]))
  return matchScannerObservation(
    {
      rawNameText: null,
      rawCollectorNumberText: null,
      rawSetText: null,
      languageHint: 'en',
      nameOcrConfidence: null,
      collectorOcrConfidence: null,
    },
    hits.map((h) => record(h.cardId)),
    scores,
  )
}

function noisy(vector: Float32Array, sigma: number): Float32Array {
  if (sigma === 0) return vector
  const out = new Float32Array(DIM)
  // sigma is per-dimension std as a fraction of the unit vector's RMS component (1/sqrt(DIM)).
  const scale = sigma / Math.sqrt(DIM)
  for (let d = 0; d < DIM; d += 1) out[d] = (vector[d] ?? 0) + scale * gaussian()
  return l2Normalize(out)
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let d = 0; d < DIM; d += 1) s += (a[d] ?? 0) * (b[d] ?? 0)
  return s
}

interface Counts {
  n: number
  high: number
  highCorrect: number
  highWrong: number
  medium: number
  low: number
  none: number
  top1Correct: number
  sameCardSimMean: number
  nearestWrongSimMean: number
}

function emptyCounts(): Counts {
  return {
    n: 0,
    high: 0,
    highCorrect: 0,
    highWrong: 0,
    medium: 0,
    low: 0,
    none: 0,
    top1Correct: 0,
    sameCardSimMean: 0,
    nearestWrongSimMean: 0,
  }
}

type Policy = (match: ScannerMatch) => ScannerConfidenceTier

/** The tier the engine would have produced BEFORE the P151 visual-only cap (a held-back HIGH is
 *  recorded by the engine as the 'visual-only-uncorroborated' note). */
function uncappedTier(m: ScannerMatch): ScannerConfidenceTier {
  return m.notes.includes('visual-only-uncorroborated') ? 'high' : m.tier
}

const POLICIES: Record<string, Policy> = {
  /** The engine as it ships now (P151: visual-only evidence can never be HIGH). */
  shippedAfterP151: (m) => m.tier,
  /** The behaviour before P151 — the baseline every change is measured against. */
  beforeP151Uncapped: (m) => uncappedTier(m),
  /** Considered and rejected alternative: keep visual-only HIGH but demand top >= 0.90 and >= 0.10
   *  ahead. It does not remove the failure (a same-art sibling sits at >= 0.95), it only shrinks
   *  correct-HIGH. */
  alt_uncappedButNeeds090Margin010: (m) => {
    if (uncappedTier(m) !== 'high') return m.tier
    const top = m.candidates[0]
    const second = m.candidates[1]
    const ok =
      (top?.visualSimilarity ?? 0) >= 0.9 &&
      (top?.visualSimilarity ?? 0) - (second?.visualSimilarity ?? -1) >= 0.1
    return ok ? 'high' : 'medium'
  },
}

interface Row {
  regime: string
  scenario: 'present' | 'absent'
  policy: string
  counts: Counts
}

const REGIMES: { name: string; sigma: number }[] = [
  { name: 'aux-as-is', sigma: 0 },
  { name: 'noise-0.35', sigma: 0.35 },
  { name: 'noise-0.55', sigma: 0.55 },
  { name: 'noise-0.70', sigma: 0.7 },
  { name: 'noise-0.90', sigma: 0.9 },
]

const sampleIndexes: number[] = []
{
  const seen = new Set<number>()
  while (sampleIndexes.length < Math.min(SAMPLES, cardIds.length)) {
    const i = Math.floor(rng() * cardIds.length)
    if (!seen.has(i)) {
      seen.add(i)
      sampleIndexes.push(i)
    }
  }
}

const rows: Row[] = []
const started = Date.now()
for (const regime of REGIMES) {
  const acc = new Map<string, Counts>()
  const countsFor = (scenario: string, policy: string): Counts => {
    const key = `${scenario}|${policy}`
    let found = acc.get(key)
    if (found === undefined) {
      found = emptyCounts()
      acc.set(key, found)
    }
    return found
  }
  const sameSims: number[] = []
  const wrongSims: number[] = []
  for (const cardIndex of sampleIndexes) {
    const trueId = cardIds[cardIndex] as string
    const query = noisy(rowVector(cardIndex, 1), regime.sigma)
    const pristineOfTrue = rowVector(cardIndex, 0)
    sameSims.push(dot(query, pristineOfTrue))
    const hits = searchVisualIndex(pristine, query, TOP_K + 1)
    for (const scenario of ['present', 'absent'] as const) {
      const list =
        scenario === 'present'
          ? hits.slice(0, TOP_K)
          : hits.filter((h) => h.cardId !== trueId).slice(0, TOP_K)
      if (scenario === 'absent') wrongSims.push(list[0]?.similarity ?? 0)
      const match = matchVisualOnly(list)
      const top1 = match.candidates[0]?.card.cardId
      for (const [policyName, policy] of Object.entries(POLICIES)) {
        const c = countsFor(scenario, policyName)
        const tier = policy(match)
        c.n += 1
        if (top1 === trueId) c.top1Correct += 1
        if (tier === 'high') {
          c.high += 1
          if (top1 === trueId) c.highCorrect += 1
          else c.highWrong += 1
        } else if (tier === 'medium') c.medium += 1
        else if (tier === 'low') c.low += 1
        else c.none += 1
      }
    }
  }
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
  for (const scenario of ['present', 'absent'] as const) {
    for (const policy of Object.keys(POLICIES)) {
      const counts = countsFor(scenario, policy)
      counts.sameCardSimMean = mean(sameSims)
      counts.nearestWrongSimMean = mean(wrongSims)
      rows.push({ regime: regime.name, scenario, policy, counts })
    }
  }
}

// --- near-duplicate structure of the index (why printing-level identity is not visual) -------
const dupSample = sampleIndexes.slice(0, Math.min(600, sampleIndexes.length))
let withNeighbour095 = 0
let withNeighbour090 = 0
for (const cardIndex of dupSample) {
  const trueId = cardIds[cardIndex] as string
  const hits = searchVisualIndex(pristine, rowVector(cardIndex, 0), 2)
  const other = hits.find((h) => h.cardId !== trueId)
  if ((other?.similarity ?? 0) >= 0.95) withNeighbour095 += 1
  if ((other?.similarity ?? 0) >= 0.9) withNeighbour090 += 1
}

const report = {
  audit: 'P151 confidence audit (visual-only path)',
  provenance:
    'synthetic proxies built from the production index itself; NO real captures exist in the repository',
  indexContentId: pointer.contentId,
  cards: cardIds.length,
  prototypesPerCard: PROTOS,
  samples: sampleIndexes.length,
  seed: SEED,
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
  nearDuplicate: {
    sampled: dupSample.length,
    withOtherCardAtCos095: withNeighbour095,
    withOtherCardAtCos090: withNeighbour090,
  },
  rows,
}

if (OUT !== '') writeFileSync(OUT, JSON.stringify(report, null, 2))

function pct(x: number, of: number): string {
  return of === 0 ? '—' : `${((100 * x) / of).toFixed(1)}%`
}
console.log(
  `P151 confidence audit  index=${pointer.contentId}  cards=${cardIds.length}  samples=${sampleIndexes.length}  seed=${SEED}`,
)
console.log(
  `near-duplicate art (sampled ${dupSample.length}): another card at cos>=0.95: ${withNeighbour095}, >=0.90: ${withNeighbour090}`,
)
for (const row of rows) {
  const c = row.counts
  console.log(
    `${row.regime.padEnd(10)} ${row.scenario.padEnd(7)} ${row.policy.padEnd(32)} ` +
      `sameSim=${c.sameCardSimMean.toFixed(3)} wrongSim=${c.nearestWrongSimMean.toFixed(3)} | ` +
      `top1=${pct(c.top1Correct, c.n).padStart(6)} HIGH=${String(c.high).padStart(4)} ` +
      `(correct ${String(c.highCorrect).padStart(4)} / wrong ${String(c.highWrong).padStart(4)}) ` +
      `manual=${String(c.medium + c.low + c.none).padStart(4)}`,
  )
}
