/**
 * Scanner domain barrel — pure matching logic between OCR/visual observations and the existing
 * canonical card identity. Zero dependencies on React, Supabase or any network layer
 * (docs/ARCHITECTURE.md §2). See ./README.md for the module map and invariants.
 *
 * F-33 (P89): './perceptual-hash' is deliberately NOT re-exported here. Its dHash/pHash
 * functions were benchmarked and explicitly REJECTED as a live retrieval channel (P82 §9-§11,
 * docs/PROJECT_JOURNAL.md — "noise with a similarity number attached" once real capture-like
 * distortion is present) — no code under src/features/scanner ever calls it. The module itself
 * stays in place (still real, tested math, still useful for reproducing that benchmark) and its
 * two callers (scripts/scanner-visual-benchmark/run-benchmark.ts,
 * .../run-hash-benchmark.ts) import it directly by path rather than through this barrel, so
 * removing it from the barrel drops it from the domain's LIVE production API surface without
 * touching benchmark reproducibility.
 */
export * from './types'
export * from './normalize'
export * from './edit-distance'
export * from './collector-number'
export * from './collector-compare'
export * from './collector-parse'
export * from './name-similarity'
export * from './name-lexicon'
export * from './set-hint'
export * from './visual-evidence'
export * from './photometric'
export * from './capture-quality'
export * from './engine'
