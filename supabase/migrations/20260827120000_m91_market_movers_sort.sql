-- M9.1 (prompt §18-23): the owner's original Market Movers spec needed a real dedicated screen
-- with period and sort-mode controls, not just Home's fixed-7-day/fixed-sort compact section.
-- get_market_movers already accepted p_period_days (UX_FLOWS.md F16 already called this "UI-only
-- remaining work"), but had no sort parameter and no quantity-weighted secondary figure (prompt
-- §23). This DROP+CREATEs it to add both — per the M9.1 standing checklist this same migration adds
-- to TESTING.md (D-054's lesson), the body below is a direct extension of the M9 version
-- (20260826120055_m9_market_movers.sql), not a rewrite: the same materialized CTEs, the same
-- provider-preference/FX/exclusion rules, unchanged. Only the final SELECT/ORDER BY and one added
-- `quantity`/`holding_impact_nok_minor` column are new.
--
-- Sort semantics (prompt §21, documented decision): the owner's original request was about cards
-- whose PRICE moved most, so every sort mode ranks by the per-unit percentage change — never by
-- absolute holding-total kroner, which would just reward large quantities regardless of real price
-- movement. `holding_impact_nok_minor` (unit change x quantity) rides along as a secondary,
-- informational figure only (prompt §23's "you may additionally display... as a secondary value").
--
--   highest_increase  change_pct DESC
--   largest_decrease  change_pct ASC
--   most_movement     ABS(change_pct) DESC   (the previous, and still the default)
--   least_movement    ABS(change_pct) ASC
--
-- A holding with no comparison point in the window is excluded, never shown as 0% (prompt §21's
-- "do not treat missing as zero movement" — unchanged from M9).

create type public.market_mover_sort as enum (
  'most_movement', 'least_movement', 'highest_increase', 'largest_decrease'
);

drop function if exists public.get_market_movers(int, int);

create function public.get_market_movers(
  p_period_days int default 7,
  p_limit int default 10,
  p_sort public.market_mover_sort default 'most_movement'
)
returns table (
  holding_id uuid,
  card_variant_id uuid,
  card_name text,
  card_image_base_url text,
  quantity bigint,
  current_value_nok_minor text,
  previous_value_nok_minor text,
  change_nok_minor text,
  change_pct numeric,
  holding_impact_nok_minor text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_use_eu_pricing boolean;
  v_period int := greatest(least(coalesce(p_period_days, 7), 365), 1);
  v_limit int := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select p.use_eu_pricing into v_use_eu_pricing from public.profiles p where p.id = v_user_id;
  v_use_eu_pricing := coalesce(v_use_eu_pricing, true);

  return query
  with owned as materialized (
    select
      h.id as holding_id, h.card_variant_id,
      sum(l.quantity_remaining)::bigint as quantity
    from public.holdings h
    join public.acquisition_lots l on l.holding_id = h.id
    where h.user_id = v_user_id
      and h.deleted_at is null
      and h.holding_kind = 'raw_card'
      and h.card_variant_id is not null
      and l.voided_at is null
      and l.quantity_remaining > 0
    group by h.id, h.card_variant_id
  ),
  -- Preferred-provider snapshot on/after the window start, closest to it (the "previous" point);
  -- and the latest snapshot at all (the "current" point) — both via the same provider-preference
  -- rule the current-value resolver uses (D-052), so Market Movers never disagrees with the
  -- headline value about which provider is authoritative.
  preferred_snapshot as materialized (
    select
      ps.card_variant_id, ps.snapshot_date, ps.value_minor, ps.source_currency, ps.provider
    from public.price_snapshots ps
    join owned o on o.card_variant_id = ps.card_variant_id
    where ps.provider = case when v_use_eu_pricing then 'tcgdex_cardmarket'::public.price_provider
                              else 'tcgdex_tcgplayer'::public.price_provider end
  ),
  fx_lookup as materialized (
    select
      d.base_currency, d.snapshot_date,
      (select fr.rate from public.fx_rates fr
       where fr.base_currency = d.base_currency and fr.quote_currency = 'NOK'
         and fr.source = 'norges_bank' and fr.rate_date <= d.snapshot_date
       order by fr.rate_date desc limit 1) as rate
    from (select distinct source_currency as base_currency, snapshot_date
          from preferred_snapshot where source_currency <> 'NOK') d
  ),
  converted as materialized (
    select
      s.card_variant_id, s.snapshot_date,
      case when s.source_currency = 'NOK' then s.value_minor::numeric
           when fx.rate is not null then round(s.value_minor * fx.rate)
           else null end as value_nok_minor
    from preferred_snapshot s
    left join fx_lookup fx on fx.base_currency = s.source_currency and fx.snapshot_date = s.snapshot_date
  ),
  latest as materialized (
    select distinct on (converted.card_variant_id)
      converted.card_variant_id, converted.snapshot_date, converted.value_nok_minor
    from converted
    where value_nok_minor is not null
    order by converted.card_variant_id, converted.snapshot_date desc
  ),
  previous as materialized (
    select distinct on (converted.card_variant_id)
      converted.card_variant_id, converted.snapshot_date, converted.value_nok_minor
    from converted
    where value_nok_minor is not null and snapshot_date <= current_date - v_period
    order by converted.card_variant_id, converted.snapshot_date desc
  ),
  moved as materialized (
    select
      o.holding_id,
      o.card_variant_id,
      o.quantity,
      lt.value_nok_minor::bigint as current_value_nok_minor,
      pv.value_nok_minor::bigint as previous_value_nok_minor,
      (lt.value_nok_minor::bigint - pv.value_nok_minor::bigint) as change_nok_minor,
      case when pv.value_nok_minor <> 0
        then round(
          (lt.value_nok_minor::bigint - pv.value_nok_minor::bigint)::numeric
            / pv.value_nok_minor::numeric * 100,
          1
        )
        else null
      end as change_pct
    from owned o
    join latest lt on lt.card_variant_id = o.card_variant_id
    join previous pv on pv.card_variant_id = o.card_variant_id
    -- A holding whose only observation in range is the same single snapshot has no real movement to
    -- report (latest = previous by identity) — excluded rather than shown as a fake 0% (prompt §54).
    where lt.snapshot_date <> pv.snapshot_date
  )
  select
    m.holding_id,
    m.card_variant_id,
    c.name,
    c.image_base_url,
    m.quantity,
    m.current_value_nok_minor::text,
    m.previous_value_nok_minor::text,
    m.change_nok_minor::text,
    m.change_pct,
    (m.change_nok_minor * m.quantity)::text
  from moved m
  left join public.card_variants cv on cv.id = m.card_variant_id
  left join public.cards c on c.id = cv.card_id
  order by
    case p_sort
      when 'highest_increase' then m.change_pct end desc nulls last,
    case p_sort
      when 'largest_decrease' then m.change_pct end asc nulls last,
    case p_sort
      when 'most_movement' then abs(m.change_pct) end desc nulls last,
    case p_sort
      when 'least_movement' then abs(m.change_pct) end asc nulls last,
    abs(m.change_nok_minor) desc
  limit v_limit;
end;
$$;

grant execute on function public.get_market_movers(int, int, public.market_mover_sort) to authenticated;
revoke execute on function public.get_market_movers(int, int, public.market_mover_sort) from public;

comment on function public.get_market_movers(int, int, public.market_mover_sort) is
  'Real period-over-period price movement of the caller''s own owned, currently-priced raw-card '
  'holdings (M9.1 prompt §18-23). Ranks by per-unit change_pct; holding_impact_nok_minor '
  '(change x quantity) is a secondary informational figure only. No cross-user data.';
