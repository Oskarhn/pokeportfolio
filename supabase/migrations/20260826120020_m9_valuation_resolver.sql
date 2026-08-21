-- M9 valuation resolver (FINANCIAL_MODEL.md §6): manual → fresh → stale → missing, activating
-- `profiles.use_eu_pricing` (D-044/D-052) and replacing D-041's manual-only transitional value.
--
-- `resolve_variant_market_values(p_card_variant_ids uuid[])` is the ONE reusable, set-oriented
-- resolver every other M9 surface calls — never a per-row correlated subquery (prompt §74/§77's
-- exact warning, and the same defect class the real M7 10,000-lot benchmark already found once:
-- see 20260822120030_m7_portfolio_query_perf_fix.sql). It is called ONCE per query with the full
-- array of card_variant_ids that query needs, never once per holding.
--
-- Provider preference (D-052, FINANCIAL_MODEL.md §6 amendment): `use_eu_pricing = true` prefers
-- Cardmarket whenever it resolves to a non-missing (fresh or stale) price; TCGplayer is used only
-- when Cardmarket has none. `use_eu_pricing = false` is the mirror. Freshness is never compared
-- *across* providers to override this preference — a stale Cardmarket price is still preferred
-- over a fresher TCGplayer one when EU pricing is selected. This is the simplest reading of the
-- owner's stated preference ("use European pricing when available") and avoids a second implicit
-- ranking rule nobody asked for.

