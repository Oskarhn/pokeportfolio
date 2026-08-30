/**
 * Perceptual hashes — the cheap, ML-free visual signals evaluated in P76's method comparison
 * (prompt §13/§29) and re-evaluated in P82 as a FAST first-scan baseline that does not require the
 * ~45MB DINOv2/ONNX-Runtime cold start (D-099): a real iPhone stalled in `VISUAL_MODEL_STATE=
 * loading` for over a minute while OCR alone failed to identify a clearly-legible card (P82 §0).
 * Pure arithmetic over a small grayscale grid; no canvas, no network, no ML runtime — both hashes
 * below are computable in low single-digit milliseconds from an already-rectified card image, so
 * they can be ready as soon as the tiny reference index asset itself has been fetched, independent
 * of whether the heavyweight visual worker has finished loading.
 *
 * Two independent, complementary hash families (P82 §10):
 * - dHash (`computeDHash`): a directional (horizontal gradient sign) hash — cheap, robust to
 *   uniform brightness shifts, but only looks at ADJACENT-pixel relationships.
 * - pHash (`computePHash`): a DCT-based hash over the image's LOW-FREQUENCY structure (the same
 *   algorithm python's `imagehash.phash` uses — 32x32 resample, full 2D DCT-II, top-left 8x8
 *   coefficients thresholded against their own median) — captures coarse shape/layout, which is
 *   complementary to dHash's local-gradient signal and typically more robust to mild blur/resize.
 *
 * Whether either channel is wired into production scoring is decided by benchmark evidence, not
 * assumed either way — see docs/SCANNER_RESEARCH.md §7b/§7e for the measured outcomes and the
 * resulting decisions.
 */

const HASH_GRID_WIDTH = 9
const HASH_GRID_HEIGHT = 8

/** pHash working resolution before DCT (imagehash's default `highfreq_factor=4` × `hash_size=8`). */
const PHASH_SAMPLE_SIZE = 32
/** Low-frequency coefficients kept after the DCT — an 8x8 block gives a 64-bit hash, matching
 *  dHash's own bit width so both can be combined/compared on equal footing. */
const PHASH_KEPT_SIZE = 8

/** One directional (horizontal) difference hash: 8x8 = 64 bits, packed into a BigInt. */
export function computeDHash(grayscale: Uint8ClampedArray, width: number, height: number): bigint {
  if (grayscale.length !== width * height) {
    throw new Error('dHash: grayscale buffer length does not match width*height.')
  }
  // Nearest-neighbour resample to the fixed small grid — deterministic, no interpolation
  // ambiguity, matching how the offline benchmark and any future browser caller must agree.
  const grid = new Uint8ClampedArray(HASH_GRID_WIDTH * HASH_GRID_HEIGHT)
  for (let gy = 0; gy < HASH_GRID_HEIGHT; gy += 1) {
    const sy = Math.min(height - 1, Math.floor((gy * height) / HASH_GRID_HEIGHT))
    for (let gx = 0; gx < HASH_GRID_WIDTH; gx += 1) {
      const sx = Math.min(width - 1, Math.floor((gx * width) / HASH_GRID_WIDTH))
      grid[gy * HASH_GRID_WIDTH + gx] = grayscale[sy * width + sx] ?? 0
    }
  }
  let hash = 0n
  let bit = 0n
  for (let gy = 0; gy < HASH_GRID_HEIGHT; gy += 1) {
    for (let gx = 0; gx < HASH_GRID_WIDTH - 1; gx += 1) {
      const left = grid[gy * HASH_GRID_WIDTH + gx] ?? 0
      const right = grid[gy * HASH_GRID_WIDTH + gx + 1] ?? 0
      if (left > right) hash |= 1n << bit
      bit += 1n
    }
  }
  return hash
}

/** Hamming distance between two dHash values, 0..64. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x !== 0n) {
    x &= x - 1n
    count += 1
  }
  return count
}

/** Distance-to-similarity mapping used only for reporting/comparison in the benchmark. */
export function dHashSimilarity(distanceBits: number, totalBits = 64): number {
  return 1 - distanceBits / totalBits
}

/** Nearest-neighbour resample to a square grid of floats (0..255) — the shared resample step both
 *  hash families use, kept deterministic (no interpolation) so the browser caller and any offline
 *  benchmark/generator always agree bit-for-bit. */
function resampleSquare(
  grayscale: Uint8ClampedArray,
  width: number,
  height: number,
  size: number,
): Float64Array {
  const out = new Float64Array(size * size)
  for (let gy = 0; gy < size; gy += 1) {
    const sy = Math.min(height - 1, Math.floor((gy * height) / size))
    for (let gx = 0; gx < size; gx += 1) {
      const sx = Math.min(width - 1, Math.floor((gx * width) / size))
      out[gy * size + gx] = grayscale[sy * width + sx] ?? 0
    }
  }
  return out
}

