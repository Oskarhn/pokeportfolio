import { describe, expect, it } from 'vitest'
import {
  computeDHash,
  computePHash,
  hammingDistance,
  dHashSimilarity,
  combinedHashSimilarity,
  packHashRow,
  unpackHashRow,
  HASH_ROW_BYTES,
} from '../../../src/domain/scanner/perceptual-hash'

function solidGrid(width: number, height: number, value: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height).fill(value)
}

function gradientGrid(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = Math.round((x / (width - 1)) * 255)
    }
  }
  return data
}

describe('perceptual hash (dHash)', () => {
  it('is deterministic for identical input', () => {
    const grid = gradientGrid(9, 8)
    expect(computeDHash(grid, 9, 8)).toBe(computeDHash(grid, 9, 8))
  })

  it('produces zero Hamming distance for identical images', () => {
    const grid = gradientGrid(9, 8)
    const a = computeDHash(grid, 9, 8)
    const b = computeDHash(gradientGrid(9, 8), 9, 8)
    expect(hammingDistance(a, b)).toBe(0)
  })

  it('a flat/solid image has no left>right transitions (all-zero hash)', () => {
    const hash = computeDHash(solidGrid(9, 8, 128), 9, 8)
    expect(hash).toBe(0n)
  })

  it('a rising gradient produces every left<right comparison as false (0 bits)', () => {
    const hash = computeDHash(gradientGrid(9, 8), 9, 8)
    expect(hash).toBe(0n)
  })

  it('a falling gradient sets every bit (left always brighter than right)', () => {
    const width = 9
    const height = 8
    const data = new Uint8ClampedArray(width * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        data[y * width + x] = Math.round(((width - 1 - x) / (width - 1)) * 255)
      }
    }
    const hash = computeDHash(data, width, height)
    expect(hash).toBe((1n << 64n) - 1n)
  })

  it('throws when the buffer length does not match width*height', () => {
    expect(() => computeDHash(new Uint8ClampedArray(10), 9, 8)).toThrow()
  })

  it('similarity is 1 at distance 0 and 0 at distance 64 (all bits differ)', () => {
    expect(dHashSimilarity(0)).toBe(1)
    expect(dHashSimilarity(64)).toBe(0)
    expect(dHashSimilarity(32)).toBeCloseTo(0.5)
  })
})

describe('perceptual hash (pHash, P82 §10)', () => {
  it('is deterministic for identical input', () => {
    const grid = gradientGrid(40, 40)
    expect(computePHash(grid, 40, 40)).toBe(computePHash(grid, 40, 40))
  })

  it('produces zero Hamming distance for identical images', () => {
    const grid = gradientGrid(40, 40)
    const a = computePHash(grid, 40, 40)
    const b = computePHash(gradientGrid(40, 40), 40, 40)
    expect(hammingDistance(a, b)).toBe(0)
  })

  it('a uniform/flat image never throws and produces a stable hash', () => {
    const hash = computePHash(solidGrid(32, 32, 200), 32, 32)
    expect(computePHash(solidGrid(32, 32, 200), 32, 32)).toBe(hash)
  })

  it('throws when the buffer length does not match width*height', () => {
    expect(() => computePHash(new Uint8ClampedArray(10), 9, 8)).toThrow()
  })

  it('distinguishes two structurally different images (real discriminative signal on this fixture)', () => {
    const gradient = computePHash(gradientGrid(40, 40), 40, 40)
    // A checkerboard has a completely different low-frequency DCT structure than a smooth ramp.
    const width = 40
    const height = 40
    const checker = new Uint8ClampedArray(width * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        checker[y * width + x] = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0 ? 255 : 0
      }
    }
    const checkerHash = computePHash(checker, width, height)
    expect(hammingDistance(gradient, checkerHash)).toBeGreaterThan(0)
  })
})

describe('combined hash similarity (P82 §10 "C: combination")', () => {
  it('is the unweighted average of each hash family’s own similarity', () => {
    expect(combinedHashSimilarity(0, 64)).toBeCloseTo(0.5)
    expect(combinedHashSimilarity(0, 0)).toBe(1)
    expect(combinedHashSimilarity(64, 64)).toBe(0)
  })
})

describe('hash row packing (P82 §11)', () => {
  it('round-trips arbitrary 64-bit dHash/pHash pairs exactly', () => {
    const dHash = 0x0123456789abcdefn
    const pHash = 0xfedcba9876543210n
    const packed = packHashRow(dHash, pHash)
    expect(packed.length).toBe(HASH_ROW_BYTES)
    const unpacked = unpackHashRow(packed, 0)
    expect(unpacked.dHash).toBe(dHash)
    expect(unpacked.pHash).toBe(pHash)
  })

  it('reads correctly at a non-zero offset inside a larger buffer (a multi-row index)', () => {
    const buffer = new Uint8Array(HASH_ROW_BYTES * 2)
    buffer.set(packHashRow(1n, 2n), 0)
    buffer.set(packHashRow(3n, 4n), HASH_ROW_BYTES)
    expect(unpackHashRow(buffer, 0)).toEqual({ dHash: 1n, pHash: 2n })
    expect(unpackHashRow(buffer, HASH_ROW_BYTES)).toEqual({ dHash: 3n, pHash: 4n })
  })

  it('round-trips the zero and all-ones extremes without sign-extension bugs', () => {
    const allOnes = (1n << 64n) - 1n
    const packed = packHashRow(0n, allOnes)
    const unpacked = unpackHashRow(packed, 0)
    expect(unpacked.dHash).toBe(0n)
    expect(unpacked.pHash).toBe(allOnes)
  })
})
