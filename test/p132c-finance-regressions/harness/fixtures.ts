import type { PgSession } from './docker-pg'
import type { FileContext, UserContext } from './context'
import {
  addAcquisitionSql,
  createOpeningSql,
  createPurchaseSql,
  createSaleSql,
  setSealedIntentSql,
  type NewPurchaseLine,
  type PurchaseHeader,
  type Snapshot,
} from './ledger'

/**
 * Rows written in one transaction share `created_at`, so snapshot order within a purchase is by
 * uuid, not by input order. Resolve each input line to its row (and its first lot) by content.
 * Fixture lines within one purchase must differ in type, identity, quantity or price.
 */
export function matchLines(
  snap: Snapshot,
  purchaseId: string,
  lines: NewPurchaseLine[],
): { lineIds: string[]; lotIds: string[] } {
  const rows = snap.lines.filter((l) => l.purchase_id === purchaseId)
  const lineIds = lines.map((input, index) => {
    const matches = rows.filter(
      (row) =>
        row.line_type === input.line_type &&
        row.quantity === input.quantity &&
        row.unit_price_minor === input.unit_price_minor &&
        row.sealed_product_id === (input.sealed_product_id ?? null) &&
        row.card_variant_id === (input.card_variant_id ?? null),
    )
    if (matches.length !== 1)
      throw new Error(`fixture line ${String(index)} is not uniquely identifiable`)
    return matches[0]!.id
  })
  const lotIds = lineIds.map(
    (lineId) => snap.lots.find((l) => l.purchase_line_id === lineId)?.id ?? '',
  )
  return { lineIds, lotIds }
}

export interface Bought {
  purchaseId: string
  lineIds: string[]
  lotIds: string[]
  holdingIds: string[]
}

export async function buy(
  session: PgSession,
  user: UserContext,
  lines: NewPurchaseLine[],
  header: PurchaseHeader = {},
): Promise<Bought> {
  const purchase = JSON.parse(await session.value(createPurchaseSql(lines, header))) as {
    id: string
  }
  const snap = await user.snap()
  const matched = matchLines(snap, purchase.id, lines)
  const holdingIds = matched.lotIds.map(
    (lotId) => snap.lots.find((l) => l.id === lotId)?.holding_id ?? '',
  )
  return { purchaseId: purchase.id, ...matched, holdingIds }
}

export function sealedLine(
  ctx: FileContext,
  quantity: number,
  unitPrice: number,
  second = false,
): NewPurchaseLine {
  return {
    line_type: 'sealed',
    quantity,
    unit_price_minor: unitPrice,
    sealed_product_id: second ? ctx.catalog.sealedProductId2 : ctx.catalog.sealedProductId,
  }
}

export function cardLine(
  ctx: FileContext,
  quantity: number,
  unitPrice: number,
  second = false,
): NewPurchaseLine {
  return {
    line_type: 'card',
    quantity,
    unit_price_minor: unitPrice,
    card_variant_id: second ? ctx.catalog.cardVariantId2 : ctx.catalog.cardVariantId,
    condition: 'NM',
  }
}

/** set_sealed_lot_intent; returns the id of the lot now holding the moved units. */
export async function split(
  session: PgSession,
  lotId: string,
  intent: string,
  quantity: number | null,
): Promise<string> {
  return (
    JSON.parse(await session.value(setSealedIntentSql(lotId, intent, quantity))) as { id: string }
  ).id
}

export async function sell(
  session: PgSession,
  lotId: string,
  quantity: number,
  unitGross = 15_000,
): Promise<string> {
  return (
    JSON.parse(
      await session.value(
        createSaleSql([{ lot_id: lotId, quantity, unit_gross_minor: unitGross }]),
      ),
    ) as { id: string }
  ).id
}

/** add_card_acquisition; returns { holding_id, lot_id }. */
export async function acquire(
  session: PgSession,
  args: Parameters<typeof addAcquisitionSql>[0],
): Promise<{ holding_id: string; lot_id: string }> {
  const rows = JSON.parse(await session.value(addAcquisitionSql(args))) as {
    holding_id: string
    lot_id: string
  }[]
  if (rows.length !== 1) throw new Error('add_card_acquisition returned no row')
  return rows[0]!
}

/** create_opening with one pulled card; returns the opening id and its pull lot id. */
export async function openWithPull(
  ctx: FileContext,
  session: PgSession,
  user: UserContext,
  sourceLotId: string,
  quantity: number,
  pullQuantity: number,
): Promise<{ openingId: string; pullLotId: string }> {
  const opening = JSON.parse(
    await session.value(
      createOpeningSql(sourceLotId, quantity, [
        { card_variant_id: ctx.catalog.cardVariantId2, quantity: pullQuantity, condition: 'EX' },
      ]),
    ),
  ) as { id: string }
  const pull = (await user.snap()).lots.find((l) => l.opening_id === opening.id)
  if (!pull) throw new Error('opening produced no pull lot')
  return { openingId: opening.id, pullLotId: pull.id }
}
