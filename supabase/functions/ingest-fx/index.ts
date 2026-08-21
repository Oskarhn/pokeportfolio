/**
 * ingest-fx — scheduled daily EUR/NOK and USD/NOK cache refresh (docs/ROADMAP.md M9, prompt §31).
 *
 * M8's `fetch-fx-rate` already resolves and caches a rate on demand, per user request, for the
 * purchase form. This function is the *scheduled* counterpart the market-valuation resolver needs:
 * without it, the first Portfolio view of the day would otherwise have no NOK conversion for
 * today's price snapshots until some user happened to trigger a purchase-form FX lookup first.
 * Deliberately reuses `_shared/norges-bank.ts` rather than re-implementing the parser or the
 * weekend/holiday fallback — both already exist and are already tested
 * (tests/data/norges-bank.test.ts) — this function is only the *scheduling* and *which
 * currencies* layer on top of the same resolver `fetch-fx-rate` uses.
 *
 * Same operator-secret authentication as ingest-prices/sync-catalog: `verify_jwt = false`, a
 * bearer secret compared to `PRICE_SYNC_SECRET`, called by pg_cron via pg_net with the secret read
 * from Supabase Vault at call time.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import { fetchNorgesBankRates, NorgesBankError } from '../_shared/norges-bank.ts'
import { resolveServiceRoleKey } from '../_shared/service-key.ts'

const CURRENCIES = ['EUR', 'USD'] as const
const LOOKBACK_DAYS = 10

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

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = resolveServiceRoleKey()
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('ingest-fx is missing its Supabase environment configuration')
    return json(500, { error: 'server_error' })
  }
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = new Date().toISOString()
  const today = new Date().toISOString().slice(0, 10)
  const windowStart = shiftDate(today, -LOOKBACK_DAYS)

  const results: { currency: string; ok: boolean; rateDate?: string; error?: string }[] = []

  for (const currency of CURRENCIES) {
    try {
      const observations = await fetchNorgesBankRates({
        baseCurrency: currency,
        startDate: windowStart,
        endDate: today,
      })
      if (observations.length === 0) {
        results.push({ currency, ok: false, error: 'no_rate_found' })
        continue
      }
      const latest = observations[observations.length - 1]!
      const { error } = await db.from('fx_rates').upsert(
        {
          base_currency: currency,
          quote_currency: 'NOK',
          rate_date: latest.date,
          rate: latest.rate,
          source: 'norges_bank',
        },
        { onConflict: 'base_currency,quote_currency,rate_date,source' },
      )
      if (error) {
        results.push({ currency, ok: false, error: error.message })
      } else {
        results.push({ currency, ok: true, rateDate: latest.date })
      }
    } catch (error) {
      const message = error instanceof NorgesBankError ? error.message : 'unreachable'
      results.push({ currency, ok: false, error: message })
    }
  }

  const failures = results.filter((r) => !r.ok)
  const status =
    failures.length === 0 ? 'succeeded' : failures.length < results.length ? 'partial' : 'failed'

  await db.from('price_sync_runs').insert({
    kind: 'fx',
    status,
    batch_size: CURRENCIES.length,
    snapshots_written: results.filter((r) => r.ok).length,
    provider_error_count: failures.length,
    error: failures.length > 0 ? failures.map((f) => `${f.currency}: ${f.error}`).join('; ') : null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  })

  return json(200, { ok: failures.length === 0, results })
})
