-- M12 Dashboard — the recompute engine.
--
-- rebuild_portfolio_snapshots(p_user_id, p_from, p_through) is the SINGLE derivation of the
-- snapshot cache from canonical truth. It is deterministic, idempotent, exact-integer, and
-- respects the historical semantics FINANCIAL_MODEL.md §3 defines:
--
--   Ownership   a lot is open on D when acquired_on <= D, the lot is not voided, and
--               quantity − Σ(non-voided disposals with disposed_on <= D) > 0.
--               Current quantity_remaining is NEVER projected backward — the disposal timeline
--               is replayed per date (prompt §14/§17).
--   Boundaries  acquired day 30 contributes nothing on 29; sold day 100 contributes nothing from
--               day 100 onward (the disposal date itself is already outside); same-day
--               acquire+full-sell ends the day at zero (end-of-business-day snapshot state,
--               prompt §18/§19/§20).
--   Valuation   manual valuation interval model (D-062) → provider observation steps as-of D
--               (freshness age = D − snapshot_date, never today − snapshot_date, prompt §25)
--               → FX observed on/before the provider observation's own date (never today's rate)
--               → missing stays missing, genuine zero stays zero (F14).
--   Ledger      CS/NSP cumulatives use frozen *_nok_minor facts and business dates; voided rows
--               are excluded entirely, so a correction rewrites history to the corrected truth.
--   Coverage    market value sums resolved lots only; unresolved lots are counted in
--               unvalued_lot_count and never silently valued at zero (F14/prompt §32).
--
-- SECURITY: this function is the one writer of the cache. It takes an explicit target user and
-- writes nothing but that user's own cache rows/queue/run metadata — no arbitrary SQL, fixed
-- search_path, PUBLIC/anon/authenticated EXECUTE revoked (service/internal-only, prompt §94).
-- It is SECURITY DEFINER because the pg_cron worker and the shared-market-data triggers
-- (price/FX/thinning invalidation across users) must write the queue and cache without a
-- browser caller context; every statement inside is scoped to p_user_id explicitly. It is
-- granted to service_role only; the cron job itself runs as the migration owner (postgres).

