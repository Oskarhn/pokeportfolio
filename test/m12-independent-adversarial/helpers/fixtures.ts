import {
  createServiceClient,
  createSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../../../tests/db/setup'
import { bindParams, contractViolation, type M12Surface } from './contract'

/**
 * Deterministic event-sequence builders over the REAL product write paths (create_purchase,
 * create_sale, update_purchase, void_sale, set_manual_valuation, clear_manual_valuation) plus
 * service-role market-data facts (price_snapshots / fx_rates), which have no user write path by
 * design.
 *
 * All dates are fixed historical ISO strings — never relative to "today" — because the whole
 * point of this suite is historical correctness. Money is integer minor units everywhere.
 */

const BASE = new Date(Date.UTC(2026, 2, 1)) // 2026-03-01

/** Day n of the deterministic calendar: day(0) = 2026-03-01, day(1) = 2026-03-02, ... */
export function day(n: number): string {
  const d = new Date(BASE)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export interface FixtureEnv {
  service: TestClient
  user: SyntheticUser
  client: TestClient
}

export async function makeEnv(label: string): Promise<FixtureEnv> {
  const service = createServiceClient()
  const user = await createSyntheticUser(service, label)
  const client = await signInAs(user)
  return { service, user, client }
}

let catalogCounter = 0

export interface SynthVariant {
  cardId: string
  variantId: string
}

/**
 * Creates a private synthetic card + variant in the shared catalog under the service role.
 * Distinct rows per call keep price_snapshots' (variant, provider, date) uniqueness isolated
 * from every other suite sharing the ephemeral database.
 */
export async function makeVariant(env: FixtureEnv, tag: string): Promise<SynthVariant> {
  catalogCounter += 1
  const suffix = `${tag}-${catalogCounter}`
  const seriesId = crypto.randomUUID()
  const setId = crypto.randomUUID()
  const cardId = crypto.randomUUID()
  const variantId = crypto.randomUUID()

  const { error: seriesError } = await env.service.from('card_series').insert({
    id: seriesId,
    slug: `adv-series-${suffix}`,
    name: `Adv Series ${suffix}`,
    language: 'en',
    tcgdex_series_id: `adv-${suffix}`,
    is_active: true,
  })
  if (seriesError) throw new Error(`series insert failed: ${seriesError.message}`)

  const { error: setError } = await env.service.from('card_sets').insert({
    id: setId,
    series_id: seriesId,
    slug: `adv-set-${suffix}`,
    name: `Adv Set ${suffix}`,
    language: 'en',
    card_count_official: 1,
    card_count_total: 1,
    released_on: '2025-01-01',
    is_active: true,
  })
  if (setError) throw new Error(`set insert failed: ${setError.message}`)

  const { error: cardError } = await env.service.from('cards').insert({
    id: cardId,
    set_id: setId,
    local_id: `${catalogCounter}`,
    name: `Adversarial ${suffix}`,
    category: 'Pokemon',
    language: 'en',
    is_active: true,
  })
  if (cardError) throw new Error(`card insert failed: ${cardError.message}`)

  const { error: variantError } = await env.service.from('card_variants').insert({
    id: variantId,
    card_id: cardId,
    finish: 'normal',
    stamp: '',
    subtype: '',
    size: 'standard',
    is_active: true,
  })
  if (variantError) throw new Error(`variant insert failed: ${variantError.message}`)

  return { cardId, variantId }
}

export interface Acquisition {
  purchaseId: string
  lotId: string
  holdingId: string
}

async function singleLineLotIds(
  env: FixtureEnv,
  purchaseId: string,
): Promise<{ lotId: string; holdingId: string }> {
  const { data: line, error } = await env.service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchaseId)
    .limit(1)
    .single()
  if (error || !line)
    throw new Error(`purchase line not found for ${purchaseId}: ${error?.message}`)
  const { data: lot, error: lotError } = await env.service
    .from('acquisition_lots')
    .select('id, holding_id')
    .eq('purchase_line_id', line.id)
    .single()
  if (lotError || !lot) throw new Error(`lot not found for line: ${lotError?.message}`)
  return { lotId: lot.id as string, holdingId: lot.holding_id as string }
}

export async function acquireRaw(
  env: FixtureEnv,
  variantId: string,
  on: string,
  unitPriceMinor: number,
  quantity = 1,
): Promise<Acquisition> {
  const { data: purchase, error } = await env.client
    .rpc('create_purchase', {
      p_purchased_on: on,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: variantId,
          condition: 'NM',
          quantity,
          unit_price_minor: unitPriceMinor,
        },
      ],
    })
    .single<{ id: string }>()
  if (error || !purchase) throw new Error(`create_purchase failed: ${error?.message}`)
  const { lotId, holdingId } = await singleLineLotIds(env, purchase.id)
  return { purchaseId: purchase.id, lotId, holdingId }
}

