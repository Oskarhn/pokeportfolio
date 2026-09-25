/**
 * Seeds the isolated P169 stack with SYNTHETIC data only (never a real collection, purchase or
 * price). Run through the repo's tsx so it can reuse the invitation-claim user harness:
 *
 *   pnpm --dir <repo> exec tsx apps/mobile-spike/scripts/p169/seed.mts [--db106]
 *
 * Output: .local-backend/p169[-db106]/fixture.json (gitignored). It holds generated throwaway
 * credentials of two synthetic users and must never be committed.
 *
 * Besides the catalog of catalog-fixture.mjs it writes:
 *   - fx_rates EUR/USD/JPY -> NOK (NOK per ONE major unit, P136 semantics);
 *   - price_snapshots for the released DB-104 snapshot RPC (two providers on one variant, so the
 *     caller's EU/US preference decides which ONE the RPC returns);
 *   - user A prefers EU pricing, user B does not (a per-account preference that must not survive an
 *     A -> B switch), each with a couple of holdings so the ledger tables the read-only test hashes
 *     are not empty;
 *   - the two ingest cron jobs are deactivated IN THIS PROJECT ONLY (they are already fail-closed by
 *     the empty environment_ingest_config; this is belt and braces).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServiceClient, createSyntheticUser } from '../../../../tests/db/setup'
// @ts-expect-error plain .mjs helpers without type declarations
import { readLocalEnv, stackOf } from './local-backend.mjs'
// @ts-expect-error plain .mjs helpers without type declarations
import { CARDS, SETS, tcgdexId } from './catalog-fixture.mjs'

interface FixtureCard {
  key: string
  set: string
  localId: string
  name: string
  rarity: string
  variants: { finish: string; stamp: string; active: boolean }[]
  provider: unknown
}

const stack = stackOf(process.argv.slice(2)) as {
  workdir: string
  dbContainer: string
  apiPort: number
}

function psql(sql: string, vars: Record<string, string> = {}): string {
  const args = ['exec', '-i', stack.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres']
  args.push('-v', 'ON_ERROR_STOP=1', '-At')
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`)
  const r = spawnSync('docker', args, {
    input: sql,
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  })
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout
}

const lit = (s: string | null): string => (s === null ? 'null' : `'${s.replaceAll("'", "''")}'`)

const env = readLocalEnv(stack) as Record<string, string>
if (env.API_URL !== `http://127.0.0.1:${String(stack.apiPort)}`) {
  throw new Error(`refusing to seed: API_URL ${String(env.API_URL)} is not the P169 stack`)
}
process.env.SUPABASE_URL = env.API_URL
process.env.SUPABASE_ANON_KEY = env.ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SERVICE_ROLE_KEY

const existing = psql("select count(*) from public.card_sets where slug like 'p169-%';").trim()
if (existing !== '0') throw new Error('P169 catalog already seeded; restart the stack to reseed')

const service = createServiceClient()
const userA = await createSyntheticUser(service, 'p169-a')
const userB = await createSyntheticUser(service, 'p169-b')

const sets = (SETS as { slug: string; name: string; language: string }[])
  .map(
    (s) =>
      `((select id from public.card_series where slug = ${s.language === 'ja' ? "'neo'" : "'base'"}), ${lit(s.slug)}, ${lit(s.name)}, ${lit(s.language)})`,
  )
  .join(',\n')

const cards = (CARDS as FixtureCard[])
  .map((c) => {
    const lang = (SETS as { slug: string; language: string }[]).find(
      (s) => s.slug === c.set,
    )?.language
    return `((select id from public.card_sets where slug = ${lit(c.set)}), ${lit(c.localId)}, ${lit(c.name)}, ${lit(c.rarity)}, ${lit(lang ?? 'en')}, ${lit(tcgdexId(c) as string | null)})`
  })
  .join(',\n')

const variants = (CARDS as FixtureCard[])
  .flatMap((c) =>
    c.variants.map(
      (v) =>
        `((select c.id from public.cards c join public.card_sets s on s.id = c.set_id where s.slug = ${lit(c.set)} and c.local_id = ${lit(c.localId)}), ${lit(v.finish)}::public.card_finish, ${lit(v.stamp)}, ${String(v.active)})`,
    ),
  )
  .join(',\n')

psql(
  `
insert into public.card_sets (series_id, slug, name, language) values
${sets};

insert into public.cards (set_id, local_id, name, rarity, language, tcgdex_card_id) values
${cards};

insert into public.card_variants (card_id, finish, stamp, is_active) values
${variants};

insert into public.fx_rates (base_currency, quote_currency, rate_date, rate, source) values
  ('EUR','NOK',current_date,11.5,'norges_bank'),
  ('USD','NOK',current_date,10.5,'norges_bank'),
  ('JPY','NOK',current_date,0.0712,'norges_bank')
on conflict do nothing;

-- Released snapshot RPC data (server converts to NOK). Pikachu base normal has BOTH providers.
with v as (
  select v.id, c.local_id, s.slug, v.finish::text as finish, v.stamp
  from public.card_variants v join public.cards c on c.id = v.card_id join public.card_sets s on s.id = c.set_id
  where s.slug like 'p169-%'
)
insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date, provider_updated_at)
select v.id, p.provider::public.price_provider, p.kind::public.price_kind, p.cur, p.val, current_date - p.age, now() - make_interval(days => p.age)
from v join (values
  ('p169-base','025','normal','', 'tcgdex_cardmarket','cm_trend','EUR', 150::bigint, 0),
  ('p169-base','025','normal','', 'tcgdex_tcgplayer','tp_market','USD', 210::bigint, 0),
  ('p169-base','025','reverse','', 'tcgdex_cardmarket','cm_trend','EUR', 420::bigint, 0),
  ('p169-base','004','holo','', 'tcgdex_cardmarket','cm_trend','EUR', 987654321098765::bigint, 0),
  ('p169-base','099','normal','', 'tcgdex_cardmarket','cm_trend','EUR', 0::bigint, 0),
  ('p169-base','095','normal','', 'tcgdex_cardmarket','cm_trend','EUR', 777::bigint, 10)
) as p(slug, local_id, finish, stamp, provider, kind, cur, val, age)
  on v.slug = p.slug and v.local_id = p.local_id and v.finish = p.finish and v.stamp = p.stamp;

-- Per-account preference: A = EU (Cardmarket), B = US (TCGplayer).
update public.profiles set use_eu_pricing = true where id = :'a_id'::uuid;
update public.profiles set use_eu_pricing = false where id = :'b_id'::uuid;

-- A few holdings each, so the ledger tables the read-only test hashes hold rows.
with h as (
  insert into public.holdings (user_id, holding_kind, card_variant_id, condition, grading_state)
  select :'a_id'::uuid, 'raw_card', v.id, 'NM', 'raw'
  from public.card_variants v join public.cards c on c.id = v.card_id join public.card_sets s on s.id = c.set_id
  where s.slug = 'p169-base' and c.local_id in ('025','004') and v.is_active and v.stamp = '' and v.finish in ('normal','holo')
  returning id
)
insert into public.acquisition_lots (holding_id, user_id, origin, cost_basis_state, acquired_on, quantity, quantity_remaining)
select h.id, :'a_id'::uuid, 'pre_tracking', 'unknown', current_date, 2, 2 from h;
with h as (
  insert into public.holdings (user_id, holding_kind, card_variant_id, condition, grading_state)
  select :'b_id'::uuid, 'raw_card', v.id, 'NM', 'raw'
  from public.card_variants v join public.cards c on c.id = v.card_id join public.card_sets s on s.id = c.set_id
  where s.slug = 'p169-base' and c.local_id = '099'
  returning id
)
insert into public.acquisition_lots (holding_id, user_id, origin, cost_basis_state, acquired_on, quantity, quantity_remaining)
select h.id, :'b_id'::uuid, 'pre_tracking', 'unknown', current_date, 5, 5 from h;

-- This project only: no ingest dispatch, ever.
select cron.alter_job(jobid, active := false) from cron.job where jobname in ('m9-ingest-prices','m9-ingest-fx');
`,
  { a_id: userA.id, b_id: userB.id },
)

const rows = psql(`
select json_object_agg(s.slug || '/' || c.local_id, json_build_object(
  'cardId', c.id,
  'variants', (select json_object_agg(v.finish::text || '|' || v.stamp, v.id) from public.card_variants v where v.card_id = c.id)))
from public.cards c join public.card_sets s on s.id = c.set_id where s.slug like 'p169-%';`)

const catalog = JSON.parse(rows) as Record<string, unknown>
const byKey: Record<string, unknown> = {}
for (const c of CARDS as FixtureCard[]) byKey[c.key] = catalog[`${c.set}/${c.localId}`]

mkdirSync(stack.workdir, { recursive: true })
writeFileSync(
  join(stack.workdir, 'fixture.json'),
  JSON.stringify({ apiUrl: env.API_URL, users: { a: userA, b: userB }, catalog: byKey }, null, 2),
)
console.log(
  `seeded P169 synthetic catalog (${String((CARDS as unknown[]).length)} cards), users A/B -> fixture.json`,
)
