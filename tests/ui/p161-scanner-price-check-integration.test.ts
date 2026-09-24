import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P161 — Price Check on top of the hardened scanner, END TO END through real code.
 *
 * REAL here: `createRealScannerController` (latest-scan-wins, publish gate, confidence policy,
 * dispose), `scanner-identification` (`createReadOnlyScanner` / `identifyCapture`), Price Check's
 * `PriceCheckScanSession` and its outcome mapping. FAKE (as in the P151 harness): Tesseract's
 * recognition (`runOcrAnalysis`), the OCR engine and visual worker classes (so live workers can be
 * counted), the catalog and the collection writer (so "no write" is an assertion, not a hope).
 *
 * This is the suite the two parent branches could not have: P151's tests never used Price Check's
 * session, P153's never ran over the real controller. Every barrier is an explicit deferred; nothing
 * depends on timing. Real-browser proof of the same properties: tests/e2e/price-check-scan.spec.ts
 * and tests/e2e/price-check-p161-integration.spec.ts.
 */

const debugState = vi.hoisted(() => ({ on: false }))
vi.mock('../../src/features/scanner/debug-flag', () => ({
  isScannerDebugEnabled: () => debugState.on,
}))
vi.mock('../../src/features/scanner/analyze', () => ({
  runOcrAnalysis: vi.fn(),
  releaseOcrCanvases: vi.fn(),
}))
vi.mock('../../src/data/catalog', () => ({
  searchCards: vi.fn(),
  getCardVariants: vi.fn(),
  getCardsByIds: vi.fn(),
  classifyCardIdsAgainstCatalog: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('../../src/data/collection', () => ({ addCardAcquisition: vi.fn() }))

const world = vi.hoisted(() => ({
  liveEngines: new Set<object>(),
  liveVisualClients: new Set<object>(),
  visualAnalyze: null as null | ((bitmap: { blob: Blob }) => unknown),
}))
vi.mock('../../src/features/scanner/ocr-engine', () => ({
  ScannerOcrEngine: class {
    constructor() {
      world.liveEngines.add(this)
    }
    prepare = () => Promise.resolve()
    getState = () => 'ready' as const
    recognize = () => Promise.resolve({ text: '', confidence: 0 })
    dispose = () => {
      world.liveEngines.delete(this)
    }
  },
}))
vi.mock('../../src/features/scanner/visual/visual-client', () => ({
  VisualRecognitionClient: class {
    constructor() {
      world.liveVisualClients.add(this)
    }
    analyze = (bitmap: { blob: Blob; close: () => void }) => {
      bitmap.close()
      return Promise.resolve(world.visualAnalyze?.(bitmap) ?? null)
    }
    getDiagnosticsSnapshot = () => ({
      modelState: 'not-loaded' as const,
      unavailableReason: null,
      readyInfo: null,
      backendDiagnostics: null,
      firstEmbedMs: null,
      liveProgress: {
        workerBooted: false,
        workerBootMs: null,
        currentPhase: null,
        currentPhaseElapsedMs: null,
        lastProgressMsAgo: null,
      },
    })
    prewarm = () => Promise.resolve(null)
    getExpectedCardRank = () => Promise.resolve(null)
    dispose = () => {
      world.liveVisualClients.delete(this)
    }
  },
}))

import { getCardsByIds, searchCards } from '../../src/data/catalog'
import { addCardAcquisition } from '../../src/data/collection'
import { runOcrAnalysis } from '../../src/features/scanner/analyze'
import { scannerSessionStore } from '../../src/features/scanner/session-store'
import {
  createReadOnlyScanner,
  identifyCapture,
} from '../../src/features/scanner/scanner-identification'
import {
  createPriceCheckScanSession,
  type PriceCheckScanSession,
  type ScanResult,
} from '../../src/features/price-check/scan-session'

const PIKACHU = '11111111-1111-4111-8111-111111111111'
const CHARIZARD = '22222222-2222-4222-8222-222222222222'
const SIBLING = '33333333-3333-4333-8333-333333333333'

function row(cardId: string, name: string, localId: string, setName = 'Base Set') {
  return {
    cardId,
    name,
    localId,
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: 'en' as const,
    setId: setName,
    setName,
    variantCount: 2,
  }
}
const CATALOG = [
  row(PIKACHU, 'Pikachu', '58'),
  row(CHARIZARD, 'Charizard', '4'),
  row(SIBLING, 'Pikachu', '58', 'Base Set 2'),
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** What one photo "contains" as far as the (fake) OCR and visual channel are concerned. */
interface Script {
  name: string
  number: string
  visual: { cardId: string; similarity: number } | null
  /** When set, OCR does not answer until the test releases it. */
  gate?: ReturnType<typeof deferred<void>>
  /** Injects a scanner failure at the OCR stage. */
  ocrFails?: 'engine'
  /** Set by the fake once this scan reached the OCR stage. */
  reachedOcr?: boolean
}
const scripts = new Map<Blob, Script>()

const READABLE_HIGH: Script = {
  name: 'Pikachu',
  number: '58/102',
  visual: { cardId: PIKACHU, similarity: 0.9 },
}
const VISUAL_ONLY: Script = { name: '', number: '', visual: { cardId: PIKACHU, similarity: 0.9 } }
const UNREADABLE: Script = { name: '', number: '', visual: null }

function photo(script: Script) {
  const blob = new Blob(['p161'], { type: 'image/jpeg' })
  scripts.set(blob, { ...script })
  return {
    capture: {
      blob,
      width: 500,
      height: 700,
      cardRect: { left: 0, top: 0, width: 500, height: 700 },
    },
    script: scripts.get(blob) as Script,
  }
}

/** When set, catalog enrichment of visual hits (the controller's LAST await) waits for the test. */
let enrichGate: ReturnType<typeof deferred<void>> | null = null
let bitmapsOpen = 0
let liveUrls: Set<string>

beforeEach(() => {
  vi.clearAllMocks()
  debugState.on = false
  enrichGate = null
  scripts.clear()
  world.liveEngines.clear()
  world.liveVisualClients.clear()
  scannerSessionStore.clearAll()
  bitmapsOpen = 0
  liveUrls = new Set()
  let counter = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    counter += 1
    const url = `blob:p161-${String(counter)}`
    liveUrls.add(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    liveUrls.delete(url)
  })
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: vi.fn((blob: Blob) => {
      bitmapsOpen += 1
      let closed = false
      return Promise.resolve({
        blob,
        width: 500,
        height: 700,
        close: () => {
          if (!closed) {
            closed = true
            bitmapsOpen -= 1
          }
        },
      })
    }),
    configurable: true,
  })
  vi.mocked(runOcrAnalysis).mockImplementation(async (cap) => {
    const script = scripts.get(cap.blob)
    if (script === undefined) throw new Error('unrouted scan')
    script.reachedOcr = true
    if (script.gate !== undefined) await script.gate.promise
    if (script.ocrFails === 'engine') {
      const error = new Error('The card reader could not start on this device.')
      error.name = 'ScannerEngineError'
      throw error
    }
    return {
      rawNameText: script.name,
      rawCollectorNumberText: script.number,
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    }
  })
  world.visualAnalyze = (bitmap) => {
    const script = scripts.get(bitmap.blob)
    if (script?.visual == null) return null
    return {
      hits: [{ cardId: script.visual.cardId, similarity: script.visual.similarity }],
      backend: 'wasm',
      embedMs: 1,
      searchMs: 1,
      embeddingNorm: 1,
    }
  }
  vi.mocked(searchCards).mockImplementation(((params: { query: string }) => {
    const q = params.query.toLowerCase()
    const results = CATALOG.filter((c) => q.includes(c.name.toLowerCase()))
    return Promise.resolve({ results, totalCount: results.length })
  }) as never)
  vi.mocked(getCardsByIds).mockImplementation((async (ids: string[]) => {
    if (enrichGate !== null) await enrichGate.promise
    return CATALOG.filter((c) => ids.includes(c.cardId)).map((c) => ({
      id: c.cardId,
      name: c.name,
      localId: c.localId,
      rarity: c.rarity,
      category: c.category,
      illustrator: c.illustrator,
      imageBaseUrl: c.imageBaseUrl,
      language: c.language,
      setId: c.setId,
      setName: c.setName,
    }))
  }) as never)
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).createImageBitmap
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function openSession(userId: string | null = 'user-a'): PriceCheckScanSession {
  return createPriceCheckScanSession({ createReadOnlyScanner, identifyCapture }, userId)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function untilOcr(script: Script): Promise<void> {
  for (let i = 0; i < 400 && script.reachedOcr !== true; i += 1) await flush()
  if (script.reachedOcr !== true) throw new Error('scan never reached the OCR stage')
}

function kindOf(result: ScanResult): string {
  return result.status === 'outcome' ? `outcome:${result.outcome.kind}` : result.status
}

function expectNothingWritten(): void {
  expect(vi.mocked(addCardAcquisition)).not.toHaveBeenCalled()
}

describe('scan → Price Check outcome through the real controller', () => {
  it('printed text + visual agree → HIGH, the exact catalog uuid pre-selected, nothing written', async () => {
    const session = openSession()
    const result = await session.analyze(photo(READABLE_HIGH).capture)
    expect(result).toMatchObject({
      status: 'outcome',
      outcome: { kind: 'high', preselectedId: PIKACHU },
    })
    if (result.status === 'outcome' && result.outcome.kind === 'high') {
      const best = result.outcome.candidates[0]
      // Identity fields survive the whole chain: uuid, set, collector number, language stays a label.
      expect(best).toMatchObject({
        candidateId: PIKACHU,
        setName: 'Base Set',
        collectorNumber: '58',
      })
    }
    session.dispose()
    expectNothingWritten()
  })

  it('VISUAL-ONLY evidence is never a pre-selected HIGH (same-art sibling printing)', async () => {
    const session = openSession()
    const result = await session.analyze(
      photo({ ...VISUAL_ONLY, visual: { cardId: SIBLING, similarity: 0.95 } }).capture,
    )
    expect(result.status).toBe('outcome')
    if (result.status !== 'outcome') return
    expect(result.outcome.kind).toBe('review')
    expect('preselectedId' in result.outcome).toBe(false)
    expect(result.outcome).toMatchObject({ confidence: 'MEDIUM' })
    session.dispose()
    expectNothingWritten()
  })

  it('an unreadable photo is an honest no-match, never a guess', async () => {
    const session = openSession()
    expect(kindOf(await session.analyze(photo(UNREADABLE).capture))).toBe('outcome:no_match')
    session.dispose()
  })

  it('the scanner never reports a variant: candidates carry identity only', async () => {
    const session = openSession()
    const result = await session.analyze(photo(READABLE_HIGH).capture)
    const flat = JSON.stringify(result)
    expect(flat).not.toMatch(/variant|finish|holo|reverse/i)
    session.dispose()
  })
})

describe('latest request wins across the real controller and the Price Check session', () => {
  it('A started, B started, B finishes, A finishes: only B is delivered', async () => {
    const session = openSession()
    const a = photo({ ...READABLE_HIGH, gate: deferred<void>() })
    const b = photo({
      name: 'Charizard',
      number: '4/102',
      visual: { cardId: CHARIZARD, similarity: 0.9 },
      gate: deferred<void>(),
    })
    const pa = session.analyze(a.capture)
    await untilOcr(a.script)
    const pb = session.analyze(b.capture)
    await untilOcr(b.script)
    b.script.gate?.resolve()
    const rb = await pb
    a.script.gate?.resolve()
    const ra = await pa
    expect(ra).toEqual({ status: 'abandoned' })
    expect(rb).toMatchObject({
      status: 'outcome',
      outcome: { kind: 'high', preselectedId: CHARIZARD },
    })
    session.dispose()
    expectNothingWritten()
  })

  it('A finishes first but B was started later: A is still not delivered', async () => {
    const session = openSession()
    const a = photo({ ...READABLE_HIGH, gate: deferred<void>() })
    const b = photo({
      ...READABLE_HIGH,
      name: 'Charizard',
      number: '4/102',
      visual: { cardId: CHARIZARD, similarity: 0.9 },
      gate: deferred<void>(),
    })
    const pa = session.analyze(a.capture)
    await untilOcr(a.script)
    const pb = session.analyze(b.capture)
    await untilOcr(b.script)
    a.script.gate?.resolve()
    expect(await pa).toEqual({ status: 'abandoned' })
    b.script.gate?.resolve()
    expect(kindOf(await pb)).toBe('outcome:high')
    session.dispose()
  })

  it('100 cancel/restart cycles: every abandoned scan stays abandoned, every restart succeeds', async () => {
    const session = openSession()
    for (let i = 0; i < 100; i += 1) {
      const abandoned = photo({ ...READABLE_HIGH, gate: deferred<void>() })
      const pAbandoned = session.analyze(abandoned.capture)
      await untilOcr(abandoned.script)
      session.cancel()
      const fresh = photo(READABLE_HIGH)
      const pFresh = session.analyze(fresh.capture)
      abandoned.script.gate?.resolve() // the cancelled scan's OCR finally answers, AFTER the restart
      expect(await pAbandoned).toEqual({ status: 'abandoned' })
      expect(kindOf(await pFresh)).toBe('outcome:high')
      expect(bitmapsOpen).toBe(0)
    }
    session.dispose()
    expect(world.liveEngines.size).toBe(0)
    expect(world.liveVisualClients.size).toBe(0)
    expectNothingWritten()
  }, 120_000)

  it('cancel mid-OCR then a successful scan on the same session (recovery)', async () => {
    const session = openSession()
    const slow = photo({ ...READABLE_HIGH, gate: deferred<void>() })
    const p = session.analyze(slow.capture)
    await untilOcr(slow.script)
    session.cancel()
    // A single OCR pass cannot be interrupted: the abort takes effect at the next checkpoint, so the
    // abandoned promise settles only once that pass answers (nothing waits on it).
    slow.script.gate?.resolve()
    expect(await p).toEqual({ status: 'abandoned' })
    expect(kindOf(await session.analyze(photo(READABLE_HIGH).capture))).toBe('outcome:high')
    session.dispose()
  })
})

describe('the read-only port itself enforces latest-wins (independent of the session)', () => {
  // Price Check's session also aborts its own signal, so the two owners overlap today. These tests
  // drive identifyCapture on the port with NO caller signal: they pin the scanner's half of the
  // ownership, so a future consumer (or a regression in the session) cannot bring stale delivery back.
  it('a second identification on the same port supersedes the first, without any caller abort', async () => {
    const port = createReadOnlyScanner('user-a')
    const a = photo({ ...READABLE_HIGH, gate: deferred<void>() })
    const pa = identifyCapture(port, a.capture)
    await untilOcr(a.script)
    const b = photo(READABLE_HIGH)
    const pb = identifyCapture(port, b.capture)
    a.script.gate?.resolve()
    expect(await pa).toMatchObject({ status: 'error', error: { code: 'aborted' } })
    expect(await pb).toMatchObject({ status: 'identified', best: { catalogCardId: PIKACHU } })
    port.dispose()
    expectNothingWritten()
  })

  it('a scan superseded while its LAST await (catalog enrichment) is pending is still not delivered', async () => {
    const port = createReadOnlyScanner('user-a')
    enrichGate = deferred<void>()
    // Visual-only: the candidate only exists through enrichment, so the scan parks in getCardsByIds.
    const a = photo(VISUAL_ONLY)
    const pa = identifyCapture(port, a.capture)
    await untilOcr(a.script)
    for (let i = 0; i < 50; i += 1) await flush()
    expect(vi.mocked(getCardsByIds)).toHaveBeenCalledTimes(1)
    port.dispose() // dispose = the same abort the publish gate observes
    enrichGate.resolve()
    expect(await pa).toMatchObject({ status: 'error', error: { code: 'aborted' }, best: null })
  })
})

describe('failure recovery', () => {
  it('a reader failure is a sanitised error result and the next scan succeeds', async () => {
    const session = openSession()
    const failing = await session.analyze(photo({ ...READABLE_HIGH, ocrFails: 'engine' }).capture)
    expect(failing.status).toBe('error')
    expect(failing.status === 'error' && failing.message).toContain(
      'could not start on this device',
    )
    expect(kindOf(await session.analyze(photo(READABLE_HIGH).capture))).toBe('outcome:high')
    session.dispose()
  })

  it('an unreachable catalog is its own error (not a no-match), and the session survives it', async () => {
    const session = openSession()
    vi.mocked(searchCards).mockRejectedValue(new Error('network down'))
    const result = await session.analyze(photo(READABLE_HIGH).capture)
    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.message).toContain('catalog could not be reached')
    vi.mocked(searchCards).mockReset()
    vi.mocked(searchCards).mockImplementation(((params: { query: string }) => {
      const q = params.query.toLowerCase()
      const results = CATALOG.filter((c) => q.includes(c.name.toLowerCase()))
      return Promise.resolve({ results, totalCount: results.length })
    }) as never)
    expect(kindOf(await session.analyze(photo(READABLE_HIGH).capture))).toBe('outcome:high')
    session.dispose()
  })
})

describe('account switch: nothing of A survives into B', () => {
  it('A → B during OCR: A is abandoned, A’s workers are released, B gets only its own result', async () => {
    const sessionA = openSession('user-a')
    const a = photo({ ...READABLE_HIGH, gate: deferred<void>() })
    const pa = sessionA.analyze(a.capture)
    await untilOcr(a.script)
    expect(world.liveEngines.size).toBe(1)

    sessionA.dispose() // the identity boundary unmounts A's screen
    const sessionB = openSession('user-b')
    const b = photo({
      name: 'Charizard',
      number: '4/102',
      visual: { cardId: CHARIZARD, similarity: 0.9 },
    })
    const rb = await sessionB.analyze(b.capture)

    a.script.gate?.resolve() // A's OCR answers late, after B has already won
    expect(await pa).toEqual({ status: 'abandoned' })
    expect(rb).toMatchObject({
      status: 'outcome',
      outcome: { kind: 'high', preselectedId: CHARIZARD },
    })
    expect(JSON.stringify(rb)).not.toContain(PIKACHU)
    // Exactly one live reader (B's): A's engine and visual client were terminated by dispose().
    expect(world.liveEngines.size).toBe(1)
    expect(world.liveVisualClients.size).toBe(1)
    sessionB.dispose()
    expect(world.liveEngines.size).toBe(0)
    expect(world.liveVisualClients.size).toBe(0)
    expectNothingWritten()
  })

  it('A → B → A: the first A session can never deliver into the second A session', async () => {
    const a1 = openSession('user-a')
    const slow = photo({ ...READABLE_HIGH, gate: deferred<void>() })
    const p1 = a1.analyze(slow.capture)
    await untilOcr(slow.script)
    a1.dispose()
    const b = openSession('user-b')
    await b.analyze(photo(READABLE_HIGH).capture)
    b.dispose()
    const a2 = openSession('user-a')
    const fresh = photo({
      name: 'Charizard',
      number: '4/102',
      visual: { cardId: CHARIZARD, similarity: 0.9 },
    })
    const p2 = a2.analyze(fresh.capture)
    slow.script.gate?.resolve()
    expect(await p1).toEqual({ status: 'abandoned' })
    expect(await p2).toMatchObject({ outcome: { preselectedId: CHARIZARD } })
    a2.dispose()
    expect(world.liveEngines.size).toBe(0)
  })

  it('same-user refresh (a NEW session for the same id) behaves like any remount: old one is dead', async () => {
    const first = openSession('user-a')
    const slow = photo({ ...READABLE_HIGH, gate: deferred<void>() })
    const p = first.analyze(slow.capture)
    await untilOcr(slow.script)
    first.dispose()
    const second = openSession('user-a')
    slow.script.gate?.resolve()
    expect(await p).toEqual({ status: 'abandoned' })
    expect(kindOf(await second.analyze(photo(READABLE_HIGH).capture))).toBe('outcome:high')
    second.dispose()
  })

  it('a disposed session accepts no further work and never builds a second worker', async () => {
    const session = openSession()
    session.dispose()
    expect(await session.analyze(photo(READABLE_HIGH).capture)).toEqual({ status: 'abandoned' })
    expect(world.liveEngines.size).toBe(0)
    expect(world.liveVisualClients.size).toBe(0)
  })
})

describe('bounded mixed workload (100 scans, valid and invalid)', () => {
  it('every scan settles as scripted, no resource accumulates, no write happens', async () => {
    const session = openSession()
    const counts: Record<string, number> = {}
    for (let i = 0; i < 100; i += 1) {
      const kind = i % 5
      const script: Script =
        kind === 0
          ? READABLE_HIGH
          : kind === 1
            ? VISUAL_ONLY
            : kind === 2
              ? UNREADABLE
              : kind === 3
                ? { ...READABLE_HIGH, ocrFails: 'engine' }
                : {
                    name: 'Charizard',
                    number: '4/102',
                    visual: { cardId: CHARIZARD, similarity: 0.9 },
                  }
      const label = kindOf(await session.analyze(photo(script).capture))
      counts[label] = (counts[label] ?? 0) + 1
      expect(bitmapsOpen).toBe(0)
    }
    expect(counts).toEqual({
      'outcome:high': 40,
      'outcome:review': 20,
      'outcome:no_match': 20,
      error: 20,
    })
    session.dispose()
    expect(world.liveEngines.size).toBe(0)
    expect(world.liveVisualClients.size).toBe(0)
    expect(liveUrls.size).toBe(0)
    expectNothingWritten()
  }, 120_000)
})

describe('the read-only boundary holds over the real controller', () => {
  it('Price Check’s port has no commit path; the real collection writer is never reachable from it', async () => {
    const port = createReadOnlyScanner('user-a')
    expect('commitBatch' in port).toBe(false)
    expect(Object.keys(port).sort()).toEqual([
      'analyzeCapture',
      'dispose',
      'listVariantChoices',
      'prewarm',
      'searchFallback',
    ])
    port.dispose()
    expectNothingWritten()
  })
})
