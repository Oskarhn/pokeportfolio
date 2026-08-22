-- M10: Sales and History — schema (DATA_MODEL.md §5.7/§5.11, FINANCIAL_MODEL.md §2.2/§2.6/§4.5).
--
-- Three new tables, created in dependency order: sales -> sale_lines -> lot_disposals
-- (lot_disposals.sale_line_id references sale_lines, so sale_lines must exist first — the reverse
-- of DATA_MODEL's §5 reading order, not a reverse of its meaning).
--
-- lot_disposals.kind carries every value DATA_MODEL.md §5.7 documents (sale, opened, traded_away,
-- write_off, correction) even though M10 only ever writes 'sale' — same "enum vocabulary ships
-- ahead of the table that will produce the other values" pattern D-038 already established for
-- acquisition_lots.origin. opening_id/trade_line_id columns are NOT added here, for the same
-- reason: no openings/trades table exists yet (M16/M18).
--
-- D1 (quantity_remaining = quantity - Σ non-voided disposals) is enforced by an AFTER trigger on
-- lot_disposals, not by application code alone. The trigger function is SECURITY DEFINER
-- specifically so quantity_remaining becomes a value only the disposal ledger can move — see the
-- trigger's own comment below for the full reasoning and its accepted scope limit.

create type public.disposal_kind as enum ('sale', 'opened', 'traded_away', 'write_off', 'correction');

-- ── 1. sales ─────────────────────────────────────────────────────────────────────────────────────
-- One row per real sale/order/transaction (prompt §7) — never one row per card sold together.
-- net_proceeds_minor/net_proceeds_nok_minor are checked columns, not just RPC-computed, so no write
-- path (including a future one) can silently violate FINANCIAL_MODEL.md §2.2's NSP formula or F11's
-- frozen-NOK-matches-rate rule. gross/fees/shipping_cost/shipping_charged are individually
-- non-negative (prompt §108) but net_proceeds_minor is deliberately NOT constrained >= 0 — a sale
-- can genuinely cost more in fees and shipping than it grossed (prompt §109).
--
-- realized_result_nok_minor / proceeds_from_uncosted_nok_minor are materialized sums over this
-- sale's own lines (written by create_sale/update_sale/void_sale, never by the browser directly —
-- see the privilege baseline). They exist so History's list view and the result-sort gate (prompt
-- §100-101) never have to fetch every sale_line just to sort or render a summary row. NULL
-- realized_result_nok_minor means "no line in this sale has a known cost basis" — the unknown
-- bucket a sort must never treat as +/-infinity.
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  sold_on date not null,
  marketplace text,
  currency text not null,
  gross_minor bigint not null,
  fees_minor bigint not null default 0,
  shipping_cost_minor bigint not null default 0,
  shipping_charged_minor bigint not null default 0,
  net_proceeds_minor bigint not null,
  fx_rate_to_nok numeric(18, 8) not null,
  fx_rate_date date not null,
  fx_source public.fx_source not null,
  net_proceeds_nok_minor bigint not null,
  realized_result_nok_minor bigint,
  proceeds_from_uncosted_nok_minor bigint not null default 0,
  notes text,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  constraint sales_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint sales_amounts_non_negative check (
    gross_minor >= 0 and fees_minor >= 0 and shipping_cost_minor >= 0 and shipping_charged_minor >= 0
    and proceeds_from_uncosted_nok_minor >= 0
  ),
  -- FINANCIAL_MODEL.md §2.2: NSP = SGP - SF - OSC + SCB. Not clamped at zero (prompt §109).
  constraint sales_net_proceeds_formula check (
    net_proceeds_minor = gross_minor - fees_minor - shipping_cost_minor + shipping_charged_minor
  ),
  -- F11's frozen-NOK-matches-rate rule, same shape as purchases_total_nok_matches_rate. round()
  -- of a numeric handles a negative net_proceeds_minor correctly (rounds toward the nearer integer,
  -- ties away from zero) — no special-casing needed for prompt §109's negative-NSP case.
  constraint sales_net_proceeds_nok_matches_rate check (
    net_proceeds_nok_minor = round(net_proceeds_minor::numeric * fx_rate_to_nok)::bigint
  )
);

create unique index sales_user_idempotency_key_idx on public.sales (user_id, idempotency_key);
create index sales_user_sold_on_idx on public.sales (user_id, sold_on desc, id desc);
create index sales_user_result_idx on public.sales (user_id, realized_result_nok_minor desc, id desc);

create trigger sales_set_updated_at before update on public.sales
  for each row execute function public.set_updated_at();