create or replace function public.rebuild_portfolio_snapshots(
  p_user_id uuid,
  p_from date,
  p_through date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from date := least(p_from, p_through);
  v_through date := least(greatest(p_from, p_through), current_date);
  v_use_eu boolean;
  v_first_tracked date;
  v_written integer := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  select coalesce(p.use_eu_pricing, true) into v_use_eu
    from public.profiles p where p.id = p_user_id;
  v_use_eu := coalesce(v_use_eu, true);

  delete from public.portfolio_snapshots s
   where s.user_id = p_user_id
     and s.snapshot_date between v_from and v_through;

  -- Earliest date any canonical fact begins for this user. Nothing before it can have a
  -- snapshot: no ownership, no spend, no proceeds — storing zero-filled rows there would
  -- fabricate history (prompt §27/§48/§91).
  select min(d) into v_first_tracked from (
    select min(l.acquired_on) as d from public.acquisition_lots l
      where l.user_id = p_user_id and l.voided_at is null
    union all
    select min(p.purchased_on) from public.purchases p
      where p.user_id = p_user_id and p.voided_at is null
    union all
    select min(s.sold_on) from public.sales s
      where s.user_id = p_user_id and s.voided_at is null
  ) f;

  if v_first_tracked is null or v_through < v_first_tracked or v_through < v_from then
    return 0;
  end if;
  v_from := greatest(v_from, v_first_tracked);

  insert into public.portfolio_snapshots (
    user_id, snapshot_date,
    market_value_nok_minor, attributed_value_nok_minor, cost_basis_nok_minor,
    collectible_spend_to_date_nok_minor, sales_proceeds_to_date_nok_minor,
    open_lot_count, unvalued_lot_count, computed_at
  )
  with lots as materialized (
    -- Every non-voided lot of every live holding, with its identity for valuation. Voided lots
    -- are corrections: they are excluded from every historical state entirely (prompt §21),
    -- exactly as the current-state queries treat them.
    select l.id as lot_id, l.holding_id, l.acquired_on, l.quantity,
           l.cost_basis_state, l.unit_cost_basis_nok_minor
    from public.acquisition_lots l
    join public.holdings h on h.id = l.holding_id
    where l.user_id = p_user_id
      and l.voided_at is null
      and h.deleted_at is null
      and h.user_id = p_user_id
  ),
  dates as materialized (
    select d::date as d from generate_series(v_from, v_through, interval '1 day') d
  ),
  -- ── ownership timeline: quantity remaining as of each date ────────────────────────────────
  grid as materialized (
    select l.lot_id, l.holding_id, l.quantity, l.cost_basis_state,
           l.unit_cost_basis_nok_minor, dt.d
    from lots l join dates dt on dt.d >= l.acquired_on
  ),
  disposed_per_day as materialized (
    select ld.lot_id, ld.disposed_on as d, sum(ld.quantity) as qty
    from public.lot_disposals ld
    join lots l on l.lot_id = ld.lot_id
    where ld.voided_at is null and ld.disposed_on <= v_through
    group by ld.lot_id, ld.disposed_on
  ),
  adjusted_per_day as materialized (
    select a.lot_id, a.occurred_on as d, sum(a.amount_nok_minor) as amt
    from public.lot_cost_adjustments a
    join lots l on l.lot_id = a.lot_id
    where a.occurred_on <= v_through
    group by a.lot_id, a.occurred_on
  ),
  -- Two single-stream joins + GROUP BY (never a correlated per-row subquery, D-054 discipline):
  -- cumulative disposal quantity and cumulative adjustment amount as of each date.
  lot_qty_day as materialized (
    select g.lot_id, g.holding_id, g.d, g.cost_basis_state, g.unit_cost_basis_nok_minor,
           g.quantity - coalesce(sum(dp.qty), 0)::int as qty_open
    from grid g
    left join disposed_per_day dp on dp.lot_id = g.lot_id and dp.d <= g.d
    group by g.lot_id, g.holding_id, g.d, g.quantity, g.cost_basis_state, g.unit_cost_basis_nok_minor
  ),
  lot_adj_day as materialized (
    select g.lot_id, g.d, coalesce(sum(ap.amt), 0)::bigint as adj_to_date
    from grid g
    left join adjusted_per_day ap on ap.lot_id = g.lot_id and ap.d <= g.d
    group by g.lot_id, g.d
  ),
  lot_day as materialized (
    select q.*, a.adj_to_date
    from lot_qty_day q join lot_adj_day a on a.lot_id = q.lot_id and a.d = q.d
    where q.qty_open > 0
  ),
  -- ── manual valuation intervals (D-062): economic validity [effective_from, next_effective_from)
  -- sorted by (effective_from, created_at, id); a terminal clear ends the last interval at the
  -- wall-clock clear date. A later-created backdated row therefore rewrites history from its own
  -- effective_from forward — corrections rewrite history, deliberately.
  mv_intervals as materialized (
    select mv.holding_id, mv.effective_from,
           lead(mv.effective_from) over w as next_eff,
           case when lead(mv.effective_from) over w is not null
                then lead(mv.effective_from) over w
                else cast(mv.superseded_at as date) end as valid_to,
           mv.value_nok_minor
    from public.manual_valuations mv
    where mv.user_id = p_user_id
    window w as (partition by mv.holding_id order by mv.effective_from, mv.created_at, mv.id)
  ),
  holding_meta as materialized (
    select h.id as holding_id, h.holding_kind, h.card_variant_id
    from public.holdings h
    where h.user_id = p_user_id and h.deleted_at is null
  ),
  manual_days as materialized (
    select mi.holding_id, dt.d, mi.value_nok_minor
    from mv_intervals mi join dates dt
      on dt.d >= mi.effective_from
     and (mi.valid_to is null or dt.d < mi.valid_to)
  ),
  -- ── provider observations as step functions over the range (age measured from D, prompt §25)
  owned_variants as materialized (
    select distinct hm.card_variant_id
    from holding_meta hm
    where hm.card_variant_id is not null and hm.holding_kind = 'raw_card'
  ),
  obs as materialized (
    select ps.card_variant_id, ps.provider, ps.snapshot_date, ps.source_currency, ps.value_minor
    from public.price_snapshots ps
    join owned_variants ov on ov.card_variant_id = ps.card_variant_id
    where ps.snapshot_date > v_from - 31   -- older observations can never resolve inside the range
      and ps.snapshot_date <= v_through
  ),
  obs_step as materialized (
    select o.*,
           lead(o.snapshot_date) over (
             partition by o.card_variant_id, o.provider order by o.snapshot_date
           ) as next_date
    from obs o
  ),
  obs_fx as materialized (
    select
      d.base_currency, d.snapshot_date,
      (
        select fr.rate from public.fx_rates fr
        where fr.base_currency = d.base_currency
          and fr.quote_currency = 'NOK'
          and fr.source = 'norges_bank'
          and fr.rate_date <= d.snapshot_date
        order by fr.rate_date desc
        limit 1
      ) as rate
    from (
      select distinct o.source_currency as base_currency, o.snapshot_date
      from obs_step o where o.source_currency <> 'NOK'
    ) d
  ),
  steps as materialized (
    select os.card_variant_id, os.provider, os.snapshot_date,
           least(os.snapshot_date + 31, coalesce(os.next_date, os.snapshot_date + 31)) as valid_to,
           case when os.source_currency = 'NOK' then os.value_minor::numeric
                when fx.rate is not null then round(os.value_minor * fx.rate)
           end as nok_value
    from obs_step os
    left join obs_fx fx
      on fx.base_currency = os.source_currency and fx.snapshot_date = os.snapshot_date
  ),
  provider_days as materialized (
    select s.card_variant_id, dt.d, s.nok_value, s.provider
    from steps s join dates dt
      on dt.d >= s.snapshot_date and dt.d < s.valid_to
    where s.nok_value is not null
  ),
  -- One resolved unit value per (variant, date), honouring the same use_eu_pricing preference
  -- (D-052) as the current-value resolver — freshness never overrides the preference.
  provider_choice as materialized (
    select pd.card_variant_id, pd.d,
           max(pd.nok_value) filter (where pd.provider = 'tcgdex_cardmarket') as cm,
           max(pd.nok_value) filter (where pd.provider = 'tcgdex_tcgplayer') as tp
    from provider_days pd
    group by pd.card_variant_id, pd.d
  ),
  variant_unit as materialized (
    select pc.card_variant_id, pc.d,
           case when v_use_eu and pc.cm is not null then pc.cm
                when v_use_eu and pc.tp is not null then pc.tp
                when not v_use_eu and pc.tp is not null then pc.tp
                else pc.cm
           end as unit_value
    from provider_choice pc
  ),
  holding_days as materialized (
    select distinct ld.holding_id, ld.d from lot_day ld
  ),
  -- Per-holding unit value on a day: active manual interval wins; otherwise a provider value
  -- ONLY for raw cards (F10 — graded and sealed resolve manual-or-missing, unchanged from M9).
  holding_unit as materialized (
    select hd.holding_id, hd.d,
           case
             when md.value_nok_minor is not null then md.value_nok_minor
             when hm.holding_kind = 'raw_card' and vu.unit_value is not null then vu.unit_value::bigint
             else null
           end as unit_value
    from holding_days hd
    join holding_meta hm on hm.holding_id = hd.holding_id
    left join manual_days md on md.holding_id = hd.holding_id and md.d = hd.d
    left join variant_unit vu on vu.card_variant_id = hm.card_variant_id and vu.d = hd.d
  ),
  lot_valued as materialized (
    select ld.d, ld.lot_id, ld.qty_open, ld.adj_to_date,
           lq.cost_basis_state, lq.unit_cost_basis_nok_minor, hu.unit_value
    from lot_day ld
    join lots lq on lq.lot_id = ld.lot_id
    join holding_meta hm on hm.holding_id = ld.holding_id
    left join holding_unit hu on hu.holding_id = ld.holding_id and hu.d = ld.d
  ),
  -- DCB as of D: quantity × unit basis plus the lot's proportional share (floor) of adjustments
  -- that had occurred by D — a future grading adjustment never inflates a past snapshot
  -- (prompt §58). Exact integers; the flooring rule is DECISIONS.md D-068.
  daily_core as materialized (
    select lv.d,
           coalesce(sum(lv.qty_open * lv.unit_value)
             filter (where lv.unit_value is not null), 0)::bigint as cmv,
           coalesce(sum(lv.qty_open * lv.unit_value)
             filter (where lv.unit_value is not null and lv.cost_basis_state = 'known'), 0)::bigint as acmv,
           coalesce(sum(
             lv.qty_open * lq.unit_cost_basis_nok_minor
             + floor(lv.adj_to_date * lv.qty_open / greatest(lq.quantity, 1))
           ) filter (where lv.cost_basis_state = 'known'), 0)::bigint as dcb,
           count(*)::bigint as open_lot_count,
           count(*) filter (where lv.unit_value is null)::bigint as unvalued_lot_count
    from lot_valued lv
    join lots lq on lq.lot_id = lv.lot_id
    group by lv.d
  ),
  spend_by_day as materialized (
    select p.purchased_on as d,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'collectible'), 0)::bigint as cs_delta,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'hobby'), 0)::bigint as hs_delta
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id
      and p.user_id = p_user_id
      and p.voided_at is null
      and p.purchased_on <= v_through
    group by p.purchased_on
  ),
  proceeds_by_day as materialized (
    select s.sold_on as d, sum(s.net_proceeds_nok_minor)::bigint as nsp_delta
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on <= v_through
    group by s.sold_on
  ),
  spend_before as materialized (
    select coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'collectible'), 0)::bigint as cs,
           coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'hobby'), 0)::bigint as hs
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id and p.voided_at is null and p.purchased_on < v_from
  ),
  proceeds_before as materialized (
    select coalesce(sum(s.net_proceeds_nok_minor), 0)::bigint as nsp
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on < v_from
  ),
  -- Frozen-ledger cumulatives over the date spine: opening balance before the range plus a
  -- running sum of per-day deltas. Set-based window, no correlated per-date subquery.
  spine as materialized (
    select dt.d,
           sb.cs + coalesce(sum(sd.cs_delta) over (order by dt.d), 0)::bigint as cs,
           pb.nsp + coalesce(sum(pd.nsp_delta) over (order by dt.d), 0)::bigint as nsp
    from dates dt
    left join spend_by_day sd on sd.d = dt.d
    left join proceeds_by_day pd on pd.d = dt.d
    cross join spend_before sb
    cross join proceeds_before pb
  )
  select
    p_user_id,
    spine.d,
    coalesce(dc.cmv, 0),
    coalesce(dc.acmv, 0),
    coalesce(dc.dcb, 0),
    spine.cs,
    spine.nsp,
    coalesce(dc.open_lot_count, 0),
    coalesce(dc.unvalued_lot_count, 0),
    now()
  from spine
  left join daily_core dc on dc.d = spine.d;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function public.rebuild_portfolio_snapshots(uuid, date, date) is
  'M12: deterministic full/incremental derivation of portfolio_snapshots from canonical rows '
  '(DATA_MODEL.md §6). Deletes and recomputes [max(p_from, first tracked date), min(p_through, '
  'current_date)] for one user. Service-only writer; see the migration header for the full '
  'historical-semantics contract and DECISIONS.md D-062/D-068.';

