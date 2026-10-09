-- P201: price-ingest reliability. Three defects found by auditing the M9 pipeline, one migration.
--
-- 1. QUEUE STARVATION. `select_price_sync_batch` ordered the work queue by each variant's newest
--    `snapshot_date`, "nulls first". But `snapshot_date` is the PROVIDER's own business date, not
--    a record that we tried, so two kinds of variant never left the head of the queue:
--      - a watched variant with no price at all (a printing the provider does not price, or one the
--        mapper rightly refuses to guess) has no snapshot ever, sorts first on every tick, is
--        selected, yields nothing, and is selected again 15 minutes later;
--      - a variant whose provider data is simply old keeps the old date after every successful fetch
--        (the upsert rewrites the same row), so it too sorts ahead of everything fresh.
--    With 200 such variants (the batch size) the queue stops advancing and no other watched variant
--    is refreshed again. `price_sync_attempts` records WHEN we last tried and WHAT came of it; the
--    queue orders by that, and a variant that came back unpriced is retried after an increasing
--    pause (1 day, 2 days … capped at 7) instead of every tick.
--
-- 2. WHOLE-CHUNK REJECTION. ingest-prices sent price rows to PostgREST in chunks of 500. One row the
--    database refuses (a date that does not exist, a negative value, a stale variant id) failed the
--    entire chunk, the same card re-entered the next tick, and the same chunk failed again.
--    `ingest_price_observations` validates and writes row by row: a bad row is counted as rejected and
--    never costs the valid ones their write.
--
-- 3. OUT-OF-ORDER AND DUPLICATE DELIVERY. The upsert key is (variant, provider, snapshot_date) and
--    the old upsert overwrote unconditionally, so a delivery carrying an OLDER provider timestamp
--    (a provider cache serving yesterday's figure, two overlapping runs) replaced a newer observation
--    of the same day, and an identical redelivery rewrote the row for nothing. The new write only
--    replaces a row when the incoming observation is not older than the stored one, and an identical
--    one is counted as unchanged (the `snapshots_unchanged` column existed and was never written).
--
-- Also: a trigger refuses a `snapshot_date` more than one day ahead of the database date. A far-future
-- date wins `ORDER BY snapshot_date DESC` in `resolve_variant_market_values` forever and pins a
-- variant "fresh". It is a trigger, not a CHECK: a CHECK on `current_date` is re-evaluated by a
-- restore and would reject a dump restored on a machine with a wrong clock.
--
-- Deployment order: this migration BEFORE the ingest-prices Edge Function that calls
-- `ingest_price_observations`. The function falls back to the previous direct upsert when the RPC does
-- not exist, so the reverse order (function first) degrades to the old behaviour instead of failing.
-- Everything here is additive or CREATE OR REPLACE with an unchanged signature; nothing a browser role
-- can reach changes (no grant to anon/authenticated), so no privilege baseline restatement is needed.

-- ── 1. Attempt tracking ──────────────────────────────────────────────────────────────────────────

create table public.price_sync_attempts (
  card_variant_id uuid primary key references public.card_variants (id) on delete cascade,
  last_attempt_at timestamptz not null default now(),
  -- priced: at least one provider candidate was written; no_price: the provider answered and nothing
  -- could be attributed to this exact variant; provider_failed: the provider could not be reached.
  last_outcome text not null check (last_outcome in ('priced', 'no_price', 'provider_failed')),
  consecutive_unpriced int not null default 0 check (consecutive_unpriced >= 0),
  consecutive_failed int not null default 0 check (consecutive_failed >= 0)
);

create index price_sync_attempts_last_attempt_idx on public.price_sync_attempts (last_attempt_at);

-- Market-data/infrastructure table: RLS on, zero policies, service role only (same shape as
-- price_sync_runs). It names which variants somebody owns only by variant id, never by user.
alter table public.price_sync_attempts enable row level security;
revoke all on public.price_sync_attempts from public, anon, authenticated;
grant all on public.price_sync_attempts to service_role;

comment on table public.price_sync_attempts is
  'Service-role-only. When ingest-prices last tried each watched variant and what came of it; the '
  'ingest work queue orders by this, not by the provider''s own snapshot date (P201).';

-- ── 2. The work queue ────────────────────────────────────────────────────────────────────────────

-- Same signature and result columns as M9 (CREATE OR REPLACE keeps the ACL). `last_snapshot_date`
-- stays informational; it is now read for the selected rows only instead of aggregating the whole
-- snapshot table on every tick.
create or replace function public.select_price_sync_batch(p_batch_size int default 200)
returns table (
  card_variant_id uuid,
  card_id uuid,
  tcgdex_card_id text,
  language text,
  finish public.card_finish,
  stamp text,
  subtype text,
  size public.card_size,
  last_snapshot_date date
)
language sql
stable
set search_path = ''
as $$
  with queue as (
    select
      cv.id as variant_id, cv.card_id, c.tcgdex_card_id, c.language,
      cv.finish, cv.stamp, cv.subtype, cv.size, a.last_attempt_at
    from public.watched_card_variants wv
    join public.card_variants cv on cv.id = wv.card_variant_id
    join public.cards c on c.id = cv.card_id
    left join public.price_sync_attempts a on a.card_variant_id = cv.id
    where c.tcgdex_card_id is not null
      and (
        a.card_variant_id is null
        or a.last_outcome <> 'no_price'
        -- A variant the provider has no price for is retried after 1, 2 … 7 days, not every tick.
        or a.last_attempt_at <= now() - make_interval(days => least(a.consecutive_unpriced, 7))
      )
    order by a.last_attempt_at asc nulls first, cv.id asc
    limit greatest(least(coalesce(p_batch_size, 200), 2000), 1)
  )
  select
    q.variant_id, q.card_id, q.tcgdex_card_id, q.language, q.finish, q.stamp, q.subtype, q.size,
    (select max(ps.snapshot_date) from public.price_snapshots ps where ps.card_variant_id = q.variant_id)
  from queue q
  order by q.last_attempt_at asc nulls first, q.variant_id asc;
$$;

comment on function public.select_price_sync_batch(int) is
  'Service-role-only. Bounded work queue for ingest-prices: never-attempted variants first, then the '
  'least recently attempted; a variant the provider had no price for backs off 1-7 days (P201).';

-- ── 3. Row-by-row, order-aware observation write ─────────────────────────────────────────────────

create function public.ingest_price_observations(
  p_observations jsonb,
  p_attempts jsonb default '[]'::jsonb
)
returns table (
  written int,
  unchanged int,
  superseded int,
  rejected int,
  attempts_recorded int
)
language plpgsql
set search_path = ''
as $$
declare
  o jsonb;
  a jsonb;
  v_written int := 0;
  v_unchanged int := 0;
  v_superseded int := 0;
  v_rejected int := 0;
  v_attempts int := 0;
  v_rows int;
  v_variant uuid;
  v_provider public.price_provider;
  v_kind public.price_kind;
  v_currency text;
  v_value bigint;
  v_date date;
  v_updated timestamptz;
  v_outcome text;
  v_existing_updated timestamptz;
begin
  if jsonb_typeof(coalesce(p_observations, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_attempts, '[]'::jsonb)) <> 'array' then
    raise exception 'ingest_price_observations: arguments must be JSON arrays' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_observations, '[]'::jsonb)) > 5000
     or jsonb_array_length(coalesce(p_attempts, '[]'::jsonb)) > 5000 then
    raise exception 'ingest_price_observations: at most 5000 entries per call' using errcode = '22023';
  end if;

  for o in select value from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) loop
    begin
      v_variant := (o ->> 'card_variant_id')::uuid;
      v_provider := (o ->> 'provider')::public.price_provider;
      v_kind := (o ->> 'price_kind')::public.price_kind;
      v_currency := o ->> 'source_currency';
      v_value := (o ->> 'value_minor')::bigint;
      v_date := (o ->> 'snapshot_date')::date;
      v_updated := nullif(o ->> 'provider_updated_at', '')::timestamptz;

      insert into public.price_snapshots as ps (
        card_variant_id, provider, price_kind, source_currency, value_minor,
        snapshot_date, provider_updated_at
      ) values (
        v_variant, v_provider, v_kind, v_currency, v_value, v_date, v_updated
      )
      on conflict (card_variant_id, provider, snapshot_date) do update
        set price_kind = excluded.price_kind,
            source_currency = excluded.source_currency,
            value_minor = excluded.value_minor,
            provider_updated_at = excluded.provider_updated_at,
            retrieved_at = now()
        where
          -- never replace a row with an OLDER provider observation of the same day ...
          (ps.provider_updated_at is null or excluded.provider_updated_at >= ps.provider_updated_at)
          -- ... and do not rewrite an identical one.
          and (ps.price_kind, ps.source_currency, ps.value_minor, ps.provider_updated_at)
              is distinct from
              (excluded.price_kind, excluded.source_currency, excluded.value_minor, excluded.provider_updated_at);
      get diagnostics v_rows = row_count;

      if v_rows = 1 then
        v_written := v_written + 1;
      else
        select ps.provider_updated_at into v_existing_updated
        from public.price_snapshots ps
        where ps.card_variant_id = v_variant and ps.provider = v_provider and ps.snapshot_date = v_date;
        if v_existing_updated is not null and (v_updated is null or v_updated < v_existing_updated) then
          v_superseded := v_superseded + 1;
        else
          v_unchanged := v_unchanged + 1;
        end if;
      end if;
    exception
      -- Only DATA problems are a rejected row (bad uuid / enum / date / number, CHECK, FK, NOT NULL,
      -- the future-date trigger). Locks, deadlocks and everything else still abort the call so the
      -- caller sees a real fault instead of a silent zero.
      when data_exception or integrity_constraint_violation then
        v_rejected := v_rejected + 1;
    end;
  end loop;

  for a in select value from jsonb_array_elements(coalesce(p_attempts, '[]'::jsonb)) loop
    begin
      v_variant := (a ->> 'card_variant_id')::uuid;
      v_outcome := a ->> 'outcome';

      insert into public.price_sync_attempts as pa (
        card_variant_id, last_attempt_at, last_outcome, consecutive_unpriced, consecutive_failed
      ) values (
        v_variant, now(), v_outcome,
        case when v_outcome = 'no_price' then 1 else 0 end,
        case when v_outcome = 'provider_failed' then 1 else 0 end
      )
      on conflict (card_variant_id) do update
        set last_attempt_at = now(),
            last_outcome = excluded.last_outcome,
            consecutive_unpriced =
              case when excluded.last_outcome = 'no_price' then pa.consecutive_unpriced + 1 else 0 end,
            consecutive_failed =
              case when excluded.last_outcome = 'provider_failed' then pa.consecutive_failed + 1 else 0 end;
      v_attempts := v_attempts + 1;
    exception
      when data_exception or integrity_constraint_violation then
        null;
    end;
  end loop;

  return query select v_written, v_unchanged, v_superseded, v_rejected, v_attempts;
end;
$$;

revoke all on function public.ingest_price_observations(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_price_observations(jsonb, jsonb) to service_role;

comment on function public.ingest_price_observations(jsonb, jsonb) is
  'Service-role-only. Row-by-row price snapshot write for ingest-prices: a rejected row never costs '
  'the valid ones their write, an older observation never replaces a newer one of the same day, an '
  'identical one is counted as unchanged; also records per-variant attempts (P201).';

-- ── 4. No far-future snapshot dates ──────────────────────────────────────────────────────────────

create function public.reject_future_snapshot_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.snapshot_date > current_date + 1 then
    raise exception 'price_snapshots.snapshot_date % is more than a day in the future', new.snapshot_date
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_future_snapshot_date() from public, anon, authenticated;

create trigger price_snapshots_reject_future_date
  before insert or update of snapshot_date on public.price_snapshots
  for each row execute function public.reject_future_snapshot_date();
