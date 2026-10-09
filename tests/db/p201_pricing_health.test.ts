import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rawSqlAvailable, runRawSqlAsync } from './raw-sql'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P201 — scripts/pricing-health-diagnostics.sql: read-only, and it reports what it is meant to.
 *
 * Every scenario runs in its OWN transaction that is rolled back, so the shared market-data tables
 * are left exactly as other suites expect them. Assertions are made only on the checks whose inputs
 * the scenario fully controls (the run log, FX rates, attempts, the catalog run log).
 */
const HEALTH_SQL = readFileSync(
  join(process.cwd(), 'scripts', 'pricing-health-diagnostics.sql'),
  'utf8',
)
const available = rawSqlAvailable()
const withRaw = available ? describe : describe.skip

interface Row {
  status: string
  value: string
}

/** Runs `setup` then the health query inside a transaction that is always rolled back. */
async function health(setup: string, readOnly = false): Promise<Map<string, Row>> {
  const result = await runRawSqlAsync(
    `begin${readOnly ? ' read only' : ''};\n${setup}\n${HEALTH_SQL}\nrollback;\n`,
  )
  if (result.code !== 0) throw new Error(`health query failed:\n${result.output}`)
  const rows = new Map<string, Row>()
  for (const line of result.output.split('\n')) {
    const [name, status, value] = line.split('|')
    if (name && status && value !== undefined && /^[A-Za-z0-9_]+$/.test(name)) {
      rows.set(name, { status, value })
    }
  }
  return rows
}

/** FX rows for every weekday of the last 40 days, newest = yesterday-ish (a healthy feed). */
const HEALTHY_FX = `
  delete from public.fx_rates;
  insert into public.fx_rates (base_currency, quote_currency, rate_date, rate, source)
  select c, 'NOK', d::date, 11.5, 'norges_bank'
  from (values ('EUR'), ('USD')) v(c),
       generate_series(current_date - 40, current_date, interval '1 day') d
  where extract(isodow from d) < 6;`

const run = (kind: string, status: string, minutesAgo: number, error = 'null') =>
  `insert into public.price_sync_runs (kind, status, started_at, finished_at, error)
   values ('${kind}', '${status}', now() - interval '${minutesAgo + 1} minutes',
           now() - interval '${minutesAgo} minutes', ${error === 'null' ? 'null' : `'${error}'`});`

describe('the health script is read-only by construction', () => {
  it('contains no statement that writes', () => {
    const code = HEALTH_SQL.replace(/--.*$/gm, '')
    expect(code).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i)
    expect(code.trim().startsWith('with')).toBe(true)
  })

  withRaw('runs to completion inside a READ ONLY transaction', () => {
    it('returns an overall row', async () => {
      const rows = await health('', true)
      expect(rows.has('overall')).toBe(true)
    })
  })
})

withRaw('pricing health — a healthy pipeline', () => {
  it('passes the run, FX and integrity checks', async () => {
    const rows = await health(`
      delete from public.price_sync_runs;
      ${run('prices', 'succeeded', 5)}
      ${run('prices', 'succeeded', 20)}
      ${run('fx', 'succeeded', 120)}
      ${HEALTHY_FX}`)
    for (const name of [
      'ingest_prices_minutes_since_last_run',
      'ingest_prices_failed_runs_24h',
      'ingest_prices_runs_stopped_early_24h',
      'ingest_prices_runs_with_rejected_rows_24h',
      'ingest_fx_hours_since_last_success',
      'fx_newest_rate_age_days_EUR',
      'fx_newest_rate_age_days_USD',
      'fx_missing_weekdays_30d_EUR',
      'fx_missing_weekdays_30d_USD',
      'snapshots_future_dated',
      'snapshots_negative_value',
    ]) {
      expect(rows.get(name), name).toMatchObject({ status: 'PASS' })
    }
  })
})