revoke execute on function public.rebuild_portfolio_snapshots(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.rebuild_portfolio_snapshots(uuid, date, date) to service_role;

-- ── enqueue_portfolio_recompute ──────────────────────────────────────────────────────────────
-- The one writer of the queue. Coalesces with LEAST so repeated/backdated invalidations can
-- never move the dirty boundary later and silently skip older history (prompt §15/§53).
-- SECURITY DEFINER because triggers fire under many roles (authenticated mutations, the
-- service-role ingest jobs, postgres-run retention); browsers hold no EXECUTE grant, so a
-- session cannot enqueue arbitrary users (prompt §93).

create or replace function public.enqueue_portfolio_recompute(
  p_user_id uuid,
  p_dirty_from date
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.portfolio_recompute_queue as q (user_id, dirty_from)
  values (p_user_id, p_dirty_from)
  on conflict (user_id) do update
    set dirty_from = least(excluded.dirty_from, q.dirty_from),
        updated_at = now();
$$;

revoke execute on function public.enqueue_portfolio_recompute(uuid, date)
  from public, anon, authenticated;

-- ── drain_portfolio_recompute_queue ──────────────────────────────────────────────────────────
-- The worker (pg_cron, prompt §51/§52). Bounded batch, SKIP LOCKED so overlapping invocations
-- never process the same user destructively (prompt §54), per-user subtransaction so one bad
-- user cannot lose anyone else's work or its own dirty marker (prompt §53 — the queue row is
-- deleted only AFTER its snapshots are successfully written in the same transaction).

create or replace function public.drain_portfolio_recompute_queue(
  p_batch_users int default 20
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch int := least(greatest(coalesce(p_batch_users, 20), 1), 100);
  v_run_id bigint;
  v_processed int := 0;
  v_written int := 0;
  v_errors text := null;
  r record;
  v_user_written int;
begin
  insert into public.portfolio_recompute_runs (started_at) values (now())
    returning id into v_run_id;

  for r in
    select q.user_id, q.dirty_from
    from public.portfolio_recompute_queue q
    where q.dirty_from <= current_date
    order by q.dirty_from, q.user_id
    limit v_batch
    for update skip locked
  loop
    begin
      v_user_written := public.rebuild_portfolio_snapshots(r.user_id, r.dirty_from, current_date);
      delete from public.portfolio_recompute_queue where user_id = r.user_id;
      v_processed := v_processed + 1;
      v_written := v_written + coalesce(v_user_written, 0);
    exception when others then
      -- Roll back this user's partial work (inner block), keep their queue row, keep going.
      v_errors := coalesce(v_errors, '') || format('user %s failed: %s; ', r.user_id, sqlerrm);
    end;
  end loop;

  update public.portfolio_recompute_runs
     set finished_at = now(),
         users_processed = v_processed,
         snapshots_written = v_written,
         error = v_errors
   where id = v_run_id;

  return v_processed;
end;
$$;

comment on function public.drain_portfolio_recompute_queue(int) is
  'M12 worker: drains up to p_batch_users due queue rows (SKIP LOCKED, per-user failure '
  'isolation), rebuilding each user''s snapshots from their dirty_from through today. '
  'Service/internal-only — no browser-reachable EXECUTE.';

revoke execute on function public.drain_portfolio_recompute_queue(int)
  from public, anon, authenticated;
grant execute on function public.drain_portfolio_recompute_queue(int) to service_role;

-- ── enqueue_portfolio_daily_maintenance ──────────────────────────────────────────────────────
-- The daily safety sweep (prompt §50/§52): guarantees every user who owns anything gets a fresh
-- current-date snapshot even when no transaction and no price/FX tick happens to enqueue them
-- (e.g. a quiet weekend), and rescues a stranded future-dated dirty_from once its date arrives.
-- Enqueues with LEAST, so it never widens anyone else's range backward.

create or replace function public.enqueue_portfolio_daily_maintenance()
returns integer
language sql
security definer
set search_path = ''
as $$
  with owners as (
    select distinct l.user_id
    from public.acquisition_lots l
    where l.voided_at is null
    union
    select distinct p.user_id from public.purchases p where p.voided_at is null
    union
    select distinct s.user_id from public.sales s where s.voided_at is null
  )
  insert into public.portfolio_recompute_queue as q (user_id, dirty_from, updated_at)
  select o.user_id, current_date, now() from owners o
  on conflict (user_id) do update
    set dirty_from = least(excluded.dirty_from, q.dirty_from),
        updated_at = now();
  select count(*)::int from public.portfolio_recompute_queue where dirty_from = current_date;
$$;

revoke execute on function public.enqueue_portfolio_daily_maintenance()
  from public, anon, authenticated;
grant execute on function public.enqueue_portfolio_daily_maintenance() to service_role;
