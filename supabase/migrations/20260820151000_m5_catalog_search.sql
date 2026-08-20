-- M5: search infrastructure for the shared catalog, plus the sync-run log the ingest function
-- writes to. See docs/DATA_MODEL.md §10/§4.2-style indexing notes for the general approach and
-- docs/RESEARCH.md for the Japanese trigram-behaviour findings this design responds to.

-- ── 1. Indexes ───────────────────────────────────────────────────────────────────────────────
--
-- cards.name already has a trigram GIN index from M3 (20260817120020). Set names need the same
-- treatment for "Base Set", "Scarlet & Violet" style queries, and pg_trgm's GIN index accelerates
-- both the `%` similarity operator and `ILIKE '%term%'` — one index serves both the ranking
-- comparison and the containment filter search_cards() below performs.

create index card_sets_name_trgm_idx on public.card_sets using gin (name extensions.gin_trgm_ops);

-- Collector number lookup. Plain btree: local_id is short, printed-as-is text (`SV049`, `TG12`,
-- `4/102`) and the query patterns below are equality and anchored prefix/suffix, not general
-- substring — a btree serves those without pulling in trigram's fuzzier semantics for what should
-- be an exact-ish lookup.

create index cards_local_id_idx on public.cards (local_id);

-- ── 2. search_cards — one ranked, paginated read over the shared catalog ───────────────────────
--
-- SECURITY INVOKER (the default — stated for the reader, not because anything forces the choice):
-- `authenticated` already holds plain SELECT on every table this function touches, so there is no
-- privilege gap for a DEFINER to bridge (SECURITY.md prompt §61's "prefer invoker rights for
-- ordinary shared-data search"). Every predicate is a bound parameter; nothing here concatenates
-- the caller's input into SQL text.
--
-- Combined "name + number" queries (DATA_MODEL search UX, e.g. "Pikachu 58", "Charizard 4/102")
-- are handled by a deliberately simple heuristic, not a parser: split off a trailing token that
-- looks like a collector number (letters/digits/slash, containing at least one digit) and use it
-- to filter local_id, using whatever text remains to filter name. A query that is *only* a number
-- skips the name filter; a query with no number-shaped token skips the number filter. This covers
-- the examples in the product spec without attempting general natural-language search.

create or replace function public.search_cards(
  p_query text,
  p_language text default null,
  p_limit int default 40,
  p_offset int default 0
)
returns table (
  card_id uuid,
  name text,
  local_id text,
  rarity text,
  category text,
  illustrator text,
  image_base_url text,
  language text,
  set_id uuid,
  set_name text,
  variant_count bigint,
  total_count bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_query text := btrim(coalesce(p_query, ''));
  v_number_token text;
  v_text_query text;
  v_limit int := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  -- Trailing token: at least one digit, otherwise letters/digits/slash only (`SV049`, `TG12`,
  -- `4/102`, `58`). Matched case-insensitively; local_id itself is compared with ILIKE below.
  v_number_token := (regexp_match(v_query, '([A-Za-z0-9]*\d[A-Za-z0-9/]*)\s*$'))[1];
  if v_number_token is not null then
    v_text_query := btrim(left(v_query, length(v_query) - length(v_number_token)));
  else
    v_text_query := v_query;
  end if;

  return query
  select
    c.id,
    c.name,
    c.local_id,
    c.rarity,
    c.category,
    c.illustrator,
    c.image_base_url,
    c.language,
    s.id,
    s.name,
    (select count(*) from public.card_variants v where v.card_id = c.id and v.is_active),
    count(*) over ()
  from public.cards c
  join public.card_sets s on s.id = c.set_id
  where
    (p_language is null or c.language = p_language)
    and c.is_active
    and (
      v_text_query = ''
      or c.name ilike '%' || v_text_query || '%'
      or s.name ilike '%' || v_text_query || '%'
      or extensions.similarity(c.name, v_text_query) > 0.15
      or extensions.similarity(s.name, v_text_query) > 0.15
    )
    and (
      v_number_token is null
      or c.local_id ilike v_number_token || '%'
      or c.local_id ilike '%' || v_number_token
      or c.local_id ilike '%/' || v_number_token
      or c.local_id = v_number_token
    )
  order by
    greatest(
      extensions.similarity(c.name, coalesce(nullif(v_text_query, ''), v_query)),
      extensions.similarity(s.name, coalesce(nullif(v_text_query, ''), v_query))
    ) desc,
    c.name asc,
    c.local_id asc
  limit v_limit offset v_offset;
end;
$$;

comment on function public.search_cards(text, text, int, int) is
  'Ranked catalog search over cards + card_sets. See migration header for the name/number split heuristic.';

-- ── 3. catalog_sync_runs — per-set ingest observability, resumability and freshness ────────────
--
-- One row per (language, set) attempt. Answers HANDOVER's "when was English/Japanese last synced,
-- did anything fail, which set failed" without building anything closer to monitoring than that.
-- Service-role-only: the ingest Edge Function is the sole writer, and no browser session has any
-- reason to see sync internals (a set id and a row count are not sensitive, but they are also not
-- product surface — SECURITY.md §3.1's "writes require service_role" extends naturally to this
-- table's writes *and* reads, since it exists for operators, not users).

create table public.catalog_sync_runs (
  id bigint generated always as identity primary key,
  language text not null,
  tcgdex_set_id text not null,
  tcgdex_series_id text,
  status text not null check (status in ('succeeded', 'failed', 'skipped_pocket')),
  cards_seen int not null default 0,
  cards_upserted int not null default 0,
  variants_upserted int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index catalog_sync_runs_lookup_idx
  on public.catalog_sync_runs (language, tcgdex_set_id, finished_at desc);

alter table public.catalog_sync_runs enable row level security;
-- No policies: RLS with zero policies denies every row to every role it applies to, and
-- service_role bypasses RLS entirely (SECURITY.md §4), which is the only role that touches this
-- table. Enabled anyway, for the same reason invitation_claims is (DATA_MODEL.md §7) — a table
-- that unexpectedly gained a policy or grant later fails safely rather than defaulting open.

-- ── 4. Privileges ────────────────────────────────────────────────────────────────────────────
--
-- Defaults are neutralized project-wide since M4.1 (20260820140000_m41_privilege_baseline.sql,
-- §2) — a brand new object starts with nothing granted. The revoke lines below are therefore
-- belt-and-braces documentation of intent, not a functional requirement; the grant lines are the
-- ones that do something. scripts/grant-audit.sql's expected surface is updated in the same
-- commit (search_cards only — catalog_sync_runs stays outside it, correctly, since nothing is
-- granted on it to anon or authenticated).

revoke all on public.catalog_sync_runs from anon, authenticated;
grant all on public.catalog_sync_runs to service_role;

grant execute on function public.search_cards(text, text, int, int) to authenticated;
