-- holdings and acquisition_lots (DATA_MODEL.md §5.4-5.5, FINANCIAL_MODEL.md §1.1).
--
-- SCOPE NOTE: lot_disposals, lot_cost_adjustments, openings, trades and lot_transfers are not
-- created in M3. ROADMAP.md's M3 entry lists "catalog, profiles, invitations, holdings, lots,
-- purchases" only; disposal-producing features (sales M10, openings M16, trades M18, grading
-- M17) each bring their own table in their own milestone. Consequently acquisition_lots here has
-- no opening_id/trade_line_id column yet, and quantity_remaining has no D1-invariant trigger
-- yet — there is no disposal path in M3 that could violate it. quantity_remaining is simply
-- constrained to 0 <= quantity_remaining <= quantity, and the invariant trigger arrives with the
-- first migration that adds a disposal table.

create table public.holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  holding_kind public.holding_kind not null,
  card_variant_id uuid references public.card_variants (id),
  sealed_product_id uuid references public.sealed_products (id),
  condition public.card_condition,
  grading_state public.grading_state not null default 'raw',
  grader public.grader,
  grade numeric(3, 1),
  cert_number text,
  sealed_intent public.sealed_intent,
  storage_location_id uuid references public.storage_locations (id) on delete set null,
  is_favorite boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Exactly one of card_variant_id / sealed_product_id (DATA_MODEL.md §5.4).
  constraint holdings_exactly_one_catalog_ref check (
    (card_variant_id is not null and sealed_product_id is null)
    or (card_variant_id is null and sealed_product_id is not null)
  ),
  -- condition applies to raw cards only; null for sealed and graded holdings.
  constraint holdings_condition_only_for_raw check (
    holding_kind = 'raw_card' or condition is null
  ),
  -- grader / grade / cert_number apply only once grading has started.
  constraint holdings_grading_fields_require_state check (
    grading_state in ('pending', 'graded')
    or (grader is null and grade is null and cert_number is null)
  ),
  -- sealed_intent applies only to sealed holdings.
  constraint holdings_sealed_intent_scope check (
    holding_kind = 'sealed' or sealed_intent is null
  )
);

-- Prevents the same physical state fragmenting into duplicate holdings (DATA_MODEL.md §5.4).
-- Enum columns are cast to text before coalescing: there is no enum member meaning "absent".
create unique index holdings_identity on public.holdings (
  user_id,
  holding_kind,
  coalesce(card_variant_id, sealed_product_id),
  coalesce(condition::text, ''),
  grading_state,
  coalesce(grader::text, ''),
  coalesce(grade, -1)
) where deleted_at is null;

create index holdings_user_kind_idx on public.holdings (user_id, holding_kind) where deleted_at is null;
create index holdings_user_storage_idx on public.holdings (user_id, storage_location_id) where storage_location_id is not null;

create table public.acquisition_lots (
  id uuid primary key default gen_random_uuid(),
  holding_id uuid not null references public.holdings (id),
  user_id uuid not null references auth.users (id),
  origin public.lot_origin not null,
  cost_basis_state public.cost_basis_state not null,
  purchase_line_id uuid references public.purchase_lines (id),
  acquired_on date not null,
  quantity int not null,
  quantity_remaining int not null,
  unit_cost_basis_minor bigint,
  cost_basis_currency text,
  unit_cost_basis_nok_minor bigint,
  residual_minor int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  constraint acquisition_lots_quantity_positive check (quantity > 0),
  constraint acquisition_lots_remaining_in_range check (
    quantity_remaining >= 0 and quantity_remaining <= quantity
  ),
  constraint acquisition_lots_currency_shape check (
    cost_basis_currency is null or cost_basis_currency ~ '^[A-Z]{3}$'
  ),
  -- Invariant M2 (FINANCIAL_MODEL.md §1.1): unit_cost_basis_minor IS NOT NULL iff
  -- cost_basis_state = 'known', and a known lot must trace to a real purchase line.
  constraint acquisition_lots_cost_basis_state_consistency check (
    (cost_basis_state = 'known' and unit_cost_basis_minor is not null and purchase_line_id is not null)
    or (cost_basis_state <> 'known' and unit_cost_basis_minor is null)
  ),
  -- DATA_MODEL.md §5.5: a gift-origin lot is always not_paid.
  constraint acquisition_lots_gift_is_not_paid check (
    origin <> 'gift' or cost_basis_state = 'not_paid'
  )
);

create index acquisition_lots_user_acquired_idx on public.acquisition_lots (user_id, acquired_on);
create index acquisition_lots_holding_open_idx on public.acquisition_lots (holding_id) where quantity_remaining > 0;
create index acquisition_lots_purchase_line_idx on public.acquisition_lots (purchase_line_id) where purchase_line_id is not null;

-- Invariant S1: acquisition_lots.user_id must match its parent holding's owner, and — as
-- defence in depth — the purchase_line it cites, if any, must belong to the same owner too.
-- Both SELECTs run with invoker rights: RLS on holdings/purchase_lines hides another user's row,
-- so a cross-tenant attempt fails as "not found" rather than confirming the row exists.
create or replace function public.acquisition_lots_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_user_id uuid;
  line_user_id uuid;
begin
  select user_id into parent_user_id from public.holdings where id = new.holding_id;
  if parent_user_id is null or new.user_id <> parent_user_id then
    raise exception 'acquisition_lots.user_id must match the owner of holding %', new.holding_id;
  end if;

  if new.purchase_line_id is not null then
    select user_id into line_user_id from public.purchase_lines where id = new.purchase_line_id;
    if line_user_id is null or line_user_id <> new.user_id then
      raise exception 'acquisition_lots.purchase_line_id must belong to the same owner';
    end if;
  end if;

  return new;
end;
$$;

create trigger acquisition_lots_owner_check
  before insert or update on public.acquisition_lots
  for each row execute function public.acquisition_lots_check_owner();

create trigger holdings_set_updated_at before update on public.holdings
  for each row execute function public.set_updated_at();

-- acquisition_lots has no updated_at trigger: it is an immutable historical record
-- (DATA_MODEL.md §9). Corrections happen through explicit, audited operations, not silent edits.

alter table public.holdings enable row level security;
alter table public.acquisition_lots enable row level security;

-- holdings may be deleted directly (an empty, mistaken holding — FK RESTRICT already blocks
-- deleting one that still has lots). acquisition_lots is financial ledger, same reasoning as
-- purchases/purchase_lines above: void semantics, no raw DELETE grant.
create policy holdings_owner on public.holdings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy acquisition_lots_owner_select on public.acquisition_lots
  for select to authenticated using (user_id = (select auth.uid()));
create policy acquisition_lots_owner_insert on public.acquisition_lots
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy acquisition_lots_owner_update on public.acquisition_lots
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.holdings to authenticated;
grant select, insert, update on public.acquisition_lots to authenticated;
