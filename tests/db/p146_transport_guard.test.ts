import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { createAppSupabaseClient } from '../../src/data/supabase-factory'
import type { LeasedDb } from '../../src/data/leased-client'
import { leasedHarness } from './leased'
import { UnsafeIntegerTransportError } from '../../src/data/exact-json-guard'

/**
 * P146 / P130-19 — the exact-transport guard and the null/zero contract, against the real stack.
 *
 *  - REQUEST side: a JavaScript number above 2^53 in a request is refused before it leaves, and
 *    nothing is written.
 *  - RESPONSE side: a money column selected WITHOUT `::text` (the mistake the contract forbids)
 *    still reaches the application with its exact digits — as a string — and the rewrite is
 *    reported, which is how the suites prove no real path depends on it.
 *  - NULL is unknown and 0 is a known zero, end to end, through the data layer.
 */

const transport = vi.hoisted(() => ({ client: null as unknown as object }))
vi.mock('../../src/data/supabase-client', () => ({
  supabase: new Proxy(
    {},
    {
      get(_target, property) {
        const target = transport.client as Record<PropertyKey, unknown>
        const value = target[property]
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    },
  ),
}))

import { addCardAcquisition, getHoldingLots } from '../../src/data/collection'
import { createPurchase } from '../../src/data/purchases'
import { createSale, getSale } from '../../src/data/sales'
import { getOpening, createProvisionalOpening } from '../../src/data/opening'

const A = BigInt(Number.MAX_SAFE_INTEGER) + 2n // 2^53 + 1
const today = new Date().toISOString().slice(0, 10)

let service: TestClient
let user: SyntheticUser
let client: ReturnType<typeof createAppSupabaseClient>
const rewrites: string[] = []
/** The production leased client of the synthetic user (identity lease + exact-transport guard). */
let db: LeasedDb

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p146-guard')
  client = createAppSupabaseClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_ANON_KEY as string,
    { onResponseRewrite: (literals) => rewrites.push(...literals) },
  )
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(error.message)
  transport.client = client
  db = leasedHarness(client, user.id, {
    onResponseRewrite: (literals) => rewrites.push(...literals),
  }).db
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

describe('request side: an unsafe JS number never leaves the client', () => {
  it('a Number(bigint) money argument is refused and nothing is written', async () => {
    const before = await service
      .from('purchases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)

    const { error } = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [{ line_type: 'accessory', description: 'x', quantity: 1, unit_price_minor: 5 }],
      // The historical bug: money converted with Number(). 2^53 + 1 becomes 2^53 on the way.
      p_shipping_minor: Number(A),
      p_idempotency_key: crypto.randomUUID(),
    })
    expect(error).not.toBeNull()
    expect(error?.message).toContain('refusing request body')
    expect(error?.message).toContain('9007199254740992')

    const after = await service
      .from('purchases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    expect(after.count).toBe(before.count)
  })

  it('the same value as a decimal string is accepted and stored exactly', async () => {
    const { data, error } = await client
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [{ line_type: 'accessory', description: 'x', quantity: 1, unit_price_minor: '5' }],
        p_shipping_minor: A.toString() as unknown as number,
        p_idempotency_key: crypto.randomUUID(),
      })
      .select('id, shipping_minor::text')
      .single()
    expect(error).toBeNull()
    expect((data as unknown as { shipping_minor: string }).shipping_minor).toBe(A.toString())
  })

  it('the guard error type is exported for callers that want to recognise it', () => {
    expect(new UnsafeIntegerTransportError('9007199254740993').name).toBe(
      'UnsafeIntegerTransportError',
    )
  })
})

describe('response side: a forgotten ::text cannot silently round money', () => {
  it('selecting a bigint column plainly yields the exact digits as a string, and reports it', async () => {
    const { data: created } = await client
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'accessory',
            description: 'x',
            quantity: 1,
            unit_price_minor: A.toString(),
          },
        ],
        p_idempotency_key: crypto.randomUUID(),
      })
      .select('id')
      .single()
    const id = (created as unknown as { id: string }).id

    rewrites.length = 0
    // NO ::text — this is the wrong way to read money. Without the guard the value below would be
    // the number 9007199254740992 (p146_transport_layers.test.ts, layer L3/L4).
    const { data, error } = await client
      .from('purchases')
      .select('total_minor')
      .eq('id', id)
      .single()
    expect(error).toBeNull()
    const seen = (data as unknown as { total_minor: unknown }).total_minor
    expect(seen).toBe(A.toString())
    expect(BigInt(seen as string)).toBe(A)
    expect(rewrites).toEqual([A.toString()])
    rewrites.length = 0
  })

  it('safe values and ordinary payloads are untouched (no rewrite, still numbers)', async () => {
    rewrites.length = 0
    const { data, error } = await client
      .from('purchases')
      .select('id, currency, total_minor')
      .eq('user_id', user.id)
      .eq('total_minor', 5)
      .limit(1)
    expect(error).toBeNull()
    expect(rewrites).toEqual([])
    for (const row of (data ?? []) as unknown as { total_minor: unknown }[]) {
      expect(typeof row.total_minor).toBe('number')
    }
  })
})

