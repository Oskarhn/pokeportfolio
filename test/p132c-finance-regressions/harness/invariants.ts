/**
 * Ledger invariants, derived from the schema and the accounting rules — not from any particular
 * implementation of update_purchase or of the correction RPCs.
 *
 * The model carries the one fact the final state cannot reveal on its own: how many units of a
 * purchase line the owner deliberately removed (void_acquisition_lot / remove_holdings_from_
 * portfolio on one of the line's lots). Removed units are not inventory any more, but the receipt
 * still records them, so the line quantity is the live units PLUS the removed units.
 */
import type { LotRow, Snapshot } from './ledger'

export interface LedgerModel {
  /** purchase_line_id -> units the owner removed from inventory through a void/remove operation. */
  removedUnits: Map<string, number>
}

export function newModel(): LedgerModel {
  return { removedUnits: new Map() }
}

export interface Violation {
  code: string
  detail: string
}

const INVENTORY_LINE_TYPES = new Set(['card', 'sealed'])

function liveDisposedUnits(snap: Snapshot, lotId: string): number {
  return snap.disposals
    .filter((d) => d.lot_id === lotId && d.voided_at === null)
    .reduce((sum, d) => sum + d.quantity, 0)
}

export function checkInvariants(snap: Snapshot, model: LedgerModel = newModel()): Violation[] {
  const violations: Violation[] = []
  const add = (code: string, detail: string) => violations.push({ code, detail })
  const lotsById = new Map(snap.lots.map((l) => [l.id, l]))

  // ── Per lot ───────────────────────────────────────────────────────────────────────────────────
  for (const lot of snap.lots) {
    const disposed = liveDisposedUnits(snap, lot.id)
    if (lot.voided_at === null) {
      // D1: quantity_remaining == quantity - sum(non-voided disposal quantity)
      if (lot.quantity_remaining !== lot.quantity - disposed) {
        add(
          'LOT_D1',
          `lot ${lot.id}: quantity ${lot.quantity}, remaining ${lot.quantity_remaining}, live disposed ${disposed}`,
        )
      }
      if (disposed > lot.quantity) {
        add('LOT_OVERSOLD', `lot ${lot.id}: live disposed ${disposed} > quantity ${lot.quantity}`)
      }
    } else if (disposed > 0) {
      // Voiding inventory that a live sale/opening/write-off already consumed.
      add(
        'VOIDED_LOT_LIVE_DISPOSAL',
        `voided lot ${lot.id} still has ${disposed} live disposed unit(s)`,
      )
    }
    if (lot.quantity_remaining < 0 || lot.quantity_remaining > lot.quantity) {
      add('LOT_RANGE', `lot ${lot.id}: remaining ${lot.quantity_remaining} of ${lot.quantity}`)
    }
    // Unknown cost stays unknown: never 0, never a fabricated basis.
    if (lot.cost_basis_state === 'known') {
      if (
        lot.unit_cost_basis_minor === null ||
        lot.unit_cost_basis_nok_minor === null ||
        lot.cost_basis_currency === null
      ) {
        add('KNOWN_BASIS_MISSING', `known lot ${lot.id} lost part of its basis`)
      }
    } else if (
      lot.unit_cost_basis_minor !== null ||
      lot.unit_cost_basis_nok_minor !== null ||
      lot.cost_basis_currency !== null
    ) {
      add(
        'NULL_BASIS_FABRICATED',
        `${lot.cost_basis_state} lot ${lot.id} carries basis ${String(lot.unit_cost_basis_minor)}/${String(lot.unit_cost_basis_nok_minor)} ${String(lot.cost_basis_currency)}`,
      )
    }
  }

  // ── Per purchase line ─────────────────────────────────────────────────────────────────────────
  for (const purchase of snap.purchases) {
    const lines = snap.lines.filter((l) => l.purchase_id === purchase.id)
    for (const line of lines) {
      const lineLots = snap.lots.filter((l) => l.purchase_line_id === line.id)
      const live = lineLots.filter((l) => l.voided_at === null)
      if (purchase.voided_at !== null) {
        for (const lot of live) {
          add('VOIDED_PURCHASE_LIVE_LOT', `voided purchase ${purchase.id} has live lot ${lot.id}`)
        }
        continue
      }
      if (!INVENTORY_LINE_TYPES.has(line.line_type) || lineLots.length === 0) continue

      const removed = model.removedUnits.get(line.id) ?? 0
      const liveUnits = live.reduce((sum, l) => sum + l.quantity, 0)
      if (live.length === 0) {
        // Every lot of the line was removed; the receipt may still be edited. Units that are neither
        // inventory nor recorded as removed are unaccounted for (not the P130-01 multi-lot path).
        if (removed !== line.quantity) {
          add(
            'LINE_QUANTITY_WITHOUT_LIVE_LOTS',
            `line ${line.id}: line quantity ${line.quantity}, removed ${removed}, no live lot`,
          )
        }
      } else if (liveUnits !== line.quantity - removed) {
        // Core P130-01 invariant: sum of live lot quantity == line quantity (less removed units).
        add(
          'LINE_LOT_QUANTITY',
          `line ${line.id}: line quantity ${line.quantity}, removed ${removed}, live lot units ${liveUnits} (${live.map((l) => `${l.quantity}@${String(l.unit_cost_basis_nok_minor)}`).join(' + ')})`,
        )
      }

      const knownLive = live.filter((l) => l.cost_basis_state === 'known')
      for (const lot of knownLive) {
        if (lot.cost_basis_currency !== purchase.currency) {
          add(
            'LOT_BASIS_CURRENCY',
            `lot ${lot.id}: basis currency ${String(lot.cost_basis_currency)} on a ${purchase.currency} purchase`,
          )
        }
        // Every unit of one receipt line costs the same, give or take the one-minor-unit spread a
        // largest-remainder split can introduce.
        const perUnitNok = Math.floor(line.attributable_cost_nok_minor / line.quantity)
        if (Math.abs((lot.unit_cost_basis_nok_minor ?? 0) - perUnitNok) > 1) {
          add(
            'LOT_UNIT_BASIS_STALE',
            `lot ${lot.id}: unit basis ${String(lot.unit_cost_basis_nok_minor)} NOK vs line ${line.attributable_cost_nok_minor}/${line.quantity}`,
          )
        }
      }
      if (removed === 0 && knownLive.length === live.length && live.length > 0) {
        const basisNok = sumBasis(knownLive, 'nok')
        const basisTxn = sumBasis(knownLive, 'txn')
        if (basisNok !== line.attributable_cost_nok_minor) {
          add(
            'LINE_BASIS_NOK',
            `line ${line.id}: attributable ${line.attributable_cost_nok_minor} NOK, live lot basis ${basisNok}`,
          )
        }
        if (basisTxn !== line.attributable_cost_minor) {
          add(
            'LINE_BASIS_TXN',
            `line ${line.id}: attributable ${line.attributable_cost_minor} ${purchase.currency}, live lot basis ${basisTxn}`,
          )
        }
      }
    }
  }

  // ── Sales ─────────────────────────────────────────────────────────────────────────────────────
  for (const saleLine of snap.saleLines) {
    const sale = snap.sales.find((s) => s.id === saleLine.sale_id)
    const disposal = snap.disposals.find((d) => d.sale_line_id === saleLine.id)
    const lot = lotsById.get(saleLine.lot_id)
    if (!sale || !disposal || !lot) {
      add('SALE_LINK', `sale line ${saleLine.id}: sale/disposal/lot missing`)
      continue
    }
    if ((sale.voided_at === null) !== (disposal.voided_at === null)) {
      add(
        'SALE_DISPOSAL_STATE',
        `sale ${sale.id} voided=${String(sale.voided_at !== null)} but disposal voided=${String(disposal.voided_at !== null)}`,
      )
    }
    if (disposal.quantity !== saleLine.quantity || disposal.lot_id !== saleLine.lot_id) {
      add('SALE_DISPOSAL_SHAPE', `sale line ${saleLine.id} and its disposal disagree`)
    }
    if (
      lot.cost_basis_state !== 'known' &&
      (saleLine.cost_basis_at_sale_nok_minor !== null ||
        saleLine.realized_result_nok_minor !== null)
    ) {
      add(
        'SALE_NULL_BASIS_FABRICATED',
        `sale line ${saleLine.id} on ${lot.cost_basis_state} lot has a basis/realized value`,
      )
    }
    if (lot.cost_basis_state === 'known' && saleLine.cost_basis_at_sale_nok_minor === null) {
      add('SALE_KNOWN_BASIS_LOST', `sale line ${saleLine.id} on a known lot has no frozen basis`)
    }
  }
  for (const sale of snap.sales) {
    const lines = snap.saleLines.filter((l) => l.sale_id === sale.id)
    const anyKnown = lines.some((l) => l.cost_basis_at_sale_nok_minor !== null)
    if (anyKnown !== (sale.realized_result_nok_minor !== null)) {
      add(
        'SALE_REALIZED_NULLNESS',
        `sale ${sale.id}: realized ${String(sale.realized_result_nok_minor)} with known lines=${String(anyKnown)}`,
      )
    }
  }

  // ── Openings ──────────────────────────────────────────────────────────────────────────────────
  for (const opening of snap.openings) {
    const consumed = snap.disposals.find((d) => d.opening_id === opening.id && d.kind === 'opened')
    if (!consumed) {
      add('OPENING_LINK', `opening ${opening.id} has no opened disposal`)
      continue
    }
    if ((opening.voided_at === null) !== (consumed.voided_at === null)) {
      add(
        'OPENING_DISPOSAL_STATE',
        `opening ${opening.id} voided=${String(opening.voided_at !== null)} but its disposal voided=${String(consumed.voided_at !== null)}`,
      )
    }
    if (opening.voided_at !== null) {
      for (const pull of snap.lots.filter(
        (l) => l.opening_id === opening.id && l.voided_at === null,
      )) {
        add(
          'VOIDED_OPENING_LIVE_PULL',
          `voided opening ${opening.id} still has live pull lot ${pull.id}`,
        )
      }
    }
    const source = lotsById.get(opening.source_lot_id)
    if (source && source.cost_basis_state !== 'known' && opening.cost_nok_minor !== null) {
      add(
        'OPENING_NULL_BASIS_FABRICATED',
        `opening ${opening.id} from unknown-cost lot has cost ${opening.cost_nok_minor}`,
      )
    }
  }

  return violations
}

