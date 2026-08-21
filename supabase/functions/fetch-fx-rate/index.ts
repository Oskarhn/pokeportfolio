/**
 * fetch-fx-rate — resolves and caches a Norges Bank exchange rate for one (base currency, date)
 * pair, on demand for the M8 purchase form (docs/FINANCIAL_MODEL.md §7).
 *
 * User-reachable, unlike sync-catalog: `verify_jwt = true` in supabase/config.toml (the default —
 * this function does not opt out of it), so the platform rejects a request with no valid user JWT
 * before this code ever runs. The explicit header check below is defence in depth, not the actual
 * gate. There is no per-user data here to scope by uid — fx_rates is shared market-data cache
 * (DATA_MODEL.md §1) — the JWT requirement exists only to keep this off the fully public internet,
 * matching ARCHITECTURE.md §2's "every screen is authenticated".
 *
 * Cache-then-fetch: a cached observation already covering the resolved date is reused; otherwise a
 * bounded window ending at the requested date is fetched from Norges Bank (fixed host, no
 * caller-supplied URL — see _shared/norges-bank.ts), the latest observation in that window is
 * cached under the service role, and returned. This is what makes the weekend/holiday fallback
 * (FINANCIAL_MODEL.md §7) and the same-day-before-publication case (a purchase recorded today,
 * before Norges Bank's ~16:00 CET release, naturally resolves to the last published business day)
 * both correct without special-casing either: the window always contains whatever was actually
 * published, and the caller is told which date it actually got back (`rateDate`), never a label
 * that pretends today's request used today's rate when it did not.
 *
 * A manual override never reaches this function or `fx_rates` at all — it is written straight onto
 * the caller's own `purchases` row with `fx_source = 'manual'`, so one user's manual rate can never
 * leak into another user's automatic resolution or into the shared cache.
 *
 * Every business outcome — success, no rate found, upstream unreachable, bad input — is returned as
 * HTTP 200 with an `{ ok: boolean, ... }` body, deliberately. supabase-js's `functions.invoke`
 * does not reliably surface a non-2xx response body back to the caller (confirmed against this
 * exact client in src/features/auth/InvitePage.tsx's redeem-invitation integration, which hedges
 * with a generic fallback message for the same reason) — real HTTP status codes stay reserved for
 * genuine transport/gateway failures (wrong method, no session) that the ordinary UI path can never
 * trigger.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import { fetchNorgesBankRates, NorgesBankError } from '../_shared/norges-bank.ts'
import { resolveServiceRoleKey } from '../_shared/service-key.ts'

const LOOKBACK_DAYS = 10
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_SHAPE = /^[A-Z]{3}$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  const iso = d.toISOString().slice(0, 10)
  return iso
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' })
  }

  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, { ok: false, error: 'unauthorized' })
  }

  let body: { baseCurrency?: unknown; date?: unknown }
  try {
    body = (await request.json()) as { baseCurrency?: unknown; date?: unknown }
  } catch {
    return json(200, { ok: false, error: 'invalid_json' })
  }

  const baseCurrency = typeof body.baseCurrency === 'string' ? body.baseCurrency.toUpperCase() : ''
  const date = typeof body.date === 'string' ? body.date : ''

  if (!CURRENCY_SHAPE.test(baseCurrency)) {
    return json(200, { ok: false, error: 'invalid_base_currency' })
  }
  if (baseCurrency === 'NOK') {
    return json(200, { ok: false, error: 'nok_has_no_fx_rate' })
  }
  if (!DATE_SHAPE.test(date)) {
    return json(200, { ok: false, error: 'invalid_date' })
  }
  const todayIso = new Date().toISOString().slice(0, 10)
  if (date > todayIso) {
    return json(200, {
      ok: false,
      error: 'date_in_future',
      message: 'Cannot resolve a rate for a future date',
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = resolveServiceRoleKey()
  if (!supabaseUrl || !serviceKey) {
    return json(200, { ok: false, error: 'server_misconfigured' })
  }
  const service = createClient(supabaseUrl, serviceKey)

  const windowStart = shiftDate(date, -LOOKBACK_DAYS)

  const { data: cached, error: cacheError } = await service
    .from('fx_rates')
    .select('rate, rate_date')
    .eq('base_currency', baseCurrency)
    .eq('quote_currency', 'NOK')
    .eq('source', 'norges_bank')
    .lte('rate_date', date)
    .gte('rate_date', windowStart)
    .order('rate_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (cacheError) {
    return json(200, { ok: false, error: 'cache_read_failed' })
  }
  if (cached) {
    return json(200, {
      ok: true,
      rate: cached.rate,
      rateDate: cached.rate_date,
      source: 'norges_bank',
    })
  }

  let observations
  try {
    observations = await fetchNorgesBankRates({
      baseCurrency,
      startDate: windowStart,
      endDate: date,
    })
  } catch (error) {
    const message = error instanceof NorgesBankError ? error.message : 'Norges Bank unreachable'
    return json(200, { ok: false, error: 'norges_bank_unreachable', message })
  }

  if (observations.length === 0) {
    return json(200, {
      ok: false,
      error: 'no_rate_found',
      message: `No Norges Bank rate for ${baseCurrency}/NOK on or before ${date}`,
    })
  }

  const latest = observations[observations.length - 1]!

  const { error: upsertError } = await service.from('fx_rates').upsert(
    {
      base_currency: baseCurrency,
      quote_currency: 'NOK',
      rate_date: latest.date,
      rate: latest.rate,
      source: 'norges_bank',
    },
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
  if (upsertError) {
    return json(200, { ok: false, error: 'cache_write_failed' })
  }

  return json(200, { ok: true, rate: latest.rate, rateDate: latest.date, source: 'norges_bank' })
})