describe('NULL is unknown, 0 is a known zero — never exchanged', () => {
  it('lot cost basis: unknown -> null, known zero -> 0n, known unsafe -> exact', async () => {
    const unknown = await addCardAcquisition(
      {
        cardVariantId: seedCatalog.pikachuVariantId,
        gradingState: 'raw',
        condition: 'NM',
        origin: 'pre_tracking',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: today,
        clientRequestKey: crypto.randomUUID(),
      },
      db,
    )
    const zero = await addCardAcquisition(
      {
        cardVariantId: seedCatalog.charizardVariantId,
        gradingState: 'raw',
        condition: 'NM',
        origin: 'purchase',
        costBasisState: 'known',
        unitCostBasisMinor: 0n,
        quantity: 1,
        acquiredOn: today,
        clientRequestKey: crypto.randomUUID(),
      },
      db,
    )
    const big = await addCardAcquisition(
      {
        cardVariantId: seedCatalog.grassEnergyVariantId,
        gradingState: 'raw',
        condition: 'NM',
        origin: 'purchase',
        costBasisState: 'known',
        unitCostBasisMinor: A,
        quantity: 1,
        acquiredOn: today,
        clientRequestKey: crypto.randomUUID(),
      },
      db,
    )
    const basisOf = async (holdingId: string, lotId: string) =>
      (await getHoldingLots(holdingId)).find((l) => l.id === lotId)?.unitCostBasisMinor
    expect(await basisOf(unknown.holdingId, unknown.lotId)).toBeNull()
    expect(await basisOf(zero.holdingId, zero.lotId)).toBe(0n)
    expect(await basisOf(big.holdingId, big.lotId)).toBe(A)
    expect(rewrites).toEqual([])
  })

  it('sale results: uncosted -> realized null, costed break-even -> realized 0n', async () => {
    const uncosted = await addCardAcquisition(
      {
        cardVariantId: seedCatalog.japaneseVariantId,
        gradingState: 'raw',
        condition: 'NM',
        origin: 'pre_tracking',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: today,
        clientRequestKey: crypto.randomUUID(),
      },
      db,
    )
    const soldUncosted = await createSale(
      [{ lotId: uncosted.lotId, quantity: 1, unitGrossMinor: 0n }],
      { soldOn: today, currency: 'NOK' },
      crypto.randomUUID(),
      db,
    )
    // Zero proceeds from an unknown basis: the cash flow is a known 0, the RESULT is unknown.
    expect(soldUncosted.netProceedsMinor).toBe(0n)
    expect(soldUncosted.realizedResultNokMinor).toBeNull()
    const uncostedLine = (await getSale(soldUncosted.id))!.lines[0]!
    expect(uncostedLine.costBasisAtSaleNokMinor).toBeNull()
    expect(uncostedLine.realizedResultNokMinor).toBeNull()

    const bought = await createPurchase(
      {
        purchasedOn: today,
        currency: 'NOK',
        lines: [
          {
            lineType: 'card',
            cardVariantId: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: 1,
            unitPriceMinor: 1_000n,
          },
        ],
      },
      crypto.randomUUID(),
      db,
    )
    const { data: line } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', bought.id)
      .single()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', (line as { id: string }).id)
      .single()
    const breakEven = await createSale(
      [{ lotId: (lot as { id: string }).id, quantity: 1, unitGrossMinor: 1_000n }],
      { soldOn: today, currency: 'NOK' },
      crypto.randomUUID(),
      db,
    )
    expect(breakEven.realizedResultNokMinor).toBe(0n)
    expect(rewrites).toEqual([])
  })

  it('an unknown-cost opening keeps its return null; explicit zero-value fields stay 0n', async () => {
    const opening = await createProvisionalOpening(
      {
        sealedProductId: seedCatalog.sealedProductId,
        quantity: 1,
        totalPaidNokMinor: 0n,
        purchasedOn: today,
        trackingCompleteness: 'unknown',
      },
      db,
    )
    // A receipt total of 0 is a known free product, not an unknown cost.
    expect(opening.costNokMinor).toBe(0n)
    const detail = await getOpening(opening.id)
    expect(detail?.costNokMinor).toBe(0n)
    expect(detail?.bulkRemainderEstimateNokMinor).toBeNull()
    expect(rewrites).toEqual([])
  })
})
