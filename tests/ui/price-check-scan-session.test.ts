import { describe, expect, it, vi } from 'vitest'

// scanner-identification imports the controller (→ catalog → Supabase client). Its wiring is
// exercised against the REAL controller in p161-scanner-price-check-integration.test.ts.
vi.mock('../../src/features/scanner/controller', () => ({ getScannerUiController: vi.fn() }))

import {
  createPriceCheckScanSession,
  identificationToOutcome,
  PriceCheckScanSession,
  type ScannerIdentificationModule,
} from '../../src/features/price-check/scan-session'
import {
  identifyCapture,
  toReadOnlyScannerPort,
  type ReadOnlyScannerPort,
} from '../../src/features/scanner/scanner-identification'
import type {
  ScannerAnalysis,
  ScannerCapture,
  ScannerUiController,
} from '../../src/features/scanner/contract'

/**
 * Price Check's scan session over the hardened read-only scanner contract (P151 + P161). The port
 * is the real `toReadOnlyScannerPort`, the identification is the real `identifyCapture`; only the
 * controller underneath is a double. The full-controller integration (real pipeline, doubles for
 * Tesseract / the visual worker / the catalog) lives in
 * tests/ui/p161-scanner-price-check-integration.test.ts.
 */

const CARD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CARD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CAPTURE: ScannerCapture = {
  blob: new Blob(['x']),
  width: 10,
  height: 14,
  cardRect: { left: 0, top: 0, width: 10, height: 14 },
}

function analysis(over: Partial<ScannerAnalysis> = {}): ScannerAnalysis {
  return {
    confidence: 'HIGH',
    candidates: [{ candidateId: CARD_A, name: 'Pikachu', setName: 'Base', collectorNumber: '58' }],
    ...over,
  }
}

/** A controller whose acquisition and every other non-recognition path fails loudly if touched. */
function controllerWith(analyzeCapture: ScannerUiController['analyzeCapture']) {
  return {
    analyzeCapture,
    searchFallback: vi.fn(() => Promise.reject(new Error('search must not be used'))),
    listVariantChoices: vi.fn(() => Promise.reject(new Error('variants must not be used'))),
    commitBatch: vi.fn(() => Promise.reject(new Error('ACQUISITION CALLED'))),
    dispose: vi.fn(),
    prewarm: vi.fn(),
  } satisfies ScannerUiController
}

function sessionOver(controller: ScannerUiController): PriceCheckScanSession {
  return new PriceCheckScanSession(toReadOnlyScannerPort(controller), identifyCapture)
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createPriceCheckScanSession — the only door into the scanner', () => {
  it('builds the session from createReadOnlyScanner, prewarms it, and forwards disposal', () => {
    const controller = controllerWith(() => Promise.resolve(analysis()))
    const port = toReadOnlyScannerPort(controller)
    const module: ScannerIdentificationModule = {
      createReadOnlyScanner: vi.fn(() => port),
      identifyCapture,
    }
    const session = createPriceCheckScanSession(module, 'user-1')
    expect(module.createReadOnlyScanner).toHaveBeenCalledWith('user-1')
    expect(controller.prewarm).toHaveBeenCalledTimes(1)
    session.dispose()
    expect(controller.dispose).toHaveBeenCalledTimes(1)
  })

  it('the port Price Check holds has no commitBatch, at runtime, even through a cast', () => {
    const port = toReadOnlyScannerPort(controllerWith(() => Promise.resolve(analysis())))
    expect('commitBatch' in port).toBe(false)
    expect((port as unknown as Record<string, unknown>).commitBatch).toBeUndefined()
    expect(Object.keys(port).sort()).toEqual([
      'analyzeCapture',
      'dispose',
      'listVariantChoices',
      'prewarm',
      'searchFallback',
    ])
  })
})

