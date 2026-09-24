import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * P161 — the photo path Price Check shares with the scanner.
 *
 * Price Check's scan screen decodes the chosen photo with the scanner's own `decodeImageFile`, so
 * the P151 image-input protections apply to it only as long as that is (still) the function it
 * calls. Two halves: (1) behaviour — a hostile file is refused BEFORE the decoder runs, through the
 * very function the page imports; (2) structure — the page wires that function, the latest-pick
 * guard and the identity key the way the ownership rules in PriceCheckScanPage.tsx say. The page is
 * not mountable in this suite (no DOM), so the structural half is what a mutant in the page meets;
 * the real-browser twins are in tests/e2e/price-check-p161-integration.spec.ts.
 */

vi.mock('../../src/data/catalog', () => ({}))
vi.mock('../../src/data/collection', () => ({}))

import { decodeImageFile } from '../../src/features/scanner/capture'

function be32(v: number): number[] {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
}

/** A 33-byte PNG header DECLARING `width` x `height` — no pixel data, so nothing to allocate. */
function pngHeader(width: number, height: number): File {
  return new File(
    [
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...be32(13),
        0x49,
        0x48,
        0x44,
        0x52,
        ...be32(width),
        ...be32(height),
        8,
        6,
        0,
        0,
        0,
        ...be32(0),
      ]),
    ],
    'bomb.png',
    { type: 'image/png' },
  )
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).createImageBitmap
})

describe('the shared photo decoder refuses hostile input before decoding', () => {
  it.each([
    ['60000 x 60000 (3.6 GP declared)', 60000, 60000],
    ['4294967295 x 4294967295', 4294967295, 4294967295],
    ['12001 px longest edge', 12001, 100],
    ['a 10000 x 100 strip', 10000, 100],
    ['a 1 x 1 pixel', 1, 1],
  ])('%s', async (_label, width, height) => {
    const decoder = vi.fn()
    Object.defineProperty(globalThis, 'createImageBitmap', { value: decoder, configurable: true })
    await expect(decodeImageFile(pngHeader(width, height))).rejects.toBeTruthy()
    expect(decoder).not.toHaveBeenCalled()
  })

  it('an empty file and a non-image type are refused without a decode', async () => {
    const decoder = vi.fn()
    Object.defineProperty(globalThis, 'createImageBitmap', { value: decoder, configurable: true })
    await expect(
      decodeImageFile(new File([], 'empty.png', { type: 'image/png' })),
    ).rejects.toBeTruthy()
    await expect(
      decodeImageFile(new File(['hello'], 'x.txt', { type: 'text/plain' })),
    ).rejects.toBeTruthy()
    expect(decoder).not.toHaveBeenCalled()
  })
})

const ROOT = process.cwd()
const scanPage = readFileSync(
  path.join(ROOT, 'src/features/price-check/PriceCheckScanPage.tsx'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '')
const scanSession = readFileSync(
  path.join(ROOT, 'src/features/price-check/scan-session.ts'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '')

describe('PriceCheckScanPage wiring (structural — the page cannot be mounted here)', () => {
  it('decodes the photo with the scanner’s guarded decoder and reports its refusal', () => {
    expect(scanPage).toMatch(/await import\('\.\.\/scanner\/capture'\)/)
    expect(scanPage).toMatch(/decodeImageFile\(file\)/)
    expect(scanPage).toMatch(/describeCaptureError\(error\)\.message/)
  })

  it('every decode continuation is latest-pick-wins: the guard is begun once and checked after each await', () => {
    expect(scanPage.match(/captureGuard\.begin\(\)/g)).toHaveLength(1)
    // after the decode, after the scanner-ready wait, and on the decode-failure path
    expect(scanPage.match(/captureGuard\.isCurrent\(token\)/g)?.length).toBeGreaterThanOrEqual(3)
    // an object URL is only created after the last check
    const lastCheck = scanPage.lastIndexOf('captureGuard.isCurrent(token)')
    expect(scanPage.indexOf('URL.createObjectURL')).toBeGreaterThan(lastCheck)
  })

  it('a new pick cancels the analysis of the previous photo at once (even if the new pick then fails to decode)', () => {
    const pick = scanPage.slice(scanPage.indexOf('function handleFilePicked'))
    const beforeDecode = pick.slice(0, pick.indexOf('decodeImageFile'))
    expect(beforeDecode).toMatch(/captureGuard.begin()[sS]*scanSessionRef.current?.cancel()/)
  })

  it('Cancel/Retake and leaving the page invalidate every capture still decoding', () => {
    expect(scanPage.match(/captureGuard\.invalidate\(\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('one screen per signed-in identity: an account switch discards the photo and candidates', () => {
    expect(scanPage).toMatch(/<PriceCheckScanScreen key=\{userId \?\? 'signed-out'\}/)
  })

  it('leaving the screen disposes the scanner session (workers released), and revokes the preview URL', () => {
    expect(scanPage).toMatch(/created\?\.dispose\(\)/)
    expect(scanPage).toMatch(/URL\.revokeObjectURL\(previewUrl\)/)
  })

  it('the page keeps no stale-result generation of its own for the analysis (one owner: the scanner)', () => {
    expect(scanPage).not.toMatch(/generation/i)
    expect(scanSession).not.toMatch(/generation/i)
  })
})

describe('no derived prices in Price Check (graded stays PARTIAL_NO_AUTHORIZED_PROVIDER)', () => {
  it('no Price Check source multiplies, estimates or extrapolates a price', () => {
    const files = [
      'src/domain/price-check/graded.ts',
      'src/domain/price-check/raw-section.ts',
      'src/domain/price-check/raw-observations.ts',
      'src/features/price-check/PriceCheckResultPage.tsx',
      'src/features/price-check/ResultView.tsx',
    ]
    for (const file of files) {
      const code = readFileSync(path.join(ROOT, file), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      expect(code, file).not.toMatch(/multiplier|estimat(e|ed)|extrapolat|interpolat|approximat/i)
    }
  })
})
