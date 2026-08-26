/**
 * Perceptual hash (dHash) — the cheap, ML-free visual signal evaluated in P76's method
 * comparison (prompt §13/§29). Pure arithmetic over a small grayscale grid; no canvas, no
 * network, no ML runtime. Whether this channel is wired into production scoring is decided by
 * benchmark evidence, not assumed either way — see docs/SCANNER_RESEARCH.md §7b "PERCEPTUAL
 * HASH" for the measured outcome and the resulting decision.
 */

const HASH_GRID_WIDTH = 9
const HASH_GRID_HEIGHT = 8

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
