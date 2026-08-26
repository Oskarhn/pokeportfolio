-- M16: Openings V1 — canonical schema (FINANCIAL_MODEL.md §5, DATA_MODEL.md §5.8).
--
-- An opening is the state transition "sealed units became pulled cards". It creates NO spend:
-- the purchase already contributed to GPO/CS exactly once, and CS/GPO are byte-identical before
-- and after any opening. The opening OWNS the monetary cost of what it consumed, copied frozen
-- from the source lot; pulled cards carry NULL basis (unallocated_opening), never 0 (M1/M2).
--
-- ── Deliberate deviations from DATA_MODEL.md §5.8's pre-implementation sketch ─────────────────
--
-- 1. ONE source lot per opening (P50 decision, prompt §10). The sketch left both
--    openings.source_lot_id and disposal-level linkage open; this migration commits to the
--    smallest model that satisfies real usage: a user opens 1–N units of ONE sealed acquisition
--    lot per opening. Opening units across two lots is two openings — no corruption either way,
--    because each opening consumes its own lot's frozen basis exactly and the residual rule is
--    per-lot. Multi-lot consumption can be added later by dropping the single-disposal unique
--    index below WITHOUT touching any stored row or financial figure.
-- 2. quantity_opened replaces the sketch's informational pack_count: the number of sealed UNITS
--    consumed is the load-bearing fact (it drives the disposal, the cost share and History);
--    pack-count metadata remains on sealed_products for cost-per-pack analytics.
-- 3. No audit_events anywhere (prompt §4B): reconciliation provenance lives on the opening row
--    itself (provisional_purchase_id / reconciled_at / reconciled_to_purchase_id) — see §19 of
--    the M16 core prompt. FINANCIAL_MODEL.md §5.5's audit_event mention is corrected by P53.
-- 4. Reconciliation columns are explicit nullable fields rather than a side table — the smallest
--    defensible schema that preserves "which provisional purchase was replaced by which real
--    one, when" without inventing an event-sourcing surface.
--
-- ── Integration additions (P53) ───────────────────────────────────────────────────────────────
--
-- 5. openings.idempotency_key — server-side idempotency (P53 §5). The UI already generates a
--    client key per submission attempt; without server enforcement a lost response (timeout,
--    offline flip) followed by a retry would record TWO openings — and on the provisional path
--    TWO purchases. Every opening row therefore carries NOT NULL uuid key, unique per owner.
--    Retries with the SAME key return the SAME committed opening from inside the writer RPCs;
--    reuse of a key for a MATERIALLY different request is rejected explicitly (never silently
--    treated as a replay).
--
-- 6. purchase_lines_line_total_matches_unit_price is REPLACED by a residual-tolerant form
--    (P53 §12, D-090). Buy-and-open enters a receipt TOTAL ("3 packs, paid 299.95"): the exact
--    total must survive end-to-end while unit_price stays an integer display/storage value.
--    Under the old equality constraint (line_total = unit_price × quantity) the single sealed
--    line could only carry 29994 and one øre of genuinely-paid money had nowhere honest to go.
--    The replacement bounds the excess by the largest-remainder discipline exactly:
--        unit_price_minor × quantity ≤ line_total_minor ≤ unit_price_minor × quantity + quantity − 1
--    i.e. line_total may exceed unit×qty by up to (quantity − 1) øre — never fall below it, never
--    more than one øre per unit. Every row written before this migration has excess 0 and
--    validates unchanged; update_purchase's own recomputation writes excess 0 rows; the only
--    writer that uses the slack is create_opening_from_provisional, which stores the integer-
--    division unit value (total/qty, truncating toward zero — identical to floor for the
--    nonnegative totals entered here) and hands the remainder to the acquisition lot's existing residual columns
--    so Σ attributable basis across openings reproduces the entered total EXACTLY (29995 = 9998×2
--    +19996… see FINANCIAL_MODEL.md §5.5).
--
-- Everything else follows the shipped disposal architecture exactly: the consumption IS a
-- lot_disposals row (kind='opened' — the enum value has existed since M10 awaiting exactly
-- this writer), so invariant D1, the M12 history-invalidation triggers and the frozen
-- cost_basis_at_disposal_nok_minor column all apply with zero new trigger code.

