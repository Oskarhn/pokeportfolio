import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P199 (docs/FINANCIAL_MODEL.md section 4.3, D-060): a lot stores `unit_cost_basis = floor(C / q)`
 * and a `residual_nok_minor` so that `q * unit + residual = C` exactly. The residual rides on the lot
 * until the disposal that exhausts it. The historical snapshot's cost basis (`portfolio_snapshots.
 * cost_basis_nok_minor`, shown on Home as the cost of inventory and subtracted in the unrealized
 * result) summed `qty_open * unit` and dropped the residual, so every open multi-unit lot with an
 * inexact division was understated by its residual.
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient
const today = new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p199-dcb')
  client = await signInAs(user)
})
afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

async function snapshotToday(): Promise<{ cost: bigint; cs: bigint; open: number }> {
  const rb = await service.rpc('rebuild_portfolio_snapshots', {
    p_user_id: user.id,
    p_from: today,
    p_through: today,
  })
  if (rb.error) throw new Error(rb.error.message)
  const { data, error } = await service
    .from('portfolio_snapshots')
    .select('cost_basis_nok_minor, collectible_spend_to_date_nok_minor, open_lot_count')
    .eq('user_id', user.id)
    .eq('snapshot_date', today)
    .single<{
      cost_basis_nok_minor: number
      collectible_spend_to_date_nok_minor: number
      open_lot_count: number
    }>()
  if (error) throw new Error(error.message)
  return {
    cost: BigInt(data.cost_basis_nok_minor),
    cs: BigInt(data.collectible_spend_to_date_nok_minor),
    open: data.open_lot_count,
  }
}

describe('P199 snapshot cost basis keeps the lot residual', () => {
  let lotId = ''

  it('a 3-unit line with an indivisible shipping share: DCB equals the full attributable cost', async () => {
    // 3 x 333 + 1 shipping = 1000; unit basis 333, residual 1.
    const purchase = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: 1,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 3,
          unit_price_minor: 333,
        },
      ],
    })
    expect(purchase.error).toBeNull()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id, unit_cost_basis_nok_minor, residual_nok_minor')
      .eq('user_id', user.id)
      .single<{ id: string; unit_cost_basis_nok_minor: number; residual_nok_minor: number }>()
    expect(lot).toMatchObject({ unit_cost_basis_nok_minor: 333, residual_nok_minor: 1 })
    lotId = lot!.id

    const snap = await snapshotToday()
    expect(snap.cs).toBe(1000n)
    expect(snap.cost).toBe(1000n) // was 999n: the residual was dropped
  })

  it('after a partial sale the remaining units still carry the residual', async () => {
    const sale = await client.rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: 500 }],
    })
    expect(sale.error).toBeNull()
    // sold unit froze 333; two units remain: 2 * 333 + residual 1 = 667; 333 + 667 = 1000.
    const snap = await snapshotToday()
    expect(snap.cost).toBe(667n)
  })

  it('the disposal that exhausts the lot takes the residual with it: nothing is left on the books', async () => {
    const sale = await client.rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotId, quantity: 2, unit_gross_minor: 500 }],
    })
    expect(sale.error).toBeNull()
    const snap = await snapshotToday()
    expect(snap.open).toBe(0)
    expect(snap.cost).toBe(0n)
    // conservation: everything bought was either sold with a frozen basis or is still on the lot
    const { data: lines } = await service
      .from('sale_lines')
      .select('cost_basis_at_sale_nok_minor')
      .eq('user_id', user.id)
    const frozen = (lines ?? []).reduce((s, l) => s + BigInt(l.cost_basis_at_sale_nok_minor), 0n)
    expect(frozen).toBe(snap.cs)
  })
})

describe('P199 known limitation: the residual can be carried twice after an out-of-order void', () => {
  // KNOWN DEFECT, deliberately pinned and NOT fixed in this change (docs/DECISIONS.md D-199, "Known
  // limitation"). D-060 hands a lot's residual to the disposal that exhausts it, frozen at creation. If
  // an EARLIER sale is then voided, quantity returns to the lot while the later, exhausting sale stays
  // live and keeps the residual it already carries - so the same minor unit is on the lot and on the sale.
  // The error is bounded by the residual (< the lot's quantity in minor units). `it.fails` keeps CI green
  // while the defect exists and turns red the day it is fixed, which is the signal to delete this pin.
  it.fails(
    'voiding an earlier sale while the exhausting sale stays live conserves cost',
    async () => {
      const u = await createSyntheticUser(service, 'p199-dcb-void')
      const c = await signInAs(u)
      try {
        // 5 x 100 + 1 shipping = 501: unit 100, residual 1.
        const purchase = await c.rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_shipping_minor: 1,
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: seedCatalog.pikachuVariantId,
              condition: 'NM',
              quantity: 5,
              unit_price_minor: 100,
            },
          ],
        })
        expect(purchase.error).toBeNull()
        const { data: lot } = await service
          .from('acquisition_lots')
          .select('id')
          .eq('user_id', u.id)
          .single<{ id: string }>()
        const sell = async (quantity: number) => {
          const r = await c
            .rpc('create_sale', {
              p_idempotency_key: crypto.randomUUID(),
              p_sold_on: today,
              p_currency: 'NOK',
              p_lines: [{ lot_id: lot!.id, quantity, unit_gross_minor: 500 }],
            })
            .single<{ id: string }>()
          expect(r.error).toBeNull()
          return r.data!.id
        }
        const first = await sell(4) // not exhausting: freezes 4 x 100
        await sell(1) // exhausting: freezes 100 + residual 1
        expect((await c.rpc('void_sale', { p_sale_id: first, p_reason: 'p199' })).error).toBeNull()

        // 4 units are back on the lot; the live exhausting sale already holds the residual (101).
        const rb = await service.rpc('rebuild_portfolio_snapshots', {
          p_user_id: u.id,
          p_from: today,
          p_through: today,
        })
        expect(rb.error).toBeNull()
        const { data: snap } = await service
          .from('portfolio_snapshots')
          .select('cost_basis_nok_minor')
          .eq('user_id', u.id)
          .eq('snapshot_date', today)
          .single<{ cost_basis_nok_minor: number }>()
        expect(BigInt(snap!.cost_basis_nok_minor)).toBe(400n) // total 501 - frozen 101; the snapshot says 401
      } finally {
        await deleteSyntheticUser(service, u.id)
      }
    },
  )
})
