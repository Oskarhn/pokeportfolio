-- M9 Market Movers foundation (prompt §54-55/§94, reserved by M7.1's F16 spec). Ranks the caller's
-- OWNED, currently-priced raw-card holdings by real period-over-period price movement — never a
-- global catalog ranking (privacy: no cross-user data), never a realized-P/L figure (§94: this is
-- price movement, not a sale), and never a fabricated 0% for a variant with no historical
-- observation in the requested window (prompt §54's explicit "do not rank missing-history cards as
-- 0% movement" — those are simply excluded, same "missing means absent, not zero" principle as F14).

create function public.get_market_movers(p_period_days int default 7, p_limit int default 10)
returns table (
  holding_id uuid,
  card_variant_id uuid,
  card_name text,
  card_image_base_url text,
  current_value_nok_minor text,
  previous_value_nok_minor text,
  change_nok_minor text,
  change_pct numeric
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
    select distinct h.id as holding_id, h.card_variant_id
    from public.holdings h
    join public.acquisition_lots l on l.holding_id = h.id
    where h.user_id = v_user_id
      and h.deleted_at is null
      and h.holding_kind = 'raw_card'
      and h.card_variant_id is not null
      and l.voided_at is null
      and l.quantity_remaining > 0
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
  )
  select
    o.holding_id,
    o.card_variant_id,
    c.name,
    c.image_base_url,
    lt.value_nok_minor::bigint::text,
    pv.value_nok_minor::bigint::text,
    (lt.value_nok_minor::bigint - pv.value_nok_minor::bigint)::text,
    case when pv.value_nok_minor <> 0
      then round(
        (lt.value_nok_minor::bigint - pv.value_nok_minor::bigint)::numeric
          / pv.value_nok_minor::numeric * 100,
        1
      )
      else null
    end
  from owned o
  join latest lt on lt.card_variant_id = o.card_variant_id
  join previous pv on pv.card_variant_id = o.card_variant_id
  left join public.card_variants cv on cv.id = o.card_variant_id
  left join public.cards c on c.id = cv.card_id
  -- A holding whose only observation in range is the same single snapshot has no real movement to
  -- report (latest = previous by identity) — excluded rather than shown as a fake 0% (prompt §54).
  where lt.snapshot_date <> pv.snapshot_date
  order by abs(lt.value_nok_minor::bigint - pv.value_nok_minor::bigint) desc
  limit v_limit;
end;
$$;

grant execute on function public.get_market_movers(int, int) to authenticated;
revoke execute on function public.get_market_movers(int, int) from public;
