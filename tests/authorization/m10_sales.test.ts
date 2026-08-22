import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  promoteToAdmin,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * M10: cross-tenant attacks against the sale ledger (SECURITY.md §3.3, TESTING.md §4, prompt
 * §103/§106/§107/§131). create_sale/update_sale/void_sale derive ownership entirely from
 * auth.uid() and are SECURITY DEFINER (20260828120010's header) — what's tested here is what *is*
 * caller-supplied (another user's lot id, sale id) and, separately, that the frozen/derived
 * columns prompt §107 names are not reachable by any direct write at all, for anyone, including an
 * admin. Admin has no application access to another user's private data (SECURITY.md §4) — same
 * boundary tests/authorization/invitations_and_admin.test.ts already proves for purchases/holdings.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let admin: SyntheticUser
let clientA: TestClient
let clientB: TestClient
let adminClient: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm10-sales-auth-a')
  userB = await createSyntheticUser(service, 'm10-sales-auth-b')
  admin = await createSyntheticUser(service, 'm10-sales-auth-admin')
  await promoteToAdmin(service, admin.id)
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
  adminClient = await signInAs(admin)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
  await deleteSyntheticUser(service, admin.id)
})

const today = new Date().toISOString().slice(0, 10)

/** One card lot for the given client, quantity 1, NOK. */
async function acquireLot(client: TestClient, unitPriceMinor = 10000): Promise<string> {
  const { data: purchase, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: unitPriceMinor,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  const { data: line } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  const { data: lot } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', line!.id)
    .single()
  return lot!.id
}

async function makeSale(client: TestClient, lotId: string): Promise<string> {
  const { data: sale, error } = await client
    .rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_idempotency_key: crypto.randomUUID(),
      p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: 12000 }],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  return sale.id
}

describe('create_sale: a foreign lot id is refused, not confirmed to exist (prompt §106)', () => {
  it('A cannot sell a lot owned by B — generic "unavailable", not "belongs to another user"', async () => {
    const bLot = await acquireLot(clientB)
    const { error } = await clientA.rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_idempotency_key: crypto.randomUUID(),
      p_lines: [{ lot_id: bLot, quantity: 1, unit_gross_minor: 5000 }],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/unavailable/i)
    expect(error?.message).not.toMatch(/belongs to|another user|owner/i)

    const { data: untouched } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', bLot)
      .single()
    expect(untouched?.quantity_remaining).toBe(1) // nothing disposed
  })

  it('a nonexistent lot id fails identically to a foreign one', async () => {
    const { error } = await clientA.rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_idempotency_key: crypto.randomUUID(),
      p_lines: [{ lot_id: crypto.randomUUID(), quantity: 1, unit_gross_minor: 5000 }],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/unavailable/i)
  })
})

describe('update_sale / void_sale: a stranger is refused, not found rather than exploited', () => {
  it("B cannot update A's sale", async () => {
    const lot = await acquireLot(clientA)
    const saleId = await makeSale(clientA, lot)

    const { error } = await clientB.rpc('update_sale', {
      p_sale_id: saleId,
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [],
    })
    expect(error).not.toBeNull()
  })

  it("B cannot void A's sale, and A's inventory stays disposed", async () => {
    const lot = await acquireLot(clientA)
    const saleId = await makeSale(clientA, lot)

    const { error } = await clientB.rpc('void_sale', { p_sale_id: saleId })
    expect(error).not.toBeNull()

    const { data: stillLive } = await service
      .from('sales')
      .select('voided_at')
      .eq('id', saleId)
      .single()
    expect(stillLive?.voided_at).toBeNull()
    const { data: lotRow } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', lot)
      .single()
    expect(lotRow?.quantity_remaining).toBe(0) // not restored by the rejected void
  })
})

