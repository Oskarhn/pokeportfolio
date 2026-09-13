/**
 * P100: permanent regression coverage for the benchmark-data-leakage guard (P98's confirmed
 * finding — P95's geometry-only query was byte-identical to one of its own reference-augmentation
 * ingredients) and the held-out query regimes built to replace it. Runs entirely offline: a tiny
 * procedurally-generated image (`sharp({create: ...})`), never a network fetch or a model load.
 *
 * `sharp` is an existing devDependency (used by scripts/scanner-visual-index/lib/
 * prototype-augmentation.mjs); this file imports the research-lab .mjs modules directly by
 * relative path — they are plain ESM, importable from a .ts test the same way any other .mjs
 * module in this repo is (e.g. tests already import scripts/scanner-visual-index/lib/*.mjs).
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  hashBuffer,
  hashReferenceIngredients,
  assertNoLeakage,
  assertNoLeakageAll,
  LeakageError,
} from '../../scripts/scanner-recognition-lab/retrieval/leakage-guard.mjs'
import {
  AUGMENTATION_PROFILES,
  augmentAll,
} from '../../scripts/scanner-recognition-lab/augment/photometric.mjs'
import { AXES } from '../../scripts/scanner-recognition-lab/augment/continuous.mjs'
import { HARD_AUGMENTATION_PROFILES } from '../../scripts/scanner-recognition-lab/augment/hard.mjs'
import {
  HELDOUT_REGIMES,
  buildAllHeldoutQueries,
} from '../../scripts/scanner-recognition-lab/augment/heldout.mjs'

async function tinySyntheticCardBuffer(seed: number): Promise<Buffer> {
  // A small, deterministic, procedurally-generated "card" image — no network, no fixture file.
  // Different seeds produce visibly different images so cross-card behavior can be tested too.
  const svg = Buffer.from(
    `<svg width="120" height="168"><rect width="100%" height="100%" fill="rgb(${String((seed * 37) % 256)},${String((seed * 91) % 256)},${String((seed * 53) % 256)})"/>` +
      `<circle cx="60" cy="84" r="30" fill="rgb(${String((seed * 17) % 256)},${String((seed * 61) % 256)},${String((seed * 113) % 256)})"/></svg>`,
  )
  return sharp(svg).jpeg({ quality: 95 }).toBuffer()
}

describe('hashBuffer / hashReferenceIngredients / assertNoLeakage (P100)', () => {
  it('hashes byte-identical buffers to the same digest, and different buffers to different digests', () => {
    const a = Buffer.from([1, 2, 3, 4])
    const b = Buffer.from([1, 2, 3, 4])
    const c = Buffer.from([1, 2, 3, 5])
    expect(hashBuffer(a)).toBe(hashBuffer(b))
    expect(hashBuffer(a)).not.toBe(hashBuffer(c))
  })

  it('assertNoLeakage throws LeakageError when the query is byte-identical to a reference ingredient', () => {
    const pristine = Buffer.from([9, 9, 9])
    const augmented = Buffer.from([1, 2, 3])
    const hashes = hashReferenceIngredients([
      { label: 'pristine', buffer: pristine },
      { label: 'perspective-rotate', buffer: augmented },
    ])
    // The leaking query is byte-identical to the 'perspective-rotate' ingredient — exactly the P95
    // contamination shape.
    const leakingQuery = Buffer.from([1, 2, 3])
    expect(() => {
      assertNoLeakage('card-x', 'geometryOnly', leakingQuery, hashes)
    }).toThrow(LeakageError)
  })

  it('assertNoLeakage passes silently when the query differs from every reference ingredient', () => {
    const hashes = hashReferenceIngredients([
      { label: 'pristine', buffer: Buffer.from([9, 9, 9]) },
      { label: 'perspective-rotate', buffer: Buffer.from([1, 2, 3]) },
    ])
    const genuinelyHeldOutQuery = Buffer.from([7, 7, 7, 7])
    expect(() => {
      assertNoLeakage('card-x', 'heldoutGeometry', genuinelyHeldOutQuery, hashes)
    }).not.toThrow()
  })

  it('assertNoLeakageAll checks every regime and throws on the first collision found', () => {
    const referenceIngredients = [
      { label: 'pristine', buffer: Buffer.from([1, 1, 1]) },
      { label: 'blur-jpeg', buffer: Buffer.from([2, 2, 2]) },
    ]
    expect(() => {
      assertNoLeakageAll('card-y', referenceIngredients, {
        clean: Buffer.from([9, 9, 9]),
        heldoutBlur: Buffer.from([2, 2, 2]), // collides with the 'blur-jpeg' reference ingredient
      })
    }).toThrow(LeakageError)
    expect(() => {
      assertNoLeakageAll('card-y', referenceIngredients, {
        clean: Buffer.from([9, 9, 9]),
        heldoutBlur: Buffer.from([3, 3, 3]),
      })
    }).not.toThrow()
  })
})

describe('P100 — structural disjointness between reference-augmentation and held-out query profiles', () => {
  it('HELDOUT_REGIMES shares no name with photometric.mjs AUGMENTATION_PROFILES', () => {
    const overlap = HELDOUT_REGIMES.filter((r) => AUGMENTATION_PROFILES.includes(r))
    expect(overlap).toEqual([])
  })

  it('HELDOUT_REGIMES shares no name with continuous.mjs AXES', () => {
    const overlap = HELDOUT_REGIMES.filter((r) => AXES.includes(r))
    expect(overlap).toEqual([])
  })

  it('HELDOUT_REGIMES shares no name with hard.mjs HARD_AUGMENTATION_PROFILES', () => {
    const overlap = HELDOUT_REGIMES.filter((r) => HARD_AUGMENTATION_PROFILES.includes(r))
    expect(overlap).toEqual([])
  })

  it('has at least 8 distinct named regimes, including the pristine control', () => {
    expect(new Set(HELDOUT_REGIMES).size).toBeGreaterThanOrEqual(8)
    expect(HELDOUT_REGIMES).toContain('clean')
  })
})

describe('P100 — end-to-end runtime proof: held-out queries never collide with their own card reference ingredients', () => {
  it('for a real (procedurally-generated) image, every held-out query buffer differs from every one of that card reference augmentation ingredient buffer', async () => {
    const cardId = 'synthetic-card-p100-a'
    const buf = await tinySyntheticCardBuffer(1)

    // The exact reference-side construction the production dual-prototype build and the
    // (corrected) benchmark scripts both use: pristine + augmentAll's 6 deterministic views.
    const augmented = await augmentAll(buf, cardId)
    const referenceIngredients = [
      { label: 'pristine', buffer: buf },
      ...augmented.map((a) => ({ label: a.profile, buffer: a.buffer })),
    ]

    const heldoutQueries = await buildAllHeldoutQueries(buf, cardId)
    // 'clean' is DEFINITIONALLY the unmodified pristine buffer (the zero-distortion control) — it
    // is EXPECTED and CORRECT for it to equal the 'pristine' reference ingredient, exactly as the
    // next test below pins directly. Every corrected benchmark script excludes 'clean' from the
    // leakage check for this reason; only the DISTORTED regimes are checked here.
    const distortedQueries = { ...heldoutQueries }
    delete distortedQueries.clean

    // This is the exact call every corrected benchmark script makes before recording a result —
    // if this ever throws, a future change reintroduced the P95/P98 leak shape.
    expect(() => {
      assertNoLeakageAll(cardId, referenceIngredients, distortedQueries)
    }).not.toThrow()
  }, 20000)

  it('the pristine "clean" held-out query IS expected to equal the pristine reference ingredient — this is correct, not a leak (the clean regime IS the unmodified image)', async () => {
    const cardId = 'synthetic-card-p100-b'
    const buf = await tinySyntheticCardBuffer(2)
    const heldout = await buildAllHeldoutQueries(buf, cardId, ['clean'])
    const cleanBuffer = heldout.clean
    expect(cleanBuffer).toBeDefined()
    expect(hashBuffer(cleanBuffer ?? Buffer.alloc(0))).toBe(hashBuffer(buf))
  })

  it('a genuinely mismatched card id still produces disjoint hashes (sanity: the guard is comparing bytes, not merely labels)', async () => {
    const cardId = 'synthetic-card-p100-c'
    const buf = await tinySyntheticCardBuffer(3)
    const otherBuf = await tinySyntheticCardBuffer(4)
    const augmented = await augmentAll(buf, cardId)
    const referenceIngredients = [
      { label: 'pristine', buffer: buf },
      ...augmented.map((a) => ({ label: a.profile, buffer: a.buffer })),
    ]
    const heldoutOnOtherImage = await buildAllHeldoutQueries(otherBuf, cardId)
    expect(() => {
      assertNoLeakageAll(cardId, referenceIngredients, heldoutOnOtherImage)
    }).not.toThrow()
  }, 20000)
})
