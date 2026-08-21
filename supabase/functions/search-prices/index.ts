/**
 * search-prices — on-demand, non-persisted current price references for Search/Card Detail
 * (docs/ROADMAP.md M9, prompt §48-50/§78-80).
 *
 * Watched-variant snapshotting intentionally covers owned/history variants only (DATA_MODEL.md
 * §4.2) — most catalog cards a user searches are never owned, so they have no `price_snapshots`
 * row and never will unless acquired. This function answers "what does this look like on
 * Cardmarket/TCGplayer right now" for a small, caller-bounded batch of *catalog* cards, using the
 * exact same variant-safe mapper `ingest-prices` uses (`_shared/tcgdex.ts#fetchCardPricing`), but
 * never writes to `price_snapshots` — a search does not become history (prompt §50).
 *
 * User-reachable, unlike ingest-prices/ingest-fx: `verify_jwt = true` (the platform default,
 * supabase/config.toml does not opt this function out of it), so a request needs a real signed-in
 * session before this code runs at all — the same shape as `fetch-fx-rate`. No service-role write
 * capability is needed since nothing here mutates the database; the service key below is used only
 * to read shared catalog rows (card_variants/cards), which is exactly what `authenticated` already
 * has plain SELECT on — using the service role here is a read-only convenience, not a privilege
 * escalation (prompt §78's "no service role required if it is read-only" is satisfied in spirit:
 * this function performs no write of any kind).
 *
 * Bounded batch (<=20 cards) and bounded TCGdex concurrency — never one browser request per card
 * (prompt §48's explicit "do not request every result individually from React").
 */
import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import { fetchCardPricing, TcgdexNotFoundError, type Language } from '../_shared/tcgdex.ts'
import { resolveServiceRoleKey } from '../_shared/service-key.ts'

const MAX_CARD_IDS = 20
const FETCH_CONCURRENCY = 5
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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

  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, { error: 'unauthorized' })
  }

  let body: { cardIds?: unknown; useEuPricing?: unknown }
  try {
    body = (await request.json()) as { cardIds?: unknown; useEuPricing?: unknown }
  } catch {
    return json(400, { error: 'bad_request' })
  }

  const cardIds = Array.isArray(body.cardIds) ? body.cardIds : null
  if (
    !cardIds ||
    cardIds.length === 0 ||
    cardIds.length > MAX_CARD_IDS ||
    !cardIds.every((id) => typeof id === 'string' && UUID_SHAPE.test(id))
  ) {
    return json(400, { error: 'bad_request', message: `cardIds must be 1-${MAX_CARD_IDS} uuids` })
  }
  const useEuPricing = body.useEuPricing !== false

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = resolveServiceRoleKey()
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('search-prices is missing its Supabase environment configuration')
    return json(500, { error: 'server_error' })
  }
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: variantRows, error: variantError } = await db
    .from('card_variants')
    .select('id, card_id, finish, stamp, subtype, size, cards!inner(id, tcgdex_card_id, language)')
    .in('card_id', cardIds as string[])

  if (variantError) {
    console.error('search-prices: card_variants lookup failed', variantError.message)
    return json(500, { error: 'server_error' })
  }

  interface VariantRow {
    id: string
    card_id: string
    finish: string
    stamp: string
    subtype: string
    size: string
    cards: { id: string; tcgdex_card_id: string | null; language: string } | null
  }
  const rows = (variantRows ?? []) as unknown as VariantRow[]

  const cardKey = (language: string, tcgdexCardId: string) => `${language}:${tcgdexCardId}`
  const cardsToFetch = new Map<string, { language: Language; tcgdexCardId: string }>()
  for (const row of rows) {
    if (!row.cards?.tcgdex_card_id) continue
    const key = cardKey(row.cards.language, row.cards.tcgdex_card_id)
    if (!cardsToFetch.has(key)) {
      cardsToFetch.set(key, {
        language: row.cards.language as Language,
        tcgdexCardId: row.cards.tcgdex_card_id,
      })
    }
  }

  const fetchResults = await mapWithConcurrency(
    [...cardsToFetch.entries()],
    FETCH_CONCURRENCY,
    async ([key, { language, tcgdexCardId }]) => {
      const pricing = await fetchCardPricing(language, tcgdexCardId)
      return { key, pricing }
    },
  )

  const pricingByCard = new Map<string, Awaited<ReturnType<typeof fetchCardPricing>>>()
  let providerErrorCount = 0
  for (const result of fetchResults) {
    if (result.status === 'fulfilled') {
      pricingByCard.set(result.value.key, result.value.pricing)
    } else {
      providerErrorCount++
      const message =
        result.reason instanceof TcgdexNotFoundError
          ? 'not found'
          : result.reason instanceof Error
            ? result.reason.message
            : 'unknown error'
      console.error('search-prices: fetchCardPricing failed', message)
    }
  }

  const results: {
    cardVariantId: string
    cardId: string
    priceState: 'available' | 'missing'
    provider: string | null
    priceKind: string | null
    sourceCurrency: string | null
    sourceValueMinor: number | null
    providerUpdatedAt: string | null
  }[] = []

  for (const row of rows) {
    if (!row.cards?.tcgdex_card_id) {
      results.push({
        cardVariantId: row.id,
        cardId: row.card_id,
        priceState: 'missing',
        provider: null,
        priceKind: null,
        sourceCurrency: null,
        sourceValueMinor: null,
        providerUpdatedAt: null,
      })
      continue
    }
    const key = cardKey(row.cards.language, row.cards.tcgdex_card_id)
    const pricing = pricingByCard.get(key)
    const match = pricing?.variants.find(
      (v) =>
        v.finish === row.finish &&
        v.stamp === row.stamp &&
        v.subtype === row.subtype &&
        v.size === row.size,
    )
    // Same preference rule as resolve_variant_market_values (D-052): preferred provider first,
    // fall back to the other only when the preferred one has no candidate.
    const primary = useEuPricing ? match?.cardmarket : match?.tcgplayer
    const secondary = useEuPricing ? match?.tcgplayer : match?.cardmarket
    const chosen = primary ?? secondary ?? null

    results.push({
      cardVariantId: row.id,
      cardId: row.card_id,
      priceState: chosen ? 'available' : 'missing',
      provider: chosen?.provider ?? null,
      priceKind: chosen?.priceKind ?? null,
      sourceCurrency: chosen?.sourceCurrency ?? null,
      sourceValueMinor: chosen ? Number(chosen.valueMinor) : null,
      providerUpdatedAt: chosen?.providerUpdatedAt ?? null,
    })
  }

  return json(200, { ok: true, results, providerErrorCount })
})
