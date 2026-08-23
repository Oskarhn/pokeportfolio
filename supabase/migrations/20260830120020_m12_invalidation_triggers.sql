-- M12 Dashboard — history invalidation (prompt Part C).
--
-- WHAT DIRTIES HISTORY, and the exact boundary each writer uses. Every trigger writes ONLY a
-- queue row via public.enqueue_portfolio_recompute() — never purchases/sales/cost basis/anything
-- financial (prompt §95). The queue is service-internal, so shared-market-data invalidations
-- never leak which users own what to any browser.
--
--   acquisition insert/backdate ............ acquired_on (new)
--   acquisition edit ....................... least(old.acquired_on, new.acquired_on)
--   acquisition void ....................... acquired_on
--   purchase create ........................ purchased_on
--   purchase date move ..................... least(old, new)  — moving Mar 1 → Apr 1 must ALSO
--                                            recompute March (prompt §35's exact example)
--   purchase void / amount change .......... purchased_on
--   purchase line amount/class change ...... its purchase's business date
--   sale create / void ..................... sold_on
--   sale date move ......................... least(old_sold_on, new_sold_on) (prompt §38)
--   sale fee/proceeds change ............... sold_on
--   disposal (any change) .................. least(old.disposed_on, new.disposed_on) — this is
--                                            what keeps quantity_remaining_as_of(D) honest
--   manual valuation set (incl. backdated). effective_from
--   manual valuation clear ................. the clear date (the interval ends there, D-062)
--   price snapshot write (shared) .......... every owner of a non-voided lot on that variant,
--                                            from the snapshot_date (prompt §41)
--   price snapshot THINNING (shared) ....... owners of affected variants, from the oldest
--                                            deleted observation — thinned facts legitimately
--                                            change as-of resolution beyond 60 days
--   fx rate write (shared) ................. owners of raw-card holdings, from rate_date
--                                            (prompt §42; market display only — frozen purchase/
--                                            sale NOK are never rewritten by anything here)
--
--   NOT dirtying (prompt §23/§44): sealed_intent, storage_location_id, tags, favourites, notes,
--   custom-collection membership. Organisation changes no ownership, cost or value fact. This is
--   enforced by the UPDATE OF column lists below — those columns are simply absent from them.
--
-- Row-level triggers for user-private tables (low volume); statement-level triggers with
-- transition tables for the shared market-data tables, so one ingest batch enqueues once, not
-- once per row.

-- ── user-private: acquisition lots ───────────────────────────────────────────────────────────

create or replace function public.m12_lot_dirties_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_portfolio_recompute(new.user_id, new.acquired_on);
  elsif tg_op = 'UPDATE' then
    perform public.enqueue_portfolio_recompute(
      new.user_id, least(old.acquired_on, coalesce(new.acquired_on, old.acquired_on)));
  end if;
  return null;
end;
$$;

create trigger portfolio_recompute_lot_inserted
  after insert on public.acquisition_lots
  for each row execute function public.m12_lot_dirties_history();

-- Column list IS the policy: sealed_intent / storage_location_id / notes deliberately absent
-- (prompt §23/§44 — changing intent or location dirties nothing financial).
create trigger portfolio_recompute_lot_updated
  after update of acquired_on, quantity, quantity_remaining, voided_at,
                  cost_basis_state, purchase_line_id,
                  unit_cost_basis_minor, unit_cost_basis_nok_minor,
                  residual_nok_minor
  on public.acquisition_lots
  for each row execute function public.m12_lot_dirties_history();

-- ── user-private: purchases and their lines ──────────────────────────────────────────────────

create or replace function public.m12_purchase_dirties_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from date := least(old.purchased_on, coalesce(new.purchased_on, old.purchased_on));
begin
  if tg_op = 'INSERT' then
    v_from := new.purchased_on;
  end if;
  perform public.enqueue_portfolio_recompute(new.user_id, v_from);
  return null;
end;
$$;

create trigger portfolio_recompute_purchase_inserted
  after insert on public.purchases
  for each row execute function public.m12_purchase_dirties_history();

create trigger portfolio_recompute_purchase_updated
  after update of purchased_on, total_nok_minor, voided_at
  on public.purchases
  for each row execute function public.m12_purchase_dirties_history();

create or replace function public.m12_purchase_line_dirties_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_date date;
  v_old_date date;
begin
  select p.purchased_on into v_new_date
    from public.purchases p where p.id = new.purchase_id;
  if tg_op = 'UPDATE' and old.purchase_id <> new.purchase_id then
    select p.purchased_on into v_old_date
      from public.purchases p where p.id = old.purchase_id;
  else
    v_old_date := v_new_date;
  end if;
  perform public.enqueue_portfolio_recompute(
    new.user_id, least(coalesce(v_old_date, v_new_date), coalesce(v_new_date, v_old_date)));
  return null;
end;
$$;

-- Allocation/basis-affecting columns only; description/notes do not dirty money history.
create trigger portfolio_recompute_purchase_line_inserted
  after insert on public.purchase_lines
  for each row execute function public.m12_purchase_line_dirties_history();

create trigger portfolio_recompute_purchase_line_updated
  after update of quantity, unit_price_minor, line_total_minor, spend_class,
                  allocated_shipping_minor, allocated_customs_minor,
                  allocated_discount_minor, attributable_cost_minor,
                  attributable_cost_nok_minor, purchase_id
  on public.purchase_lines
  for each row execute function public.m12_purchase_line_dirties_history();

-- ── user-private: sales, sale lines, lot disposals ───────────────────────────────────────────

create or replace function public.m12_sale_dirties_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_portfolio_recompute(new.user_id, new.sold_on);
  else
    perform public.enqueue_portfolio_recompute(
      new.user_id, least(old.sold_on, coalesce(new.sold_on, old.sold_on)));
  end if;
  return null;
end;
$$;

create trigger portfolio_recompute_sale_inserted
  after insert on public.sales
  for each row execute function public.m12_sale_dirties_history();

create trigger portfolio_recompute_sale_updated
  after update of sold_on, gross_minor, fees_minor, shipping_cost_minor,
                  shipping_charged_minor, net_proceeds_minor, net_proceeds_nok_minor,
                  realized_result_nok_minor, proceeds_from_uncosted_nok_minor, voided_at
  on public.sales
  for each row execute function public.m12_sale_dirties_history();

create or replace function public.m12_sale_line_dirties_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_date date;
begin
  select s.sold_on into v_sale_date from public.sales s where s.id = new.sale_id;
  if v_sale_date is not null then
    perform public.enqueue_portfolio_recompute(new.user_id, v_sale_date);
  end if;
  return null;
end;
$$;

create trigger portfolio_recompute_sale_line_inserted
  after insert on public.sale_lines
  for each row execute function public.m12_sale_line_dirties_history();

create trigger portfolio_recompute_sale_line_updated
  after update of quantity, unit_gross_minor, line_gross_minor, allocated_fees_minor,
                  allocated_shipping_minor, allocated_shipping_charged_minor,
                  net_proceeds_minor, net_proceeds_nok_minor,
                  cost_basis_at_sale_nok_minor, realized_result_nok_minor
  on public.sale_lines
  for each row execute function public.m12_sale_line_dirties_history();

create or replace function public.m12_disposal_dirties_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_portfolio_recompute(new.user_id, new.disposed_on);
  else
    perform public.enqueue_portfolio_recompute(
      new.user_id, least(old.disposed_on, coalesce(new.disposed_on, old.disposed_on)));
  end if;
  return null;
end;
$$;

create trigger portfolio_recompute_disposal_inserted
  after insert on public.lot_disposals
  for each row execute function public.m12_disposal_dirties_history();

create trigger portfolio_recompute_disposal_updated
  after update of disposed_on, quantity, voided_at, cost_basis_at_disposal_nok_minor
  on public.lot_disposals
  for each row execute function public.m12_disposal_dirties_history();

-- ── user-private: manual valuations (interval model boundaries, D-062) ───────────────────────

create or replace function public.m12_manual_valuation_dirties_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from date;
begin
  if tg_op = 'INSERT' then
    v_from := new.effective_from;
  else
    -- A supersede (set over set, or clear) truncates the previous interval at the NEW row's
    -- effective_from, or at the clear wall-clock date when superseded_at was just stamped.
    v_from := least(
      coalesce(cast(old.superseded_at as date), current_date),
      coalesce(cast(new.superseded_at as date), current_date));
    if new.effective_from is distinct from old.effective_from then
      v_from := least(v_from, least(old.effective_from, new.effective_from));
    end if;
  end if;
  perform public.enqueue_portfolio_recompute(new.user_id, v_from);
  return null;
end;
$$;

create trigger portfolio_recompute_manual_valuation_inserted
  after insert on public.manual_valuations
  for each row execute function public.m12_manual_valuation_dirties_history();

create trigger portfolio_recompute_manual_valuation_updated
  after update of effective_from, value_minor, value_nok_minor, superseded_at
  on public.manual_valuations
  for each row execute function public.m12_manual_valuation_dirties_history();

-- ── shared market data: price snapshots (statement-level, transition tables) ─────────────────
-- One enqueue per ingest batch, never one per row. Each branch joins the transition rows to the
-- owners of non-voided lots on those variants; dirty_from is the batch's earliest affected date.

create or replace function public.m12_price_snapshot_enq_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.portfolio_recompute_queue as q (user_id, dirty_from, updated_at)
  select distinct l.user_id, min(p.snapshot_date), now()
  from new_rows p
  join public.holdings h on h.card_variant_id = p.card_variant_id
  join public.acquisition_lots l on l.holding_id = h.id and l.user_id = h.user_id
  where l.voided_at is null and h.deleted_at is null
  group by l.user_id
  on conflict (user_id) do update
    set dirty_from = least(excluded.dirty_from, q.dirty_from), updated_at = now();
  return null;
end;
$$;

create or replace function public.m12_price_snapshot_enq_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.portfolio_recompute_queue as q (user_id, dirty_from, updated_at)
  select distinct l.user_id, min(least(o.snapshot_date, n.snapshot_date)), now()
  from old_rows o
  join new_rows n on n.id = o.id
  join public.holdings h on h.card_variant_id = n.card_variant_id
  join public.acquisition_lots l on l.holding_id = h.id and l.user_id = h.user_id
  where l.voided_at is null and h.deleted_at is null
    and (o.snapshot_date <> n.snapshot_date or o.value_minor <> n.value_minor
         or o.source_currency <> n.source_currency)
  group by l.user_id
  on conflict (user_id) do update
    set dirty_from = least(excluded.dirty_from, q.dirty_from), updated_at = now();
  return null;
end;
$$;

create or replace function public.m12_price_snapshot_enq_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.portfolio_recompute_queue as q (user_id, dirty_from, updated_at)
  select distinct l.user_id, min(d.snapshot_date), now()
  from deleted_rows d
  join public.holdings h on h.card_variant_id = d.card_variant_id
  join public.acquisition_lots l on l.holding_id = h.id and l.user_id = h.user_id
  where l.voided_at is null and h.deleted_at is null
  group by l.user_id
  on conflict (user_id) do update
    set dirty_from = least(excluded.dirty_from, q.dirty_from), updated_at = now();
  return null;
end;
$$;

create trigger portfolio_recompute_price_inserted
  after insert on public.price_snapshots
  referencing new table as new_rows
  for each statement execute function public.m12_price_snapshot_enq_insert();

create trigger portfolio_recompute_price_updated
  after update of card_variant_id, source_currency, value_minor, snapshot_date
  on public.price_snapshots
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.m12_price_snapshot_enq_update();

-- Retention (thin_price_snapshots) deletes old observations; the surviving weekly facts are
-- different canonical data, so cached history beyond 60 days must rebuild to stay truthful.
create trigger portfolio_recompute_price_deleted
  after delete on public.price_snapshots
  referencing old table as deleted_rows
  for each statement execute function public.m12_price_snapshot_enq_delete();

-- ── shared market data: fx rates ─────────────────────────────────────────────────────────────
-- Market-value history only. Frozen purchase/sale NOK amounts are never touched by design
-- (F11) — they do not read fx_rates, so they cannot drift.

create or replace function public.m12_fx_rate_enq_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Conservative and bounded at this project's scale (≤10 users): an FX fact can affect any
  -- provider-priced raw-card valuation whose observation resolves against it, so every user
  -- owning a raw-card holding is dirtied from the rate's own date.
  insert into public.portfolio_recompute_queue as q (user_id, dirty_from, updated_at)
  select distinct l.user_id, min(n.rate_date), now()
  from new_rows n
  join public.holdings h
    on h.holding_kind = 'raw_card' and h.card_variant_id is not null
  join public.acquisition_lots l on l.holding_id = h.id and l.user_id = h.user_id
  where l.voided_at is null and h.deleted_at is null
  group by l.user_id
  on conflict (user_id) do update
    set dirty_from = least(excluded.dirty_from, q.dirty_from), updated_at = now();
  return null;
end;
$$;

create or replace function public.m12_fx_rate_enq_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.portfolio_recompute_queue as q (user_id, dirty_from, updated_at)
  select distinct l.user_id, min(least(o.rate_date, n.rate_date)), now()
  from old_rows o
  join new_rows n on (n.base_currency, n.quote_currency, n.rate_date, n.source)
      = (o.base_currency, o.quote_currency, o.rate_date, o.source)
  join public.holdings h
    on h.holding_kind = 'raw_card' and h.card_variant_id is not null
  join public.acquisition_lots l on l.holding_id = h.id and l.user_id = h.user_id
  where l.voided_at is null and h.deleted_at is null
    and o.rate <> n.rate
  group by l.user_id
  on conflict (user_id) do update
    set dirty_from = least(excluded.dirty_from, q.dirty_from), updated_at = now();
  return null;
end;
$$;

create trigger portfolio_recompute_fx_inserted
  after insert on public.fx_rates
  referencing new table as new_rows
  for each statement execute function public.m12_fx_rate_enq_insert();

create trigger portfolio_recompute_fx_updated
  after update of rate, rate_date
  on public.fx_rates
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.m12_fx_rate_enq_update();

-- ── privilege posture for the trigger functions ──────────────────────────────────────────────
-- They fire implicitly under whichever role performs the triggering statement (PostgreSQL does
-- not check EXECUTE on trigger functions at firing time — the same production-tested property
-- that lets supabase_auth_admin fire handle_new_user()). Revoked from PUBLIC/named browser
-- roles so nobody can invoke them directly; no positive grants anywhere.

revoke execute on function public.m12_lot_dirties_history()
  from public, anon, authenticated;
revoke execute on function public.m12_purchase_dirties_history()
  from public, anon, authenticated;
revoke execute on function public.m12_purchase_line_dirties_history()
  from public, anon, authenticated;
revoke execute on function public.m12_sale_dirties_history()
  from public, anon, authenticated;
revoke execute on function public.m12_sale_line_dirties_history()
  from public, anon, authenticated;
revoke execute on function public.m12_disposal_dirties_history()
  from public, anon, authenticated;
revoke execute on function public.m12_manual_valuation_dirties_history()
  from public, anon, authenticated;
revoke execute on function public.m12_price_snapshot_enq_insert()
  from public, anon, authenticated;
revoke execute on function public.m12_price_snapshot_enq_update()
  from public, anon, authenticated;
revoke execute on function public.m12_price_snapshot_enq_delete()
  from public, anon, authenticated;
revoke execute on function public.m12_fx_rate_enq_insert()
  from public, anon, authenticated;
revoke execute on function public.m12_fx_rate_enq_update()
  from public, anon, authenticated;
