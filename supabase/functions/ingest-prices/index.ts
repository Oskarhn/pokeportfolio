/**
 * ingest-prices — bounded, idempotent Cardmarket/TCGplayer price ingest for watched card variants
 * (docs/ROADMAP.md M9, prompt §22/§26-28).
 *
 * Not user-reachable — same authentication shape as sync-catalog (M5): a bearer operator secret
 * (`PRICE_SYNC_SECRET`), `verify_jwt = false` in supabase/config.toml, called by pg_cron via
 * pg_net with the secret read from Supabase Vault at call time (never a migration literal, never
 * logged — see the cron-scheduling migration for the calling side).
 *
 * One invocation processes one bounded batch (`select_price_sync_batch`, oldest-last-synced-first)
 * so ~3-4k watched variants cycle through over many short cron ticks rather than one Edge Function
 * call trying to fetch thousands of cards before the platform's wall-clock budget runs out. Cards
 * are fetched once and deduplicated (prompt §27) even when several watched variants share one
 * `cards.id` — an Energy card can easily have four or five watched finishes.
 *
 * Mapping is delegated entirely to `_shared/tcgdex.ts#fetchCardPricing`, which already encodes the
 * variant-safe, ambiguity-averse mapping rules (prompt §14-15): a variant with no unambiguous
 * candidate resolves to `null` here, and this function simply does not write a row for it — never
 * a guess, never a zero. A genuinely observed zero price is written as-is (F14).
 */
import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import { fetchCardPricing, TcgdexNotFoundError, type Language } from '../_shared/tcgdex.ts'
import { resolveServiceRoleKey } from '../_shared/service-key.ts'

const DEFAULT_BATCH_SIZE = 200
const CARD_FETCH_CONCURRENCY = 5

