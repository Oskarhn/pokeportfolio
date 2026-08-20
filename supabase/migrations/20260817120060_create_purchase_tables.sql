-- purchases and purchase_lines (DATA_MODEL.md §5.3, FINANCIAL_MODEL.md §1-4).
-- Money columns are `bigint` minor units, never float/numeric — FINANCIAL_MODEL.md §1.
-- See docs/DATA_MODEL.md "Money in the database" note (added alongside this migration) for the
-- bigint/PostgREST serialization boundary and its mitigation.

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  origin public.purchase_origin not null default 'manual',
  purchased_on date not null,
  retailer_id uuid references public.retailers (id) on delete set null,
  currency text not null,
  subtotal_minor bigint not null default 0,
  shipping_minor bigint not null default 0,
  customs_minor bigint not null default 0,
  discount_minor bigint not null default 0,
  total_minor bigint not null,
  fx_rate_to_nok numeric(18, 8) not null default 1,
  fx_rate_date date not null,
  fx_source public.fx_source not null default 'manual',
  total_nok_minor bigint not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  constraint purchases_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint purchases_amounts_nonnegative check (
    subtotal_minor >= 0 and shipping_minor >= 0 and customs_minor >= 0
    and discount_minor >= 0 and total_minor >= 0 and total_nok_minor >= 0
  ),
  -- DATA_MODEL.md §5.3: total = subtotal + shipping + customs - discount.
  constraint purchases_total_matches_lines check (
    total_minor = subtotal_minor + shipping_minor + customs_minor - discount_minor
  )
);

create index purchases_user_purchased_on_idx on public.purchases (user_id, purchased_on desc);
create index purchases_retailer_id_idx on public.purchases (retailer_id) where retailer_id is not null;

create table public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  line_type public.line_type not null,
  spend_class public.spend_class not null,
  description text,
  card_variant_id uuid references public.card_variants (id),
  sealed_product_id uuid references public.sealed_products (id),
  condition public.card_condition,
  quantity int not null,
  unit_price_minor bigint not null,
  line_total_minor bigint not null,
  allocated_shipping_minor bigint not null default 0,
  allocated_customs_minor bigint not null default 0,
  allocated_discount_minor bigint not null default 0,
  attributable_cost_minor bigint not null default 0,
  attributable_cost_nok_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_lines_quantity_positive check (quantity > 0),
  constraint purchase_lines_amounts_nonnegative check (
    unit_price_minor >= 0 and line_total_minor >= 0
    and allocated_shipping_minor >= 0 and allocated_customs_minor >= 0
    and allocated_discount_minor >= 0 and attributable_cost_minor >= 0
    and attributable_cost_nok_minor >= 0
  ),
  constraint purchase_lines_line_total_matches_unit_price check (
    line_total_minor = unit_price_minor * quantity
  ),
  -- DATA_MODEL.md §5.3: card_variant_id and sealed_product_id are mutually exclusive (a line may
  -- reference neither, e.g. a grading fee or standalone shipping line, but never both).
  constraint purchase_lines_catalog_ref_mutually_exclusive check (
    not (card_variant_id is not null and sealed_product_id is not null)
  )
);

create index purchase_lines_purchase_id_idx on public.purchase_lines (purchase_id);
create index purchase_lines_user_spend_class_idx on public.purchase_lines (user_id, spend_class);

-- Invariant S1 (SECURITY.md §3.2): purchase_lines.user_id must match its parent purchase's
-- owner. Runs with invoker rights (not SECURITY DEFINER) — RLS on `purchases` already hides
-- another user's row from the SELECT below, so a cross-tenant attempt fails with "not found"
-- rather than leaking whether the target row exists. See also acquisition_lots_check_owner.
create or replace function public.purchase_lines_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_user_id uuid;
begin
  select user_id into parent_user_id from public.purchases where id = new.purchase_id;
  if parent_user_id is null or new.user_id <> parent_user_id then
    raise exception 'purchase_lines.user_id must match the owner of purchase %', new.purchase_id;
  end if;
  return new;
end;
$$;

create trigger purchase_lines_owner_check
  before insert or update on public.purchase_lines
  for each row execute function public.purchase_lines_check_owner();

create trigger purchases_set_updated_at before update on public.purchases
  for each row execute function public.set_updated_at();
create trigger purchase_lines_set_updated_at before update on public.purchase_lines
  for each row execute function public.set_updated_at();

alter table public.purchases enable row level security;
alter table public.purchase_lines enable row level security;

-- FOR ALL minus DELETE: financial ledger rows use void semantics, never raw deletion
-- (SECURITY.md §8, DATA_MODEL.md §9). Hard delete is an application/RPC-layer decision for a
-- later milestone (M8's guard rules), not something the raw API grant should offer today.
create policy purchases_owner_select on public.purchases
  for select to authenticated using (user_id = (select auth.uid()));
create policy purchases_owner_insert on public.purchases
  for insert to authenticated with check (true); -- TEMP: M3 gate verification, see commit message
create policy purchases_owner_update on public.purchases
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy purchase_lines_owner_select on public.purchase_lines
  for select to authenticated using (user_id = (select auth.uid()));
create policy purchase_lines_owner_insert on public.purchase_lines
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy purchase_lines_owner_update on public.purchase_lines
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on public.purchases, public.purchase_lines to authenticated;

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
-- Unlike `authenticated`, service_role keeps DELETE: the void-only restriction above is about
-- what the client app can do, not server-side/administrative access, which SECURITY.md §4
-- already discloses as inherent to operating the deployment.
grant all on public.purchases, public.purchase_lines to service_role;