function sumBasis(lots: LotRow[], which: 'nok' | 'txn'): number {
  return lots.reduce(
    (sum, l) =>
      sum +
      (which === 'nok'
        ? (l.unit_cost_basis_nok_minor ?? 0) * l.quantity + l.residual_nok_minor
        : (l.unit_cost_basis_minor ?? 0) * l.quantity + l.residual_minor),
    0,
  )
}

/**
 * Units a successful void/remove operation took out of a live purchase's lines: the pre-operation
 * quantity of every purchase-line lot that went from live to voided while its purchase stayed live.
 * Only meaningful when the operation ran alone between the two snapshots.
 */
export function recordRemovals(before: Snapshot, after: Snapshot, model: LedgerModel): void {
  for (const lot of before.lots) {
    if (lot.voided_at !== null || lot.purchase_line_id === null) continue
    const now = after.lots.find((l) => l.id === lot.id)
    if (!now || now.voided_at === null) continue
    const line = after.lines.find((l) => l.id === lot.purchase_line_id)
    const purchase = line && after.purchases.find((p) => p.id === line.purchase_id)
    if (!purchase || purchase.voided_at !== null) continue
    model.removedUnits.set(
      lot.purchase_line_id,
      (model.removedUnits.get(lot.purchase_line_id) ?? 0) + lot.quantity,
    )
  }
}

export function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.code}: ${v.detail}`).join('\n')
}