interface WatchedVariantRow {
  card_variant_id: string
  card_id: string
  tcgdex_card_id: string
  language: string
  finish: string
  stamp: string
  subtype: string
  size: string
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!) }
      } catch (error) {
        results[i] = { status: 'rejected', reason: error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' })
  }

  const expectedSecret = Deno.env.get('PRICE_SYNC_SECRET')
  const authHeader = request.headers.get('Authorization') ?? ''
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return json(401, { error: 'unauthorized' })
  }

  let batchSize = DEFAULT_BATCH_SIZE
  try {
    const body = (await request.json().catch(() => ({}))) as { batchSize?: unknown }
    if (typeof body.batchSize === 'number' && Number.isFinite(body.batchSize)) {
      batchSize = Math.max(1, Math.min(2000, Math.trunc(body.batchSize)))
    }
  } catch {
    // no body is fine; default batch size applies
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = resolveServiceRoleKey()
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('ingest-prices is missing its Supabase environment configuration')
    return json(500, { error: 'server_error' })
  }
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = new Date().toISOString()

  const { data: batch, error: batchError } = await db.rpc('select_price_sync_batch', {
    p_batch_size: batchSize,
  })
  if (batchError) {
    console.error('ingest-prices: select_price_sync_batch failed', batchError.message)
    await db.from('price_sync_runs').insert({
      kind: 'prices',
      status: 'failed',
      error: batchError.message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })
    return json(500, { error: 'server_error' })
  }

  const rows = (batch ?? []) as WatchedVariantRow[]
  if (rows.length === 0) {
    await db.from('price_sync_runs').insert({
      kind: 'prices',
      status: 'succeeded',
      batch_size: 0,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })
    return json(200, { ok: true, variantsConsidered: 0 })
  }

  // Card-level fetch deduplication (prompt §27): one TCGdex request per (language, tcgdex_card_id)
  // even when several watched variants share it.
  const cardKey = (language: string, tcgdexCardId: string) => `${language}:${tcgdexCardId}`
  const cardsToFetch = new Map<string, { language: Language; tcgdexCardId: string }>()
  for (const row of rows) {
    const key = cardKey(row.language, row.tcgdex_card_id)
    if (!cardsToFetch.has(key)) {
      cardsToFetch.set(key, {
        language: row.language as Language,
        tcgdexCardId: row.tcgdex_card_id,
      })
    }
  }

  const fetchResults = await mapWithConcurrency(
    [...cardsToFetch.entries()],
    CARD_FETCH_CONCURRENCY,
    async ([key, { language, tcgdexCardId }]) => {
      const pricing = await fetchCardPricing(language, tcgdexCardId)
      return { key, pricing }
    },
  )

  const pricingByCard = new Map<
    string,
    Awaited<ReturnType<typeof fetchCardPricing>> | { error: string }
  >()
  let providerErrorCount = 0
  let cardsFetched = 0
  for (const result of fetchResults) {
    if (result.status === 'fulfilled') {
      pricingByCard.set(result.value.key, result.value.pricing)
      cardsFetched++
    } else {
      const message =
        result.reason instanceof TcgdexNotFoundError
          ? 'not found'
          : result.reason instanceof Error
            ? result.reason.message
            : 'unknown error'
      providerErrorCount++
      console.error('ingest-prices: fetchCardPricing failed', message)
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10)
  const snapshotRows: {
    card_variant_id: string
    provider: string
    price_kind: string
    source_currency: string
    value_minor: number
    snapshot_date: string
    provider_updated_at: string | null
  }[] = []
  let missingProviderCount = 0

  for (const row of rows) {
    const key = cardKey(row.language, row.tcgdex_card_id)
    const pricing = pricingByCard.get(key)
    if (!pricing || 'error' in pricing) continue

    const match = pricing.variants.find(
      (v) =>
        v.finish === row.finish &&
        v.stamp === row.stamp &&
        v.subtype === row.subtype &&
        v.size === row.size,
    )
    if (!match) {
      missingProviderCount++
      continue
    }

    let wroteAny = false
    for (const candidate of [match.cardmarket, match.tcgplayer]) {
      if (!candidate) continue
      wroteAny = true
      const snapshotDate = candidate.providerUpdatedAt
        ? candidate.providerUpdatedAt.slice(0, 10)
        : todayIso
      snapshotRows.push({
        card_variant_id: row.card_variant_id,
        provider: candidate.provider,
        price_kind: candidate.priceKind,
        source_currency: candidate.sourceCurrency,
        value_minor: Number(candidate.valueMinor),
        snapshot_date: snapshotDate,
        provider_updated_at: candidate.providerUpdatedAt,
      })
    }
    if (!wroteAny) missingProviderCount++
  }

  let snapshotsWritten = 0
  const upsertFailures: string[] = []
  // Batched upsert, chunked to keep each request small.
  const CHUNK = 500
  for (let i = 0; i < snapshotRows.length; i += CHUNK) {
    const chunk = snapshotRows.slice(i, i + CHUNK)
    const { error, count } = await db
      .from('price_snapshots')
      .upsert(chunk, { onConflict: 'card_variant_id,provider,snapshot_date', count: 'exact' })
    if (error) {
      upsertFailures.push(error.message)
    } else {
      snapshotsWritten += count ?? chunk.length
    }
  }

  const status = upsertFailures.length > 0 && snapshotsWritten === 0 ? 'failed' : 'succeeded'
  await db.from('price_sync_runs').insert({
    kind: 'prices',
    status,
    batch_size: rows.length,
    cards_fetched: cardsFetched,
    variants_considered: rows.length,
    snapshots_written: snapshotsWritten,
    missing_provider_count: missingProviderCount,
    provider_error_count: providerErrorCount,
    error: upsertFailures.length > 0 ? upsertFailures.slice(0, 5).join('; ') : null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  })

  return json(200, {
    ok: true,
    variantsConsidered: rows.length,
    cardsFetched,
    snapshotsWritten,
    missingProviderCount,
    providerErrorCount,
  })
})