-- ── 1. Enum vocabulary ───────────────────────────────────────────────────────────────────────
-- New types (fresh CREATE TYPE in the same transaction as their first use is safe; the M6
-- ALTER-TYPE-same-transaction caveat applies only to ADD VALUE on pre-existing enums, and no
-- existing enum gains a value here: lot_origin.'opening', cost_basis_state.'unallocated_opening'
-- and disposal_kind.'opened' have existed since M6/M10 precisely for this milestone).

create type public.opening_cost_source as enum ('from_lot', 'unknown');
create type public.opening_tracking as enum ('all_cards', 'selected_pulls', 'unknown');

comment on type public.opening_cost_source is
  'from_lot: the opening''s cost is the exact frozen basis consumed from its source lot. '
  'unknown: no recoverable cost exists (gifted/unknown-cost product) — cost stays NULL, never 0.';
comment on type public.opening_tracking is
  'Declared tracking completeness (F8 area). selected_pulls/unknown force the incompleteness '
  'marker on every opening-return surface; never inferred from the number of pulls recorded.';

-- ── 2. openings ──────────────────────────────────────────────────────────────────────────────
create table public.openings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  opened_on date not null,
  -- The ONE sealed acquisition lot this opening consumed units from. Ownership and identity are
  -- asserted by openings_check_owner below; the RPC layer locks the lot FOR UPDATE before use.
  source_lot_id uuid not null references public.acquisition_lots (id),
  -- Denormalized display identity, derived from the source lot's holding inside every write path
  -- and re-asserted by openings_check_owner — an opening is always one sealed product's opening.
  sealed_product_id uuid not null references public.sealed_products (id),
  quantity_opened int not null,
  cost_source public.opening_cost_source not null,
  -- M1 at opening scope: NULL means "no known cost" (unknown source), NEVER zero kroner.
  cost_nok_minor bigint,
  tracking_completeness public.opening_tracking not null default 'all_cards',
  -- Owner-entered estimate for untracked leftovers (DATA_MODEL.md §11). Both-or-neither.
  -- Affects OPENING RETURN only: never CMV, never inventory counts, never purchase spend.
  bulk_remainder_estimate_nok_minor bigint,
  bulk_remainder_count int,
  -- D-021/FINANCIAL_MODEL §5.5 provisional path: the auto-created real purchase this opening
  -- immediately consumed. Retained after reconciliation as the historical pointer; the purchase
  -- ROW is voided at reconcile, never deleted.
  provisional_purchase_id uuid references public.purchases (id),
  -- Reconciliation provenance without audit_events (prompt §19/§4B): set together, once, by
  -- reconcile_opening_cost. F12 ("at most one active monetary source") holds at every instant:
  -- the provisional purchase is voided in the same transaction that repoints the source lot.
  reconciled_at timestamptz,
  reconciled_to_purchase_id uuid references public.purchases (id),
  notes text,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  -- Server-side idempotency key (P53 §5): the client-generated submission identity. NOT NULL —
  -- every writer RPC supplies one, generating internally when a caller omits it. Unique per
  -- owner: two different users may collide freely; one user never gets two openings from one
  -- lost-then-retried request.
  idempotency_key uuid not null default gen_random_uuid(),

  constraint openings_quantity_positive check (quantity_opened > 0),
  constraint openings_cost_shape check (
    (cost_source = 'from_lot' and cost_nok_minor is not null)
    or (cost_source = 'unknown' and cost_nok_minor is null)
  ),
  constraint openings_remainder_shape check (
    (bulk_remainder_estimate_nok_minor is null and bulk_remainder_count is null)
    or (bulk_remainder_estimate_nok_minor >= 0 and bulk_remainder_count > 0)
  ),
  constraint openings_reconciliation_shape check (
    (reconciled_at is null and reconciled_to_purchase_id is null)
    or (
      reconciled_at is not null
      and reconciled_to_purchase_id is not null
      and provisional_purchase_id is not null
    )
  )
);

