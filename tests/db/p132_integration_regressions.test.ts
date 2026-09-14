import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client as PgClient } from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import {
  connectMonitor,
  HeldLockSession,
  silenceUnhandledRejection,
  waitUntilLockWaiting,
} from './lib/held-lock-session'

/**
 * P132 integration regressions: inventory-integrity defects found by the independent P132-C
 * package (test/p132c-finance-regressions) against the first integrated P132 candidate, promoted
 * into the standard DB suite so CI keeps them closed.
 *
 *   X-1  voiding one sibling of a split purchase line auto-voided the purchase while another
 *        sibling stayed live inventory (D-131).
 *   X-2  void_opening restored the opened source lot through the D1 trigger without locking it, so
 *        a concurrent sale on that lot was missed and D1 was written stale.
 *   X-3  set_sealed_lot_intent validated a stale quantity_remaining against a concurrent sale and
 *        only the CHECK constraint (raw 23514) stopped the write.
 *   X-4  update_purchase changed the quantity of a line with no live lot left (D-130).
 *   plus update_purchase re-costing a split line that is not the purchase's last line with another
 *        line's sibling quantities, resurrecting a removed sibling's units, and editing/voiding a
 *        purchase whose live-lot set grew while the call waited for its locks.
 *
 * Migrations: 20260914120000_p132_update_purchase_multilot_integrity.sql,
 * 20260914121000_p132_correction_lot_locking.sql, 20260914122000_p132_additional_inventory_race_guards.sql.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient
let monitor: PgClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p132-integration')
  clientA = await signInAs(userA)
  monitor = await connectMonitor()
})

afterAll(async () => {
  await monitor.end()
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface LotRow {
  id: string
  quantity: number
  quantity_remaining: number
  sealed_intent: string | null
  unit_cost_basis_minor: number | null
  unit_cost_basis_nok_minor: number | null
  residual_minor: number
  residual_nok_minor: number
  voided_at: string | null
}

interface LineRow {
  id: string
  quantity: number
  unit_price_minor: number
  attributable_cost_minor: number
  attributable_cost_nok_minor: number
}

interface NewLine {
  line_type: 'sealed' | 'card' | 'accessory'
  quantity: number
  unit_price_minor: number
  sealed_product_id?: string
  manual_card_id?: string
  condition?: string
  description?: string
}

/** A private sealed product per call, so every fixture gets its own holding. */
async function isolatedProduct(): Promise<string> {
  const { data, error } = await service
    .from('sealed_products')
    .insert({
      name: `p132-integration-${crypto.randomUUID()}`,
      language: 'en',
      product_type: 'other',
      created_by_user_id: userA.id,
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  return data.id
}

async function isolatedManualCard(): Promise<string> {
  const { data, error } = await clientA
    .from('manual_card_definitions')
    .insert({ name: `p132-integration card ${crypto.randomUUID()}` })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  return data.id
}

async function sealedLine(quantity: number, unitPrice: number): Promise<NewLine> {
  return {
    line_type: 'sealed',
    sealed_product_id: await isolatedProduct(),
    quantity,
    unit_price_minor: unitPrice,
  }
}

async function cardLine(quantity: number, unitPrice: number): Promise<NewLine> {
  return {
    line_type: 'card',
    manual_card_id: await isolatedManualCard(),
    condition: 'NM',
    description: `p132-integration card line ${crypto.randomUUID()}`,
    quantity,
    unit_price_minor: unitPrice,
  }
}

/** Buys the lines and returns line ids and each line's single lot, in input order. */
async function buy(
  lines: NewLine[],
  header: { shipping?: number; customs?: number; discount?: number } = {},
): Promise<{ purchaseId: string; lineIds: string[]; lotIds: (string | null)[] }> {
  const { data: purchase, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: header.shipping ?? 0,
      p_customs_minor: header.customs ?? 0,
      p_discount_minor: header.discount ?? 0,
      p_lines: lines,
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)

  const lineIds: string[] = []
  const lotIds: (string | null)[] = []
  for (const line of lines) {
    // purchase_lines has no manual card column; card and accessory lines carry a unique description.
    const identity = line.sealed_product_id
      ? { column: 'sealed_product_id', value: line.sealed_product_id }
      : { column: 'description', value: line.description ?? '' }
    const { data: row, error: lineError } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase.id)
      .eq(identity.column, identity.value)
      .single<{ id: string }>()
    if (lineError) throw new Error(lineError.message)
    lineIds.push(row.id)
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', row.id)
      .maybeSingle<{ id: string }>()
    lotIds.push(lot?.id ?? null)
  }
  return { purchaseId: purchase.id, lineIds, lotIds }
}

async function split(lotId: string, intent: string, quantity: number | null): Promise<string> {
  const { data, error } = await clientA
    .rpc('set_sealed_lot_intent', { p_lot_id: lotId, p_intent: intent, p_quantity: quantity })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  return data.id
}

async function lines(purchaseId: string): Promise<LineRow[]> {
  const { data, error } = await service
    .from('purchase_lines')
    .select('id, quantity, unit_price_minor, attributable_cost_minor, attributable_cost_nok_minor')
    .eq('purchase_id', purchaseId)
  if (error) throw new Error(error.message)
  return data
}

async function lotsOfLine(lineId: string): Promise<LotRow[]> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, sealed_intent, unit_cost_basis_minor, unit_cost_basis_nok_minor, residual_minor, residual_nok_minor, voided_at',
    )
    .eq('purchase_line_id', lineId)
    .order('id')
  if (error) throw new Error(error.message)
  return data
}

