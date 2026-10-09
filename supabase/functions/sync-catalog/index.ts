/**
 * sync-catalog — ingests one (language, TCGdex set) pair into the shared catalog per invocation.
 *
 * Not user-reachable. Gated by a bearer secret (`CATALOG_SYNC_SECRET`, an Edge Function secret set
 * with `supabase secrets set`, distinct from and no more sensitive than a CI deploy key) rather
 * than a Supabase user JWT, because the caller is an operator-run script
 * (`scripts/run-catalog-sync.mjs`), not a signed-in user — there is no admin session to require.
 * `verify_jwt = false` in supabase/config.toml, same mechanical reason as redeem-invitation
 * (docs/SECURITY.md §5), different actual authentication: a secret only the operator holds, not a
 * token bound to an invited email address.
 *
 * One set per call, deliberately (M5 prompt §30): a set can hold several hundred cards, each
 * needing its own TCGdex request, and Edge Functions have a wall-clock budget. Bounded internal
 * concurrency (docs/API_SOURCES.md's "no published hard limit, but be considerate") fetches card
 * detail a few at a time rather than serially or unbounded. The caller
 * (scripts/run-catalog-sync.mjs) iterates sets one call per set, so a single failed set never
 * requires re-running the whole language — resumability lives in that loop plus the
 * `catalog_sync_runs` row this function writes for every attempt, success or failure.
 *
 * Idempotent by construction: every upsert conflicts on the same (language, tcgdex_id) unique
 * index the M5 migrations added, so re-running a set twice changes nothing but timestamps.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import {
  fetchCardDetail,
  fetchSetDetail,
  isPocketSeries,
  TcgdexNotFoundError,
  type Language,
  type ProviderCard,
} from '../_shared/tcgdex.ts'
import { resolveServiceRoleKey } from '../_shared/service-key.ts'
import { classifyFailure, mapWithConcurrency } from '../_shared/batch.ts'
import { logEvent } from '../_shared/log.ts'

const CARD_FETCH_CONCURRENCY = 5
/** Below this share of the currently-active cards, a set listing is treated as a provider glitch. */
const MIN_PLAUSIBLE_LISTING_SHARE = 0.5
const MIN_ACTIVE_FOR_SHRINK_GUARD = 10

