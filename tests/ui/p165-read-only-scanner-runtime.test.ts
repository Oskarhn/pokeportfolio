import { describe, expect, it, vi } from 'vitest'

// scanner-identification.ts imports the real controller (and through it the app's Supabase client);
// this file only ever builds ports from controllers it creates itself.
vi.mock('../../src/features/scanner/controller', () => ({ getScannerUiController: vi.fn() }))

import type {
  ScannerAnalysis,
  ScannerCapture,
  ScannerUiController,
} from '../../src/features/scanner/contract'
import { PriceCheckScanSession } from '../../src/features/price-check/scan-session'
import {
  identifyCapture,
  toReadOnlyScannerPort,
} from '../../src/features/scanner/scanner-identification'

/**
 * P165 — independent runtime check of the read-only seam between the scanner and Price Check.
 *
 * P151's tests assert that a fake controller's `commitBatch` is not called. This looks at the seam
 * from the other side: a controller wrapped in a recorder that notes EVERY property a consumer reads
 * from it, driven through the real Price Check scan session, the way the page drives it. What the
 * port hands out, and what it ever asks the controller for, is fixed by the set below — anything
 * that could write (`commitBatch`), or expose debug state, is neither reachable nor even looked up.
 */

const ALLOWED_PORT_MEMBERS = [
  'analyzeCapture',
  'dispose',
  'listVariantChoices',
  'prewarm',
  'searchFallback',
]

const CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function capture(): ScannerCapture {
  return {
    blob: new Blob(['x'], { type: 'image/jpeg' }),
    width: 500,
    height: 700,
    cardRect: { left: 0, top: 0, width: 500, height: 700 },
  }
}

/** A controller that can do everything the scanner can, wrapped in a recorder of property reads. */
function recordedController() {
  const reads = new Set<string>()
  const commitBatch = vi.fn(() => Promise.resolve({ addedCount: 1, outcomes: [] }))
  const analyzeCapture = vi.fn(() =>
    Promise.resolve<ScannerAnalysis>({
      confidence: 'MEDIUM',
      candidates: [
        {
          candidateId: CARD,
          name: 'Fauxosaur EX',
          setName: 'Base Set',
          collectorNumber: '049',
          imageBaseUrl: null,
          languageLabel: 'English',
        },
      ],
    }),
  )
  const dispose = vi.fn()
  const target: ScannerUiController = {
    analyzeCapture,
    searchFallback: vi.fn(() => Promise.resolve([])),
    listVariantChoices: vi.fn(() => Promise.resolve([])),
    commitBatch,
    dispose,
    prewarm: vi.fn(),
    getLastDiagnostics: vi.fn(() => null),
    getLastDebugImages: vi.fn(() => null),
  }
  const controller = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string') reads.add(property)
      return Reflect.get(object, property, receiver) as unknown
    },
  })
  return { controller, reads, commitBatch, analyzeCapture, dispose }
}

describe('the read-only scanner port at runtime (P165)', () => {
  it('hands out exactly the five recognition and lifecycle members, however it is inspected', () => {
    const { controller } = recordedController()
    const port = toReadOnlyScannerPort(controller)

    expect(Object.keys(port).sort()).toEqual(ALLOWED_PORT_MEMBERS)
    expect(Reflect.ownKeys(port).sort()).toEqual(ALLOWED_PORT_MEMBERS)
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(port) as object)).toEqual(
      Object.getOwnPropertyNames(Object.prototype),
    )
    expect('commitBatch' in port).toBe(false)
    expect((port as unknown as Record<string, unknown>)['commitBatch']).toBeUndefined()
    expect(({ ...port } as Record<string, unknown>)['commitBatch']).toBeUndefined()
    expect(Object.assign({}, port)).not.toHaveProperty('commitBatch')
    // A cast cannot conjure it either: there is no such member to reach.
    const escaped = port as unknown as { commitBatch?: () => unknown }
    expect(() => escaped.commitBatch?.()).not.toThrow()
  })

  it('a whole Price Check scan — analyse, list printings, retake, dispose — never touches the write path', async () => {
    const { controller, reads, commitBatch } = recordedController()
    const port = toReadOnlyScannerPort(controller)
    const session = new PriceCheckScanSession(port, identifyCapture)
    port.prewarm()

    const first = await session.analyze(capture())
    expect(first.status).toBe('outcome')
    await port.listVariantChoices(CARD)
    await port.searchFallback({ name: 'Fauxosaur', number: '049' } as never)
    // a retake and a second photo, then leaving the screen
    session.cancel()
    await session.analyze(capture())
    session.dispose()

    expect(commitBatch).not.toHaveBeenCalled()
    // ...and the controller was never even asked for it, nor for its debug surface.
    expect([...reads].filter((name) => /commit|debug|diagnostic|images/i.test(name))).toEqual([])
    expect([...reads].sort()).toEqual(ALLOWED_PORT_MEMBERS)
  })

  it('every port call is forwarded to the controller it was built from, and to no other', async () => {
    const one = recordedController()
    const other = recordedController()
    const port = toReadOnlyScannerPort(one.controller)
    await port.analyzeCapture(capture())
    port.dispose()
    expect(one.analyzeCapture).toHaveBeenCalledTimes(1)
    expect(one.dispose).toHaveBeenCalledTimes(1)
    expect(other.analyzeCapture).not.toHaveBeenCalled()
    expect(other.dispose).not.toHaveBeenCalled()
  })
})