async function lot(lotId: string): Promise<LotRow> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, sealed_intent, unit_cost_basis_minor, unit_cost_basis_nok_minor, residual_minor, residual_nok_minor, voided_at',
    )
    .eq('id', lotId)
    .single<LotRow>()
  if (error) throw new Error(error.message)
  return data
}

async function purchaseVoidedAt(purchaseId: string): Promise<string | null> {
  const { data, error } = await service
    .from('purchases')
    .select('voided_at')
    .eq('id', purchaseId)
    .single<{ voided_at: string | null }>()
  if (error) throw new Error(error.message)
  return data.voided_at
}

/** Resubmits a purchase with its current header and per-line overrides. */
async function edit(
  purchaseId: string,
  overrides: Record<string, { quantity?: number; unit_price_minor?: number }>,
  header: { shipping?: number; customs?: number; discount?: number } = {},
) {
  const current = await lines(purchaseId)
  return clientA.rpc('update_purchase', {
    p_purchase_id: purchaseId,
    p_purchased_on: today,
    p_currency: 'NOK',
    p_shipping_minor: header.shipping ?? 0,
    p_customs_minor: header.customs ?? 0,
    p_discount_minor: header.discount ?? 0,
    p_lines: current.map((l) => ({
      line_id: l.id,
      quantity: overrides[l.id]?.quantity ?? l.quantity,
      unit_price_minor: overrides[l.id]?.unit_price_minor ?? l.unit_price_minor,
    })),
  })
}

const basisOf = (lots: LotRow[], which: 'txn' | 'nok') =>
  lots.reduce(
    (sum, l) =>
      sum +
      (which === 'nok'
        ? (l.unit_cost_basis_nok_minor ?? 0) * l.quantity + l.residual_nok_minor
        : (l.unit_cost_basis_minor ?? 0) * l.quantity + l.residual_minor),
    0,
  )

/** D1 on the stored column: quantity_remaining = quantity - Σ live disposals. */
async function assertD1(lotId: string): Promise<void> {
  const row = await lot(lotId)
  const { data, error } = await service
    .from('lot_disposals')
    .select('quantity')
    .eq('lot_id', lotId)
    .is('voided_at', null)
  if (error) throw new Error(error.message)
  const disposed = (data as { quantity: number }[]).reduce((s, d) => s + d.quantity, 0)
  expect(row.quantity_remaining, `D1 for lot ${lotId}`).toBe(row.quantity - disposed)
}

function sellInSession(session: HeldLockSession, lotId: string, quantity: number) {
  return session.query(
    `select id from public.create_sale(
       p_sold_on => $1::date, p_currency => 'NOK', p_lines => $2::jsonb, p_idempotency_key => $3::uuid)`,
    [
      today,
      JSON.stringify([{ lot_id: lotId, quantity, unit_gross_minor: 500 }]),
      crypto.randomUUID(),
    ],
  )
}

