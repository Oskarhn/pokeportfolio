import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OCR_WORKING_LONG_EDGE,
  runOcrAnalysis,
  splitFullFrameCardText,
  scoreNameRoiCandidate,
  scoreNumberRoiCandidate,
  isNameRoiConfident,
  isNumberRoiConfident,
  looksLikeCollectorNumberText,
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
  it('reads both fields in single-line mode and returns the raw texts (clean case, P80 early exit)', async () => {
    // Both fields' FIRST candidate is already confident, so P80's adaptive trial stops after one
    // recognition call per field — the same total cost the original single-ROI pipeline had.
    const engine = makeEngine([
      { text: 'TESTASAURUS', confidence: 91 }, // name candidate 1: classic-top-left
      { text: '58/102', confidence: 88 }, // number candidate 1: modern-bottom-left
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
      nameRoiId: 'classic-top-left',
      numberRoiId: 'modern-bottom-left',
    })
  })

  it('P80 R1: falls through to the modern name candidate and picks it by SCORE when the vintage strip reads worse', async () => {
    // Name candidates run FIRST; neither crosses the "confident" early-exit bar (score < 70+16),
    // so both are tried and the higher-scoring one wins — the modern layout's name plate, not
    // list order. The number field's first candidate is made trivially confident so it stops
    // after one call, keeping this test's mock sequence focused on the name-selection behavior.
    const engine = makeEngine([
      { text: '58/102', confidence: 60 }, // name candidate 1 (classic-top-left): digit-heavy noise
      { text: 'MEGA CHANDELURE EX', confidence: 55 }, // name candidate 2 (modern-full-width)
      { text: '58/102', confidence: 90 }, // number candidate 1 (modern-bottom-left): parses, stops early
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.recognize).toHaveBeenCalledTimes(3)
    expect(observation.rawNameText).toBe('MEGA CHANDELURE EX')
    expect(observation.nameRoiId).toBe('modern-full-width')
  })

  it('P80 R2: falls through to the vintage number candidate and picks it by PARSEABILITY over raw confidence', async () => {
    // The name field's first candidate is made trivially confident so it stops after one call,
    // keeping this test's mock sequence focused on the number-selection behavior that follows.
    const engine = makeEngine([
      { text: 'CHANDELURE', confidence: 90 }, // name candidate 1 (classic-top-left): confident, stops early
      { text: 'Illus. Ken S', confidence: 70 }, // number candidate 1 (modern-bottom-left): credit text, higher raw confidence, does not parse
      { text: '4/102', confidence: 50 }, // number candidate 2 (classic-bottom-right): parses as a real id
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.recognize).toHaveBeenCalledTimes(3)
    expect(observation.rawCollectorNumberText).toBe('4/102')
    expect(observation.numberRoiId).toBe('classic-bottom-right')
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

  it('P80 R3: runs EXACTLY ONE full-card fallback when EVERY candidate for BOTH fields is unusable', async () => {
    // 2 name candidates + 2 number candidates, all empty/whitespace-only, then the fallback text.
    const engine = makeEngine([
      { text: '', confidence: 0 }, // name candidate 1
      { text: ' ', confidence: 0 }, // name candidate 2
      { text: '', confidence: 0 }, // number candidate 1
      { text: ' ', confidence: 0 }, // number candidate 2
      { text: 'TESTASAURUS 58/102 junk', confidence: 40 }, // full-card fallback
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.recognize).toHaveBeenCalledTimes(5)
    expect(engine.recognize.mock.calls[4]?.[1]).toBe('auto')
    expect(observation.usedFullFrameFallback).toBe(true)
    expect(observation.rawNameText).toBe('TESTASAURUS')
    expect(observation.rawCollectorNumberText).toBe('58/102')
    // Fails gracefully: no candidate ever won either field.
    expect(observation.nameRoiId).toBeNull()
    expect(observation.numberRoiId).toBeNull()
  })

  it('returns honest NULLS when nothing at all was read — never fabricated signals', async () => {
    const engine = makeEngine([
      { text: '', confidence: 0 },
      { text: '', confidence: 0 },
      { text: '', confidence: 0 },
      { text: '', confidence: 0 },
      { text: '', confidence: 0 },
    ])
    const observation = await runOcrAnalysis(makeCapture(), engine, makePool() as never)
    expect(observation.rawNameText).toBeNull()
    expect(observation.rawCollectorNumberText).toBeNull()
    expect(observation.usedFullFrameFallback).toBe(true)
    expect(observation.nameRoiId).toBeNull()
    expect(observation.numberRoiId).toBeNull()
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

describe('P80 adaptive-ROI scoring (pure)', () => {
  it('scoreNameRoiCandidate rewards high confidence AND a high letter ratio', () => {
    const cleanName = scoreNameRoiCandidate('CHANDELURE', 80)
    const noisyDigits = scoreNameRoiCandidate('58/102 x2', 80)
    expect(cleanName).toBeGreaterThan(noisyDigits)
    expect(scoreNameRoiCandidate('CHANDELURE', 80)).toBe(80 + 20) // pure letters -> ratio 1
  })

  it('scoreNumberRoiCandidate rewards a text that actually parses as a printed id over one that merely has higher raw confidence', () => {
    const parseable = scoreNumberRoiCandidate('049/197', 40)
    const unparsedButConfident = scoreNumberRoiCandidate('Illus. Ken S', 95)
    expect(parseable).toBeGreaterThan(unparsedButConfident)
  })

  it('looksLikeCollectorNumberText rejects a long OCR string even when a digit run inside it happens to parse structurally', () => {
    // parseCollectorNumber alone WOULD accept this (documented false-positive tolerance for short
    // OCR noise) — the length guard is what keeps a paragraph of rules text from ever winning the
    // number field just because it contains a slash-separated digit pair somewhere.
    expect(looksLikeCollectorNumberText('TESTASAURUS 58/102 junk')).toBe(false)
    expect(looksLikeCollectorNumberText('049/197')).toBe(true)
    expect(looksLikeCollectorNumberText('TG01/TG30')).toBe(true)
  })

  it('isNameRoiConfident requires BOTH a high confidence and a mostly-letters signal', () => {
    expect(isNameRoiConfident('CHANDELURE', 91)).toBe(true)
    expect(isNameRoiConfident('CHANDELURE', 50)).toBe(false) // confidence too low
    expect(isNameRoiConfident('58/102', 95)).toBe(false) // high confidence, but not letters
  })

  it('isNumberRoiConfident is exactly looksLikeCollectorNumberText (parseability is the whole signal)', () => {
    expect(isNumberRoiConfident('049/197')).toBe(true)
    expect(isNumberRoiConfident('Illus. Ken S')).toBe(false)
  })
})