export async function acquireSealed(
  env: FixtureEnv,
  sealedProductId: string,
  on: string,
  unitPriceMinor: number,
): Promise<Acquisition> {
  const { data: purchase, error } = await env.client
    .rpc('create_purchase', {
      p_purchased_on: on,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: sealedProductId,
          quantity: 1,
          unit_price_minor: unitPriceMinor,
        },
      ],
    })
    .single<{ id: string }>()
  if (error || !purchase) throw new Error(`sealed create_purchase failed: ${error?.message}`)
  const { lotId, holdingId } = await singleLineLotIds(env, purchase.id)
  return { purchaseId: purchase.id, lotId, holdingId }
}

export interface SaleResult {
  saleId: string
  netProceedsNokMinor: number
}

export async function sellLots(
  env: FixtureEnv,
  on: string,
  lines: { lotId: string; quantity: number; unitGrossMinor: number }[],
  feesMinor = 0,
): Promise<SaleResult> {
  const { data: sale, error } = await env.client
    .rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: on,
      p_currency: 'NOK',
      p_fees_minor: feesMinor,
      p_lines: lines.map((l) => ({
        lot_id: l.lotId,
        quantity: l.quantity,
        unit_gross_minor: l.unitGrossMinor,
      })),
    })
    .single<{ id: string; net_proceeds_nok_minor: number }>()
  if (error || !sale) throw new Error(`create_sale failed: ${error?.message}`)
  return { saleId: sale.id, netProceedsNokMinor: Number(sale.net_proceeds_nok_minor) }
}

/** The documented correction path for moving a sale's date: void, then re-enter. */
export async function voidSale(env: FixtureEnv, saleId: string): Promise<void> {
  const { error } = await env.client.rpc('void_sale', { p_sale_id: saleId })
  if (error) throw new Error(`void_sale failed: ${error.message}`)
}

/** Backdates an existing acquisition through the real edit path (dates are editable, F3). */
export async function backdateAcquisition(
  env: FixtureEnv,
  acq: Acquisition,
  quantity: number,
  unitPriceMinor: number,
  newOn: string,
): Promise<void> {
  const { data: line } = await env.service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', acq.purchaseId)
    .limit(1)
    .single()
  if (!line) throw new Error('no line to edit')
  const { error } = await env.client.rpc('update_purchase', {
    p_purchase_id: acq.purchaseId,
    p_purchased_on: newOn,
    p_currency: 'NOK',
    p_lines: [{ line_id: line.id, quantity, unit_price_minor: unitPriceMinor }],
  })
  if (error) throw new Error(`update_purchase failed: ${error.message}`)
}

export async function setManual(
  env: FixtureEnv,
  holdingId: string,
  valueMinor: number,
  effectiveFrom?: string,
): Promise<void> {
  const args: Record<string, unknown> = { p_holding_id: holdingId, p_value_minor: valueMinor }
  if (effectiveFrom !== undefined) args.p_effective_from = effectiveFrom
  const { error } = await env.client.rpc('set_manual_valuation', args)
  if (error) throw new Error(`set_manual_valuation failed: ${error.message}`)
}

export async function clearManual(env: FixtureEnv, holdingId: string): Promise<void> {
  const { error } = await env.client.rpc('clear_manual_valuation', { p_holding_id: holdingId })
  if (error) throw new Error(`clear_manual_valuation failed: ${error.message}`)
}

/**
 * Restamps the latest superseded manual-valuation row's superseded_at to an explicit timestamp.
 * The RPC stamps wall-clock now(), which lands far outside this suite's fixed 2026-03 calendar;
 * placing the clear on a specific business day is what makes "cleared mid-history, then an
 * independent later valuation arrives" (D-062's resolved corner) constructible deterministically.
 */