-- Idempotent replay discipline (P53 §5): one key, one owner, at most one opening. Composite —
-- the same client-generated UUID from two accounts is two independent legitimate operations.
create unique index openings_user_idempotency_key_idx
  on public.openings (user_id, idempotency_key);

comment on table public.openings is
  'M16: one opening = one act of consuming 1..N units of ONE sealed acquisition lot into pulled '
  'card lots. Creates no spend (CS/GPO unchanged); owns the consumed frozen cost; pulls carry '
  'NULL individual basis. See FINANCIAL_MODEL.md §5.';

-- NO set_updated_at trigger here (P62 bug B): the generic helper assigns new.updated_at, and the
-- canonical openings schema deliberately carries explicit lifecycle timestamps only — created_at,
-- voided_at, reconciled_at (backup v2 mirrors exactly these). A mutable-fields updated_at would
-- be a new canonical column with no reader; the lifecycle columns are the audit surface. Attaching
-- the generic trigger anyway made every UPDATE fail at runtime ("record" "new" has no field
-- "updated_at") — void_opening and reconcile_opening_cost included.

create index openings_user_opened_idx on public.openings (user_id, opened_on desc, id desc);

-- ── 2b. purchase_lines line-total residual tolerance (P53 §12 / D-090) ────────────────────────
-- Replaces M8's equality form so a receipt TOTAL entered by the owner ("3 packs, paid 299.95")
-- survives exactly on the canonical line while unit_price stays an integer display/storage
-- value. See the header note (§6) for the full rationale. Widening only: excess 0 rows (every
-- pre-existing writer) validate unchanged.
alter table public.purchase_lines
  drop constraint purchase_lines_line_total_matches_unit_price;

alter table public.purchase_lines
  add constraint purchase_lines_line_total_matches_unit_price check (
    line_total_minor >= unit_price_minor * quantity
    and line_total_minor <= unit_price_minor * quantity + quantity - 1
  );

comment on constraint purchase_lines_line_total_matches_unit_price on public.purchase_lines is
  'Largest-remainder discipline (D-090): line_total may exceed unit_price × quantity by up to '
  'quantity − 1 øre (integer-division rounding of an entered receipt total toward zero — for '
  'the nonnegative totals this schema admits that is also the floor), never less and never '
  'more. The lot''s residual columns carry the difference so consumption reproduces the total. '
  'This is now a GLOBAL purchase-line invariant, not an Opening implementation detail: every '
  'writer (create_purchase, update_purchase, the provisional path) is bound by it.';

-- Ownership + identity defence in depth. Every browser write goes through the SECURITY DEFINER
-- RPCs (authenticated holds SELECT only on this table); this trigger additionally pins direct
-- privileged writes to the same rules the RPCs enforce: the source lot belongs to the same owner,
-- the denormalized sealed_product_id matches that lot's actual holding, and any referenced
-- purchase rows belong to the same owner. Same shape and reasoning as *_check_owner everywhere
-- else in this schema.
create or replace function public.openings_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_lot_user_id uuid;
  v_lot_sealed_product_id uuid;
  v_purchase_user_id uuid;
begin
  select l.user_id, h.sealed_product_id
    into v_lot_user_id, v_lot_sealed_product_id
  from public.acquisition_lots l
  join public.holdings h on h.id = l.holding_id
  where l.id = new.source_lot_id;

  if v_lot_user_id is null or v_lot_user_id <> new.user_id then
    raise exception 'openings.source_lot_id must belong to the same owner';
  end if;
  if v_lot_sealed_product_id is null or v_lot_sealed_product_id <> new.sealed_product_id then
    raise exception 'openings.sealed_product_id must match the source lot''s holding';
  end if;

  if new.provisional_purchase_id is not null then
    select user_id into v_purchase_user_id from public.purchases
      where id = new.provisional_purchase_id;
    if v_purchase_user_id is null or v_purchase_user_id <> new.user_id then
      raise exception 'openings.provisional_purchase_id must belong to the same owner';
    end if;
  end if;

  if new.reconciled_to_purchase_id is not null then
    select user_id into v_purchase_user_id from public.purchases
      where id = new.reconciled_to_purchase_id;
    if v_purchase_user_id is null or v_purchase_user_id <> new.user_id then
      raise exception 'openings.reconciled_to_purchase_id must belong to the same owner';
    end if;
  end if;

  return new;