/** A rejected raw-session promise's SQLSTATE, or null if it resolved. */
async function sqlstateOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}

// ── update_purchase: per-line allocation after splits on more than one line ───────────────────

describe('update_purchase re-costs every split line with its own siblings', () => {
  it('two split sealed lines followed by a card line: a header edit keeps each line exact', async () => {
    const bought = await buy(
      [await sealedLine(5, 10_000), await sealedLine(3, 4_999), await cardLine(2, 1_234)],
      { shipping: 1_901, customs: 777, discount: 1_003 },
    )
    await split(bought.lotIds[0]!, 'keep_sealed', 2)
    await split(bought.lotIds[1]!, 'planned_to_open', 1)

    const { error } = await edit(
      bought.purchaseId,
      {},
      { shipping: 4_999, customs: 777, discount: 17 },
    )
    expect(error).toBeNull()

    for (const line of await lines(bought.purchaseId)) {
      const live = (await lotsOfLine(line.id)).filter((l) => l.voided_at === null)
      expect(
        live.reduce((s, l) => s + l.quantity, 0),
        `quantity of line ${line.id}`,
      ).toBe(line.quantity)
      expect(basisOf(live, 'nok'), `NOK basis of line ${line.id}`).toBe(
        line.attributable_cost_nok_minor,
      )
      expect(basisOf(live, 'txn'), `NOK-currency basis of line ${line.id}`).toBe(
        line.attributable_cost_minor,
      )
    }
  })
})

// ── Removed sibling: never resurrected (D-130) ───────────────────────────────────────────────

describe('a split line with one sibling removed from inventory (D-130)', () => {
  it('a price edit keeps the removed units removed and re-costs the live sibling per unit', async () => {
    const bought = await buy([await sealedLine(5, 10_000), await sealedLine(1, 500)])
    const lineId = bought.lineIds[0]!
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 2)
    const { error: voidError } = await clientA.rpc('void_acquisition_lot', { p_lot_id: keep })
    expect(voidError).toBeNull()
    expect(await purchaseVoidedAt(bought.purchaseId)).toBeNull()

    const { error } = await edit(bought.purchaseId, { [lineId]: { unit_price_minor: 11_000 } })
    expect(error).toBeNull()

    const [line] = (await lines(bought.purchaseId)).filter((l) => l.id === lineId)
    const all = await lotsOfLine(lineId)
    const live = all.filter((l) => l.voided_at === null)
    expect(line!.quantity).toBe(5)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: bought.lotIds[0], quantity: 3, quantity_remaining: 3 })
    // 5 units cost 55000: the live 3 carry exactly their share, the removed 2 stay removed.
    expect(live[0]!.unit_cost_basis_nok_minor).toBe(11_000)
    expect(basisOf(live, 'nok')).toBe(33_000)
    expect(all.find((l) => l.id === keep)?.voided_at).not.toBeNull()
  })

  it('a quantity change on that line is refused and changes nothing', async () => {
    const bought = await buy([await sealedLine(5, 10_000), await sealedLine(1, 500)])
    const lineId = bought.lineIds[0]!
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 2)
    expect((await clientA.rpc('void_acquisition_lot', { p_lot_id: keep })).error).toBeNull()
    const before = await lotsOfLine(lineId)

    const { error } = await edit(bought.purchaseId, { [lineId]: { quantity: 6 } })
    expect(error?.message).toMatch(/multi-lot-quantity-ambiguous/)
    expect(error?.code).toBe('P0001')
    expect(await lotsOfLine(lineId)).toEqual(before)
    expect((await lines(bought.purchaseId)).find((l) => l.id === lineId)?.quantity).toBe(5)
  })
})

// ── X-4: zero live lots (D-130) ──────────────────────────────────────────────────────────────

