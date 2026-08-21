-- M9: two service-role-only helpers for the scheduled ingest jobs.
--
-- select_price_sync_batch: the bounded work queue for ingest-prices (prompt §26) — watched
-- variants whose last successful snapshot is oldest first (nulls, i.e. never synced, first of
-- all), so the whole watched set cycles through roughly evenly rather than starving anything. A
-- plain GROUP BY + LEFT JOIN, never a per-row LATERAL (same reasoning as list_portfolio's rewrite
-- in this milestone) — this table can hold results for thousands of variants, so the query shape
-- matters here too even though it is a background job, not a user-facing page.
--
-- thin_price_snapshots: the retention job (prompt §63-64). Rows older than 12 months are thinned
-- to one per ISO week per (card_variant_id, provider) — the latest observation in that week is
-- kept, the rest deleted. Never touches the most recent 12 months, and never deletes the single
-- latest row for a variant/provider even if it is older than 12 months (a variant nobody has
-- refreshed in over a year must still resolve to *something* aged into `missing` by the resolver,
-- not silently lose its last known price).

create function public.select_price_sync_batch(p_batch_size int default 200)
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
  with last_seen as (
    select ps.card_variant_id, max(ps.snapshot_date) as last_date
    from public.price_snapshots ps
    group by ps.card_variant_id
  )
  select
    cv.id, cv.card_id, c.tcgdex_card_id, c.language, cv.finish, cv.stamp, cv.subtype, cv.size,
    ls.last_date
  from public.watched_card_variants wv
  join public.card_variants cv on cv.id = wv.card_variant_id
  join public.cards c on c.id = cv.card_id
  left join last_seen ls on ls.card_variant_id = cv.id
  where c.tcgdex_card_id is not null
  order by ls.last_date asc nulls first, cv.id asc
  limit greatest(least(coalesce(p_batch_size, 200), 2000), 1);
$$;

revoke all on function public.select_price_sync_batch(int) from public, anon, authenticated;
grant execute on function public.select_price_sync_batch(int) to service_role;

comment on function public.select_price_sync_batch(int) is
  'Service-role-only. Bounded, oldest-snapshot-first work queue for ingest-prices (prompt §26).';

create function public.thin_price_snapshots()
returns table (deleted_count bigint)
language sql
set search_path = ''
as $$
  with doomed as (
    select id
    from (
      select
        id,
        row_number() over (
          partition by card_variant_id, provider, date_trunc('week', snapshot_date)
          order by snapshot_date desc
        ) as rn,
        row_number() over (
          partition by card_variant_id, provider
          order by snapshot_date desc
        ) as latest_rn
      from public.price_snapshots
      where snapshot_date < (current_date - interval '12 months')
    ) ranked
    -- Keep the latest observation in each ISO week, and always keep the single latest row per
    -- (variant, provider) regardless of age, so a variant nobody has refreshed in over a year
    -- never loses its last known price entirely.
    where rn > 1 and latest_rn > 1
  ),
  removed as (
    delete from public.price_snapshots where id in (select id from doomed)
    returning id
  )
  select count(*) from removed;
$$;

revoke all on function public.thin_price_snapshots() from public, anon, authenticated;
grant execute on function public.thin_price_snapshots() to service_role;

comment on function public.thin_price_snapshots() is
  'Service-role-only, idempotent retention thinning (prompt §63-64): older than 12 months keeps '
  'one observation per ISO week per (variant, provider), and always keeps the single latest row.';