-- ── 2. sale_lines ────────────────────────────────────────────────────────────────────────────────
-- One line per (sale, lot) pair — never one row per physical card (prompt §9): two identical-
-- looking cards leaving from two different lots in the same sale are two lines, preserving which
-- physical batch actually left inventory (the whole reason the lot model exists, FINANCIAL_MODEL.md
-- E2/E7).
--
-- allocated_shipping_charged_minor is a real, disclosed correction to DATA_MODEL.md §5.11's
-- original sketch (which listed only allocated_shipping_minor) — see DECISIONS.md D-060 and
-- prompt §39: buyer-paid shipping must be allocated and auditable per line just like outbound
-- shipping and fees, not folded into an ambiguous existing column.
--
-- cost_basis_at_sale_nok_minor / realized_result_nok_minor are the frozen pair (prompt §23/§28):
-- NULL together when the disposed lot had no known cost basis (contributes to PUD, never a
-- fabricated result), both set together and immutable afterward when it did (contributes to RRC).
-- No later purchase edit, manual valuation or market-price update may ever touch either — enforced
-- structurally: nothing after create_sale/update_sale ever issues an UPDATE on these two columns
-- for an existing row (update_sale's own scope explicitly excludes them, see the RPC migration).
create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id),
  user_id uuid not null references auth.users (id),
  lot_id uuid not null references public.acquisition_lots (id),
  quantity int not null,
  unit_gross_minor bigint not null,
  line_gross_minor bigint not null,
  allocated_fees_minor bigint not null default 0,
  allocated_shipping_minor bigint not null default 0,
  allocated_shipping_charged_minor bigint not null default 0,
  net_proceeds_minor bigint not null,
  net_proceeds_nok_minor bigint not null,
  cost_basis_at_sale_nok_minor bigint,
  realized_result_nok_minor bigint,
  created_at timestamptz not null default now(),
  constraint sale_lines_quantity_positive check (quantity > 0),
  constraint sale_lines_unit_gross_non_negative check (unit_gross_minor >= 0),
  constraint sale_lines_allocations_non_negative check (
    allocated_fees_minor >= 0 and allocated_shipping_minor >= 0 and allocated_shipping_charged_minor >= 0
  ),
  constraint sale_lines_line_gross_matches check (line_gross_minor = unit_gross_minor * quantity),
  -- FINANCIAL_MODEL.md §4.5 / prompt §43: line_net = line_gross - fees - outbound_ship + buyer_ship.
  constraint sale_lines_net_proceeds_formula check (
    net_proceeds_minor
      = line_gross_minor - allocated_fees_minor - allocated_shipping_minor + allocated_shipping_charged_minor
  ),
  -- Invariant M1's sale-side mirror: a line has a realized result iff it has a frozen cost basis.
  constraint sale_lines_realized_result_consistency check (
    (cost_basis_at_sale_nok_minor is null and realized_result_nok_minor is null)
    or (
      cost_basis_at_sale_nok_minor is not null and realized_result_nok_minor is not null
      and realized_result_nok_minor = net_proceeds_nok_minor - cost_basis_at_sale_nok_minor
    )
  )
);

create index sale_lines_sale_idx on public.sale_lines (sale_id);
create index sale_lines_lot_idx on public.sale_lines (lot_id);

-- Ownership defence in depth, same shape and same reasoning as acquisition_lots_check_owner
-- (20260817120070): both SELECTs run with invoker rights, so RLS on sales/acquisition_lots hides a
-- foreign row entirely — a cross-tenant sale_id or lot_id fails as "not found", never confirming
-- the row exists to an attacker (prompt §106, no existence oracle).
create or replace function public.sale_lines_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sale_user_id uuid;
  v_lot_user_id uuid;
begin
  select user_id into v_sale_user_id from public.sales where id = new.sale_id;
  if v_sale_user_id is null or new.user_id <> v_sale_user_id then
    raise exception 'sale_lines.user_id must match the owner of sale %', new.sale_id;
  end if;

  select user_id into v_lot_user_id from public.acquisition_lots where id = new.lot_id;
  if v_lot_user_id is null or v_lot_user_id <> new.user_id then
    raise exception 'sale_lines.lot_id must belong to the same owner';
  end if;

  return new;
end;
$$;

create trigger sale_lines_owner_check
  before insert or update on public.sale_lines
  for each row execute function public.sale_lines_check_owner();

-- ── 3. lot_disposals ─────────────────────────────────────────────────────────────────────────────
-- DATA_MODEL.md §5.7 — every reduction of quantity_remaining writes a row here, making
-- quantity_remaining_as_of(lot, D) computable (FINANCIAL_MODEL.md §3, the ownership-timeline
-- foundation prompt §112 asks M10 to lay without building the M12 chart itself).
create table public.lot_disposals (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.acquisition_lots (id),
  user_id uuid not null references auth.users (id),
  kind public.disposal_kind not null,
  quantity int not null,
  disposed_on date not null,
  sale_line_id uuid references public.sale_lines (id),
  cost_basis_at_disposal_nok_minor bigint,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  constraint lot_disposals_quantity_positive check (quantity > 0),
  -- A 'sale' disposal always cites the sale_line it came from; every other kind never does (M10
  -- writes 'sale' only, but the shape holds for whichever milestone writes the others).
  constraint lot_disposals_sale_kind_needs_line check ((kind = 'sale') = (sale_line_id is not null))
);

