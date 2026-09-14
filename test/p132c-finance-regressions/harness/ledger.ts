/**
 * Ledger fixtures, RPC call builders and snapshots for the P132-C package.
 *
 * Every write goes through the public RPCs as `authenticated` with the user's claims set, the same
 * privilege path a browser request takes. Only fixture users (auth.users has an invite-gate
 * trigger) and read-only snapshots use the superuser session.
 */
import { randomUUID } from 'node:crypto'
import { PgSession, type StatementResult } from './docker-pg'

export function lit(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return String(value)
  return `'${value.replace(/'/g, "''")}'`
}

export function jsonb(value: unknown): string {
  return `${lit(JSON.stringify(value))}::jsonb`
}

let sessionCounter = 0
export function sessionName(label: string): string {
  sessionCounter += 1
  return `p132c_${label}_${String(process.pid)}_${String(sessionCounter)}`
}

export async function openAdmin(container: string, label = 'admin'): Promise<PgSession> {
  return PgSession.open(container, sessionName(label), 'supabase_admin')
}

/** A session that acts as `authenticated`; call `actAs` before issuing RPCs. */
export async function openUserSession(container: string, label: string): Promise<PgSession> {
  const session = await PgSession.open(container, sessionName(label), 'postgres')
  await session.value('set role authenticated')
  return session
}

export async function actAs(session: PgSession, userId: string): Promise<void> {
  // auth.uid() in this image reads the per-claim setting; the JSON form is what hosted reads.
  await session.value(
    `select set_config('request.jwt.claim.sub', ${lit(userId)}, false), ` +
      `set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: userId, role: 'authenticated' }))}, false)`,
  )
}

export async function createUser(admin: PgSession, label: string): Promise<string> {
  const id = randomUUID()
  // Replica mode skips the invite-gate trigger for this synthetic `.invalid` account only.
  await admin.value('set session_replication_role = replica')
  try {
    await admin.value(
      `insert into auth.users (id, aud, role, email) values (${lit(id)}, 'authenticated', 'authenticated', ${lit(`p132c-${label}-${id.slice(0, 8)}@example.invalid`)})`,
    )
    await admin.value(
      `insert into public.profiles (id) values (${lit(id)}) on conflict (id) do nothing`,
    )
  } finally {
    await admin.value('set session_replication_role = origin')
  }
  return id
}

export interface Catalog {
  sealedProductId: string
  sealedProductId2: string
  cardVariantId: string
  cardVariantId2: string
}

export async function readCatalog(admin: PgSession): Promise<Catalog> {
  const sealed = await admin.json<string[]>(
    'select jsonb_agg(id order by id) from (select id from public.sealed_products where created_by_user_id is null order by id limit 2) s',
  )
  const cards = await admin.json<string[]>(
    'select jsonb_agg(id order by id) from (select id from public.card_variants order by id limit 2) c',
  )
  if (sealed.length < 2 || cards.length < 2) throw new Error('catalog seed missing')
  return {
    sealedProductId: sealed[0] ?? '',
    sealedProductId2: sealed[1] ?? '',
    cardVariantId: cards[0] ?? '',
    cardVariantId2: cards[1] ?? '',
  }
}

// -- Snapshot --

export interface PurchaseRow {
  id: string
  purchased_on: string
  currency: string
  retailer_id: string | null
  shipping_minor: number
  customs_minor: number
  discount_minor: number
  total_minor: number
  total_nok_minor: number
  fx_rate_to_nok: number
  fx_rate_date: string
  fx_source: string
  notes: string | null
  voided_at: string | null
}

export interface LineRow {
  id: string
  purchase_id: string
  line_type: string
  description: string | null
  sealed_product_id: string | null
  card_variant_id: string | null
  quantity: number
  unit_price_minor: number
  attributable_cost_minor: number
  attributable_cost_nok_minor: number
}

export interface LotRow {
  id: string
  holding_id: string
  origin: string
  cost_basis_state: string
  purchase_line_id: string | null
  opening_id: string | null
  quantity: number
  quantity_remaining: number
  unit_cost_basis_minor: number | null
  unit_cost_basis_nok_minor: number | null
  cost_basis_currency: string | null
  residual_minor: number
  residual_nok_minor: number
  sealed_intent: string | null
  voided_at: string | null
}

export interface DisposalRow {
  id: string
  lot_id: string
  kind: string
  quantity: number
  sale_line_id: string | null
  opening_id: string | null
  voided_at: string | null
}

export interface SaleRow {
  id: string
  voided_at: string | null
  realized_result_nok_minor: number | null
  proceeds_from_uncosted_nok_minor: number
}

export interface SaleLineRow {
  id: string
  sale_id: string
  lot_id: string
  quantity: number
  cost_basis_at_sale_nok_minor: number | null
  realized_result_nok_minor: number | null
}

export interface OpeningRow {
  id: string
  source_lot_id: string
  quantity_opened: number
  cost_source: string
  cost_nok_minor: number | null
  voided_at: string | null
}

export interface HoldingRow {
  id: string
  holding_kind: string
}

