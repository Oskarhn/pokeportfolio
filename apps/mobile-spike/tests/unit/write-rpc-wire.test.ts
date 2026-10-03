import type { LeasedWriteDb } from '../../src/write/leased-write-client'
import {
  addCardAcquisition,
  clearManualValuation,
  setManualValuation,
} from '../../src/write/collection-writes'
import { createOpening } from '../../src/write/opening-writes'
import { createPurchase } from '../../src/write/purchase-writes'
import { createSale } from '../../src/write/sale-writes'

/**
 * Exact wire-shape proofs for the write seam's RPC callers, without Docker: a fake `LeasedWriteDb`
 * whose `.rpc()` records every call and answers a scripted `{ data, error }`, standing in for
 * postgrest-js's chainable `.select()/.single()/.overrideTypes()` builder. Mutations #1/#7/#10/#14
 * in output_175.txt target this file.
 */
interface RpcCall {
  name: string
  params: Record<string, unknown>
}

function fakeDb(response: { data: unknown; error: { message: string } | null }): {
  db: LeasedWriteDb
  calls: RpcCall[]
} {
  const calls: RpcCall[] = []
  const builder = {
    select: () => builder,
    single: () => builder,
    overrideTypes: () => builder,
    then: (
      onFulfilled: (value: typeof response) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(response).then(onFulfilled, onRejected),
  }
  const db = {
    rpc: (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      return builder
    },
  } as unknown as LeasedWriteDb
  return { db, calls }
}

describe('addCardAcquisition wire shape', () => {
  it('an UNKNOWN cost omits p_unit_cost_basis_minor entirely — never sends 0', async () => {
    const { db, calls } = fakeDb({ data: { holding_id: 'h1', lot_id: 'l1' }, error: null })
    await addCardAcquisition(
      {
        cardVariantId: 'v1',
        gradingState: 'raw',
        condition: 'NM',
        origin: 'other',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: '2026-01-01',
      },
      db,
    )
    expect(calls[0]?.name).toBe('add_card_acquisition')
    expect(calls[0]?.params.p_unit_cost_basis_minor).toBeUndefined()
    expect(calls[0]?.params.p_cost_basis_state).toBe('unknown')
  })

  it('a KNOWN cost sends the exact decimal string, never a JS number', async () => {
    const { db, calls } = fakeDb({ data: { holding_id: 'h1', lot_id: 'l1' }, error: null })
    await addCardAcquisition(
      {
        cardVariantId: 'v1',
        gradingState: 'raw',
        condition: 'NM',
        origin: 'other',
        costBasisState: 'known',
        unitCostBasisMinor: 9007199254740993n,
        quantity: 1,
        acquiredOn: '2026-01-01',
      },
      db,
    )
    expect(calls[0]?.params.p_unit_cost_basis_minor).toBe('9007199254740993')
  })
})

describe('manual valuation wire shape', () => {
  it('setManualValuation with an explicit 0n sends the string "0"', async () => {
    const { db, calls } = fakeDb({ data: [{ id: 'mv1' }], error: null })
    await setManualValuation({ holdingId: 'h1', valueMinor: 0n }, db)
    expect(calls[0]?.name).toBe('set_manual_valuation')
    expect(calls[0]?.params.p_value_minor).toBe('0')
  })

  it('clearManualValuation calls a DIFFERENT rpc — never set_manual_valuation with 0', async () => {
    const { db, calls } = fakeDb({ data: null, error: null })
    await clearManualValuation('h1', db)
    expect(calls[0]?.name).toBe('clear_manual_valuation')
    expect(calls.some((c) => c.name === 'set_manual_valuation')).toBe(false)
  })
})

describe('createPurchase wire shape', () => {
  it('serialises the line and charges as decimal strings, and an absent discount is omitted', async () => {
    const { db, calls } = fakeDb({
      data: {
        id: 'p1',
        purchased_on: '2026-01-01',
        currency: 'NOK',
        subtotal_minor: '100',
        shipping_minor: '0',
        customs_minor: '0',
        discount_minor: '0',
        total_minor: '100',
        total_nok_minor: '100',
        notes: null,
      },
      error: null,
    })
    await createPurchase(
      {
        purchasedOn: '2026-01-01',
        currency: 'NOK',
        lines: [
          {
            lineType: 'card',
            cardVariantId: 'v1',
            condition: 'NM',
            quantity: 1,
            unitPriceMinor: 100n,
          },
        ],
      },
      'key-1',
      db,
    )
    expect(calls[0]?.name).toBe('create_purchase')
    const lines = calls[0]?.params.p_lines as {
      unit_price_minor: string
      card_variant_id: string
    }[]
    expect(lines[0]?.unit_price_minor).toBe('100')
    expect(lines[0]?.card_variant_id).toBe('v1')
    expect(calls[0]?.params.p_shipping_minor).toBeUndefined()
    expect(calls[0]?.params.p_discount_minor).toBeUndefined()
    expect(calls[0]?.params.p_idempotency_key).toBe('key-1')
  })
})

describe('createSale wire shape', () => {
  it('each line keeps its OWN lotId — never swapped between lines', async () => {
    const { db, calls } = fakeDb({
      data: {
        id: 's1',
        sold_on: '2026-01-01',
        currency: 'NOK',
        gross_minor: '0',
        fees_minor: '0',
        shipping_cost_minor: '0',
        shipping_charged_minor: '0',
        net_proceeds_minor: '0',
        net_proceeds_nok_minor: '0',
        realized_result_nok_minor: null,
        proceeds_from_uncosted_nok_minor: '0',
        notes: null,
      },
      error: null,
    })
    await createSale(
      [
        { lotId: 'lot-A', quantity: 1, unitGrossMinor: 100n },
        { lotId: 'lot-B', quantity: 2, unitGrossMinor: 200n },
      ],
      { soldOn: '2026-01-01', currency: 'NOK' },
      'key-1',
      db,
    )
    const lines = calls[0]?.params.p_lines as { lot_id: string; unit_gross_minor: string }[]
    expect(lines[0]?.lot_id).toBe('lot-A')
    expect(lines[1]?.lot_id).toBe('lot-B')
    expect(lines[0]?.unit_gross_minor).toBe('100')
    expect(lines[1]?.unit_gross_minor).toBe('200')
  })

  it('a fee combination that makes net proceeds negative is sent as-is — never clamped or rejected client-side', async () => {
    const { db, calls } = fakeDb({
      data: {
        id: 's1',
        sold_on: '2026-01-01',
        currency: 'NOK',
        gross_minor: '100',
        fees_minor: '3000',
        shipping_cost_minor: '0',
        shipping_charged_minor: '0',
        net_proceeds_minor: '-2900',
        net_proceeds_nok_minor: '-2900',
        realized_result_nok_minor: null,
        proceeds_from_uncosted_nok_minor: '-2900',
        notes: null,
      },
      error: null,
    })
    const sale = await createSale(
      [{ lotId: 'lot-A', quantity: 1, unitGrossMinor: 100n }],
      { soldOn: '2026-01-01', currency: 'NOK', feesMinor: 3000n },
      'key-1',
      db,
    )
    expect(calls[0]?.params.p_fees_minor).toBe('3000') // the server decides, not the client
    expect(sale.netProceedsMinor).toBe(-2900n)
  })
})

describe('createOpening wire shape', () => {
  it('always sends tracking_completeness "unknown" and no pulls (P175 minimal scope)', async () => {
    const { db, calls } = fakeDb({
      data: {
        id: 'o1',
        opened_on: '2026-01-01',
        source_lot_id: 'lot-A',
        quantity_opened: 1,
        cost_nok_minor: null,
        bulk_remainder_estimate_nok_minor: null,
        notes: null,
      },
      error: null,
    })
    await createOpening({ sourceLotId: 'lot-A', quantity: 1, openedOn: '2026-01-01' }, db)
    expect(calls[0]?.name).toBe('create_opening')
    expect(calls[0]?.params.p_tracking_completeness).toBe('unknown')
    expect(calls[0]?.params.p_pulls).toBeUndefined()
  })
})
