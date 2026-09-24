import { describe, expect, it, vi } from 'vitest'
import {
  narrowScannerPort,
  PriceCheckScanSession,
  type PriceCheckScannerPort,
} from '../../src/features/price-check/scan-session'
import type {
  ScannerAnalysis,
  ScannerCapture,
  ScannerUiController,
} from '../../src/features/scanner/contract'

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

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('narrowScannerPort — Price Check cannot reach the acquisition path', () => {
  it('exposes only analyzeCapture and dispose', () => {
    const controller = controllerWith(() => Promise.resolve(analysis()))
    const port = narrowScannerPort(controller)
    expect(Object.keys(port).sort()).toEqual(['analyzeCapture', 'dispose'])
    expect('commitBatch' in port).toBe(false)
    expect('searchFallback' in port).toBe(false)
  })

  it('forwards the abort signal and disposal', async () => {
    const analyze = vi.fn<ScannerUiController['analyzeCapture']>(() => Promise.resolve(analysis()))
    const controller = controllerWith(analyze)
    const port = narrowScannerPort(controller)
    const signal = new AbortController().signal
    await port.analyzeCapture(CAPTURE, signal)
    expect(analyze).toHaveBeenCalledWith(CAPTURE, signal)
    port.dispose()
    expect(controller.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('PriceCheckScanSession', () => {
  it('HIGH → high outcome, best candidate pre-selected; no write is ever attempted', async () => {
    const controller = controllerWith(() => Promise.resolve(analysis()))
    const session = new PriceCheckScanSession(narrowScannerPort(controller))
    const result = await session.analyze(CAPTURE)
    expect(result).toMatchObject({
      status: 'outcome',
      outcome: { kind: 'high', preselectedId: CARD_A },
    })
    expect(controller.commitBatch).not.toHaveBeenCalled()
  })

  it('MEDIUM with two candidates → review, nothing pre-selected', async () => {
    const session = new PriceCheckScanSession(
      narrowScannerPort(
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
      ),
    )
    const result = await session.analyze(CAPTURE)
    expect(result.status === 'outcome' && result.outcome.kind).toBe('review')
  })

  it('NO_MATCH → no_match (manual fallback)', async () => {
    const session = new PriceCheckScanSession(
      narrowScannerPort(
        controllerWith(() => Promise.resolve(analysis({ confidence: 'NO_MATCH', candidates: [] }))),
      ),
    )
    expect(await session.analyze(CAPTURE)).toEqual({
      status: 'outcome',
      outcome: { kind: 'no_match' },
    })
  })

  it('drops candidates whose id is not a catalog uuid, and duplicates', async () => {
    const session = new PriceCheckScanSession(
      narrowScannerPort(
        controllerWith(() =>
          Promise.resolve(
            analysis({
              candidates: [
                { candidateId: 'not-a-uuid', name: 'X' },
                { candidateId: CARD_A, name: 'A' },
                { candidateId: CARD_A, name: 'A again' },
              ],
            }),
          ),
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

  it('all candidates unusable → no_match, not a crash', async () => {
    const session = new PriceCheckScanSession(
      narrowScannerPort(
        controllerWith(() =>
          Promise.resolve(analysis({ candidates: [{ candidateId: 'zzz', name: 'X' }] })),
        ),
      ),
    )
    expect(await session.analyze(CAPTURE)).toEqual({
      status: 'outcome',
      outcome: { kind: 'no_match' },
    })
  })

  it('a scanner failure is an error result, and acquisition is still untouched', async () => {
    const controller = controllerWith(() => Promise.reject(new Error('worker crashed')))
    const session = new PriceCheckScanSession(narrowScannerPort(controller))
    expect((await session.analyze(CAPTURE)).status).toBe('error')
    expect(controller.commitBatch).not.toHaveBeenCalled()
  })

  it('repeated scan: the older result is never delivered once a newer scan started', async () => {
    const first = deferred<ScannerAnalysis>()
    const second = deferred<ScannerAnalysis>()
    const calls = [first, second]
    const port: PriceCheckScannerPort = {
      analyzeCapture: () => calls.shift()?.promise ?? Promise.reject(new Error('unexpected call')),
      dispose: vi.fn(),
    }
    const session = new PriceCheckScanSession(port)
    const p1 = session.analyze(CAPTURE)
    const p2 = session.analyze(CAPTURE)
    // The scanner answers the OLD scan last — it must be discarded.
    second.resolve(analysis({ candidates: [{ candidateId: CARD_B, name: 'New' }] }))
    first.resolve(analysis({ candidates: [{ candidateId: CARD_A, name: 'Old' }] }))
    expect(await p1).toEqual({ status: 'abandoned' })
    const r2 = await p2
    expect(r2.status === 'outcome' && r2.outcome.kind === 'high' && r2.outcome.preselectedId).toBe(
      CARD_B,
    )
  })

  it('the superseded scan is aborted through its signal', () => {
    const signals: AbortSignal[] = []
    const port: PriceCheckScannerPort = {
      analyzeCapture: (_c, signal) => {
        if (signal) signals.push(signal)
        return new Promise(() => undefined)
      },
      dispose: vi.fn(),
    }
    const session = new PriceCheckScanSession(port)
    void session.analyze(CAPTURE)
    void session.analyze(CAPTURE)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })

  it('cancel abandons the in-flight scan (a late result is discarded)', async () => {
    const pending = deferred<ScannerAnalysis>()
    const session = new PriceCheckScanSession({
      analyzeCapture: () => pending.promise,
      dispose: vi.fn(),
    })
    const p = session.analyze(CAPTURE)
    session.cancel()
    pending.resolve(analysis())
    expect(await p).toEqual({ status: 'abandoned' })
  })

  it('a scanner error arriving after cancel is abandoned, not shown', async () => {
    const pending = deferred<ScannerAnalysis>()
    const session = new PriceCheckScanSession({
      analyzeCapture: () => pending.promise,
      dispose: vi.fn(),
    })
    const p = session.analyze(CAPTURE)
    session.cancel()
    pending.reject(new Error('aborted by scanner'))
    expect(await p).toEqual({ status: 'abandoned' })
  })

  it('navigating away (dispose) abandons the scan, releases the scanner once, idempotently', async () => {
    const pending = deferred<ScannerAnalysis>()
    const controller = controllerWith(() => pending.promise)
    const session = new PriceCheckScanSession(narrowScannerPort(controller))
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
