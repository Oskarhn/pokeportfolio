import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ScannerAnalysis, ScannerUiController } from '../../src/features/scanner/contract'

/**
 * P151 — the read-only scanner result contract (what Price Check consumes). The properties that
 * matter are the negative ones: nothing reachable through this seam can write, cancellation is a
 * result not a throw, and the scanner never claims a printing.
 */

vi.mock('../../src/features/scanner/controller', () => ({
  getScannerUiController: vi.fn(),
}))

import { getScannerUiController } from '../../src/features/scanner/controller'
import {
  createReadOnlyScanner,
  identifyCapture,
  toReadOnlyScannerPort,
  toScannerIdentification,
  toScannerIdentificationError,
  type ReadOnlyScannerPort,
} from '../../src/features/scanner/scanner-identification'

function capture() {
  return {
    blob: new Blob(['x'], { type: 'image/jpeg' }),
    width: 500,
    height: 700,
    cardRect: { left: 0, top: 0, width: 500, height: 700 },
  }
}

const candidate = (id: string, name = 'Pikachu') => ({
  candidateId: id,
  name,
  setName: 'Base Set',
  collectorNumber: '058',
  imageBaseUrl: 'https://img.test/x',
  languageLabel: 'English',
})

function fakeController(overrides: Partial<ScannerUiController> = {}) {
  const commitBatch = vi.fn()
  const controller: ScannerUiController = {
    analyzeCapture: vi.fn(() =>
      Promise.resolve<ScannerAnalysis>({ confidence: 'NO_MATCH', candidates: [] }),
    ),
    searchFallback: vi.fn(() => Promise.resolve([])),
    listVariantChoices: vi.fn(() => Promise.resolve([])),
    commitBatch,
    dispose: vi.fn(),
    prewarm: vi.fn(),
    getLastDiagnostics: vi.fn(() => null),
    getLastDebugImages: vi.fn(() => null),
    ...overrides,
  }
  return { controller, commitBatch }
}

describe('P151 — analysis → read-only identification mapping', () => {
  it('HIGH is "identified" and the ONLY status that does not require manual confirmation', () => {
    const analysis: ScannerAnalysis = {
      confidence: 'HIGH',
      candidates: [candidate('c1'), candidate('c2')],
    }
    const result = toScannerIdentification(analysis)
    expect(result.status).toBe('identified')
    expect(result.confidence).toBe('HIGH')
    expect(result.requiresManualConfirmation).toBe(false)
    expect(result.best?.catalogCardId).toBe('c1')
    expect(result.candidates.map((c) => c.catalogCardId)).toEqual(['c1', 'c2'])
    expect(result.best).toEqual({
      catalogCardId: 'c1',
      name: 'Pikachu',
      setName: 'Base Set',
      collectorNumber: '058',
      imageBaseUrl: 'https://img.test/x',
      languageLabel: 'English',
    })
  })

  it('MEDIUM and LOW need confirmation; NO_MATCH and an empty list are "no-match" with no fabricated candidate', () => {
    for (const confidence of ['MEDIUM', 'LOW'] as const) {
      const result = toScannerIdentification({ confidence, candidates: [candidate('c1')] })
      expect(result.status).toBe('needs-confirmation')
      expect(result.requiresManualConfirmation).toBe(true)
    }
    for (const analysis of [
      { confidence: 'NO_MATCH', candidates: [] },
      { confidence: 'HIGH', candidates: [] }, // a HIGH with nothing to show can never be "identified"
    ] as ScannerAnalysis[]) {
      const result = toScannerIdentification(analysis)
      expect(result.status).toBe('no-match')
      expect(result.best).toBeNull()
      expect(result.candidates).toEqual([])
      expect(result.requiresManualConfirmation).toBe(true)
    }
  })

  it('NEVER claims a printing: variant evidence is explicitly "not identified" for every outcome', () => {
    const outcomes = [
      toScannerIdentification({ confidence: 'HIGH', candidates: [candidate('c1')] }),
      toScannerIdentification({ confidence: 'MEDIUM', candidates: [candidate('c1')] }),
      toScannerIdentification({ confidence: 'NO_MATCH', candidates: [] }),
      toScannerIdentificationError(new Error('boom')),
    ]
    for (const outcome of outcomes) {
      expect(outcome.variantEvidence).toEqual({
        identified: false,
        reason: 'card-level-recognition-only',
      })
    }
  })

  it('maps scanner error classes to stable codes with sanitised messages (no internals leak)', () => {
    const named = (name: string) => Object.assign(new Error('secret internal detail'), { name })
    const cases: [unknown, string][] = [
      [named('ScannerAnalysisAbortedError'), 'aborted'],
      [named('ScannerEngineDisposedError'), 'aborted'],
      [named('ScannerCatalogUnavailableError'), 'catalog-unavailable'],
      [named('ScannerEngineError'), 'engine-unavailable'],
      [new Error('anything else'), 'unknown'],
      ['a thrown string', 'unknown'],
    ]
    for (const [thrown, code] of cases) {
      const result = toScannerIdentificationError(thrown)
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe(code)
      expect(result.error?.message).not.toContain('secret internal detail')
      expect(result.requiresManualConfirmation).toBe(true)
      expect(result.candidates).toEqual([])
    }
  })
})

