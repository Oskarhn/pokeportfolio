import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { previewPurchase } from '../../src/domain/allocation'
import { previewSale } from '../../src/domain/sales'
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
 * P209 (F): the forms' live previews are pure domain functions (previewSale, previewPurchase). This
 * suite proves they are the arithmetic the database freezes: for seeded random inputs the preview's
 * figures equal the rows create_purchase / create_sale wrote. A component that formats the preview
 * therefore shows what will be stored, and cannot drift from it without this test failing.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let service: TestClient
let user: SyntheticUser
let client: TestClient
const today = new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p209-parity')
  client = await signInAs(user)
})
afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

describe('previewPurchase equals what create_purchase stores', () => {
  for (const seed of Array.from({ length: 12 }, (_, i) => 3000 + i)) {
    it(`seed ${String(seed)}`, async () => {
      const rng = mulberry32(seed)
      const ri = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
      const n = ri(1, 3)
      // distinct unit prices identify the stored lines (they carry no ordinal)
      const lines = Array.from({ length: n }, (_, i) => ({
        quantity: ri(1, 6),
        unitPriceMinor: BigInt(ri(1, 90_000) + i * 100_000),
      }))
      const subtotal = lines.reduce((s, l) => s + Number(l.unitPriceMinor) * l.quantity, 0)
      const shipping = rng() < 0.7 ? ri(0, 4000) : 0
      const customs = rng() < 0.3 ? ri(0, 2000) : 0
      const discount = rng() < 0.4 ? ri(0, Math.min(subtotal, 6000)) : 0
      const preview = previewPurchase({
        lines,
        shippingMinor: BigInt(shipping),
        customsMinor: BigInt(customs),
        discountMinor: BigInt(discount),
      })
      const r = await client
        .rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_shipping_minor: shipping,
          p_customs_minor: customs,
          p_discount_minor: discount,
          p_lines: lines.map((l) => ({
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: l.quantity,
            unit_price_minor: Number(l.unitPriceMinor),
          })),
        })
        .single<{ id: string; total_minor: number }>()
      expect(r.error).toBeNull()
      expect(BigInt(r.data!.total_minor)).toBe(preview.totalMinor)
      const stored = await service
        .from('purchase_lines')
        .select('unit_price_minor, attributable_cost_minor')
        .eq('purchase_id', r.data!.id)
      const byUnit = new Map(
        (stored.data as { unit_price_minor: number; attributable_cost_minor: number }[]).map(
          (x) => [BigInt(x.unit_price_minor), BigInt(x.attributable_cost_minor)],
        ),
      )
      const got = lines.map((l) => byUnit.get(l.unitPriceMinor))
      expect(got).toEqual(preview.attributable)
      expect(got.reduce((a, b) => a! + b!, 0n)).toBe(preview.totalMinor)
    })
  }
})

describe('previewSale equals what create_sale stores', () => {
  for (const seed of Array.from({ length: 12 }, (_, i) => 4000 + i)) {
    it(`seed ${String(seed)}`, async () => {
      const u = await createSyntheticUser(service, `p209-parity-sale-${String(seed)}`)
      const c = await signInAs(u)
      try {
        const rng = mulberry32(seed)
        const ri = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
        const variants = [seedCatalog.pikachuVariantId, seedCatalog.charizardVariantId]
        const n = ri(1, 2)
        const lots: { id: string; quantity: number }[] = []
        for (let i = 0; i < n; i += 1) {
          const quantity = ri(2, 5)
          const p = await c
            .rpc('create_purchase', {
              p_purchased_on: today,
              p_currency: 'NOK',
              p_lines: [
                {
                  line_type: 'card',
                  card_variant_id: variants[i],
                  condition: 'NM',
                  quantity,
                  unit_price_minor: 1000,
                },
              ],
            })
            .single<{ id: string }>()
          expect(p.error).toBeNull()
          const pl = await service
            .from('purchase_lines')
            .select('id')
            .eq('purchase_id', p.data!.id)
            .single<{ id: string }>()
          const lot = await service
            .from('acquisition_lots')
            .select('id')
            .eq('purchase_line_id', pl.data!.id)
            .single<{ id: string }>()
          lots.push({ id: lot.data!.id, quantity })
        }
        const soldLines = lots.map((l) => ({
          lotId: l.id,
          quantity: ri(1, l.quantity),
          unitGrossMinor: BigInt(ri(0, 70_000)),
        }))
        const fees = rng() < 0.7 ? ri(0, 4000) : 0
        const ship = rng() < 0.5 ? ri(0, 2500) : 0
        const charged = rng() < 0.4 ? ri(0, 2500) : 0
        const preview = previewSale({
          lines: soldLines.map((l) => ({ unitGrossMinor: l.unitGrossMinor, quantity: l.quantity })),
          feesMinor: BigInt(fees),
          shippingCostMinor: BigInt(ship),
          shippingChargedMinor: BigInt(charged),
        })
        const sale = await c
          .rpc('create_sale', {
            p_idempotency_key: crypto.randomUUID(),
            p_sold_on: today,
            p_currency: 'NOK',
            p_fees_minor: fees,
            p_shipping_cost_minor: ship,
            p_shipping_charged_minor: charged,
            p_lines: soldLines.map((l) => ({
              lot_id: l.lotId,
              quantity: l.quantity,
              unit_gross_minor: Number(l.unitGrossMinor),
            })),
          })
          .single<{ id: string; gross_minor: number; net_proceeds_minor: number }>()
        expect(sale.error).toBeNull()
        expect(BigInt(sale.data!.gross_minor)).toBe(preview.grossMinor)
        expect(BigInt(sale.data!.net_proceeds_minor)).toBe(preview.netMinor)
        // sale_lines come back in the order the lines were sent (one per distinct lot)
        const stored = await service
          .from('sale_lines')
          .select('lot_id, net_proceeds_minor')
          .eq('sale_id', sale.data!.id)
        const byLot = new Map(
          (stored.data as { lot_id: string; net_proceeds_minor: number }[]).map((x) => [
            x.lot_id,
            BigInt(x.net_proceeds_minor),
          ]),
        )
        soldLines.forEach((l, i) => {
          expect(byLot.get(l.lotId)).toBe(preview.lineNet[i])
        })
        expect(preview.lineNet.reduce((a, b) => a + b, 0n)).toBe(preview.netMinor)
      } finally {
        await deleteSyntheticUser(service, u.id)
      }
    })
  }
})