/** Orthonormal 1D DCT-II (the same normalization `scipy.fftpack.dct(norm='ortho')` uses) — the
 *  building block for the 2D DCT below. O(N^2); N is fixed at 32, so this is a bounded, cheap
 *  computation (a few thousand multiply-adds), never a scaling concern at index-search time. */
function dct1d(input: Float64Array): Float64Array {
  const n = input.length
  const output = new Float64Array(n)
  const scaleZero = Math.sqrt(1 / n)
  const scaleRest = Math.sqrt(2 / n)
  for (let k = 0; k < n; k += 1) {
    let sum = 0
    for (let i = 0; i < n; i += 1) {
      sum += (input[i] ?? 0) * Math.cos((Math.PI / n) * (i + 0.5) * k)
    }
    output[k] = sum * (k === 0 ? scaleZero : scaleRest)
  }
  return output
}

/** Separable 2D DCT-II over a square grid stored row-major (rows, then columns). */
function dct2d(grid: Float64Array, size: number): Float64Array {
  const rowTransformed = new Float64Array(size * size)
  for (let y = 0; y < size; y += 1) {
    const row = grid.subarray(y * size, y * size + size)
    const transformed = dct1d(Float64Array.from(row))
    rowTransformed.set(transformed, y * size)
  }
  const output = new Float64Array(size * size)
  const column = new Float64Array(size)
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) column[y] = rowTransformed[y * size + x] ?? 0
    const transformed = dct1d(column)
    for (let y = 0; y < size; y += 1) output[y * size + x] = transformed[y] ?? 0
  }
  return output
}

/**
 * pHash (P82 §10): resample to 32x32, full 2D DCT-II, keep the top-left 8x8 (lowest-frequency,
 * i.e. coarse-structure) coefficients, threshold each against the MEDIAN of that same 64-value
 * block (never a fixed constant — a media threshold self-calibrates to each image's own DCT
 * energy). Same 64-bit width as {@link computeDHash} so both can be combined/compared directly.
 */
export function computePHash(grayscale: Uint8ClampedArray, width: number, height: number): bigint {
  if (grayscale.length !== width * height) {
    throw new Error('pHash: grayscale buffer length does not match width*height.')
  }
  const sample = resampleSquare(grayscale, width, height, PHASH_SAMPLE_SIZE)
  const dct = dct2d(sample, PHASH_SAMPLE_SIZE)
  const kept: number[] = []
  for (let y = 0; y < PHASH_KEPT_SIZE; y += 1) {
    for (let x = 0; x < PHASH_KEPT_SIZE; x += 1) {
      kept.push(dct[y * PHASH_SAMPLE_SIZE + x] ?? 0)
    }
  }
  const sorted = [...kept].sort((a, b) => a - b)
  const mid = sorted.length / 2
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[Math.floor(mid)] ?? 0)
  let hash = 0n
  let bit = 0n
  for (const value of kept) {
    if (value > median) hash |= 1n << bit
    bit += 1n
  }
  return hash
}

/** One card's packed hash pair — 16 bytes total (8 dHash + 8 pHash), the on-disk/in-memory row
 *  format {@link data/scanner/hash-index.ts} reads/writes (P82 §11). Big-endian, matching
 *  `DataView`'s default so browser and Node agree without an explicit endianness flag anywhere. */
export const HASH_ROW_BYTES = 16

export function packHashRow(dHash: bigint, pHash: bigint): Uint8Array {
  const bytes = new Uint8Array(HASH_ROW_BYTES)
  const view = new DataView(bytes.buffer)
  view.setBigUint64(0, dHash, false)
  view.setBigUint64(8, pHash, false)
  return bytes
}

export function unpackHashRow(bytes: Uint8Array, offset: number): { dHash: bigint; pHash: bigint } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    dHash: view.getBigUint64(offset, false),
    pHash: view.getBigUint64(offset + 8, false),
  }
}

/** Combined Hamming similarity across both hash families (P82 §10 "C: combination"): a simple
 *  unweighted average of each hash's own similarity — deliberately not a learned/tuned weighting,
 *  since no evidence yet favours one hash over the other at real-index scale (see
 *  docs/SCANNER_RESEARCH.md §7e for what WAS measured this session). */
export function combinedHashSimilarity(
  dHashDistance: number,
  pHashDistance: number,
  totalBits = 64,
): number {
  return (dHashSimilarity(dHashDistance, totalBits) + dHashSimilarity(pHashDistance, totalBits)) / 2
}
