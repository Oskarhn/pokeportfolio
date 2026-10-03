import {
  fxWriteIsSubmittable,
  loadFxForWrite,
  nokReferenceForWrite,
} from '../../src/write/fx-for-write'
import type { FxRateReader } from '../../src/features/price-check/fx-source'

const NOW = Date.parse('2026-09-28T12:00:00.000Z')

function readerReturning(data: { rate: unknown; rate_date: unknown } | null): FxRateReader {
  return () => Promise.resolve({ data, error: null })
}

function readerThatThrows(): FxRateReader {
  return () => Promise.resolve({ data: null, error: { message: 'boom' } })
}

/**
 * P180 primary task: the pure resolution the purchase/sale screens run before they will let a
 * non-NOK write reach `create_purchase`/`create_sale` (which requires FX metadata — P133). Every
 * one of the mission's FX FAILURE STATES is asserted as its own distinguishable outcome.
 */
describe('loadFxForWrite', () => {
  it('NOK never touches the network and is immediately submittable', async () => {
    let called = false
    const state = await loadFxForWrite(
      'NOK',
      () => {
        called = true
        return Promise.resolve({ data: null, error: null })
      },
      NOW,
    )
    expect(state).toEqual({ kind: 'not_needed' })
    expect(fxWriteIsSubmittable(state)).toBe(true)
    expect(called).toBe(false)
  })

  it('a fresh rate resolves ready, submittable, not stale', async () => {
    const state = await loadFxForWrite(
      'EUR',
      readerReturning({ rate: '11.50000000', rate_date: '2026-09-27' }),
      NOW,
    )
    expect(state).toEqual({
      kind: 'ready',
      rateToNok: '11.50000000',
      rateDate: '2026-09-27',
      source: 'norges_bank',
      stale: false,
    })
    expect(fxWriteIsSubmittable(state)).toBe(true)
  })

  it('a rate older than 7 days is still ready and submittable, but flagged stale', async () => {
    const state = await loadFxForWrite(
      'USD',
      readerReturning({ rate: '10.00000000', rate_date: '2026-09-01' }),
      NOW,
    )
    expect(state.kind).toBe('ready')
    if (state.kind === 'ready') expect(state.stale).toBe(true)
    expect(fxWriteIsSubmittable(state)).toBe(true)
  })

  it('no rate row at all resolves missing, and is NOT submittable — fail closed', async () => {
    const state = await loadFxForWrite('JPY', readerReturning(null), NOW)
    expect(state).toEqual({ kind: 'missing' })
    expect(fxWriteIsSubmittable(state)).toBe(false)
  })

  it('a malformed stored rate resolves malformed, never a fabricated number', async () => {
    const state = await loadFxForWrite(
      'GBP',
      readerReturning({ rate: 'not-a-number', rate_date: '2026-09-27' }),
      NOW,
    )
    expect(state).toEqual({ kind: 'malformed' })
    expect(fxWriteIsSubmittable(state)).toBe(false)
  })

  it('a read failure (including offline) resolves read_failed, distinct from missing', async () => {
    const state = await loadFxForWrite('EUR', readerThatThrows(), NOW)
    expect(state).toEqual({ kind: 'read_failed' })
    expect(fxWriteIsSubmittable(state)).toBe(false)
  })

  it('a rejecting reader (thrown, not just an error field) also resolves read_failed', async () => {
    const state = await loadFxForWrite(
      'EUR',
      () => Promise.reject(new Error('network request failed')),
      NOW,
    )
    expect(state).toEqual({ kind: 'read_failed' })
  })
})

describe('nokReferenceForWrite', () => {
  it('is null when there is no ready rate — never a guessed reference', () => {
    expect(
      nokReferenceForWrite({ minorUnits: 1000n, currency: 'EUR' }, { kind: 'missing' }),
    ).toBeNull()
    expect(
      nokReferenceForWrite({ minorUnits: 1000n, currency: 'EUR' }, { kind: 'loading' }),
    ).toBeNull()
  })

  it('converts exactly, exponent-aware, using the SAME rate the write will send', () => {
    const ref = nokReferenceForWrite(
      { minorUnits: 2500n, currency: 'JPY' }, // JPY exponent 0: 2500 minor units = 2500 JPY
      {
        kind: 'ready',
        rateToNok: '0.06',
        rateDate: '2026-09-27',
        source: 'norges_bank',
        stale: false,
      },
    )
    expect(ref).not.toBeNull()
    expect(ref?.currency).toBe('NOK')
    // 2500 JPY * 0.06 NOK/JPY = 150.00 NOK = 15000 minor units at NOK's exponent 2.
    expect(ref?.minorUnits).toBe(15000n)
  })
})