end;
$$;

create trigger openings_owner_check
  before insert or update on public.openings
  for each row execute function public.openings_check_owner();

-- ── 3. lot_disposals.opening_id — the canonical consumption record ───────────────────────────
alter table public.lot_disposals
  add column opening_id uuid references public.openings (id);

-- Joins the existing (kind='sale') = (sale_line_id is not null) shape: an 'opened' disposal
-- always cites its opening; no other kind ever does. kind is single-valued so the two rules
-- cannot collide.
alter table public.lot_disposals
  add constraint lot_disposals_opened_kind_needs_opening
    check ((kind = 'opened') = (opening_id is not null));

-- Exactly one LIVE consumption row per opening. Void-filtered so reconcile_opening_cost can
-- retire the provisional consumption and write the repointed one in the same transaction.
create unique index lot_disposals_one_live_per_opening
  on public.lot_disposals (opening_id)
  where opening_id is not null and voided_at is null;

create index lot_disposals_opening_idx
  on public.lot_disposals (opening_id)
  where opening_id is not null;

-- Extends lot_disposals_check_owner (20260828120000_m10_sales_schema.sql) with the opening link —
-- FULL-BODY DIFF discipline (the M11 lesson: replacing a check-owner trigger from an older copy
-- silently drops checks later milestones added). New block: an opening-linked disposal must cite
-- an opening owned by the same user.
create or replace function public.lot_disposals_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_lot_user_id uuid;
  v_line_user_id uuid;
  v_opening_user_id uuid;
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

  -- M16: an opened disposal's opening must belong to the same owner.
  if new.opening_id is not null then
    select user_id into v_opening_user_id from public.openings where id = new.opening_id;
    if v_opening_user_id is null or v_opening_user_id <> new.user_id then
      raise exception 'lot_disposals.opening_id must belong to the same owner';
    end if;
  end if;

  return new;
end;
$$;

-- ── 4. acquisition_lots.opening_id — pulled-card attribution ─────────────────────────────────
alter table public.acquisition_lots
  add column opening_id uuid references public.openings (id);

-- Forward direction only: opening_id ⇒ origin='opening'. Pre-existing M6-era origin='opening'
-- lots legitimately keep NULL until/unless linked (D-038); nothing here retro-fits them.
alter table public.acquisition_lots
  add constraint acquisition_lots_opening_id_needs_opening_origin
    check (opening_id is null or origin = 'opening');

-- Reserved since M6 for exactly this purpose (DATA_MODEL.md §10, "Opening return").
create index acquisition_lots_opening_idx
  on public.acquisition_lots (opening_id)
  where opening_id is not null;

-- Extends acquisition_lots_check_owner (current body: 20260821120020_m6_holdings_and_lots_extensions.sql
-- — holding owner + purchase_line owner + storage_location owner) with the opening link. FULL-BODY
-- DIFF discipline as above: every existing check preserved verbatim, opening ownership added.
create or replace function public.acquisition_lots_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_user_id uuid;
  line_user_id uuid;
  location_user_id uuid;
  opening_user_id uuid;
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

  -- M16: a pull lot must cite an opening owned by the same user.
  if new.opening_id is not null then
    select user_id into opening_user_id from public.openings where id = new.opening_id;
    if opening_user_id is null or opening_user_id <> new.user_id then
      raise exception 'acquisition_lots.opening_id must belong to the same owner';
    end if;
  end if;

  return new;
end;
$$;

-- ── 5. RLS and privileges ────────────────────────────────────────────────────────────────────
-- Owner-SELECT only, mirroring the sale ledger's posture: every write happens inside the M16
-- SECURITY DEFINER RPCs (they author frozen financial figures — the copied opening cost and the
-- frozen disposal share — which must be unreachable by direct writes, the D-060 standard), so no
-- INSERT/UPDATE policy or grant exists for any browser role. service_role keeps full access for
-- backup/maintenance tooling, consistent with every sibling table.
alter table public.openings enable row level security;

create policy openings_owner_select on public.openings
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.openings to authenticated;

grant all on public.openings to service_role;
