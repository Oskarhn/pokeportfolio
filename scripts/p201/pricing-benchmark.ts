/**
 * P201 — deterministic measurements for the pricing pipeline, run against a LOCAL stack only.
 *
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres \
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ANON_KEY=… \
 *     pnpm exec tsx scripts/p201/pricing-benchmark.ts [--cards=60000] [--watched=1500] [--snapshots=200000]
 *
 * What it measures, old implementation vs new (the old function bodies are read from the migrations
 * that defined them and installed under a `zz_p201_old_*` name for the duration of the run):
 *
 *   1. QUEUE STARVATION — 400 watched variants the provider has no price for + 1,100 priced ones, batch
 *      200, twelve simulated ticks. How many distinct priced variants does each queue refresh?
 *   2. QUEUE COST — `select_price_sync_batch(200)` against N watched variants and M snapshots
 *      (EXPLAIN ANALYZE execution time, median of 7).
 *   3. SEARCH COST — `search_cards` over a large synthetic catalog for representative queries.
 *
 * SAFETY. Refuses a non-loopback database. Every row it creates carries a `p201-bench` marker and one
 * synthetic `.invalid` user; all of it is deleted, and the zz functions dropped, before exit — also on
 * failure. Nothing here talks to a provider or a Production service.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
} from '../../tests/db/setup'

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true'] as const
  }),
)
const CARDS = Number(args.get('cards') ?? 60_000)
const WATCHED = Number(args.get('watched') ?? 1_500)
const SNAPSHOTS = Number(args.get('snapshots') ?? 200_000)
const UNPRICED = 400
const TICKS = 12
const BATCH = 200

const dbUrl = process.env.DB_URL
if (!dbUrl) throw new Error('DB_URL is not set')
const host = new URL(dbUrl).hostname
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
  throw new Error(`refusing to benchmark against a non-loopback database (${host})`)
}

const MIGRATIONS = join(process.cwd(), 'supabase/migrations')
const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8')

function oldQueueSql(): string {
  const text = read('20260826120040_m9_price_sync_batch_and_retention.sql')
  const start = text.indexOf('create function public.select_price_sync_batch')
  const end = text.indexOf('$$;', start) + 3
  return text
    .slice(start, end)
    .replace(
      'create function public.select_price_sync_batch',
      'create function public.zz_p201_old_queue',
    )
}

function oldSearchSql(): string {
  return read('20260926120000_p173_search_cards_stable_paging.sql')
    .replace(
      'create or replace function public.search_cards(',
      'create function public.zz_p201_old_search(',
    )
    .replace(/^--.*$/gm, '')
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function main() {
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  const service = createServiceClient()
  const user = await createSyntheticUser(service, 'p201-bench')
  const q = (text: string, values?: unknown[]) => client.query(text, values)
  const results: Record<string, unknown> = { cards: CARDS, watched: WATCHED, snapshots: SNAPSHOTS }

  try {
    await q(oldQueueSql())
    await q(oldSearchSql())

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────
    const set = await q(
      `insert into public.card_sets (series_id, slug, name, language, card_count_official)
       values ($1, 'p201-bench-set', 'P201 Bench Set', 'en', 200) returning id`,
      [seedCatalog.cardSeriesId],
    )
    const setId = set.rows[0].id as string
    await q(
      `insert into public.cards (set_id, local_id, name, language, tcgdex_card_id, rarity)
       select $1, lpad(g::text, 6, '0'),
              (array['Pikachu','Charizard','Bulbasaur','Squirtle','Mewtwo','Eevee','Snorlax','Gengar'])[g % 8 + 1]
                || ' ' || (array['V','VMAX','ex','GX','Prime','Star'])[g % 6 + 1] || ' ' || g::text,
              'en', 'p201-bench-' || g::text, 'Common'
       from generate_series(1, $2) g`,
      [setId, CARDS],
    )
    await q(
      `insert into public.card_variants (card_id, finish, stamp, subtype, size)
       select id, 'normal', '', 'p201-bench', 'standard' from public.cards where set_id = $1`,
      [setId],
    )
    const watched = await q(
      `select cv.id from public.card_variants cv join public.cards c on c.id = cv.card_id
       where c.set_id = $1 order by c.tcgdex_card_id limit $2`,
      [setId, WATCHED],
    )
    const ids = watched.rows.map((r) => r.id as string)
    await q(
      `with h as (
         insert into public.holdings (user_id, holding_kind, card_variant_id, condition, grading_state)
         select $1, 'raw_card', v, 'NM', 'raw' from unnest($2::uuid[]) v returning id)
       insert into public.acquisition_lots (holding_id, user_id, origin, cost_basis_state, acquired_on, quantity, quantity_remaining)
       select id, $1, 'gift', 'not_paid', current_date, 1, 1 from h`,
      [user.id, ids],
    )
    await q('analyze public.cards; analyze public.card_variants; analyze public.holdings')

    // ── 1. queue starvation ──────────────────────────────────────────────────────────────────
    const unpriced = new Set(ids.slice(0, UNPRICED))
    const priced = ids.slice(UNPRICED)
    const oldProviderDate = new Set(priced.slice(0, 300))
    const mine = new Set(ids)

    async function simulate(kind: 'old' | 'new') {
      await q('delete from public.price_snapshots where card_variant_id = any($1)', [ids])
      await q('delete from public.price_sync_attempts where card_variant_id = any($1)', [ids])
      const refreshed = new Set<string>()
      const unpricedTries: number[] = []
      for (let tick = 0; tick < TICKS; tick++) {
        const fn = kind === 'old' ? 'zz_p201_old_queue' : 'select_price_sync_batch'
        const batch = (await q(`select card_variant_id from public.${fn}($1)`, [BATCH])).rows
          .map((r) => r.card_variant_id as string)
          .filter((id) => mine.has(id))
        unpricedTries.push(batch.filter((id) => unpriced.has(id)).length)
        const pricedNow = batch.filter((id) => !unpriced.has(id))
        for (const id of pricedNow) refreshed.add(id)
        // what ingest-prices does with the batch: priced variants get a snapshot dated by the
        // PROVIDER (300 of them carry old provider data); unpriced ones get nothing.
        if (pricedNow.length > 0) {
          await q(
            `insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date)
             select v, 'tcgdex_cardmarket', 'cm_trend', 'EUR', 100,
                    case when v = any($2::uuid[]) then current_date - 20 else current_date end
             from unnest($1::uuid[]) v
             on conflict (card_variant_id, provider, snapshot_date) do nothing`,
            [pricedNow, [...oldProviderDate]],
          )
        }
        if (kind === 'new') {
          await q('select * from public.ingest_price_observations($1::jsonb, $2::jsonb)', [
            '[]',
            JSON.stringify(
              batch.map((id) => ({
                card_variant_id: id,
                outcome: unpriced.has(id) ? 'no_price' : 'priced',
              })),
            ),
          ])
        }
      }
      return { distinctPricedRefreshed: refreshed.size, unpricedSelectedPerTick: unpricedTries }
    }
    results.starvation = {
      priced: priced.length,
      unpriced: unpriced.size,
      batch: BATCH,
      ticks: TICKS,
      old: await simulate('old'),
      new: await simulate('new'),
    }

    // ── 2. queue cost ────────────────────────────────────────────────────────────────────────
    await q(
      `insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date)
       select v, 'tcgdex_cardmarket', 'cm_trend', 'EUR', 100, current_date - d
       from unnest($1::uuid[]) v, generate_series(0, $2) d
       on conflict do nothing`,
      [ids, Math.ceil(SNAPSHOTS / Math.max(ids.length, 1))],
    )
    await q('analyze public.price_snapshots')
    async function timeMs(sql: string, values: unknown[] = []) {
      const samples: number[] = []
      for (let i = 0; i < 7; i++) {
        const plan = await q(`explain (analyze, format json) ${sql}`, values)
        samples.push(plan.rows[0]['QUERY PLAN'][0]['Execution Time'] as number)
      }
      return Math.round(median(samples) * 100) / 100
    }
    const snapshotCount = Number(
      (await q('select count(*) n from public.price_snapshots')).rows[0].n,
    )
    results.queueCostMs = {
      snapshotRows: snapshotCount,
      old: await timeMs('select * from public.zz_p201_old_queue(200)'),
      new: await timeMs('select * from public.select_price_sync_batch(200)'),
    }

    // ── 3. search cost ───────────────────────────────────────────────────────────────────────
    const queries = ['Pikachu', 'Pikachu 25', 'Charizard 058/200', 'pikachu v', 'zzzz-no-match']
    const searchMs: Record<string, { old: number; new: number }> = {}
    for (const query of queries) {
      searchMs[query] = {
        old: await timeMs(`select * from public.zz_p201_old_search($1, 'en', 40, 0)`, [query]),
        new: await timeMs(`select * from public.search_cards($1, 'en', 40, 0)`, [query]),
      }
    }
    results.searchMs = searchMs
    results.totalCardsInDb = Number((await q('select count(*) n from public.cards')).rows[0].n)
  } finally {
    await q('drop function if exists public.zz_p201_old_queue(int)').catch(() => undefined)
    await q('drop function if exists public.zz_p201_old_search(text, text, int, int)').catch(
      () => undefined,
    )
    await q(
      `delete from public.price_snapshots where card_variant_id in
         (select cv.id from public.card_variants cv join public.cards c on c.id = cv.card_id
          join public.card_sets s on s.id = c.set_id where s.slug = 'p201-bench-set')`,
    ).catch(() => undefined)
    await deleteSyntheticUser(service, user.id).catch(() => undefined)
    await q(
      `delete from public.price_sync_attempts where card_variant_id in
         (select cv.id from public.card_variants cv join public.cards c on c.id = cv.card_id
          join public.card_sets s on s.id = c.set_id where s.slug = 'p201-bench-set')`,
    ).catch(() => undefined)
    await q(
      `delete from public.card_variants where card_id in
         (select c.id from public.cards c join public.card_sets s on s.id = c.set_id where s.slug = 'p201-bench-set')`,
    ).catch(() => undefined)
    await q(
      `delete from public.cards where set_id in (select id from public.card_sets where slug = 'p201-bench-set')`,
    ).catch(() => undefined)
    await q(`delete from public.card_sets where slug = 'p201-bench-set'`).catch(() => undefined)
    await client.end()
  }
  console.log(JSON.stringify(results, null, 2))
}

void main()
