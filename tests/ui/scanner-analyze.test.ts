import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OCR_WORKING_LONG_EDGE,
  runOcrAnalysis,
  splitFullFrameCardText,
  type OcrEnginePort,
} from '../../src/features/scanner/analyze'
import type { ScannerCapture } from '../../src/features/scanner/contract'

/**
 * I1 — capture → OCR observation (prompt §12–§17), verified without a browser by substituting
 * recording fakes for the canvas pool and the engine. Pinned here: working-resolution cropping
 * to the CARD rect, one recognition call per ROI in single-line mode, exactly ONE bounded
 * full-card fallback when BOTH strips are unusable, honest nulls when nothing is read, and the
 * decoded ImageBitmap always being closed — including on failure.
 */

function makeCanvas() {
  const element = {
    width: 0,
    height: 0,
  }
  const context = {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    })),
    createImageData: vi.fn((w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    })),
    putImageData: vi.fn(),
  }
  return { element, context }
}

function makePool() {
  const canvases = new Map<string, ReturnType<typeof makeCanvas>>()
  return {
    take: vi.fn((slot: string, width: number, height: number) => {
      let canvas = canvases.get(slot)
      if (canvas === undefined) {
        canvas = makeCanvas()
        canvases.set(slot, canvas)
      }
      if (canvas.element.width < width) canvas.element.width = Math.round(width)
      if (canvas.element.height < height) canvas.element.height = Math.round(height)
      return canvas
    }),
    release: vi.fn(),
    canvases,
  }
}

function makeBitmap(width: number, height: number) {
  return {
    width,
    height,
    close: vi.fn(),
  }
}

function makeCapture(cardRect = { left: 10, top: 20, width: 500, height: 700 }): ScannerCapture {
  return {
    blob: new Blob(['synthetic'], { type: 'image/jpeg' }),
    width: 520,
    height: 720,
    cardRect,
  }
}

function makeEngine(results: Array<{ text: string; confidence: number }>): OcrEnginePort & {
  recognize: ReturnType<typeof vi.fn>
  prepare: ReturnType<typeof vi.fn>
} {
  let call = 0
  return {
    prepare: vi.fn(() => Promise.resolve()),
    recognize: vi.fn(() => {
      const result = results[call] ?? { text: '', confidence: 0 }
      call += 1
      return Promise.resolve(result)
    }),
  }
}

beforeEach(() => {
  // Node has no createImageBitmap; each test installs its own stub and removes it after.
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: vi.fn(() => Promise.resolve(makeBitmap(500, 700))),
    configurable: true,
  })
  return () => {
    delete (globalThis as Record<string, unknown>).createImageBitmap
  }
})

describe('runOcrAnalysis — capture → observation', () => {
  it('reads both ROIs in single-line mode and returns the raw texts (clean case)', async () => {
    const engine = makeEngine([
      { text: 'TESTASAURUS', confidence: 91 },
      { text: '58/102', confidence: 88 },
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.prepare).toHaveBeenCalledTimes(1)
    expect(engine.recognize).toHaveBeenCalledTimes(2)
    expect(engine.recognize.mock.calls.every((call) => call[1] === 'single-line')).toBe(true)
    expect(observation).toEqual({
      rawNameText: 'TESTASAURUS',
      rawCollectorNumberText: '58/102',
      usedFullFrameFallback: false,
    })
  })

  it('crops to the CARD rect at working resolution — never the whole frame', async () => {
    const engine = makeEngine([
      { text: 'NAME', confidence: 90 },
      { text: '7', confidence: 90 },
    ])
    const pool = makePool()
    await runOcrAnalysis(
      makeCapture({ left: 40, top: 60, width: 1000, height: 1400 }),
      engine,
      pool as never,
    )
    const working = pool.canvases.get('working')
    // Long edge of the 1000×1400 card rect clamps to the OCR working bound.
    expect(working?.element.width ?? 0).toBeLessThanOrEqual(OCR_WORKING_LONG_EDGE)
    expect(working?.element.height ?? 0).toBeLessThanOrEqual(OCR_WORKING_LONG_EDGE)
    const draw = working?.context.drawImage.mock.calls[0]
    expect(draw?.[1]).toBe(40)
    expect(draw?.[2]).toBe(60)
    expect(draw?.[3]).toBe(1000)
    expect(draw?.[4]).toBe(1400)
  })

  it('runs EXACTLY ONE full-card fallback when both ROIs are unusable, splitting text', async () => {
    const engine = makeEngine([
      { text: '', confidence: 0 },
      { text: ' ', confidence: 0 },
      { text: 'TESTASAURUS 58/102 junk', confidence: 40 },
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.recognize).toHaveBeenCalledTimes(3)
    expect(engine.recognize.mock.calls[2]?.[1]).toBe('auto')
    expect(observation.usedFullFrameFallback).toBe(true)
    expect(observation.rawNameText).toBe('TESTASAURUS')
    expect(observation.rawCollectorNumberText).toBe('58/102')
  })

  it('returns honest NULLS when nothing at all was read — never fabricated signals', async () => {
    const engine = makeEngine([
      { text: '', confidence: 0 },
      { text: '', confidence: 0 },
      { text: '', confidence: 0 },
    ])
    const observation = await runOcrAnalysis(makeCapture(), engine, makePool() as never)
    expect(observation.rawNameText).toBeNull()
    expect(observation.rawCollectorNumberText).toBeNull()
    expect(observation.usedFullFrameFallback).toBe(true)
  })

  it('closes the decoded bitmap even when recognition throws', async () => {
    const bitmap = makeBitmap(500, 700)
    Object.defineProperty(globalThis, 'createImageBitmap', {
      value: vi.fn(() => Promise.resolve(bitmap)),
      configurable: true,
    })
    const engine = makeEngine([])
    engine.recognize.mockRejectedValueOnce(new Error('engine exploded'))
    const pool = makePool()
    await expect(runOcrAnalysis(makeCapture(), engine, pool as never)).rejects.toThrow()
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })
})

describe('splitFullFrameCardText', () => {
  it('splits trailing collector-number tokens from the name', () => {
    expect(splitFullFrameCardText('PIKACHU LIKE 58/102')).toEqual({
      name: 'PIKACHU LIKE',
      number: '58/102',
    })
  })

  it('handles prefixed sub-numberings', () => {
    expect(splitFullFrameCardText('SOME TRAINER TG01')).toEqual({
      name: 'SOME TRAINER',
      number: 'TG01',
    })
  })

  it('treats prose without any id-shaped token as name-only', () => {
    expect(splitFullFrameCardText('JUST SOME WORDS HERE')).toEqual({
      name: 'JUST SOME WORDS HERE',
      number: null,
    })
  })
})
