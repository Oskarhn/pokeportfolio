/**
 * Seeds the isolated P158 local Supabase stack with SYNTHETIC data only (never real collection
 * data). Run through the repo's tsx so it can reuse the invitation-claim user harness already used
 * by every database suite:
 *
 *   pnpm --dir <repo> exec tsx apps/mobile-spike/scripts/seed-local-backend.mts
 *
 * Output: apps/mobile-spike/.local-backend/fixture.json (gitignored). It holds the generated
 * throwaway credentials of two synthetic users, so it must never be committed.
 *
 * Fixture design (each row exists so one specific failure is detectable):
 *   - user A: 10,000 holdings (list virtualisation / pagination / memory), plus named holdings whose
 *     unit value is 2^53+1 and 2^58+1 minor units (exact-money transport), a deliberate manual zero
 *     ("0,00 kr", not "â€”"), and an unpriced one (NULL, never 0).
 *   - user B: a small, disjoint set of uniquely named holdings, so any A row rendered under B (or
 *     B row under A) is visible by name.
 *   - catalog: one card with two finishes and DIFFERENT prices per finish (wrong-variant detection),
 *     one card with no price rows, one card with an astronomically large EUR snapshot.
 *   - fx_rates: EUR/USD -> NOK, so the released RPC converts snapshots into NOK server-side.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServiceClient, createSyntheticUser } from '../../../tests/db/setup'
// @ts-expect-error plain .mjs helper without type declarations
import { DB_CONTAINER, readLocalEnv } from './local-backend.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', '.local-backend')

const A_HOLDINGS = 10_000
const B_HOLDINGS = 40

function psql(sql: string, vars: Record<string, string> = {}): string {
  const args = [
    'exec',
    '-i',
    DB_CONTAINER as string,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
  ]
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`)
  const r = spawnSync('docker', args, {
    input: sql,
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  })
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout
}

const env = readLocalEnv() as Record<string, string>
process.env.SUPABASE_URL = env.API_URL
process.env.SUPABASE_ANON_KEY = env.ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SERVICE_ROLE_KEY
if (!/^http:\/\/(127\.0\.0\.1|localhost):55321$/.test(env.API_URL ?? '')) {
  throw new Error("refusing to seed: API_URL is not this spike's isolated local stack")
}

const service = createServiceClient()
const userA = await createSyntheticUser(service, 'p158-a')
const userB = await createSyntheticUser(service, 'p158-b')

psql(
  `
-- fx: server-side NOK conversion of the EUR/USD snapshots below
insert into public.fx_rates (base_currency, quote_currency, rate_date, rate, source)
values ('EUR','NOK',current_date,11.5,'norges_bank'), ('USD','NOK',current_date,10.5,'norges_bank')
on conflict do nothing;

-- catalog: one synthetic set, N synthetic cards, one normal variant each
insert into public.card_sets (series_id, slug, name, language)
select series_id, 'p158-synthetic-set', 'P158 Synthetic Set', 'en' from public.card_sets limit 1;

insert into public.cards (set_id, local_id, name, rarity, language)
select (select id from public.card_sets where slug = 'p158-synthetic-set'), lpad(g::text, 5, '0'), 'Synthetic Card ' || lpad(g::text, 5, '0'), 'Common', 'en'
from generate_series(1, :a_holdings) g;

insert into public.cards (set_id, local_id, name, rarity, language)
select (select id from public.card_sets where slug = 'p158-synthetic-set'), 'B' || lpad(g::text, 3, '0'), 'Synthetic BOnly ' || lpad(g::text, 3, '0'), 'Common', 'en'
from generate_series(1, :b_holdings) g;

insert into public.cards (set_id, local_id, name, rarity, language) values
  ((select id from public.card_sets where slug = 'p158-synthetic-set'), 'S01', 'P158 Twin Finish', 'Rare', 'en'),
  ((select id from public.card_sets where slug = 'p158-synthetic-set'), 'S02', 'P158 No Prices', 'Rare', 'en'),
  ((select id from public.card_sets where slug = 'p158-synthetic-set'), 'S03', 'P158 Astronomical', 'Rare', 'en'),
  ((select id from public.card_sets where slug = 'p158-synthetic-set'), 'S04', 'P158 Manual Zero', 'Rare', 'en'),
  ((select id from public.card_sets where slug = 'p158-synthetic-set'), 'S05', 'P158 Above Safe Integer', 'Rare', 'en'),
  ((select id from public.card_sets where slug = 'p158-synthetic-set'), 'S06', 'P158 Priced Both Providers', 'Rare', 'en');

insert into public.card_variants (card_id, finish)
select c.id, 'normal' from public.cards c where c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set');
insert into public.card_variants (card_id, finish)
select c.id, 'holo' from public.cards c where c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set') and c.local_id = 'S01';

-- snapshots (server converts to NOK via fx_rates): two finishes of one card, DIFFERENT prices
insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date, provider_updated_at)
select v.id, 'tcgdex_cardmarket', 'cm_trend', 'EUR', case v.finish when 'normal' then 1234 else 98765 end, current_date, now()
from public.card_variants v join public.cards c on c.id = v.card_id where c.local_id = 'S01' and c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set');
insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date, provider_updated_at)
select v.id, 'tcgdex_cardmarket', 'cm_trend', 'EUR', 288230376151711745, current_date, now()
from public.card_variants v join public.cards c on c.id = v.card_id where c.local_id = 'S03' and c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set');
insert into public.price_snapshots (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date, provider_updated_at)
select v.id, p.provider::price_provider, p.kind::price_kind, p.cur, p.val, current_date, now()
from public.card_variants v join public.cards c on c.id = v.card_id,
  (values ('tcgdex_cardmarket','cm_trend','EUR',4200::bigint), ('tcgdex_tcgplayer','tp_market','USD',5100::bigint)) as p(provider, kind, cur, val)
where c.local_id = 'S06' and c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set');

-- holdings + one open lot each, for user A (created_at spread so 'added_newest' is a stable order)
with h as (
  insert into public.holdings (user_id, holding_kind, card_variant_id, condition, grading_state, created_at)
  select :'a_id'::uuid, 'raw_card', v.id, 'NM', 'raw', now() - (row_number() over (order by c.local_id)) * interval '1 second'
  from public.card_variants v join public.cards c on c.id = v.card_id
  where c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set') and c.local_id ~ '^[0-9]{5}$' and v.finish = 'normal'
  returning id, card_variant_id
)
insert into public.acquisition_lots (holding_id, user_id, origin, cost_basis_state, acquired_on, quantity, quantity_remaining)
select h.id, :'a_id'::uuid, 'pre_tracking', 'unknown', current_date, 1 + (abs(hashtext(h.id::text)) % 3), 1 + (abs(hashtext(h.id::text)) % 3) from h;

-- named holdings for A
with h as (
  insert into public.holdings (user_id, holding_kind, card_variant_id, condition, grading_state)
  select :'a_id'::uuid, 'raw_card', v.id, 'NM', 'raw'
  from public.card_variants v join public.cards c on c.id = v.card_id
  where c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set') and c.local_id in ('S01','S02','S03','S04','S05','S06') and v.finish = 'normal'
  returning id, card_variant_id
)
insert into public.acquisition_lots (holding_id, user_id, origin, cost_basis_state, acquired_on, quantity, quantity_remaining)
select h.id, :'a_id'::uuid, 'pre_tracking', 'unknown', current_date, 3, 3 from h;

-- manual valuations: exact-money extremes and a deliberate zero (all NOK; the table is NOK-only)
insert into public.manual_valuations (user_id, holding_id, value_minor, currency, value_nok_minor)
select :'a_id'::uuid, ho.id, m.val, 'NOK', m.val
from public.holdings ho
join public.card_variants v on v.id = ho.card_variant_id
join public.cards c on c.id = v.card_id
join (values ('S03', 288230376151711745::bigint), ('S05', 9007199254740993::bigint), ('S04', 0::bigint)) as m(local_id, val) on m.local_id = c.local_id
where ho.user_id = :'a_id'::uuid and c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set');

-- user B: disjoint, uniquely named holdings
with h as (
  insert into public.holdings (user_id, holding_kind, card_variant_id, condition, grading_state)
  select :'b_id'::uuid, 'raw_card', v.id, 'NM', 'raw'
  from public.card_variants v join public.cards c on c.id = v.card_id
  where c.set_id = (select id from public.card_sets where slug = 'p158-synthetic-set') and c.local_id ~ '^B[0-9]{3}$'
  returning id
)
insert into public.acquisition_lots (holding_id, user_id, origin, cost_basis_state, acquired_on, quantity, quantity_remaining)
select h.id, :'b_id'::uuid, 'pre_tracking', 'unknown', current_date, 7, 7 from h;
`,
  {
    a_id: userA.id,
    b_id: userB.id,
    a_holdings: String(A_HOLDINGS),
    b_holdings: String(B_HOLDINGS),
  },
)

const ids = psql(
  `select c.local_id || '=' || c.id || ':' || string_agg(v.finish::text || '=' || v.id, ',' order by v.finish)
   from public.cards c join public.card_variants v on v.card_id = c.id
   where c.local_id like 'S0%' group by c.local_id, c.id order by c.local_id;`,
)
const catalog: Record<string, { cardId: string; variants: Record<string, string> }> = {}
for (const line of ids.trim().split('\n')) {
  const [local, rest] = line.split('=') as [string, string]
  const [cardId, variants] = [rest.slice(0, 36), rest.slice(37)]
  catalog[local] = {
    cardId,
    variants: Object.fromEntries(variants.split(',').map((p) => p.split('=') as [string, string])),
  }
}

mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'fixture.json'),
  JSON.stringify(
    {
      apiUrl: env.API_URL,
      users: { a: userA, b: userB },
      counts: { aHoldings: A_HOLDINGS + 6, bHoldings: B_HOLDINGS },
      catalog,
    },
    null,
    2,
  ),
)
console.log(
  `seeded: A=${A_HOLDINGS + 6} holdings, B=${B_HOLDINGS} holdings -> ${join(outDir, 'fixture.json')}`,
)