export async function stampSupersession(
  env: FixtureEnv,
  holdingId: string,
  stampedAtIso: string,
): Promise<void> {
  const { data, error } = await env.service
    .from('manual_valuations')
    .select('id')
    .eq('holding_id', holdingId)
    .not('superseded_at', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (error || !data) throw new Error(`no superseded row to restamp on ${holdingId}`)
  const { error: updateError } = await env.service
    .from('manual_valuations')
    .update({ superseded_at: stampedAtIso })
    .eq('id', data.id)
  if (updateError) throw new Error(`restamping superseded_at failed: ${updateError.message}`)
}

export type Provider = 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'

export async function setProviderPrice(
  env: FixtureEnv,
  variantId: string,
  provider: Provider,
  valueMinor: number,
  snapshotDate: string,
): Promise<void> {
  const { error } = await env.service.from('price_snapshots').upsert(
    {
      card_variant_id: variantId,
      provider,
      price_kind: provider === 'tcgdex_cardmarket' ? 'cm_trend' : 'tp_market',
      source_currency: provider === 'tcgdex_cardmarket' ? 'EUR' : 'USD',
      value_minor: valueMinor,
      snapshot_date: snapshotDate,
      provider_updated_at: `${snapshotDate}T12:00:00Z`,
    },
    { onConflict: 'card_variant_id,provider,snapshot_date' },
  )
  if (error) throw new Error(`price upsert failed: ${error.message}`)
}

/** A provider CORRECTION: same (variant, provider, date), new value — scenario I's lever. */
export async function correctProviderPrice(
  env: FixtureEnv,
  variantId: string,
  provider: Provider,
  snapshotDate: string,
  newValueMinor: number,
): Promise<void> {
  await setProviderPrice(env, variantId, provider, newValueMinor, snapshotDate)
}

export async function setFxRate(
  env: FixtureEnv,
  currency: 'EUR' | 'USD',
  rateDate: string,
  rate: string,
): Promise<void> {
  const { error } = await env.service.from('fx_rates').upsert(
    {
      base_currency: currency,
      quote_currency: 'NOK',
      rate_date: rateDate,
      rate,
      source: 'norges_bank',
    },
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
  if (error) throw new Error(`fx upsert failed: ${error.message}`)
}

// ---------------------------------------------------------------------------
// Snapshot cache reads and engine invocation
// ---------------------------------------------------------------------------

export interface QueueRow {
  user_id: string
  dirty_from: string
}

export async function readQueueRow(env: FixtureEnv): Promise<QueueRow | null> {
  const { data, error } = await env.service
    .from('portfolio_recompute_queue')
    .select('user_id, dirty_from')
    .eq('user_id', env.user.id)
    .maybeSingle()
  if (error) throw new Error(`queue read failed: ${error.message}`)
  return (data as QueueRow | null) ?? null
}

export async function drainQueue(surface: M12Surface): Promise<void> {
  if (!surface.drain) throw contractViolation('drain_portfolio_recompute_queue does not exist')
  const { error } = await envlessRpc(surface.drain.name, {})
  if (error) throw new Error(`drain failed: ${error.message}`)
}

async function envlessRpc(name: string, args: Record<string, unknown>) {
  const service = createServiceClient()
  return service.rpc(name, args)
}

export interface SnapshotRow {
  snapshot_date: string
  computed_at?: string | null
  [column: string]: unknown
}

const SEMANTIC_COLUMNS = [
  'market_value_nok_minor',
  'attributed_value_nok_minor',
  'cost_basis_nok_minor',
  'collectible_spend_to_date_nok_minor',
  'sales_proceeds_to_date_nok_minor',
  'open_lot_count',
  'unvalued_lot_count',
] as const

export async function readSnapshots(env: FixtureEnv): Promise<SnapshotRow[]> {
  const columns = ['snapshot_date', ...SEMANTIC_COLUMNS].join(', ')
  const { data, error } = await env.service
    .from('portfolio_snapshots')
    .select(columns)
    .eq('user_id', env.user.id)
    .order('snapshot_date')
  if (error) throw new Error(`snapshot read failed: ${error.message}`)
  return (data ?? []) as unknown as SnapshotRow[]
}

/** Full rebuild across a range, via the discovered engine signature (see helpers/contract.ts). */
export async function fullRebuild(
  surface: M12Surface,
  userId: string,
  from: string,
  through: string,
): Promise<void> {
  if (!surface.rebuild) throw contractViolation('rebuild_portfolio_snapshots does not exist')
  const args = bindParams(surface.rebuild, { user: userId, from, through })
  const { error } = await envlessRpc(surface.rebuild.name, args)
  if (error) throw new Error(`rebuild failed: ${error.message}`)
}

export function semanticColumns(): readonly string[] {
  return SEMANTIC_COLUMNS
}