create index lot_disposals_lot_idx on public.lot_disposals (lot_id) where voided_at is null;
-- One live disposal per sale line — a sale line's units leave inventory exactly once.
create unique index lot_disposals_sale_line_idx on public.lot_disposals (sale_line_id) where sale_line_id is not null;

create or replace function public.lot_disposals_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_lot_user_id uuid;
  v_line_user_id uuid;
begin
  select user_id into v_lot_user_id from public.acquisition_lots where id = new.lot_id;
  if v_lot_user_id is null or new.user_id <> v_lot_user_id then
    raise exception 'lot_disposals.user_id must match the owner of lot %', new.lot_id;
  end if;

  if new.sale_line_id is not null then
    select user_id into v_line_user_id from public.sale_lines where id = new.sale_line_id;
    if v_line_user_id is null or v_line_user_id <> new.user_id then
      raise exception 'lot_disposals.sale_line_id must belong to the same owner';
    end if;
  end if;

  return new;
end;
$$;

create trigger lot_disposals_owner_check
  before insert or update on public.lot_disposals
  for each row execute function public.lot_disposals_check_owner();

-- ── 4. D1 — the invariant, enforced by trigger, not just by RPC discipline ─────────────────────
-- "lot.quantity_remaining = lot.quantity - Σ non-voided disposals" (DATA_MODEL.md §5.7). Recomputes
-- and overwrites acquisition_lots.quantity_remaining from lot_disposals directly, every time a
-- disposal is inserted or voided — the single source of truth for this column going forward,
-- instead of trusting create_sale/void_sale's own arithmetic to always agree with the ledger.
--
-- SECURITY DEFINER, deliberately: authenticated already holds UPDATE on
-- acquisition_lots.quantity_remaining (M6/M8, needed by update_purchase's own "reset to new
-- quantity on an undisposed lot" path — unchanged by M10). A SECURITY DEFINER trigger makes
-- quantity_remaining a value only the disposal ledger can move: every legitimate disposal event
-- forces it back to the ledger-derived truth, immediately, inside the same transaction, regardless
-- of what a stray direct write might have set it to. See the RPC migration
-- (20260828120010_m10_sales_rpc.sql) for the matching decision on create_sale/update_sale/void_sale
-- themselves — prompt §107 names quantity/cost-basis-adjacent system columns as ones the browser
-- must never be able to forge directly, which is the "documented requirement" prompt §105 asks for
-- before deviating from the SECURITY INVOKER default.
create or replace function public.recompute_lot_quantity_remaining()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot_id uuid := coalesce(new.lot_id, old.lot_id);
  v_quantity int;
  v_disposed int;
begin
  select quantity into v_quantity from public.acquisition_lots where id = v_lot_id;
  select coalesce(sum(quantity), 0) into v_disposed
    from public.lot_disposals where lot_id = v_lot_id and voided_at is null;

  update public.acquisition_lots
    set quantity_remaining = v_quantity - v_disposed
    where id = v_lot_id;

  return coalesce(new, old);
end;
$$;

create trigger lot_disposals_recompute_quantity
  after insert or update of voided_at on public.lot_disposals
  for each row execute function public.recompute_lot_quantity_remaining();

-- ── 5. RLS ───────────────────────────────────────────────────────────────────────────────────────
-- SELECT only for authenticated (browsing own History), enforced by RLS in the ordinary way.
-- No INSERT/UPDATE policy on any of the three tables: every write happens inside
-- create_sale/update_sale/void_sale, which are SECURITY DEFINER (20260828120010's own header
-- explains why) and therefore run with the owning role's privileges, not the caller's — an RLS
-- policy with nothing able to reach it (authenticated holds no INSERT/UPDATE grant at all, below)
-- would be dead code, so none is written. service_role gets `all`, same as purchases.

alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.lot_disposals enable row level security;

create policy sales_owner_select on public.sales
  for select to authenticated using (user_id = (select auth.uid()));

create policy sale_lines_owner_select on public.sale_lines
  for select to authenticated using (user_id = (select auth.uid()));

create policy lot_disposals_owner_select on public.lot_disposals
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.sales to authenticated;
grant select on public.sale_lines to authenticated;
grant select on public.lot_disposals to authenticated;

grant all on public.sales, public.sale_lines, public.lot_disposals to service_role;