export interface Snapshot {
  purchases: PurchaseRow[]
  lines: LineRow[]
  lots: LotRow[]
  disposals: DisposalRow[]
  sales: SaleRow[]
  saleLines: SaleLineRow[]
  openings: OpeningRow[]
  holdings: HoldingRow[]
}

const SNAPSHOT_TABLES: [keyof Snapshot, string][] = [
  ['purchases', 'purchases'],
  ['lines', 'purchase_lines'],
  ['lots', 'acquisition_lots'],
  ['disposals', 'lot_disposals'],
  ['sales', 'sales'],
  ['saleLines', 'sale_lines'],
  ['openings', 'openings'],
  ['holdings', 'holdings'],
]

export async function snapshot(admin: PgSession, userId: string): Promise<Snapshot> {
  const parts = SNAPSHOT_TABLES.map(
    ([key, table]) =>
      `'${key}', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]'::jsonb) from public.${table} t where t.user_id = ${lit(userId)})`,
  )
  return admin.json<Snapshot>(`select jsonb_build_object(${parts.join(', ')})`)
}

// -- RPC builders (each returns one SQL statement printing one JSON line) --

export interface NewPurchaseLine {
  line_type: 'card' | 'sealed' | 'accessory'
  quantity: number
  unit_price_minor: number
  sealed_product_id?: string
  card_variant_id?: string
  condition?: string
  sealed_intent?: string
  description?: string
}

export interface PurchaseHeader {
  purchasedOn?: string
  currency?: string
  shipping?: number
  customs?: number
  discount?: number
  fxRate?: string
  fxDate?: string
  fxSource?: 'manual' | 'norges_bank'
  notes?: string | null
}

export function createPurchaseSql(lines: NewPurchaseLine[], header: PurchaseHeader = {}): string {
  const currency = header.currency ?? 'NOK'
  return (
    'select to_jsonb(public.create_purchase(' +
    `p_purchased_on => ${lit(header.purchasedOn ?? '2026-01-10')}::date, ` +
    `p_currency => ${lit(currency)}, p_lines => ${jsonb(lines)}, ` +
    `p_shipping_minor => ${String(header.shipping ?? 0)}, p_customs_minor => ${String(header.customs ?? 0)}, ` +
    `p_discount_minor => ${String(header.discount ?? 0)}, ` +
    `p_fx_rate_to_nok => ${header.fxRate ? `${lit(header.fxRate)}::numeric` : 'null'}, ` +
    `p_fx_rate_date => ${header.fxDate ? `${lit(header.fxDate)}::date` : 'null'}, ` +
    `p_fx_source => ${header.fxSource ? `${lit(header.fxSource)}::public.fx_source` : 'null'}, ` +
    `p_notes => ${lit(header.notes ?? null)}, p_idempotency_key => ${lit(randomUUID())}::uuid))`
  )
}

export interface LineEdit {
  quantity?: number
  unit_price_minor?: number
  description?: string
}

/**
 * update_purchase restates the whole receipt. This builds the call from the current snapshot and a
 * patch, so a test only states what it changes.
 */
export function updatePurchaseSql(
  snap: Snapshot,
  purchaseId: string,
  patch: { header?: PurchaseHeader; lines?: Record<string, LineEdit> } = {},
): string {
  const purchase = snap.purchases.find((p) => p.id === purchaseId)
  if (!purchase) throw new Error(`purchase ${purchaseId} not in snapshot`)
  const h = patch.header ?? {}
  const lines = snap.lines
    .filter((l) => l.purchase_id === purchaseId)
    .map((l) => {
      const edit = patch.lines?.[l.id] ?? {}
      return {
        line_id: l.id,
        quantity: edit.quantity ?? l.quantity,
        unit_price_minor: edit.unit_price_minor ?? l.unit_price_minor,
        ...(edit.description !== undefined ? { description: edit.description } : {}),
      }
    })
  const currency = h.currency ?? purchase.currency
  const nok = currency === 'NOK'
  return (
    'select to_jsonb(public.update_purchase(' +
    `p_purchase_id => ${lit(purchaseId)}::uuid, ` +
    `p_purchased_on => ${lit(h.purchasedOn ?? purchase.purchased_on)}::date, ` +
    `p_currency => ${lit(currency)}, p_lines => ${jsonb(lines)}, ` +
    `p_retailer_id => ${purchase.retailer_id ? `${lit(purchase.retailer_id)}::uuid` : 'null'}, ` +
    `p_shipping_minor => ${String(h.shipping ?? purchase.shipping_minor)}, ` +
    `p_customs_minor => ${String(h.customs ?? purchase.customs_minor)}, ` +
    `p_discount_minor => ${String(h.discount ?? purchase.discount_minor)}, ` +
    `p_fx_rate_to_nok => ${nok ? 'null' : `${lit(h.fxRate ?? String(purchase.fx_rate_to_nok))}::numeric`}, ` +
    `p_fx_rate_date => ${nok ? 'null' : `${lit(h.fxDate ?? purchase.fx_rate_date)}::date`}, ` +
    `p_fx_source => ${nok ? 'null' : `${lit(h.fxSource ?? purchase.fx_source)}::public.fx_source`}, ` +
    `p_notes => ${lit(h.notes === undefined ? purchase.notes : h.notes)}))`
  )
}