describe('a purchase line with no live lot left (X-4, D-130)', () => {
  it('refuses a quantity change and never resurrects inventory', async () => {
    const bought = await buy([await cardLine(2, 2_000), await cardLine(1, 3_000)])
    const [removedLine, keptLine] = bought.lineIds as [string, string]
    expect(
      (await clientA.rpc('void_acquisition_lot', { p_lot_id: bought.lotIds[0] })).error,
    ).toBeNull()
    expect(await purchaseVoidedAt(bought.purchaseId)).toBeNull()

    const { error } = await edit(bought.purchaseId, { [removedLine]: { quantity: 3 } })
    expect(error?.message).toMatch(/purchase-line-quantity-without-inventory/)
    expect(error?.code).toBe('P0001')
    expect((await lines(bought.purchaseId)).find((l) => l.id === removedLine)?.quantity).toBe(2)
    expect((await lotsOfLine(removedLine)).filter((l) => l.voided_at === null)).toHaveLength(0)
    expect((await lotsOfLine(keptLine)).filter((l) => l.voided_at === null)).toHaveLength(1)
  })

  it('still accepts a cost edit that leaves that line quantity unchanged', async () => {
    const bought = await buy([await cardLine(2, 2_000), await cardLine(1, 3_000)])
    const [removedLine, keptLine] = bought.lineIds as [string, string]
    expect(
      (await clientA.rpc('void_acquisition_lot', { p_lot_id: bought.lotIds[0] })).error,
    ).toBeNull()

    const { error } = await edit(bought.purchaseId, {
      [removedLine]: { unit_price_minor: 2_500 },
      [keptLine]: { unit_price_minor: 3_100 },
    })
    expect(error).toBeNull()
    const after = await lines(bought.purchaseId)
    expect(after.find((l) => l.id === removedLine)).toMatchObject({
      quantity: 2,
      unit_price_minor: 2_500,
    })
    expect((await lotsOfLine(removedLine)).filter((l) => l.voided_at === null)).toHaveLength(0)
    const kept = (await lotsOfLine(keptLine)).filter((l) => l.voided_at === null)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.unit_cost_basis_nok_minor).toBe(3_100)
  })
})

// ── X-1: sibling-aware parent auto-void (D-131) ──────────────────────────────────────────────

describe('void_acquisition_lot parent auto-void with split siblings (X-1, D-131)', () => {
  it('voiding one sibling of a single-line purchase keeps the purchase live; voiding the last sibling voids it', async () => {
    const bought = await buy([await sealedLine(5, 10_000)])
    const original = bought.lotIds[0]!
    const keep = await split(original, 'keep_sealed', 2)

    expect((await clientA.rpc('void_acquisition_lot', { p_lot_id: keep })).error).toBeNull()
    expect(
      await purchaseVoidedAt(bought.purchaseId),
      'a live sibling still holds 3 units',
    ).toBeNull()
    expect((await lot(original)).voided_at).toBeNull()

    expect((await clientA.rpc('void_acquisition_lot', { p_lot_id: original })).error).toBeNull()
    expect(
      await purchaseVoidedAt(bought.purchaseId),
      'every lot of every line is voided',
    ).not.toBeNull()
  })

  it('the final sibling does not auto-void a purchase that also carries a non-inventory line (D-051)', async () => {
    const bought = await buy([
      await sealedLine(3, 10_000),
      { line_type: 'accessory', quantity: 1, unit_price_minor: 900, description: 'sleeves' },
    ])
    const original = bought.lotIds[0]!
    const keep = await split(original, 'keep_sealed', 1)
    expect((await clientA.rpc('void_acquisition_lot', { p_lot_id: keep })).error).toBeNull()
    expect((await clientA.rpc('void_acquisition_lot', { p_lot_id: original })).error).toBeNull()
    expect(await purchaseVoidedAt(bought.purchaseId)).toBeNull()
  })

  it('remove_holdings_from_portfolio removing the last live sibling auto-voids the single-line purchase', async () => {
    // Siblings share the holding: one is voided first (purchase stays live), then removing the
    // holding voids the last live sibling, and only then is every lot of the line accounted for.
    const bought = await buy([await sealedLine(4, 10_000)])
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 1)
    expect((await clientA.rpc('void_acquisition_lot', { p_lot_id: keep })).error).toBeNull()
    expect(await purchaseVoidedAt(bought.purchaseId)).toBeNull()
    const { data: holding } = await service
      .from('acquisition_lots')
      .select('holding_id')
      .eq('id', bought.lotIds[0]!)
      .single<{ holding_id: string }>()
    const { error } = await clientA.rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [holding!.holding_id],
    })
    expect(error).toBeNull()
    expect(await purchaseVoidedAt(bought.purchaseId)).not.toBeNull()
  })
})

