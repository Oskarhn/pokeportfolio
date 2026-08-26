import { describe, expect, it } from 'vitest'
import {
  computeDHash,
  hammingDistance,
  dHashSimilarity,
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
