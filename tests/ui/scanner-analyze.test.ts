import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OCR_WORKING_LONG_EDGE,
  runOcrAnalysis,
  splitFullFrameCardText,
  extractCollectorNumberLine,
  scoreNameRoiCandidate,
  scoreNumberRoiCandidate,
  isNameRoiConfident,
  isNumberRoiConfident,
  NUMBER_ROI_CONFIDENCE_FLOOR,
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
      nameConfidence: 91,
      collectorNumberConfidence: 88,
    })
  })

  it('P80 R1: falls through to the modern name candidate and picks it by SCORE when the vintage strip reads worse', async () => {
    // Name candidates run FIRST; none crosses the "confident" early-exit bar (score < 70+16), so
    // all three are tried and the highest-scoring one wins — the modern layout's name plate, not
    // list order. The number field's first candidate is made trivially confident so it stops
    // after one call, keeping this test's mock sequence focused on the name-selection behavior.
    const engine = makeEngine([
      { text: '58/102', confidence: 60 }, // name candidate 1 (classic-top-left): digit-heavy noise
      { text: 'MEGA CHANDELURE EX', confidence: 55 }, // name candidate 2 (modern-full-width)
      { text: '', confidence: 0 }, // name candidate 3 (energy-bottom-band, P88 F-17): empty/unusable
      { text: '58/102', confidence: 90 }, // number candidate 1 (modern-bottom-left): parses, stops early
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.recognize).toHaveBeenCalledTimes(4)
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

  it('P80/P82/P85/P88 R3: runs EXACTLY ONE full-card fallback when EVERY candidate for BOTH fields is unusable across ALL THREE passes', async () => {
    // 3 name candidates (P88 F-17 adds the energy-bottom-band hypothesis) + 2 number candidates,
    // all empty/whitespace-only under the `contrast` pass (P78-P81 behaviour, unchanged), the P82
    // `binarize` retry pass, AND the P85 `multi-line` third pass (number field only — see the
    // dedicated recovery test below for the case where that pass actually finds something) — only
    // then the full-frame fallback text.
    const engine = makeEngine([
      { text: '', confidence: 0 }, // name candidate 1, contrast
      { text: ' ', confidence: 0 }, // name candidate 2, contrast
      { text: '', confidence: 0 }, // name candidate 3 (energy-bottom-band), contrast
      { text: '', confidence: 0 }, // name candidate 1, binarize retry
      { text: ' ', confidence: 0 }, // name candidate 2, binarize retry
      { text: '', confidence: 0 }, // name candidate 3, binarize retry
      { text: '', confidence: 0 }, // number candidate 1, contrast
      { text: ' ', confidence: 0 }, // number candidate 2, contrast
      { text: '', confidence: 0 }, // number candidate 1, binarize retry
      { text: ' ', confidence: 0 }, // number candidate 2, binarize retry
      { text: '', confidence: 0 }, // number candidate 1, multi-line retry (P85)
      { text: ' ', confidence: 0 }, // number candidate 2, multi-line retry (P85)
      { text: 'TESTASAURUS 58/102 junk', confidence: 40 }, // full-card fallback
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.recognize).toHaveBeenCalledTimes(13)
    expect(engine.recognize.mock.calls[10]?.[1]).toBe('multi-line')
    expect(engine.recognize.mock.calls[12]?.[1]).toBe('auto')
    expect(observation.usedFullFrameFallback).toBe(true)
    expect(observation.rawNameText).toBe('TESTASAURUS')
    expect(observation.rawCollectorNumberText).toBe('58/102')
    // Fails gracefully: no candidate ever won either field.
    expect(observation.nameRoiId).toBeNull()
    expect(observation.numberRoiId).toBeNull()
  })

  it('O85-14/P85 §7: the multi-line third pass recovers a collector number sharing its line with credit text, at bounded extra cost', async () => {
    // Name resolves confidently on the first candidate (1 call). The number field's contrast AND
    // binarize passes both find nothing usable on EITHER candidate (4 calls) — exactly the
    // real-corpus failure this session found (docs/SCANNER_RESEARCH.md §7f): a single-line read of
    // a crop that structurally contains two lines returns empty. The bounded multi-line retry then
    // finds the id on candidate 2's block-read second line — 2 extra calls, never the full-frame
    // fallback.
    const engine = makeEngine([
      { text: 'CHANDELURE', confidence: 90 }, // name candidate 1: confident, stops early
      { text: '', confidence: 0 }, // number candidate 1, contrast
      { text: '', confidence: 0 }, // number candidate 2, contrast
      { text: '', confidence: 0 }, // number candidate 1, binarize
      { text: '', confidence: 0 }, // number candidate 2, binarize
      { text: 'Illus. Ken Sugimori\n049/197', confidence: 55 }, // number candidate 1, multi-line: two real lines
    ])
    const pool = makePool()
    const observation = await runOcrAnalysis(makeCapture(), engine, pool as never)
    expect(engine.recognize).toHaveBeenCalledTimes(6)
    expect(engine.recognize.mock.calls[5]?.[1]).toBe('multi-line')
    expect(observation.usedFullFrameFallback).toBe(false)
    expect(observation.rawCollectorNumberText).toBe('049/197')
    expect(observation.numberRoiId).toBe('modern-bottom-left')
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

describe('P85 §7 extractCollectorNumberLine (pure)', () => {
  it('picks the LAST line when it is the one that parses as a printed id', () => {
    expect(extractCollectorNumberLine('Illus. Ken Sugimori\n049/197')).toBe('049/197')
  })

  it('finds the id even when it is not the last line', () => {
    expect(extractCollectorNumberLine('049/197\nNintendo, Creatures, GAMEFREAK')).toBe('049/197')
  })

  it('returns null when NO line looks like a printed id', () => {
    expect(extractCollectorNumberLine('Illus. Ken Sugimori\nNintendo, Creatures')).toBeNull()
  })

  it('returns null for empty/whitespace-only input', () => {
    expect(extractCollectorNumberLine('')).toBeNull()
    expect(extractCollectorNumberLine('   \n  \n')).toBeNull()
  })

  it('ignores blank lines between real content', () => {
    expect(extractCollectorNumberLine('Illus. Ken Sugimori\n\n\nTG01/TG30')).toBe('TG01/TG30')
  })

  it('extracts the id TOKEN from a line with real surrounding noise (confirmed set-symbol misread)', () => {
    // Real PSM 6 output on a Scarlet & Violet card: a misread set-symbol icon box "(BI" and a
    // trailing bullet glyph share the line with the actual printed id.
    expect(extractCollectorNumberLine('ius. Shigenori Negishi\n(BI 001/198 ®\n')).toBe('001/198')
  })

  it('never fabricates an id out of a line with no digit-bearing token at all', () => {
    expect(
      extractCollectorNumberLine('Rg TTY\nspits out a fluid that it uses to glue tree bark'),
    ).toBeNull()
  })

  it('O85-13: never mistakes a bare copyright YEAR for a printed id (confirmed real false positive)', () => {
    // Real PSM 6 output on a Base Set card: the copyright line reads as a bare "1995" — digits
    // only, structurally parseable, but this catalog's real local ids never reach 4 digits
    // without a total attached, so a bare 4-digit run with no total must be rejected here even
    // though `looksLikeCollectorNumberText` alone would accept it.
    expect(
      extractCollectorNumberLine('Nintendo, Creatures, GAMEFREAK. © 1995 Wizards.\n1/102 ★'),
    ).toBe('1/102 ★') // the whole line already parses (parseCollectorNumber tolerates the trailing glyph)
    expect(extractCollectorNumberLine('© 1995 Nintendo, Creatures, GAMEFREAK.')).toBeNull()
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

  it('isNumberRoiConfident requires BOTH parseability AND a minimum OCR confidence (F-12/P88 §8)', () => {
    expect(isNumberRoiConfident('049/197', 90)).toBe(true)
    expect(isNumberRoiConfident('Illus. Ken S', 90)).toBe(false)
    // Real F-12 repro: a shape-plausible digit run at near-zero OCR confidence must not win.
    expect(isNumberRoiConfident('049/197', 1)).toBe(false)
    expect(isNumberRoiConfident('049/197', NUMBER_ROI_CONFIDENCE_FLOOR)).toBe(true)
    expect(isNumberRoiConfident('049/197', NUMBER_ROI_CONFIDENCE_FLOOR - 1)).toBe(false)
  })
})
