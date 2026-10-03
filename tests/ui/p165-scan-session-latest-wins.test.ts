import { describe, expect, it, vi } from 'vitest'

// scanner-identification.ts (imported for its types and `ReadOnlyScannerPort`) reaches the real
// controller; this file builds the session with its own port and identify function.
vi.mock('../../src/features/scanner/controller', () => ({ getScannerUiController: vi.fn() }))

import { PriceCheckScanSession, type ScanResult } from '../../src/features/price-check/scan-session'
import type { ScannerCapture } from '../../src/features/scanner/contract'
import type {
  ReadOnlyScannerPort,
  ScannerIdentification,
} from '../../src/features/scanner/scanner-identification'

/**
 * P165 — "no previously cancelled scan result ever surfaces after a newer scan", as an invariant over
 * many orders instead of the two orders a person would think of.
 *
 * The session is the real one; only the identification is a deferred promise this test settles, in a
 * random order, after a random number of restarts and cancels. What the person sees is the result of
 * `analyze()` that the page awaits: the expected outcome is computed from the sequence alone —
 * only the most recently STARTED analysis may deliver, and only if nothing cancelled or disposed the
 * session after it started. Everything earlier must come back `abandoned`, whenever it finishes.
 */

const CARD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function identification(cardId: string): ScannerIdentification {
  return {
    status: 'needs-confirmation',
    confidence: 'MEDIUM',
    candidates: [
      {
        catalogCardId: cardId,
        name: 'Pikachu',
        setName: 'Base Set',
        collectorNumber: '058',
        imageBaseUrl: null,
        languageLabel: 'English',
      },
    ],
    best: {
      catalogCardId: cardId,
      name: 'Pikachu',
      setName: 'Base Set',
      collectorNumber: '058',
      imageBaseUrl: null,
      languageLabel: 'English',
    },
    requiresManualConfirmation: true,
    variantEvidence: { identified: false, reason: 'card-level-recognition-only' },
    error: null,
  }
}

const capture = (): ScannerCapture => ({
  blob: new Blob(['x'], { type: 'image/jpeg' }),
  width: 500,
  height: 700,
  cardRect: { left: 0, top: 0, width: 500, height: 700 },
})

interface Deferred {
  resolve(): void
  reject(): void
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** What the real `identifyCapture` returns when the scanner fails: it never throws. */
function failedIdentification(): ScannerIdentification {
  return {
    status: 'error',
    confidence: 'NO_MATCH',
    candidates: [],
    best: null,
    requiresManualConfirmation: true,
    variantEvidence: { identified: false, reason: 'card-level-recognition-only' },
    error: { code: 'unknown', message: 'The card could not be analysed just now.' },
  }
}

function newSession() {
  const deferreds: Deferred[] = []
  const identify = vi.fn(
    () =>
      new Promise<ScannerIdentification>((resolve) => {
        deferreds.push({
          resolve: () => {
            resolve(identification(CARD_A))
          },
          reject: () => {
            resolve(failedIdentification())
          },
        })
      }),
  )
  const port: ReadOnlyScannerPort = {
    analyzeCapture: vi.fn(),
    searchFallback: vi.fn(),
    listVariantChoices: vi.fn(),
    prewarm: vi.fn(),
    dispose: vi.fn(),
  }
  return { session: new PriceCheckScanSession(port, identify), deferreds, port }
}

describe('a newer scan wins, whatever order the older ones finish in (P165)', () => {
  it('two scans, both finishing orders: only the newer one delivers', async () => {
    for (const olderFirst of [true, false]) {
      const { session, deferreds } = newSession()
      const older = session.analyze(capture())
      const newer = session.analyze(capture())
      expect(deferreds).toHaveLength(2)
      if (olderFirst) {
        deferreds[0]?.resolve()
        deferreds[1]?.resolve()
      } else {
        deferreds[1]?.resolve()
        deferreds[0]?.resolve()
      }
      expect((await older).status).toBe('abandoned')
      expect((await newer).status).toBe('outcome')
    }
  })

  it('a scan cancelled by Retake never delivers, even when it is the only one', async () => {
    const { session, deferreds } = newSession()
    const scan = session.analyze(capture())
    session.cancel()
    deferreds[0]?.resolve()
    expect((await scan).status).toBe('abandoned')
  })

  it('a failure of an abandoned scan is not reported either', async () => {
    const { session, deferreds } = newSession()
    const older = session.analyze(capture())
    const newer = session.analyze(capture())
    deferreds[0]?.reject()
    deferreds[1]?.resolve()
    expect((await older).status).toBe('abandoned')
    expect((await newer).status).toBe('outcome')
  })

  it('400 random sequences of starts, cancels, disposal and settling orders', async () => {
    const random = mulberry32(0x165a11ce)
    for (let round = 0; round < 400; round += 1) {
      const { session, deferreds } = newSession()
      const results: Promise<ScanResult>[] = []
      /** The expected verdict of each started scan, computed from the sequence alone. */
      const mayDeliver: boolean[] = []
      let disposed = false

      const steps = 2 + Math.floor(random() * 6)
      for (let step = 0; step < steps; step += 1) {
        const roll = random()
        if (roll < 0.6 || results.length === 0) {
          if (disposed) continue
          results.push(session.analyze(capture()))
          // starting a scan abandons every earlier one
          for (let i = 0; i < mayDeliver.length; i += 1) mayDeliver[i] = false
          mayDeliver.push(true)
        } else if (roll < 0.85) {
          session.cancel() // Retake / Cancel: whatever is in flight is abandoned
          for (let i = 0; i < mayDeliver.length; i += 1) mayDeliver[i] = false
        } else {
          session.dispose() // leaving the screen
          disposed = true
          for (let i = 0; i < mayDeliver.length; i += 1) mayDeliver[i] = false
        }
      }

      // Settle every identification in a random order, some by failing.
      const order = deferreds.map((_, index) => index)
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1))
        ;[order[i], order[j]] = [order[j] as number, order[i] as number]
      }
      for (const index of order) {
        if (random() < 0.2) deferreds[index]?.reject()
        else deferreds[index]?.resolve()
      }

      const settled = await Promise.all(results)
      settled.forEach((result, index) => {
        if (!mayDeliver[index]) {
          expect(
            result.status,
            `round ${String(round)} scan ${String(index)} must be abandoned`,
          ).toBe('abandoned')
        }
      })
      // ...and nothing may deliver twice or after disposal: at most one 'outcome' per round.
      expect(settled.filter((r) => r.status === 'outcome').length).toBeLessThanOrEqual(1)
      if (disposed) expect(settled.every((r) => r.status === 'abandoned')).toBe(true)
    }
  })

  it('after dispose the session refuses to start a new scan at all', async () => {
    const { session, deferreds } = newSession()
    session.dispose()
    expect((await session.analyze(capture())).status).toBe('abandoned')
    expect(deferreds).toHaveLength(0)
  })
})