// ── X-3: set_sealed_lot_intent vs create_sale (held locks) ───────────────────────────────────

describe('set_sealed_lot_intent vs create_sale (X-3)', () => {
  it('sale first: the split blocks, then refuses with a domain error once the units are sold', async () => {
    const bought = await buy([await sealedLine(3, 10_000)])
    const lotId = bought.lotIds[0]!

    const sale = await HeldLockSession.beginAs(userA.id)
    const intent = await HeldLockSession.beginAs(userA.id)
    try {
      await sellInSession(sale, lotId, 3)
      const intentPromise = silenceUnhandledRejection(
        intent.query(`select id from public.set_sealed_lot_intent($1::uuid, 'keep_sealed', 2)`, [
          lotId,
        ]),
      )
      await waitUntilLockWaiting(monitor, intent.pid)
      await sale.commit()

      await expect(intentPromise).rejects.toThrow(/p_quantity must be between 1/)
      expect(await sqlstateOf(intentPromise)).toBe('P0001')
      await intent.end()

      expect(await lotsOfLine(bought.lineIds[0]!)).toHaveLength(1)
      expect(await lot(lotId)).toMatchObject({ quantity: 3, quantity_remaining: 0 })
      await assertD1(lotId)
    } finally {
      await sale.end()
      await intent.end()
    }
  })

  it('split first: the sale blocks, then refuses the units the split moved away', async () => {
    const bought = await buy([await sealedLine(3, 10_000)])
    const lotId = bought.lotIds[0]!

    const intent = await HeldLockSession.beginAs(userA.id)
    const sale = await HeldLockSession.beginAs(userA.id)
    try {
      await intent.query(
        `select id from public.set_sealed_lot_intent($1::uuid, 'keep_sealed', 2)`,
        [lotId],
      )
      const salePromise = silenceUnhandledRejection(sellInSession(sale, lotId, 3))
      await waitUntilLockWaiting(monitor, sale.pid)
      await intent.commit()

      await expect(salePromise).rejects.toThrow(/only 1 of the selected lot remain available/)
      await sale.end()

      const live = (await lotsOfLine(bought.lineIds[0]!)).filter((l) => l.voided_at === null)
      expect(live.map((l) => l.quantity).sort()).toEqual([1, 2])
      await assertD1(lotId)
    } finally {
      await intent.end()
      await sale.end()
    }
  })
})

// ── X-2: void_opening restores the source lot under its lock ─────────────────────────────────

