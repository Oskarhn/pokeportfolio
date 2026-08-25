-- P43: Portfolio reset + unified correction-aware history.
--
-- Two owner-facing surfaces, one migration:
--
--   1. reset_my_portfolio_data()  — the one deliberate, destructive, atomic "blank slate"
--     operation. Clears the signed-in caller's owned inventory, financial ledger and derived
--     state in one server-side transaction (prompt §2: no client-side loop of DELETEs; if any
--     part fails, nothing resets). Preserves the account, profile/settings and reusable setup
--     metadata (retailers, storage locations, tags, custom-collection definitions, manual card
--     definitions, the user's own private sealed-product definitions) — DECISIONS.md D-084.
--
--   2. list_history_events(...)   — the unified History read surface: ONE bounded,
--     keyset-paginated RPC over the canonical event sources that exist TODAY — purchases, sales,
--     non-purchase acquisitions ("Added") and active manual valuations. No event-sourcing table
--     is invented for a screen (the same rule M12's get_recent_activity already follows).
--
-- ── Why reset_my_portfolio_data is SECURITY DEFINER ────────────────────────────────────────────
-- Browser roles deliberately cannot delete from most of this schema: acquisition_lots,
-- purchases/purchase_lines, sales/sale_lines/lot_disposals and lot_cost_adjustments carry no
-- DELETE grant to authenticated at all (void semantics only), manual_valuations carries no
-- DELETE grant, portfolio_snapshots is SELECT-own-only with no write grant, and
-- portfolio_recompute_queue has no browser grant of any kind. An INVOKER reset would therefore
-- be structurally impossible without widening every one of those grants — which would hand raw
-- DELETE on the financial ledger back to a browser session, exactly what the void lifecycle was
-- built to prevent (SECURITY.md §8, DATA_MODEL.md §9). SECURITY DEFINER keeps that surface
-- unchanged: authenticated gains EXECUTE on exactly one function whose every statement filters
-- by auth.uid() and nothing else. There is no p_user_id parameter to forge, no dynamic SQL, no
-- secrets. Full adversarial reasoning: docs/SECURITY.md and DECISIONS.md D-084.
--
-- ── Deletion order is FK-deterministic ────────────────────────────────────────────────────────
-- Every parent here is referenced by at least one child WITHOUT ON DELETE CASCADE
-- (acquisition_lots.purchase_line_id, sale_lines.lot_id/sale_id, lot_disposals.lot_id/
-- sale_line_id, lot_cost_adjustments.lot_id/purchase_line_id, manual_valuations.holding_id), so
-- children are always deleted before their parents. The queue row goes FIRST, not last: taking
-- its row lock before anything else means a concurrently-running drain_portfolio_recompute_queue
-- worker (M12 cron) either waits for this transaction to commit and then finds no queue row at
-- all, or has already passed its queue read and blocks our snapshot delete until it commits,
-- after which we remove whatever it wrote. Either way the final committed state is identical:
-- zero snapshots, zero queue rows, no stale value anywhere.
--
-- The M12 invalidation triggers are INSERT/UPDATE-only, so plain DELETEs enqueue nothing — the
-- queue genuinely stays empty rather than being re-dirtied behind our backs.
--
-- NOT touched: auth.users, profiles, invitations/claims/redemptions, the shared catalog,
-- price_snapshots, fx_rates, cron jobs, other users' data, retailers, storage_locations, tags,
-- custom_collections (definitions), manual_card_definitions, sealed_products (curated AND the
-- user's own private ones). Nothing is re-created afterwards: an empty account is genuinely
-- empty — no fabricated zero-valued rows.
--
-- Future extension points (comments, not dead code): openings (M16), trades (M18) and grading
-- submissions (M17) will each add user-owned tables that belong in this deletion order between
-- the disposal/ledger rows and holdings.

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
  snapshots_deleted integer
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
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  -- 0. The recompute queue first — see the ordering note in the header.
  delete from public.portfolio_recompute_queue q where q.user_id = v_user;

  -- 1. Disposal ledger children (reference acquisition_lots + sale_lines without cascade).
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
  -- 7. Acquisition lots (reference holdings + purchase_lines without cascade).
  delete from public.acquisition_lots l where l.user_id = v_user;
  get diagnostics v_lots = row_count;
  -- 8. Purchase lines, then purchases.
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
  --   grading submissions (M17), openings (M16), trade lines (M18).

  -- Counts are captured per statement via GET DIAGNOSTICS: counting the tables AFTER the
  -- deletes would always report zero. What the caller receives is what THIS call removed.
  return query
    select v_purchases::integer,
           v_purchase_lines::integer,
           v_sales::integer,
           v_sale_lines::integer,
           v_disposals::integer,
           v_lots::integer,
           v_holdings::integer,
           v_valuations::integer,
           v_snapshots::integer;
end;
$$;

comment on function public.reset_my_portfolio_data() is
  'P43: atomically clears the caller''s owned inventory, purchase/sale ledger, acquisition '
  'lots, disposals, cost adjustments, manual valuations, collection/tag memberships, snapshot '
  'cache and recompute queue. Preserves account/profile settings and reusable setup metadata '
  '(retailers, storage locations, tags, collection definitions, manual cards, own sealed '
  'products). The one intentional hard-delete in the product — full reset, D-084; everything '
  'else corrects through the void lifecycle.';

revoke execute on function public.reset_my_portfolio_data()
  from public, anon, authenticated;

grant execute on function public.reset_my_portfolio_data() to authenticated;

-- ── list_history_events ───────────────────────────────────────────────────────────────────────
-- The unified History read surface. One RPC, four canonical sources, no N+1 (each branch
-- resolves its own display columns with plain joins inside the single statement), money cast to
-- text (PostgREST bigint boundary), SECURITY INVOKER with every predicate derived from
-- auth.uid().
--
-- Event kinds shipped today (only categories backed by real canonical data):
--   'purchase'    → /purchases/$id        (correct/edit/void via the existing lifecycle)
--   'sale'        → /sales/$id            (edit/void via the existing lifecycle)
--   'acquisition' → /portfolio/$holdingId (non-purchase-origin additions; per-lot void lives on
--                                          Holding Detail)
--   'valuation'   → /portfolio/$holdingId (active manual valuations; superseded rows are the
--                                          same fact corrected, so they never appear here —
--                                          D-062's interval model keeps them inspectable)
--
-- Voided/corrected entries are EXCLUDED by default and shown only with p_include_voided: a
-- presentation filter, never an accounting change. Voided purchases, voided sales and voided
-- lots render with status 'voided'.
--
-- Ordering and pagination are stable: keyset on (recorded_at DESC, primary_id DESC) where
-- recorded_at is the source row's created_at. Business dates are displayed (occurred_on); the
-- recording timestamp orders the feed deterministically even when several events share a date.
-- Pass the previous page's last (recorded_at, primary_id) pair as p_before_at/p_before_id.
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
    -- Purchases: real receipts in the spending ledger.
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

    -- Sales: realized proceeds over explicitly chosen lots.
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

    -- Additions acquired outside a purchase receipt (gift/found/pre-tracking/opening/trade-in/
    -- other). Purchase-origin lots are excluded — their purchase row is already the event;
    -- counting both would double-report one acquisition (same rule get_recent_activity applies).
    -- A lot's voided state is its correction status; the holding stays navigable for the
    -- per-lot lifecycle.
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

    union all

    -- Active manual valuations ("valuations where useful"). Superseded rows never appear: a
    -- supersede IS the valuation's own correction lifecycle (D-062), not a separate event.
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
    -- Keyset cursor. Both halves must be present for the row comparison to mean anything —
    -- an incomplete cursor degrades to "first page" rather than silently matching nothing
    -- (a NULL row-comparison never evaluates true).
    and (
      p_before_at is null
      or p_before_id is null
      or (events.recorded_at, events.primary_id) < (p_before_at, p_before_id)
    )
  order by events.recorded_at desc, events.primary_id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function public.list_history_events(text, boolean, int, timestamptz, uuid) is
  'P43 unified History read surface: one bounded, keyset-paginated owner-only union over '
  'purchases, sales, non-purchase acquisitions and active manual valuations. Voided/corrected '
  'entries are hidden unless p_include_voided — a display filter that never touches accounting '
  '(D-085). Future event kinds (openings M16, trades M18) extend the union when their tables '
  'exist; no fake rows before then.';

revoke execute on function public.list_history_events(text, boolean, int, timestamptz, uuid)
  from public, anon, authenticated;

grant execute on function public.list_history_events(text, boolean, int, timestamptz, uuid)
  to authenticated;