withRaw('pricing health — each failure is reported, not hidden', () => {
  it('FAILs when no ingest run has ever succeeded', async () => {
    const rows = await health('delete from public.price_sync_runs;')
    expect(rows.get('ingest_prices_minutes_since_last_run')).toMatchObject({
      status: 'FAIL',
      value: 'never',
    })
    expect(rows.get('ingest_fx_hours_since_last_success')).toMatchObject({ status: 'FAIL' })
    expect(rows.get('overall')!.status).toBe('FAIL')
  })

  it('WARNs and then FAILs as the last successful price run ages', async () => {
    const warn = await health(
      `delete from public.price_sync_runs; ${run('prices', 'succeeded', 90)}`,
    )
    expect(warn.get('ingest_prices_minutes_since_last_run')!.status).toBe('WARN')
    const fail = await health(
      `delete from public.price_sync_runs; ${run('prices', 'partial', 300)}`,
    )
    expect(fail.get('ingest_prices_minutes_since_last_run')!.status).toBe('FAIL')
  })

  it('FAILs when half or more of the last day of runs failed, WARNs for an occasional one', async () => {
    const mostly = await health(`
      delete from public.price_sync_runs;
      ${run('prices', 'failed', 10)} ${run('prices', 'failed', 40)} ${run('prices', 'succeeded', 70)}`)
    expect(mostly.get('ingest_prices_failed_runs_24h')).toMatchObject({
      status: 'FAIL',
      value: '2 of 3',
    })
    const rare = await health(`
      delete from public.price_sync_runs;
      ${run('prices', 'failed', 10)} ${Array.from({ length: 5 }, (_, i) => run('prices', 'succeeded', 20 + i * 15)).join(' ')}`)
    expect(rare.get('ingest_prices_failed_runs_24h')!.status).toBe('WARN')
  })

  it('surfaces runs stopped early, runs with rejected rows and partial runs', async () => {
    const rows = await health(`
      delete from public.price_sync_runs;
      ${run('prices', 'partial', 5, 'provider: rate_limited=5 | stopped: provider_unhealthy | skipped=3')}
      ${run('prices', 'partial', 20, 'rejected_rows=2')}`)
    expect(rows.get('ingest_prices_runs_stopped_early_24h')).toMatchObject({
      status: 'WARN',
      value: '1',
    })
    expect(rows.get('ingest_prices_runs_with_rejected_rows_24h')).toMatchObject({
      status: 'WARN',
      value: '1',
    })
    expect(rows.get('ingest_prices_partial_runs_24h')).toMatchObject({ status: 'WARN', value: '2' })
  })

  it('FAILs on a stale or empty FX feed and counts missing weekdays', async () => {
    const stale = await health(`
      delete from public.fx_rates;
      insert into public.fx_rates (base_currency, quote_currency, rate_date, rate, source)
      values ('EUR', 'NOK', current_date - 9, 11.5, 'norges_bank');`)
    expect(stale.get('fx_newest_rate_age_days_EUR')).toMatchObject({ status: 'FAIL', value: '9' })
    expect(stale.get('fx_newest_rate_age_days_USD')).toMatchObject({
      status: 'FAIL',
      value: 'none',
    })
    expect(stale.get('fx_missing_weekdays_30d_EUR')!.status).toBe('FAIL')
  })

  it('FAILs on a future-dated snapshot that something managed to write', async () => {
    const rows = await health(`
      alter table public.price_snapshots disable trigger price_snapshots_reject_future_date;
      insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date)
      values ('${seedCatalog.pikachuVariantId}', 'tcgdex_cardmarket', 'cm_trend', 'EUR', 1, current_date + 30)
      on conflict do nothing;`)
    expect(rows.get('snapshots_future_dated')).toMatchObject({ status: 'FAIL' })
  })

  it('WARNs about sets whose latest catalog sync failed or was incomplete', async () => {
    const rows = await health(`
      insert into public.catalog_sync_runs (language, tcgdex_set_id, status, error, started_at, finished_at)
      values ('en', 'p201-health-set', 'succeeded', 's1-003: provider error 503', now(), now());`)
    expect(rows.get('catalog_sets_whose_latest_sync_failed_or_was_incomplete')!.status).toBe('WARN')
  })

  it('a later clean sync of the same set clears it', async () => {
    const rows = await health(`
      delete from public.catalog_sync_runs;
      insert into public.catalog_sync_runs (language, tcgdex_set_id, status, error, started_at, finished_at)
      values ('en', 'p201-health-set', 'succeeded', 'old failure', now() - interval '1 day', now() - interval '1 day'),
             ('en', 'p201-health-set', 'succeeded', null, now(), now());`)
    expect(rows.get('catalog_sets_whose_latest_sync_failed_or_was_incomplete')).toMatchObject({
      status: 'PASS',
      value: '0',
    })
  })
})

withRaw('pricing health — the work queue', () => {
  let service: TestClient
  let user: SyntheticUser

  beforeAll(async () => {
    service = createServiceClient()
    user = await createSyntheticUser(service, 'p201-health')
    const { data: holding, error } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        grading_state: 'raw',
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    const lot = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: new Date().toISOString().slice(0, 10),
      quantity: 1,
      quantity_remaining: 1,
    })
    if (lot.error) throw new Error(lot.error.message)
  })

  afterAll(async () => {
    await deleteSyntheticUser(service, user.id)
  })

  it('WARNs about a variant whose provider lookups failed three times in a row', async () => {
    const rows = await health(`
      delete from public.price_sync_attempts;
      insert into public.price_sync_attempts (card_variant_id, last_attempt_at, last_outcome, consecutive_failed)
      values ('${seedCatalog.pikachuVariantId}', now(), 'provider_failed', 3);`)
    expect(rows.get('queue_variants_provider_failed_3_in_a_row')).toMatchObject({
      status: 'WARN',
      value: '1',
    })
  })

  it('FAILs when the oldest attempted variant has waited four days', async () => {
    const rows = await health(`
      delete from public.price_sync_attempts;
      insert into public.price_sync_attempts (card_variant_id, last_attempt_at, last_outcome)
      values ('${seedCatalog.pikachuVariantId}', now() - interval '5 days', 'priced');`)
    expect(rows.get('queue_oldest_attempt_age_hours')!.status).toBe('FAIL')
  })

  it('reports variants the provider has no price for as context, not as a problem', async () => {
    const rows = await health(`
      delete from public.price_sync_attempts;
      insert into public.price_sync_attempts (card_variant_id, last_attempt_at, last_outcome, consecutive_unpriced)
      values ('${seedCatalog.pikachuVariantId}', now(), 'no_price', 9);`)
    expect(rows.get('queue_variants_unpriced_backed_off')).toMatchObject({
      status: 'INFO',
      value: '1',
    })
    expect(rows.get('queue_variants_unpriced_for_7_attempts_or_more')).toMatchObject({
      status: 'INFO',
      value: '1',
    })
  })

  it('classifies owned variants by the age of their newest snapshot', async () => {
    const rows = await health(`
      delete from public.price_snapshots where card_variant_id = '${seedCatalog.pikachuVariantId}';
      insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date)
      values ('${seedCatalog.pikachuVariantId}', 'tcgdex_cardmarket', 'cm_trend', 'EUR', 100, current_date - 45);`)
    expect(Number(rows.get('watched_variants_outdated')!.value)).toBeGreaterThanOrEqual(1)
  })
})
