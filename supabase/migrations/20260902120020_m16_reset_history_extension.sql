-- M16: extends the P43 reset + unified History surfaces for openings (prompt §21/§22).
--
--   reset_my_portfolio_data()  — DROP+CREATE (the return type grows two columns): clears the
--                                caller's openings and their pull lots in FK-deterministic
--                                position, with per-statement counts preserved.
--   list_history_events(...)   — gains the 'opening' event kind AND stops double-reporting
--                                opening-linked pulls as individual "Added" events (one action,
--                                one row — the prompt's explicit rule). Legacy unlinked
--                                origin='opening' lots (D-038) keep appearing as acquisitions,
--                                because no opening event exists for them.
--   get_recent_activity(...)   — opening-linked pull lots stop appearing individually AND each
--                                opening gains exactly ONE activity row of its own
--                                (activity_type='opening', primary_id = openings.id,
--                                occurred_on = opened_on, amount = the frozen cost or NULL).
--                                One act, one row — Home reports the opening, never N phantom
--                                additions beside nothing (P53 §18). The amount is analytical
--                                opening scope (F8): no Home total sums it.
--
-- No other Purchase/Sale/Added semantics change by one character.

-- ── 1. reset_my_portfolio_data ───────────────────────────────────────────────────────────────
-- Return type grew ⇒ identity changed ⇒ DROP+CREATE (same rule as every signature change here).
-- New deletion steps sit exactly where DATA_MODEL.md §9 reserved them: opening-linked pull lots
-- BEFORE openings (they reference it), openings BEFORE acquisition_lots (openings.source_lot_id),
-- which is still before purchase_lines/purchases/holdings. lot_disposals are already long gone
-- (step 1), so an opening's consumption rows never block its delete; the queue row is still
-- locked FIRST so no concurrent drain can resurrect stale derived state; the M12 invalidation
-- triggers are INSERT/UPDATE-only, so these DELETEs enqueue nothing.
drop function public.reset_my_portfolio_data();

create or replace function public.reset_my_portfolio_data()
returns table (
  purchases_deleted integer,
  purchase_lines_deleted integer,
  sales_deleted integer,
  sale_lines_deleted integer,
  lot_disposals_deleted integer,
  acquisition_lots_deleted integer,
  holdings_deleted integer,
  manual_valuations_deleted integer,
  snapshots_deleted integer,
  openings_deleted integer,
  opening_pull_lots_deleted integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_purchases bigint;
  v_purchase_lines bigint;
  v_sales bigint;
  v_sale_lines bigint;
  v_disposals bigint;
  v_lots bigint;
  v_holdings bigint;
  v_valuations bigint;
  v_snapshots bigint;
  v_openings bigint;
  v_opening_pull_lots bigint;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  -- 0. The recompute queue first — see the ordering note in 20260901120010's header (unchanged).
  delete from public.portfolio_recompute_queue q where q.user_id = v_user;

  -- 1. Disposal ledger children (reference acquisition_lots + sale_lines + openings).
  delete from public.lot_disposals ld where ld.user_id = v_user;
  get diagnostics v_disposals = row_count;
  -- 2. Sale lines (reference sales + acquisition_lots without cascade).
  delete from public.sale_lines sl where sl.user_id = v_user;
  get diagnostics v_sale_lines = row_count;
  -- 3. Sales.
  delete from public.sales s where s.user_id = v_user;
  get diagnostics v_sales = row_count;
  -- 4. Cost adjustments (reference acquisition_lots + purchase_lines without cascade).
  delete from public.lot_cost_adjustments a where a.user_id = v_user;
  -- 5. Manual valuation history (references holdings without cascade).
  delete from public.manual_valuations mv where mv.user_id = v_user;
  get diagnostics v_valuations = row_count;
  -- 6. Organisational membership join rows bound to inventory (collection/tag DEFINITIONS stay).
  delete from public.custom_collection_members m where m.user_id = v_user;
  delete from public.holding_tags ht where ht.user_id = v_user;
  -- 6b. M16: opening-linked pull lots first — they reference openings, which reference source
  --     lots; deleting in child-first order keeps every plain FK satisfied without cascades.
  delete from public.acquisition_lots l where l.user_id = v_user and l.opening_id is not null;
  get diagnostics v_opening_pull_lots = row_count;
  -- 6c. Openings themselves (their consumption disposals went at step 1; provisional purchases
  --     and source lots both live deeper in this order).
  delete from public.openings o where o.user_id = v_user;
  get diagnostics v_openings = row_count;
  -- 7. Remaining acquisition lots (reference holdings + purchase_lines without cascade).
  delete from public.acquisition_lots l where l.user_id = v_user;
  get diagnostics v_lots = row_count;
  -- 8. Purchase lines, then purchases (provisional purchases included).
  delete from public.purchase_lines pl where pl.user_id = v_user;
  get diagnostics v_purchase_lines = row_count;
  delete from public.purchases p where p.user_id = v_user;
  get diagnostics v_purchases = row_count;
  -- 9. Holdings last of the canonical rows (every child above is gone).
  delete from public.holdings h where h.user_id = v_user;
  get diagnostics v_holdings = row_count;
  -- 10. Derived cache: stale snapshots must never survive the reset.
  delete from public.portfolio_snapshots s where s.user_id = v_user;
  get diagnostics v_snapshots = row_count;

  -- Future milestones add their user-owned tables here, BEFORE holdings:
  --   grading submissions (M17), trade lines (M18).

  return query
    select v_purchases::integer,
           v_purchase_lines::integer,
           v_sales::integer,
           v_sale_lines::integer,
           v_disposals::integer,
           v_lots::integer,
           v_holdings::integer,
           v_valuations::integer,
           v_snapshots::integer,
           v_openings::integer,
           v_opening_pull_lots::integer;
end;
$$;

comment on function public.reset_my_portfolio_data() is
  'P43+M16: atomically clears the caller''s owned inventory, purchase/sale ledger, acquisition '
  'lots, disposals, cost adjustments, manual valuations, collection/tag memberships, OPENINGS '
  'and their pulled-card lots, snapshot cache and recompute queue. Preserves account/profile '
  'settings and reusable setup metadata. The one intentional hard-delete in the product — D-084.';

revoke execute on function public.reset_my_portfolio_data()
  from public, anon, authenticated;

grant execute on function public.reset_my_portfolio_data() to authenticated;

-- ── 2. list_history_events ───────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE: name, argument types and the returned column set are unchanged — the union
-- inside grows one arm ('opening') and the 'acquisition' arm stops selecting opening-linked pull
-- lots (they ARE the opening event now; reporting both would double-report one action). Legacy
-- unlinked origin='opening' lots keep their existing 'acquisition' rows — for them nothing has
-- changed since P43 shipped this function.
create or replace function public.list_history_events(
  p_kind text default null,
  p_include_voided boolean default false,
  p_limit int default 50,
  p_before_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  event_kind text,
  primary_id uuid,
  secondary_id uuid,
  occurred_on date,
  recorded_at timestamptz,
  title text,
  subtitle text,
  amount_nok_minor text,
  status text,
  href text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from (
    -- Purchases: real receipts in the spending ledger (unchanged).
    select
      'purchase'::text as event_kind,
      p.id as primary_id,
      null::uuid as secondary_id,
      p.purchased_on as occurred_on,
      p.created_at as recorded_at,
      coalesce(r.name, 'Purchase') as title,
      coalesce((
        select sum(pl.quantity)::int::text from public.purchase_lines pl
        where pl.purchase_id = p.id
      ), '0') || ' item(s)' as subtitle,
      p.total_nok_minor::text as amount_nok_minor,
      case when p.voided_at is null then 'active' else 'voided' end as status,
      '/purchases/' || p.id as href
    from public.purchases p
    left join public.retailers r on r.id = p.retailer_id
    where p.user_id = auth.uid()

    union all

    -- Sales (unchanged).
    select
      'sale'::text,
      s.id,
      null::uuid,
      s.sold_on,
      s.created_at,
      coalesce(s.marketplace, 'Sale'),
      coalesce((
        select sum(sl.quantity)::int::text from public.sale_lines sl
        where sl.sale_id = s.id
      ), '0') || ' item(s)',
      s.net_proceeds_nok_minor::text,
      case when s.voided_at is null then 'active' else 'voided' end,
      '/sales/' || s.id
    from public.sales s
    where s.user_id = auth.uid()

    union all

    -- Openings (M16): ONE row per opening act. The consumption disposal is deliberately NOT
    -- reported separately — the disposal ledger has no user-facing event of its own anywhere.
    -- Amount is the opening COST (an F8-scoped analytical figure): render — when unknown-cost,
    -- never sum it with NSP/CS figures elsewhere.
    select
      'opening'::text,
      o.id,
      null::uuid,
      o.opened_on,
      o.created_at,
      coalesce(sp.name, 'Opening'),
      '×' || o.quantity_opened::text || ' opened',
      o.cost_nok_minor::text,
      case when o.voided_at is null then 'active' else 'voided' end,
      '/openings/' || o.id
    from public.openings o
    join public.sealed_products sp on sp.id = o.sealed_product_id
    where o.user_id = auth.uid()

    union all

    -- Additions acquired outside a purchase receipt (gift/found/pre-tracking/trade-in/other,
    -- PLUS legacy origin='opening' lots recorded before openings existed — those have no opening
    -- event to belong to, D-038). Opening-LINKED pulls are excluded: they are reported by the
    -- 'opening' arm above, once, not once per card. Purchase-origin lots stay excluded — their
    -- receipt row is already the event.
    select
      'acquisition'::text,
      l.id,
      l.holding_id,
      l.acquired_on,
      l.created_at,
      coalesce(c.name, sp.name, mc.name, 'Added item'),
      initcap(replace(l.origin::text, '_', ' '))
        || ' · ×' || l.quantity::text as subtitle,
      (case when l.unit_cost_basis_nok_minor is not null
            then l.unit_cost_basis_nok_minor * l.quantity end)::text,
      case when l.voided_at is null then 'active' else 'voided' end,
      '/portfolio/' || l.holding_id
    from public.acquisition_lots l
    join public.holdings h on h.id = l.holding_id
    left join public.card_variants cv on cv.id = h.card_variant_id
    left join public.cards c on c.id = cv.card_id
    left join public.sealed_products sp on sp.id = h.sealed_product_id
    left join public.manual_card_definitions mc on mc.id = h.manual_card_id
    where l.user_id = auth.uid()
      and l.origin <> 'purchase'
      and l.opening_id is null

    union all

    -- Active manual valuations (unchanged).
    select
      'valuation'::text,
      mv.id,
      mv.holding_id,
      mv.effective_from,
      mv.created_at,
      coalesce(c.name, sp.name, mc.name, 'Manual value'),
      'Manual value' as subtitle,
      mv.value_nok_minor::text,
      'active'::text as status,
      '/portfolio/' || mv.holding_id
    from public.manual_valuations mv
    join public.holdings h on h.id = mv.holding_id
    left join public.card_variants cv on cv.id = h.card_variant_id
    left join public.cards c on c.id = cv.card_id
    left join public.sealed_products sp on sp.id = h.sealed_product_id
    left join public.manual_card_definitions mc on mc.id = h.manual_card_id
    where mv.user_id = auth.uid()
      and mv.superseded_at is null
  ) as events(event_kind, primary_id, secondary_id, occurred_on, recorded_at,
              title, subtitle, amount_nok_minor, status, href)
  where (p_kind is null or events.event_kind = p_kind)
    and (p_include_voided or events.status = 'active')
    and (
      p_before_at is null
      or p_before_id is null
      or (events.recorded_at, events.primary_id) < (p_before_at, p_before_id)
    )
  order by events.recorded_at desc, events.primary_id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function public.list_history_events(text, boolean, int, timestamptz, uuid) is
  'Unified History read surface: one bounded, keyset-paginated owner-only union over purchases, '
  'sales, openings (M16), non-purchase acquisitions (opening-linked pulls excluded — they ride '
  'their opening''s single row) and active manual valuations. Voided entries hidden unless '
  'p_include_voided (D-085).';

revoke execute on function public.list_history_events(text, boolean, int, timestamptz, uuid)
  from public, anon, authenticated;

grant execute on function public.list_history_events(text, boolean, int, timestamptz, uuid)
  to authenticated;

-- ── 3. get_recent_activity ───────────────────────────────────────────────────────────────────
-- Same signature and shape; two changes: opening-linked pull lots stop appearing as individual
-- Home activity rows, and every opening contributes exactly ONE row of its own
-- (activity_type='opening'). The opening's amount is its frozen analytical cost or NULL for an
-- unknown-cost opening — displayed by Home as the row figure only, never summed into any total.
create or replace function public.get_recent_activity(p_limit int default 8)
returns table (
  activity_type text,
  primary_id uuid,
  secondary_id uuid,
  occurred_on date,
  amount_nok_minor text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from (
    select 'purchase'::text, p.id, null::uuid, p.purchased_on,
           p.total_nok_minor::text
    from public.purchases p
    where p.user_id = auth.uid() and p.voided_at is null
    union all
    select 'sale'::text, s.id, null::uuid, s.sold_on,
           s.net_proceeds_nok_minor::text
    from public.sales s
    where s.user_id = auth.uid() and s.voided_at is null
    union all
    select 'valuation'::text, mv.id, mv.holding_id,
           cast(mv.created_at as date), mv.value_nok_minor::text
    from public.manual_valuations mv
    where mv.user_id = auth.uid() and mv.superseded_at is null
    union all
    select 'acquisition'::text, l.id, l.holding_id, l.acquired_on,
           (case when l.unit_cost_basis_nok_minor is not null
                 then l.unit_cost_basis_nok_minor * l.quantity end)::text
    from public.acquisition_lots l
    where l.user_id = auth.uid() and l.voided_at is null
      and l.origin <> 'purchase'
      and l.opening_id is null
    union all
    -- M16 (P53 §18): one Opening activity row per opening — never N per-pull rows.
    select 'opening'::text, o.id, o.source_lot_id, o.opened_on, o.cost_nok_minor::text
    from public.openings o
    where o.user_id = auth.uid()
      and o.voided_at is null
  ) as acts(activity_type, primary_id, secondary_id, occurred_on, amount_nok_minor)
  order by acts.occurred_on desc
  limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;

comment on function public.get_recent_activity(int) is
  'M12 optional recent-activity feed: a bounded union over canonical purchases, sales, active '
  'manual valuations, non-purchase acquisitions and openings (one row per opening; '
  'opening-linked pulls excluded — one act reports once).';

grant execute on function public.get_recent_activity(int) to authenticated;
revoke execute on function public.get_recent_activity(int) from public;
