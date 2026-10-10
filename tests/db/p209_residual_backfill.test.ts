import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rawSqlAvailable, runRawSqlAsync } from './raw-sql'
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
 * P209 / D-209 backfill. The migration flags existing live disposals whose frozen basis equals what a
 * residual-carrying disposal would have frozen. This runs the migration's own UPDATE statement,
 * restricted to one synthetic user, over data rewritten to look like it did before the migration (all
 * flags false), and checks which disposals it flags. A second case checks that the read-only
 * diagnostic reports a lot whose residual two live disposals both carry (legacy data).
 */

const MIGRATION = 'supabase/migrations/20261009160000_p209_residual_conservation.sql'
const today = new Date().toISOString().slice(0, 10)

function backfillStatementFor(userId: string): string {
  const sql = readFileSync(MIGRATION, 'utf8')
  const start = sql.indexOf('update public.lot_disposals ld')
  expect(start).toBeGreaterThan(0)
  const end = sql.indexOf('> 0;', start)
  expect(end).toBeGreaterThan(start)
  // The statement is global in the migration; scope it to the synthetic user here.
  return `${sql.slice(start, end + 3)} and ld.user_id = '${userId}';`
}

let service: TestClient
let user: SyntheticUser
let client: TestClient

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p209-backfill')
  client = await signInAs(user)
})
afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

async function lotWith(quantity: number, unit: number, shipping: number) {
  const r = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: shipping,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity,
          unit_price_minor: unit,
        },
      ],
    })
    .single<{ id: string }>()
  if (r.error) throw new Error(r.error.message)
  const pl = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', r.data.id)
    .single<{ id: string }>()
  const lot = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', pl.data!.id)
    .single<{ id: string }>()
  return lot.data!.id
}

async function sell(lotId: string, quantity: number) {
  const r = await client
    .rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotId, quantity, unit_gross_minor: 900 }],
    })
    .single<{ id: string }>()
  if (r.error) throw new Error(r.error.message)
  return r.data.id
}

async function flagsOf(lotId: string) {
  const { data } = await service
    .from('lot_disposals')
    .select('quantity, voided_at, consumed_lot_residual, sale_line_id')
    .eq('lot_id', lotId)
    .order('created_at')
  return (data ?? []) as {
    quantity: number
    voided_at: string | null
    consumed_lot_residual: boolean
    sale_line_id: string
  }[]
}

describe.skipIf(!rawSqlAvailable())('D-209 backfill of pre-migration disposals', () => {
  it('flags the disposal that froze the residual and leaves the others and voided ones alone', async () => {
    const lotId = await lotWith(5, 100, 1) // C = 501, unit 100, residual 1
    const first = await sell(lotId, 2)
    await sell(lotId, 1)
    const last = await sell(lotId, 2) // exhausts: 200 + 1
    expect((await client.rpc('void_sale', { p_sale_id: first })).error).toBeNull()

    // The new code already flagged the carrier; rewrite history to the pre-migration shape.
    const reset = await service
      .from('lot_disposals')
      .update({ consumed_lot_residual: false })
      .eq('lot_id', lotId)
    expect(reset.error).toBeNull()
    expect((await flagsOf(lotId)).every((d) => !d.consumed_lot_residual)).toBe(true)

    const r = await runRawSqlAsync(backfillStatementFor(user.id))
    expect(r.code, r.output).toBe(0)

    const flags = await flagsOf(lotId)
    const live = flags.filter((d) => d.voided_at === null)
    expect(live.map((d) => [d.quantity, d.consumed_lot_residual])).toEqual([
      [1, false],
      [2, true],
    ])
    // the voided first sale is never flagged
    expect(flags.filter((d) => d.voided_at !== null).every((d) => !d.consumed_lot_residual)).toBe(
      true,
    )
    expect(last).toBeTruthy()
  })

  it('a lot with no residual flags nothing', async () => {
    const lotId = await lotWith(4, 250, 0) // C = 1000 exactly, residual 0
    await sell(lotId, 4)
    await service.from('lot_disposals').update({ consumed_lot_residual: false }).eq('lot_id', lotId)
    const r = await runRawSqlAsync(backfillStatementFor(user.id))
    expect(r.code, r.output).toBe(0)
    expect((await flagsOf(lotId)).every((d) => !d.consumed_lot_residual)).toBe(true)
  })

  it('the diagnostic counts a lot whose residual two live disposals both carry', async () => {
    const count = async () => {
      const r = await runRawSqlAsync(
        readFileSync('scripts/finance-integrity-diagnostics.sql', 'utf8'),
      )
      expect(r.code, r.output).toBe(0)
      const json = JSON.parse(r.output.trim().split('\n').pop()!) as Record<string, number>
      return json.residual_double_carried_lots!
    }
    const lotId = await lotWith(5, 100, 1)
    await sell(lotId, 3)
    await sell(lotId, 2)
    const before = await count()
    const flags = await flagsOf(lotId)
    // Legacy shape: the 3-unit disposal also carried the residual.
    const upd = await service
      .from('lot_disposals')
      .update({ consumed_lot_residual: true })
      .eq('lot_id', lotId)
      .eq('quantity', 3)
    expect(upd.error).toBeNull()
    expect(flags).toHaveLength(2)
    expect(await count()).toBe(before + 1)
  })
})