describe('PriceCheckScanSession', () => {
  it('HIGH → high outcome, best candidate pre-selected; no write is ever attempted', async () => {
    const controller = controllerWith(() => Promise.resolve(analysis()))
    const result = await sessionOver(controller).analyze(CAPTURE)
    expect(result).toMatchObject({
      status: 'outcome',
      outcome: { kind: 'high', preselectedId: CARD_A },
    })
    expect(controller.commitBatch).not.toHaveBeenCalled()
    expect(controller.searchFallback).not.toHaveBeenCalled()
    expect(controller.listVariantChoices).not.toHaveBeenCalled()
  })

  it('MEDIUM with two candidates → review with the scanner band, nothing pre-selected', async () => {
    const session = sessionOver(
      controllerWith(() =>
        Promise.resolve(
          analysis({
            confidence: 'MEDIUM',
            candidates: [
              { candidateId: CARD_A, name: 'Charizard' },
              { candidateId: CARD_B, name: 'Charizard' },
            ],
          }),
        ),
      ),
    )
    const result = await session.analyze(CAPTURE)
    expect(result.status === 'outcome' && result.outcome).toMatchObject({
      kind: 'review',
      confidence: 'MEDIUM',
    })
  })

  it('NO_MATCH → no_match (manual fallback)', async () => {
    const session = sessionOver(
      controllerWith(() => Promise.resolve(analysis({ confidence: 'NO_MATCH', candidates: [] }))),
    )
    expect(await session.analyze(CAPTURE)).toEqual({
      status: 'outcome',
      outcome: { kind: 'no_match' },
    })
  })

  it('drops candidates whose id is not a catalog uuid, and duplicates', async () => {
    const session = sessionOver(
      controllerWith(() =>
        Promise.resolve(
          analysis({
            confidence: 'MEDIUM',
            candidates: [
              { candidateId: 'not-a-uuid', name: 'X' },
              { candidateId: CARD_A, name: 'A' },
              { candidateId: CARD_A, name: 'A again' },
            ],
          }),
        ),
      ),
    )
    const result = await session.analyze(CAPTURE)
    const candidates =
      result.status === 'outcome' && result.outcome.kind !== 'no_match'
        ? result.outcome.candidates
        : []
    expect(candidates.map((c) => c.candidateId)).toEqual([CARD_A])
  })

  it('HIGH whose own best candidate was dropped is NOT pre-selected on the runner-up', async () => {
    // The scanner rated 'not-a-uuid' HIGH. CARD_A merely inherited the top slot after filtering —
    // presenting it as the confident answer would vouch for a card the scanner never vouched for.
    const session = sessionOver(
      controllerWith(() =>
        Promise.resolve(
          analysis({
            confidence: 'HIGH',
            candidates: [
              { candidateId: 'not-a-uuid', name: 'Top' },
              { candidateId: CARD_A, name: 'Runner-up' },
            ],
          }),
        ),
      ),
    )
    const result = await session.analyze(CAPTURE)
    expect(result.status === 'outcome' && result.outcome).toMatchObject({ kind: 'review' })
    expect(result.status === 'outcome' && 'preselectedId' in result.outcome).toBe(false)
  })

  it('all candidates unusable → no_match, not a crash', async () => {
    const session = sessionOver(
      controllerWith(() =>
        Promise.resolve(analysis({ candidates: [{ candidateId: 'zzz', name: 'X' }] })),
      ),
    )
    expect(await session.analyze(CAPTURE)).toEqual({
      status: 'outcome',
      outcome: { kind: 'no_match' },
    })
  })

  it('a scanner failure is a sanitised error result, and acquisition is still untouched', async () => {
    const controller = controllerWith(() => Promise.reject(new Error('worker crashed: 0xDEAD')))
    const result = await sessionOver(controller).analyze(CAPTURE)
    expect(result.status).toBe('error')
    // The raw error text never reaches the screen; the contract's own sanitised message does.
    expect(result.status === 'error' && result.message).not.toContain('0xDEAD')
    expect(controller.commitBatch).not.toHaveBeenCalled()
  })

  it('a typed catalog failure gets its own message (not the generic one)', async () => {
    const error = new Error('down')
    error.name = 'ScannerCatalogUnavailableError'
    const result = await sessionOver(controllerWith(() => Promise.reject(error))).analyze(CAPTURE)
    expect(result.status === 'error' && result.message).toContain('catalog could not be reached')
  })

  it('a scanner-side abort (typed) is abandoned, never shown as a failure', async () => {
    const error = new Error('x')
    error.name = 'ScannerAnalysisAbortedError'
    expect(await sessionOver(controllerWith(() => Promise.reject(error))).analyze(CAPTURE)).toEqual(
      { status: 'abandoned' },
    )
  })

  it('repeated scan: the older result is never delivered once a newer scan started', async () => {
    const first = deferred<ScannerAnalysis>()
    const second = deferred<ScannerAnalysis>()
    const calls = [first, second]
    // A scanner that does NOT honour the abort: both results arrive successfully, old one last.
    const controller = controllerWith(
      () => calls.shift()?.promise ?? Promise.reject(new Error('unexpected call')),
    )
    const session = sessionOver(controller)
    const p1 = session.analyze(CAPTURE)
    const p2 = session.analyze(CAPTURE)
    second.resolve(analysis({ candidates: [{ candidateId: CARD_B, name: 'New' }] }))
    first.resolve(analysis({ candidates: [{ candidateId: CARD_A, name: 'Old' }] }))
    expect(await p1).toEqual({ status: 'abandoned' })
    const r2 = await p2
    expect(r2.status === 'outcome' && r2.outcome.kind === 'high' && r2.outcome.preselectedId).toBe(
      CARD_B,
    )
  })

  it('the superseded scan is aborted through the shared signal', () => {
    const signals: AbortSignal[] = []
    const controller = controllerWith((_capture, signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })
    const session = sessionOver(controller)
    void session.analyze(CAPTURE)
    void session.analyze(CAPTURE)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })

  it('cancel abandons the in-flight scan (a late result is discarded)', async () => {
    const pending = deferred<ScannerAnalysis>()
    const session = sessionOver(controllerWith(() => pending.promise))
    const p = session.analyze(CAPTURE)
    session.cancel()
    pending.resolve(analysis())
    expect(await p).toEqual({ status: 'abandoned' })
  })

  it('a scanner error arriving after cancel is abandoned, not shown', async () => {
    const pending = deferred<ScannerAnalysis>()
    const session = sessionOver(controllerWith(() => pending.promise))
    const p = session.analyze(CAPTURE)
    session.cancel()
    pending.reject(new Error('boom after cancel'))
    expect(await p).toEqual({ status: 'abandoned' })
  })

  it('after cancel the SAME session can scan again (recovery after failure)', async () => {
    const results: (() => Promise<ScannerAnalysis>)[] = [
      () => Promise.reject(new Error('worker crashed')),
      () => Promise.resolve(analysis()),
    ]
    const session = sessionOver(
      controllerWith(() => results.shift()?.() ?? Promise.reject(new Error('unexpected'))),
    )
    expect((await session.analyze(CAPTURE)).status).toBe('error')
    session.cancel()
    expect((await session.analyze(CAPTURE)).status).toBe('outcome')
  })

  it('navigating away (dispose) abandons the scan, releases the scanner once, idempotently', async () => {
    const pending = deferred<ScannerAnalysis>()
    const controller = controllerWith(() => pending.promise)
    const session = sessionOver(controller)
    const p = session.analyze(CAPTURE)
    session.dispose()
    session.dispose()
    pending.resolve(analysis())
    expect(await p).toEqual({ status: 'abandoned' })
    expect(controller.dispose).toHaveBeenCalledTimes(1)
    expect(controller.commitBatch).not.toHaveBeenCalled()
    // A disposed session accepts no more work.
    expect(await session.analyze(CAPTURE)).toEqual({ status: 'abandoned' })
  })
})

describe('identificationToOutcome (pure mapping)', () => {
  const port: ReadOnlyScannerPort = toReadOnlyScannerPort(
    controllerWith(() => Promise.resolve(analysis())),
  )

  it('carries set, number and language through untouched', async () => {
    const identification = await identifyCapture(port, CAPTURE)
    expect(identificationToOutcome(identification)).toMatchObject({
      kind: 'high',
      preselectedId: CARD_A,
      candidates: [
        {
          candidateId: CARD_A,
          name: 'Pikachu',
          setName: 'Base',
          collectorNumber: '58',
          imageBaseUrl: null,
          languageLabel: null,
        },
      ],
    })
  })
})