-- Money columns are returned as `text`, per the project's PostgREST bigint-serialization boundary
-- (DATA_MODEL.md §14 M7 note, tests/db/money-boundary.test.ts): a plain JSON number loses
-- precision above 2^53. Callers parse with BigInt()/parseMinorUnits (src/data/money.ts).
create function public.resolve_variant_market_values(p_card_variant_ids uuid[])
returns table (
  card_variant_id uuid,
  price_state text,
  value_nok_minor text,
  provider public.price_provider,
  price_kind public.price_kind,
  source_currency text,
  source_value_minor text,
  fx_rate numeric,
  snapshot_date date,
  provider_updated_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_use_eu_pricing boolean;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select p.use_eu_pricing into v_use_eu_pricing from public.profiles p where p.id = v_user_id;
  v_use_eu_pricing := coalesce(v_use_eu_pricing, true);

  return query
  with latest_snapshot as materialized (
    select distinct on (ps.card_variant_id, ps.provider)
      ps.card_variant_id, ps.provider, ps.price_kind, ps.source_currency, ps.value_minor,
      ps.snapshot_date, ps.provider_updated_at
    from public.price_snapshots ps
    where ps.card_variant_id = any(p_card_variant_ids)
    order by ps.card_variant_id, ps.provider, ps.snapshot_date desc
  ),
  -- One FX fact per (currency, date) actually present above — never one lookup per variant
  -- (prompt §76). "As-of" the snapshot date: the most recent Norges Bank observation on or before
  -- it (FINANCIAL_MODEL.md §7's weekend/holiday fallback, applied to market data too).
  fx_lookup as materialized (
    select
      d.base_currency,
      d.snapshot_date,
      (
        select fr.rate
        from public.fx_rates fr
        where fr.base_currency = d.base_currency
          and fr.quote_currency = 'NOK'
          and fr.source = 'norges_bank'
          and fr.rate_date <= d.snapshot_date
        order by fr.rate_date desc
        limit 1
      ) as rate
    from (
      select distinct ls.source_currency as base_currency, ls.snapshot_date
      from latest_snapshot ls
      where ls.source_currency <> 'NOK'
    ) d
  ),
  candidate as materialized (
    select
      ls.card_variant_id, ls.provider, ls.price_kind, ls.source_currency, ls.value_minor,
      ls.snapshot_date, ls.provider_updated_at,
      (current_date - ls.snapshot_date) as age_days,
      case
        when ls.source_currency = 'NOK' then ls.value_minor::numeric
        when fx.rate is not null then round(ls.value_minor * fx.rate)
        else null
      end as value_nok_minor,
      (case when ls.source_currency = 'NOK' then 1::numeric else fx.rate end) as fx_rate_used,
      (ls.source_currency = 'NOK' or fx.rate is not null) as fx_resolved
    from latest_snapshot ls
    left join fx_lookup fx
      on fx.base_currency = ls.source_currency and fx.snapshot_date = ls.snapshot_date
  ),
  -- A candidate only counts if FX actually resolved (prompt §32: an unresolved FX conversion is
  -- "unresolved", never 0/1) and the snapshot is not already beyond the missing threshold.
  pivot as materialized (
    select
      card_variant_id,
      max(value_nok_minor::bigint) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_value,
      max(price_kind) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_kind,
      max(source_currency) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_currency,
      max(value_minor) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_source_value,
      max(snapshot_date) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_date,
      max(provider_updated_at) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_updated,
      max(age_days) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_age,
      max(fx_rate_used) filter (
        where provider = 'tcgdex_cardmarket' and fx_resolved and age_days <= 30
      ) as cm_fx_rate,
      max(value_nok_minor::bigint) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_value,
      max(price_kind) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_kind,
      max(source_currency) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_currency,
      max(value_minor) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_source_value,
      max(snapshot_date) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_date,
      max(provider_updated_at) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_updated,
      max(age_days) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_age,
      max(fx_rate_used) filter (
        where provider = 'tcgdex_tcgplayer' and fx_resolved and age_days <= 30
      ) as tp_fx_rate
    from candidate
    group by card_variant_id
  )
  select
    p.card_variant_id,
    case
      when v_use_eu_pricing and p.cm_value is not null then case when p.cm_age <= 3 then 'fresh' else 'stale' end
      when v_use_eu_pricing and p.tp_value is not null then case when p.tp_age <= 3 then 'fresh' else 'stale' end
      when not v_use_eu_pricing and p.tp_value is not null then case when p.tp_age <= 3 then 'fresh' else 'stale' end
      when not v_use_eu_pricing and p.cm_value is not null then case when p.cm_age <= 3 then 'fresh' else 'stale' end
      else 'missing'
    end,
    (case
      when v_use_eu_pricing and p.cm_value is not null then p.cm_value
      when v_use_eu_pricing then p.tp_value
      when not v_use_eu_pricing and p.tp_value is not null then p.tp_value
      else p.cm_value
    end)::text,
    case
      when v_use_eu_pricing and p.cm_value is not null then 'tcgdex_cardmarket'::public.price_provider
      when v_use_eu_pricing and p.tp_value is not null then 'tcgdex_tcgplayer'::public.price_provider
      when not v_use_eu_pricing and p.tp_value is not null then 'tcgdex_tcgplayer'::public.price_provider
      when not v_use_eu_pricing and p.cm_value is not null then 'tcgdex_cardmarket'::public.price_provider
      else null
    end,
    case
      when v_use_eu_pricing and p.cm_value is not null then p.cm_kind
      when v_use_eu_pricing and p.tp_value is not null then p.tp_kind
      when not v_use_eu_pricing and p.tp_value is not null then p.tp_kind
      when not v_use_eu_pricing and p.cm_value is not null then p.cm_kind
      else null
    end,
    case
      when v_use_eu_pricing and p.cm_value is not null then p.cm_currency
      when v_use_eu_pricing and p.tp_value is not null then p.tp_currency
      when not v_use_eu_pricing and p.tp_value is not null then p.tp_currency
      when not v_use_eu_pricing and p.cm_value is not null then p.cm_currency
      else null
    end,
    (case
      when v_use_eu_pricing and p.cm_value is not null then p.cm_source_value
      when v_use_eu_pricing and p.tp_value is not null then p.tp_source_value
      when not v_use_eu_pricing and p.tp_value is not null then p.tp_source_value
      when not v_use_eu_pricing and p.cm_value is not null then p.cm_source_value
      else null
    end)::text,
    case
      when v_use_eu_pricing and p.cm_value is not null then p.cm_fx_rate
      when v_use_eu_pricing and p.tp_value is not null then p.tp_fx_rate
      when not v_use_eu_pricing and p.tp_value is not null then p.tp_fx_rate
      when not v_use_eu_pricing and p.cm_value is not null then p.cm_fx_rate
      else null
    end,
    case
      when v_use_eu_pricing and p.cm_value is not null then p.cm_date
      when v_use_eu_pricing and p.tp_value is not null then p.tp_date
      when not v_use_eu_pricing and p.tp_value is not null then p.tp_date
      when not v_use_eu_pricing and p.cm_value is not null then p.cm_date
      else null
    end,
    case
      when v_use_eu_pricing and p.cm_value is not null then p.cm_updated
      when v_use_eu_pricing and p.tp_value is not null then p.tp_updated
      when not v_use_eu_pricing and p.tp_value is not null then p.tp_updated
      when not v_use_eu_pricing and p.cm_value is not null then p.cm_updated
      else null
    end
  from pivot p;
end;
$$;

comment on function public.resolve_variant_market_values(uuid[]) is
  'Set-oriented FINANCIAL_MODEL.md §6 provider resolver (fresh/stale/missing, use_eu_pricing '
  'preference). Called once per query with the full array of needed card_variant_ids — never in a '
  'per-row LATERAL. Does not consider manual valuations; callers apply the manual override '
  '(state=manual always wins) themselves, since that is per-holding, not per-variant.';

grant execute on function public.resolve_variant_market_values(uuid[]) to authenticated;
revoke execute on function public.resolve_variant_market_values(uuid[]) from public;

-- ── get_holding_value_provenance (Holding Detail, prompt §34/§47) ──────────────────────────────
--
-- Full provenance for one holding: manual override if active, else the provider resolver — but
-- NEVER a raw provider price for a graded holding (F10, tested explicitly). Sealed and manual-card
-- holdings have no card_variant_id, so they fall straight through to "missing" unless a manual
-- valuation exists, with no special-casing needed.

create function public.get_holding_value_provenance(p_holding_id uuid)
returns table (
  price_state text,
  unit_value_nok_minor text,
  quantity text,
  holding_value_nok_minor text,
  provider public.price_provider,
  price_kind public.price_kind,
  source_currency text,
  source_value_minor text,
  fx_rate numeric,
  snapshot_date date,
  provider_updated_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_holding record;
  v_quantity bigint;
  v_manual_value bigint;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select h.id, h.holding_kind, h.card_variant_id
    into v_holding
    from public.holdings h
    where h.id = p_holding_id and h.user_id = v_user_id;

  if v_holding.id is null then
    raise exception 'holding % not found', p_holding_id;
  end if;

  select coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint
    into v_quantity
    from public.acquisition_lots l
    where l.holding_id = p_holding_id;

  select mv.value_nok_minor into v_manual_value
    from public.manual_valuations mv
    where mv.holding_id = p_holding_id and mv.superseded_at is null;

  if v_manual_value is not null then
    return query select
      'manual'::text, v_manual_value::text, v_quantity::text, (v_manual_value * v_quantity)::text,
      null::public.price_provider, null::public.price_kind, null::text, null::text,
      null::numeric, null::date, null::timestamptz;
    return;
  end if;

  if v_holding.holding_kind <> 'raw_card' or v_holding.card_variant_id is null then
    return query select
      'missing'::text, null::text, v_quantity::text, null::text,
      null::public.price_provider, null::public.price_kind, null::text, null::text,
      null::numeric, null::date, null::timestamptz;
    return;
  end if;

  return query
  select
    r.price_state,
    r.value_nok_minor,
    v_quantity::text,
    (r.value_nok_minor::bigint * v_quantity)::text,
    r.provider, r.price_kind, r.source_currency, r.source_value_minor, r.fx_rate,
    r.snapshot_date, r.provider_updated_at
  from public.resolve_variant_market_values(array[v_holding.card_variant_id]) r;
end;
$$;

grant execute on function public.get_holding_value_provenance(uuid) to authenticated;
revoke execute on function public.get_holding_value_provenance(uuid) from public;

-- ── get_card_variant_price_history (Card Detail chart, prompt §51-53/§95-96) ───────────────────
--
-- Real snapshots only, one resolved (already fallback-chosen, already NOK-converted) point per
-- day — never a fabricated point, never an avg7/avg30 rolling statistic mistaken for a historical
-- observation (D-008, restated for M9). Applies the same use_eu_pricing provider preference as the
-- current-value resolver, per day, so the chart and the "current value" figure never disagree
-- about which provider is authoritative.

create function public.get_card_variant_price_history(
  p_card_variant_id uuid,
  p_since date default null
)
returns table (
  snapshot_date date,
  value_nok_minor text,
  provider public.price_provider,
  price_kind public.price_kind
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_use_eu_pricing boolean;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select p.use_eu_pricing into v_use_eu_pricing from public.profiles p where p.id = v_user_id;
  v_use_eu_pricing := coalesce(v_use_eu_pricing, true);

  return query
  with raw as materialized (
    select ps.snapshot_date, ps.provider, ps.price_kind, ps.source_currency, ps.value_minor
    from public.price_snapshots ps
    where ps.card_variant_id = p_card_variant_id
      and (p_since is null or ps.snapshot_date >= p_since)
  ),
  fx_lookup as materialized (
    select
      d.base_currency,
      d.snapshot_date,
      (
        select fr.rate from public.fx_rates fr
        where fr.base_currency = d.base_currency and fr.quote_currency = 'NOK'
          and fr.source = 'norges_bank' and fr.rate_date <= d.snapshot_date
        order by fr.rate_date desc limit 1
      ) as rate
    from (select distinct source_currency as base_currency, snapshot_date from raw where source_currency <> 'NOK') d
  ),
  converted as materialized (
    select
      r.snapshot_date, r.provider, r.price_kind,
      case when r.source_currency = 'NOK' then r.value_minor::numeric
           when fx.rate is not null then round(r.value_minor * fx.rate)
           else null end as value_nok_minor
    from raw r
    left join fx_lookup fx on fx.base_currency = r.source_currency and fx.snapshot_date = r.snapshot_date
  )
  select c.snapshot_date, c.value_nok_minor::bigint::text, c.provider, c.price_kind
  from converted c
  where c.value_nok_minor is not null
    and (
      (v_use_eu_pricing and c.provider = 'tcgdex_cardmarket')
      or (v_use_eu_pricing and c.provider = 'tcgdex_tcgplayer'
          and not exists (
            select 1 from converted c2
            where c2.snapshot_date = c.snapshot_date and c2.provider = 'tcgdex_cardmarket'
              and c2.value_nok_minor is not null
          ))
      or (not v_use_eu_pricing and c.provider = 'tcgdex_tcgplayer')
      or (not v_use_eu_pricing and c.provider = 'tcgdex_cardmarket'
          and not exists (
            select 1 from converted c2
            where c2.snapshot_date = c.snapshot_date and c2.provider = 'tcgdex_tcgplayer'
              and c2.value_nok_minor is not null
          ))
    )
  order by c.snapshot_date asc;
end;
$$;

grant execute on function public.get_card_variant_price_history(uuid, date) to authenticated;
revoke execute on function public.get_card_variant_price_history(uuid, date) from public;