interface SyncBody {
  language?: unknown
  setId?: unknown
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Constant-time enough for a secret this short-lived and this narrowly held; avoids the obvious `===` timing tell. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' })
  }

  const expectedSecret = Deno.env.get('CATALOG_SYNC_SECRET')
  const authHeader = request.headers.get('Authorization') ?? ''
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return json(401, { error: 'unauthorized' })
  }

  let body: SyncBody
  try {
    body = (await request.json()) as SyncBody
  } catch {
    return json(400, { error: 'bad_request' })
  }

  const language = body.language
  const setId = body.setId
  if (
    (language !== 'en' && language !== 'ja') ||
    typeof setId !== 'string' ||
    setId.length === 0 ||
    setId.length > 64
  ) {
    return json(400, {
      error: 'bad_request',
      message: 'language must be "en"/"ja"; setId required',
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = resolveServiceRoleKey()
  if (!supabaseUrl || !serviceRoleKey) {
    logEvent('sync-catalog', 'misconfigured', {}, 'error')
    return json(500, { error: 'server_error' })
  }
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = new Date().toISOString()

  async function recordRun(
    status: 'succeeded' | 'failed' | 'skipped_pocket',
    counts: { cardsSeen: number; cardsUpserted: number; variantsUpserted: number },
    tcgdexSeriesId: string | null,
    error: string | null,
  ) {
    await db.from('catalog_sync_runs').insert({
      language,
      tcgdex_set_id: setId,
      tcgdex_series_id: tcgdexSeriesId,
      status,
      cards_seen: counts.cardsSeen,
      cards_upserted: counts.cardsUpserted,
      variants_upserted: counts.variantsUpserted,
      error,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })
  }

  let setDetail
  try {
    setDetail = await fetchSetDetail(language as Language, setId)
  } catch (error) {
    if (error instanceof TcgdexNotFoundError) {
      await recordRun(
        'failed',
        { cardsSeen: 0, cardsUpserted: 0, variantsUpserted: 0 },
        null,
        'set not found',
      )
      return json(404, { error: 'set_not_found' })
    }
    const message = error instanceof Error ? error.message : 'unknown error'
    logEvent(
      'sync-catalog',
      'set_detail_failed',
      { language: String(language), set_id: setId, failure_kind: classifyFailure(error) },
      'warn',
    )
    await recordRun(
      'failed',
      { cardsSeen: 0, cardsUpserted: 0, variantsUpserted: 0 },
      null,
      message,
    )
    return json(502, { error: 'provider_error' })
  }

  if (isPocketSeries(setDetail.series.tcgdexSeriesId)) {
    await recordRun(
      'skipped_pocket',
      { cardsSeen: 0, cardsUpserted: 0, variantsUpserted: 0 },
      setDetail.series.tcgdexSeriesId,
      null,
    )
    return json(200, { ok: true, skipped: 'pocket' })
  }

  // Series and set are shared, keyed by (language, tcgdex_*_id) — upsert is safe to repeat.
  const { data: series, error: seriesError } = await db
    .from('card_series')
    .upsert(
      {
        slug: setDetail.series.tcgdexSeriesId,
        name: setDetail.series.name,
        language,
        tcgdex_series_id: setDetail.series.tcgdexSeriesId,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'language,tcgdex_series_id' },
    )
    .select('id')
    .single()

  if (seriesError || !series) {
    const message = seriesError?.message ?? 'series upsert returned no row'
    logEvent(
      'sync-catalog',
      'series_upsert_failed',
      { language: String(language), set_id: setId },
      'error',
    )
    await recordRun(
      'failed',
      { cardsSeen: 0, cardsUpserted: 0, variantsUpserted: 0 },
      setDetail.series.tcgdexSeriesId,
      message,
    )
    return json(500, { error: 'server_error' })
  }

  const { data: set, error: setError } = await db
    .from('card_sets')
    .upsert(
      {
        series_id: series.id,
        slug: setDetail.tcgdexSetId,
        name: setDetail.name,
        language,
        card_count_official: setDetail.cardCountOfficial,
        card_count_total: setDetail.cardCountTotal,
        released_on: setDetail.releasedOn,
        logo_url: setDetail.logoUrl,
        symbol_url: setDetail.symbolUrl,
        tcgdex_set_id: setDetail.tcgdexSetId,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'language,tcgdex_set_id' },
    )
    .select('id')
    .single()

  if (setError || !set) {
    const message = setError?.message ?? 'set upsert returned no row'
    logEvent(
      'sync-catalog',
      'set_upsert_failed',
      { language: String(language), set_id: setId },
      'error',
    )
    await recordRun(
      'failed',
      { cardsSeen: 0, cardsUpserted: 0, variantsUpserted: 0 },
      setDetail.series.tcgdexSeriesId,
      message,
    )
    return json(500, { error: 'server_error' })
  }

  let cardsUpserted = 0
  let variantsUpserted = 0
  const failures: string[] = []

  const results = await mapWithConcurrency(
    setDetail.cardIds,
    CARD_FETCH_CONCURRENCY,
    async (tcgdexCardId) => {
      const card = await fetchCardDetail(language as Language, tcgdexCardId)
      return card
    },
  )

  const nowIso = new Date().toISOString()
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    const tcgdexCardId = setDetail.cardIds[i]!
    if (result.status === 'rejected') {
      const message = result.reason instanceof Error ? result.reason.message : 'unknown error'
      failures.push(`${tcgdexCardId}: ${message}`)
      continue
    }
    const card: ProviderCard = result.value

    const { data: cardRow, error: cardError } = await db
      .from('cards')
      .upsert(
        {
          set_id: set.id,
          local_id: card.localId,
          name: card.name,
          rarity: card.rarity,
          category: card.category,
          illustrator: card.illustrator,
          image_base_url: card.imageBaseUrl,
          language,
          tcgdex_card_id: card.tcgdexCardId,
          is_active: true,
          last_seen_at: nowIso,
        },
        { onConflict: 'language,tcgdex_card_id' },
      )
      .select('id')
      .single()

    if (cardError || !cardRow) {
      failures.push(`${tcgdexCardId}: ${cardError?.message ?? 'card upsert returned no row'}`)
      continue
    }
    cardsUpserted++

    for (const variant of card.variants) {
      const { error: variantError } = await db.from('card_variants').upsert(
        {
          card_id: cardRow.id,
          finish: variant.finish,
          stamp: variant.stamp,
          subtype: variant.subtype,
          size: variant.size,
          tcgdex_variant_id: variant.tcgdexVariantId,
          cardmarket_product_id: variant.cardmarketProductId,
          tcgplayer_product_id: variant.tcgplayerProductId,
          is_active: true,
          last_seen_at: nowIso,
        },
        { onConflict: 'card_id,finish,stamp,subtype,size', ignoreDuplicates: false },
      )
      if (variantError) {
        failures.push(`${tcgdexCardId} variant ${variant.finish}: ${variantError.message}`)
        continue
      }
      variantsUpserted++
    }
  }

  // Cards TCGdex no longer lists for this set are deactivated, never deleted (M5 prompt §19/§59) —
  // a holding pointing at a deactivated variant stays valid, it just stops appearing in search.
  //
  // "No longer lists" is decided from the set LISTING (`setDetail.cardIds`), never from which card
  // detail requests happened to succeed. It used to be the latter: a rate-limit or 5xx burst on the
  // detail endpoint left `seen` short, and every card whose detail request had merely failed was
  // deactivated — vanishing from search until a later full re-sync, with nothing recorded about it.
  // Two further guards: an empty listing never deactivates anything, and a listing that is less than
  // half of what is currently active is treated as a provider glitch, not as a mass removal.
  const listedIds = [...new Set(setDetail.cardIds)]
  let deactivationNote: string | null = null
  if (listedIds.length === 0) {
    deactivationNote = 'deactivation skipped: provider listed no cards'
  } else {
    const { count: activeCount, error: countError } = await db
      .from('cards')
      .select('id', { count: 'exact', head: true })
      .eq('set_id', set.id)
      .eq('language', language)
      .eq('is_active', true)
    if (countError) {
      deactivationNote = 'deactivation skipped: could not count active cards'
    } else if (
      (activeCount ?? 0) >= MIN_ACTIVE_FOR_SHRINK_GUARD &&
      listedIds.length < (activeCount ?? 0) * MIN_PLAUSIBLE_LISTING_SHARE
    ) {
      deactivationNote = `deactivation skipped: listing has ${listedIds.length} of ${activeCount} active cards`
    } else {
      const { error: deactivateError } = await db
        .from('cards')
        .update({ is_active: false })
        .eq('set_id', set.id)
        .eq('language', language)
        .not('tcgdex_card_id', 'in', `(${listedIds.map((id) => `"${id}"`).join(',')})`)
      if (deactivateError) deactivationNote = 'deactivation failed'
    }
  }
  if (deactivationNote !== null) failures.push(deactivationNote)

  const status = failures.length === 0 ? 'succeeded' : cardsUpserted > 0 ? 'succeeded' : 'failed'
  await recordRun(
    status,
    { cardsSeen: setDetail.cardIds.length, cardsUpserted, variantsUpserted },
    setDetail.series.tcgdexSeriesId,
    failures.length > 0 ? failures.slice(0, 20).join('; ') : null,
  )

  logEvent(
    'sync-catalog',
    'set_finished',
    {
      language: String(language),
      set_id: setId,
      status,
      cards_seen: setDetail.cardIds.length,
      cards_upserted: cardsUpserted,
      variants_upserted: variantsUpserted,
      failure_count: failures.length,
    },
    failures.length === 0 ? 'info' : 'warn',
  )

  return json(200, {
    ok: true,
    language,
    setId,
    cardsSeen: setDetail.cardIds.length,
    cardsUpserted,
    variantsUpserted,
    failureCount: failures.length,
    // Additive: lets the operator script re-run a set that did not fully land instead of treating
    // every HTTP 200 as "done".
    complete: failures.length === 0,
  })
})