describe('P151 — nothing reachable through the read-only seam can write', () => {
  it('the port has exactly the read-only members; commitBatch does not exist at runtime, even via a cast', () => {
    const { controller, commitBatch } = fakeController()
    const port = toReadOnlyScannerPort(controller)
    expect(Object.keys(port).sort()).toEqual(
      ['analyzeCapture', 'dispose', 'listVariantChoices', 'prewarm', 'searchFallback'].sort(),
    )
    expect((port as unknown as Record<string, unknown>).commitBatch).toBeUndefined()
    // @ts-expect-error — commitBatch is not a member of ReadOnlyScannerPort
    expect(typeof port.commitBatch).toBe('undefined')
    expect(commitBatch).not.toHaveBeenCalled()
  })

  it('a full identify → search → printings → dispose session never touches commitBatch', async () => {
    const disposeSpy = vi.fn()
    const { controller, commitBatch } = fakeController({
      analyzeCapture: vi.fn(() =>
        Promise.resolve<ScannerAnalysis>({ confidence: 'HIGH', candidates: [candidate('c1')] }),
      ),
      dispose: disposeSpy,
    })
    vi.mocked(getScannerUiController).mockReturnValue(controller)
    const port = createReadOnlyScanner('user-1')
    port.prewarm()
    const result = await identifyCapture(port, capture())
    expect(result.status).toBe('identified')
    await port.searchFallback({ name: 'Pikachu' })
    await port.listVariantChoices('c1')
    port.dispose()
    expect(commitBatch).not.toHaveBeenCalled()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('the module has no import path to the collection writer', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/features/scanner/scanner-identification.ts'),
      'utf-8',
    )
    const imports = source
      .split('\n')
      .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line))
    for (const line of imports) {
      expect(line).not.toMatch(/collection|acquisition|purchase|sale|ledger/i)
    }
  })
})

describe('P151 — identifyCapture never throws and forwards cancellation', () => {
  it('turns a rejection into an error result', async () => {
    const port: ReadOnlyScannerPort = {
      ...toReadOnlyScannerPort(fakeController().controller),
      analyzeCapture: () => Promise.reject(new Error('engine exploded')),
    }
    const result = await identifyCapture(port, capture())
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('unknown')
  })

  it('forwards the AbortSignal to the scanner and reports an abort as a result', async () => {
    const abort = new AbortController()
    let received: AbortSignal | undefined
    const port: ReadOnlyScannerPort = {
      ...toReadOnlyScannerPort(fakeController().controller),
      analyzeCapture: (_capture, signal) => {
        received = signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('x'), { name: 'ScannerAnalysisAbortedError' }))
          })
        })
      },
    }
    const pending = identifyCapture(port, capture(), abort.signal)
    abort.abort()
    const result = await pending
    expect(received).toBe(abort.signal)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('aborted')
  })
})