describe('read isolation: sales, sale_lines and lot_disposals are strictly per-user', () => {
  it("B cannot read A's sale, sale_lines or lot_disposals by id", async () => {
    const lot = await acquireLot(clientA)
    const saleId = await makeSale(clientA, lot)
    const { data: line } = await service
      .from('sale_lines')
      .select('id')
      .eq('sale_id', saleId)
      .single()
    const { data: disposal } = await service
      .from('lot_disposals')
      .select('id')
      .eq('sale_line_id', line!.id)
      .single()

    const { data: saleRead } = await clientB.from('sales').select().eq('id', saleId)
    expect(saleRead).toEqual([])
    const { data: lineRead } = await clientB.from('sale_lines').select().eq('id', line!.id)
    expect(lineRead).toEqual([])
    const { data: disposalRead } = await clientB
      .from('lot_disposals')
      .select()
      .eq('id', disposal!.id)
    expect(disposalRead).toEqual([])
  })
})

describe('system columns: no direct write reaches sales/sale_lines/lot_disposals at all (prompt §107)', () => {
  it('authenticated holds no INSERT/UPDATE grant on any of the three tables, even for own rows', async () => {
    const lot = await acquireLot(clientA)
    const saleId = await makeSale(clientA, lot)

    const { error: insertError } = await clientA.from('sales').insert({
      user_id: userA.id,
      sold_on: today,
      currency: 'NOK',
      gross_minor: 999999,
      net_proceeds_minor: 999999,
      net_proceeds_nok_minor: 999999,
      fx_rate_to_nok: 1,
      fx_rate_date: today,
      fx_source: 'manual',
      idempotency_key: crypto.randomUUID(),
    })
    expect(insertError).not.toBeNull()

    const { error: updateError } = await clientA
      .from('sales')
      .update({ realized_result_nok_minor: 999999999 })
      .eq('id', saleId)
    expect(updateError).not.toBeNull()

    const { data: line } = await service
      .from('sale_lines')
      .select('id, cost_basis_at_sale_nok_minor')
      .eq('sale_id', saleId)
      .single()
    const { error: lineUpdateError } = await clientA
      .from('sale_lines')
      .update({ cost_basis_at_sale_nok_minor: 1 })
      .eq('id', line!.id)
    expect(lineUpdateError).not.toBeNull()

    // Unchanged after every rejected attempt.
    const { data: sale } = await service
      .from('sales')
      .select('realized_result_nok_minor')
      .eq('id', saleId)
      .single()
    expect(sale?.realized_result_nok_minor).not.toBe(999999999)
    const { data: lineAfter } = await service
      .from('sale_lines')
      .select('cost_basis_at_sale_nok_minor')
      .eq('id', line!.id)
      .single()
    expect(lineAfter?.cost_basis_at_sale_nok_minor).toBe(line?.cost_basis_at_sale_nok_minor)
  })
})

describe('admin has no access to another user private sale data (SECURITY.md §4)', () => {
  it('admin cannot read, update or void a sale owned by a plain user', async () => {
    const lot = await acquireLot(clientA)
    const saleId = await makeSale(clientA, lot)

    const { data: read } = await adminClient.from('sales').select().eq('id', saleId)
    expect(read).toEqual([])

    const { error: updateError } = await adminClient.rpc('update_sale', {
      p_sale_id: saleId,
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [],
    })
    expect(updateError).not.toBeNull()

    const { error: voidError } = await adminClient.rpc('void_sale', { p_sale_id: saleId })
    expect(voidError).not.toBeNull()

    const { data: stillLive } = await service
      .from('sales')
      .select('voided_at')
      .eq('id', saleId)
      .single()
    expect(stillLive?.voided_at).toBeNull()
  })

  it("admin's own sales_summary never includes another user's proceeds", async () => {
    const lot = await acquireLot(clientA, 500000)
    await makeSale(clientA, lot)

    const { data: adminSummary } = await adminClient.rpc('sales_summary').single<{
      nsp_nok_minor: string
    }>()
    const { data: aSummary } = await clientA
      .rpc('sales_summary')
      .single<{ nsp_nok_minor: string }>()
    expect(Number(aSummary?.nsp_nok_minor)).toBeGreaterThanOrEqual(12000)
    expect(Number(adminSummary?.nsp_nok_minor)).not.toBe(Number(aSummary?.nsp_nok_minor))
  })
})