describe('void_opening vs create_sale on the opened source lot (X-2)', () => {
  async function openOneOfTwo(): Promise<{ openingId: string; sourceLotId: string }> {
    const { data: purchase, error } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: await isolatedProduct(),
            quantity: 2,
            unit_price_minor: 50_000,
          },
        ],
      })
      .single<{ id: string }>()
    if (error) throw new Error(error.message)
    const [line] = await lines(purchase.id)
    const [source] = await lotsOfLine(line!.id)
    const { data: opening, error: openError } = await clientA
      .rpc('create_opening', {
        p_source_lot_id: source!.id,
        p_quantity: 1,
        p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
      })
      .single<{ id: string }>()
    if (openError) throw new Error(openError.message)
    return { openingId: opening.id, sourceLotId: source!.id }
  }

  it('sale first: the void waits for the sale and restores the opened unit without losing the sold one', async () => {
    const { openingId, sourceLotId } = await openOneOfTwo()
    expect(await lot(sourceLotId)).toMatchObject({ quantity: 2, quantity_remaining: 1 })

    const sale = await HeldLockSession.beginAs(userA.id)
    const correction = await HeldLockSession.beginAs(userA.id)
    try {
      await sellInSession(sale, sourceLotId, 1)
      const voidPromise = silenceUnhandledRejection(
        correction.query('select public.void_opening($1::uuid, null)', [openingId]),
      )
      await waitUntilLockWaiting(monitor, correction.pid)
      await sale.commit()
      await voidPromise
      await correction.commit()

      expect(await lot(sourceLotId)).toMatchObject({ quantity: 2, quantity_remaining: 1 })
      await assertD1(sourceLotId)
    } finally {
      await sale.end()
      await correction.end()
    }
  })

  it('void first: the sale waits for the restore and sells from the restored units', async () => {
    const { openingId, sourceLotId } = await openOneOfTwo()

    const correction = await HeldLockSession.beginAs(userA.id)
    const sale = await HeldLockSession.beginAs(userA.id)
    try {
      await correction.query('select public.void_opening($1::uuid, null)', [openingId])
      const salePromise = silenceUnhandledRejection(sellInSession(sale, sourceLotId, 2))
      await waitUntilLockWaiting(monitor, sale.pid)
      await correction.commit()
      await salePromise
      await sale.commit()

      expect(await lot(sourceLotId)).toMatchObject({ quantity: 2, quantity_remaining: 0 })
      await assertD1(sourceLotId)
    } finally {
      await correction.end()
      await sale.end()
    }
  })
})

// ── Lot-set membership re-check after locking ────────────────────────────────────────────────

describe('corrections refuse when a concurrent split adds a lot they do not hold', () => {
  it('void_purchase waiting on a split refuses with 40001 and leaves no live lot under a voided purchase', async () => {
    const bought = await buy([await sealedLine(5, 10_000)])
    const lotId = bought.lotIds[0]!

    const intent = await HeldLockSession.beginAs(userA.id)
    const correction = await HeldLockSession.beginAs(userA.id)
    try {
      await intent.query(
        `select id from public.set_sealed_lot_intent($1::uuid, 'keep_sealed', 2)`,
        [lotId],
      )
      const voidPromise = silenceUnhandledRejection(
        correction.query('select public.void_purchase($1::uuid, null)', [bought.purchaseId]),
      )
      await waitUntilLockWaiting(monitor, correction.pid)
      await intent.commit()

      expect(await sqlstateOf(voidPromise)).toBe('40001')
      await correction.end()

      expect(await purchaseVoidedAt(bought.purchaseId)).toBeNull()
      const live = (await lotsOfLine(bought.lineIds[0]!)).filter((l) => l.voided_at === null)
      expect(live.map((l) => l.quantity).sort()).toEqual([2, 3])
    } finally {
      await intent.end()
      await correction.end()
    }
  })

  it('update_purchase waiting on a split refuses with 40001 and writes nothing', async () => {
    const bought = await buy([await sealedLine(5, 10_000)])
    const lineId = bought.lineIds[0]!
    const lotId = bought.lotIds[0]!

    const intent = await HeldLockSession.beginAs(userA.id)
    const correction = await HeldLockSession.beginAs(userA.id)
    try {
      await intent.query(
        `select id from public.set_sealed_lot_intent($1::uuid, 'keep_sealed', 2)`,
        [lotId],
      )
      const editPromise = silenceUnhandledRejection(
        correction.query(
          `select id from public.update_purchase(
             p_purchase_id => $1::uuid, p_purchased_on => $2::date, p_currency => 'NOK',
             p_lines => $3::jsonb)`,
          [
            bought.purchaseId,
            today,
            JSON.stringify([{ line_id: lineId, quantity: 5, unit_price_minor: 12_000 }]),
          ],
        ),
      )
      await waitUntilLockWaiting(monitor, correction.pid)
      await intent.commit()

      expect(await sqlstateOf(editPromise)).toBe('40001')
      await correction.end()

      const [line] = await lines(bought.purchaseId)
      expect(line!.unit_price_minor).toBe(10_000)
      const live = (await lotsOfLine(lineId)).filter((l) => l.voided_at === null)
      expect(live.reduce((s, l) => s + l.quantity, 0)).toBe(5)
      expect(basisOf(live, 'nok')).toBe(50_000)
    } finally {
      await intent.end()
      await correction.end()
    }
  })
})
