-- M6: extends holdings/acquisition_lots for the manual-card fallback, and relocates
-- storage_location_id from holdings to acquisition_lots (schema correction, D-036 — see below).

-- ── 1. Manual card identity on holdings ──────────────────────────────────────────────────────
-- A holding now references exactly one of three identity sources: a canonical card_variant, a
-- canonical sealed_product, or a user-private manual_card_definition (M6 prompt §18's invariant:
-- "a holding has one and only one card identity source"). The XOR check constraint widens from
-- two arms to three; the identity uniqueness index widens its coalesce() the same way so a manual
-- card's identity is exactly as fragmentation-proof as a catalog card's.

alter table public.holdings
  add column manual_card_id uuid references public.manual_card_definitions (id);

alter table public.holdings
  drop constraint holdings_exactly_one_catalog_ref;

alter table public.holdings
  add constraint holdings_exactly_one_identity_source check (
    (case when card_variant_id is not null then 1 else 0 end)
    + (case when sealed_product_id is not null then 1 else 0 end)
    + (case when manual_card_id is not null then 1 else 0 end)
    = 1
  );

-- A manual card is always a raw or graded card identity, never a sealed product — sealed
-- inventory has its own catalog table and its own identity path.
alter table public.holdings
  add constraint holdings_manual_card_not_sealed check (
    manual_card_id is null or holding_kind <> 'sealed'
  );

drop index public.holdings_identity;

create unique index holdings_identity on public.holdings (
  user_id,
  holding_kind,
  coalesce(card_variant_id, sealed_product_id, manual_card_id),
  coalesce(public.card_condition_to_text(condition), ''),
  grading_state,
  coalesce(public.grader_to_text(grader), ''),
  coalesce(grade, -1)
) where deleted_at is null;

-- S1 defence in depth (SECURITY.md §3.2): a holding's manual_card_id must belong to the same
-- owner. Runs with invoker rights — RLS on manual_card_definitions already hides another user's
-- row, so a cross-tenant attempt reads as "not found" rather than confirming the row exists,
-- exactly like acquisition_lots_check_owner below and purchase_lines_check_owner.
create or replace function public.holdings_check_manual_card_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  manual_owner uuid;
begin
  if new.manual_card_id is not null then
    select user_id into manual_owner
      from public.manual_card_definitions
      where id = new.manual_card_id;
    if manual_owner is null or manual_owner <> new.user_id then
      raise exception 'holdings.manual_card_id must belong to the same owner';
    end if;
  end if;
  return new;
end;
$$;

create trigger holdings_manual_card_owner_check
  before insert or update on public.holdings
  for each row execute function public.holdings_check_manual_card_owner();

-- ── 2. Storage location moves from holdings to acquisition_lots (D-036) ─────────────────────
-- DATA_MODEL.md §5.2 originally stated storage location as "one per holding". A real scenario
-- breaks that: two identical NM copies of the same card in Binder 1 and a third in Binder 2 are
-- one holding (same variant, same condition, same grading state — holdings_identity above
-- correctly merges them) but cannot share one storage_location_id. Location is a fact about a
-- specific batch of physical copies, which is exactly what an acquisition_lot already models —
-- consistent with §21's own guidance that ordinary lot differences, not new holdings, are the
-- right place for this kind of variation. Recorded as D-036 in DECISIONS.md, the same shape as
-- M5's D-033/D-034 catalog-identity corrections: found and fixed before real user data existed
-- rather than migrated out from under it later.

drop index public.holdings_user_storage_idx;

alter table public.holdings
  drop column storage_location_id;

alter table public.acquisition_lots
  add column storage_location_id uuid references public.storage_locations (id) on delete set null;

create index acquisition_lots_user_storage_idx on public.acquisition_lots (user_id, storage_location_id)
  where storage_location_id is not null;

-- ── 3. Origin / cost-basis-state consistency (M6 prompt §24-31, extending FINANCIAL_MODEL §1.1) ─
-- Replaces the narrower gift-only check M3 shipped with the complete mapping DATA_MODEL.md §5.5
-- always described: "an opening-origin lot may only be unallocated_opening, a gift-origin lot
-- only not_paid, and so on." 'purchase' and 'other' both permit 'known' (traceable to a real
-- purchase_line — enforced separately by acquisition_lots_cost_basis_state_consistency) alongside
-- 'unknown', because a purchase whose receipt is lost is still origin='purchase' with cost
-- unrecoverable, and 'other' is deliberately not a single fixed state (M6 prompt §31).

alter table public.acquisition_lots
  drop constraint acquisition_lots_gift_is_not_paid;

alter table public.acquisition_lots
  add constraint acquisition_lots_origin_cost_state_consistency check (
    case origin
      when 'purchase'     then cost_basis_state in ('known', 'unknown')
      when 'opening'      then cost_basis_state = 'unallocated_opening'
      when 'gift'         then cost_basis_state = 'not_paid'
      when 'trade_in'     then cost_basis_state = 'trade_in'
      when 'pre_tracking' then cost_basis_state = 'unknown'
      when 'found'        then cost_basis_state in ('not_paid', 'unknown')
      when 'other'        then cost_basis_state in ('known', 'not_paid', 'unknown')
      else false
    end
  );

-- Extends acquisition_lots_check_owner (20260817120070_create_holdings_and_lots.sql) with the new
-- storage_location_id column — same S1 defence-in-depth shape as the holding/purchase_line checks
-- already in this function.
create or replace function public.acquisition_lots_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_user_id uuid;
  line_user_id uuid;
  location_user_id uuid;
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

  if new.storage_location_id is not null then
    select user_id into location_user_id
      from public.storage_locations
      where id = new.storage_location_id;
    if location_user_id is null or location_user_id <> new.user_id then
      raise exception 'acquisition_lots.storage_location_id must belong to the same owner';
    end if;
  end if;

  return new;
end;
$$;

-- ── 4. profiles.default_storage_location_id: the same class of gap, closed the same way ────────
-- Pre-existing since M3 (the column has always been client-writable, per profile) and unrelated
-- to the M6 feature itself, but the same defence-in-depth argument applies and M6 is already
-- touching every storage_location_id ownership path — leaving this one unfixed while writing the
-- other two would be inconsistent, not conservative.
create or replace function public.profiles_check_default_storage_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  location_user_id uuid;
begin
  if new.default_storage_location_id is not null then
    select user_id into location_user_id
      from public.storage_locations
      where id = new.default_storage_location_id;
    if location_user_id is null or location_user_id <> new.id then
      raise exception 'profiles.default_storage_location_id must belong to the same owner';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_default_storage_owner_check
  before insert or update on public.profiles
  for each row execute function public.profiles_check_default_storage_owner();