export function setSealedIntentSql(lotId: string, intent: string, quantity: number | null): string {
  return `select to_jsonb(public.set_sealed_lot_intent(${lit(lotId)}::uuid, ${lit(intent)}::public.sealed_intent, ${quantity === null ? 'null' : String(quantity)}))`
}

export interface SaleLineInput {
  lot_id: string
  quantity: number
  unit_gross_minor: number
}

export function createSaleSql(lines: SaleLineInput[], soldOn = '2026-02-01'): string {
  return (
    'select to_jsonb(public.create_sale(' +
    `p_sold_on => ${lit(soldOn)}::date, p_currency => 'NOK', p_lines => ${jsonb(lines)}, ` +
    `p_idempotency_key => ${lit(randomUUID())}::uuid))`
  )
}

export const voidSaleSql = (saleId: string): string =>
  `select public.void_sale(${lit(saleId)}::uuid)`
export const voidPurchaseSql = (purchaseId: string): string =>
  `select public.void_purchase(${lit(purchaseId)}::uuid)`
export const voidLotSql = (lotId: string): string =>
  `select public.void_acquisition_lot(${lit(lotId)}::uuid)`
export const removeHoldingsSql = (holdingIds: string[]): string =>
  `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.remove_holdings_from_portfolio(array[${holdingIds.map((id) => `${lit(id)}::uuid`).join(', ')}]) r`
export const voidOpeningSql = (openingId: string): string =>
  `select public.void_opening(${lit(openingId)}::uuid)`

export function createOpeningSql(
  sourceLotId: string,
  quantity: number,
  pulls: { card_variant_id: string; quantity: number; condition: string }[],
): string {
  return (
    'select to_jsonb(public.create_opening(' +
    `p_source_lot_id => ${lit(sourceLotId)}::uuid, p_quantity => ${String(quantity)}, ` +
    `p_opened_on => '2026-01-20'::date, p_tracking_completeness => 'selected_pulls', ` +
    `p_pulls => ${jsonb(pulls)}, p_idempotency_key => ${lit(randomUUID())}::uuid))`
  )
}

/** Non-purchase acquisition (add card / add sealed). Unknown cost is the default. */
export function addAcquisitionSql(args: {
  sealedProductId?: string
  cardVariantId?: string
  condition?: string
  quantity: number
  origin?: string
  costState?: 'known' | 'unknown' | 'not_paid'
  unitCost?: number
}): string {
  return (
    "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.add_card_acquisition(" +
    `p_card_variant_id => ${args.cardVariantId ? `${lit(args.cardVariantId)}::uuid` : 'null'}, ` +
    `p_sealed_product_id => ${args.sealedProductId ? `${lit(args.sealedProductId)}::uuid` : 'null'}, ` +
    `p_condition => ${args.condition ? `${lit(args.condition)}::public.card_condition` : 'null'}, ` +
    `p_origin => ${lit(args.origin ?? 'pre_tracking')}::public.lot_origin, ` +
    `p_cost_basis_state => ${lit(args.costState ?? 'unknown')}::public.cost_basis_state, ` +
    `p_unit_cost_basis_minor => ${args.unitCost === undefined ? 'null' : String(args.unitCost)}, ` +
    `p_quantity => ${String(args.quantity)}, p_acquired_on => '2026-01-05'::date) r`
  )
}

// -- Outcome classification --

export type OutcomeKind =
  | 'ok'
  | 'domain_rejection'
  | 'retryable_conflict'
  | 'deadlock'
  | 'constraint_violation'
  | 'unexpected_error'

export interface Outcome {
  kind: OutcomeKind
  sqlstate: string | null
  message: string | null
  rows: string[]
}

/**
 * A "stable domain rejection" is an error the function raises on purpose: PL/pgSQL `raise`
 * (class P0) or the explicit parameter/prerequisite states. A raw constraint violation (class 23)
 * is NOT one: it means the function attempted a write the schema had to stop, so the guard that
 * should have refused the operation is missing. Serialization failure is accepted as an explicit
 * conflict a client can retry. Deadlock is recorded separately: it is not corruption, but it is the
 * signature of inconsistent lock ordering.
 */
export function classify(result: StatementResult): Outcome {
  const base = { sqlstate: result.sqlstate, message: result.message, rows: result.rows }
  if (result.ok) return { kind: 'ok', ...base }
  const state = result.sqlstate ?? ''
  if (state === '40P01') return { kind: 'deadlock', ...base }
  if (state === '40001') return { kind: 'retryable_conflict', ...base }
  if (state.startsWith('P0') || state === '22023' || state === '55000' || state === '55P03') {
    return { kind: 'domain_rejection', ...base }
  }
  if (state.startsWith('23')) return { kind: 'constraint_violation', ...base }
  return { kind: 'unexpected_error', ...base }
}

export function describeOutcome(outcome: Outcome): string {
  return outcome.kind === 'ok'
    ? 'ok'
    : `${outcome.kind} ${outcome.sqlstate ?? ''} ${outcome.message ?? ''}`.trim()
}
