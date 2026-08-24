import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reduceHoldingQuantity } from '../../src/data/collection'

/**
 * Pins reduceHoldingQuantity's wire contract (P28 CI repair): `p_lot_reductions` is a jsonb
 * parameter and must arrive at PostgREST as an actual JSON array of
 * {lot_id, remove_quantity} objects. The first P28 CI run failed 8 db tests because the wrapper
 * sent JSON.stringify(reductions) — a jsonb STRING scalar, rejected by the function's own array
 * guard. This suite fails if that regression ever returns, independently of any database.
 */

const harness = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
}))

vi.mock('../../src/data/supabase-client', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      harness.calls.push({ name, args })
      return Promise.resolve({ data: [{ owned_quantity: 2 }], error: null })
    },
  },
}))

const HOLDING_ID = '0b8f3d1e-1111-4111-8111-000000000001'
const LOT_A = '0b8f3d1e-2222-4222-8222-00000000000a'
const LOT_B = '0b8f3d1e-2222-4222-8222-00000000000b'

describe('reduceHoldingQuantity wire contract', () => {
  beforeEach(() => {
    harness.calls.length = 0
  })

  it('sends p_lot_reductions as a JSON array — never a JSON.stringify’d string', async () => {
    const owned = await reduceHoldingQuantity({
      holdingId: HOLDING_ID,
      reductions: [
        { lotId: LOT_A, removeQuantity: 1 },
        { lotId: LOT_B, removeQuantity: 2 },
      ],
    })

    expect(owned).toBe(2)
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]!.name).toBe('reduce_holding_quantity')
    expect(harness.calls[0]!.args.p_holding_id).toBe(HOLDING_ID)

    const payload = harness.calls[0]!.args.p_lot_reductions
    expect(Array.isArray(payload)).toBe(true)
    expect(typeof payload).not.toBe('string')
    // The exact objects PostgREST receives — snake_case keys, integer quantities.
    expect(payload).toEqual([
      { lot_id: LOT_A, remove_quantity: 1 },
      { lot_id: LOT_B, remove_quantity: 2 },
    ])
  })

  it('maps every LotReduction field onto the wire shape with nothing extra', async () => {
    await reduceHoldingQuantity({
      holdingId: HOLDING_ID,
      reductions: [{ lotId: LOT_A, removeQuantity: 3 }],
    })

    const payload = harness.calls[0]!.args.p_lot_reductions as Record<string, unknown>[]
    expect(payload).toHaveLength(1)
    expect(Object.keys(payload[0]!).sort()).toEqual(['lot_id', 'remove_quantity'])
    expect(payload[0]!.lot_id).toBe(LOT_A)
    expect(payload[0]!.remove_quantity).toBe(3)
  })
})
