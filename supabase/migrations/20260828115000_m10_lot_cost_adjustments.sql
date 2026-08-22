-- M10 prerequisite: `lot_cost_adjustments` (DATA_MODEL.md §5.6, FINANCIAL_MODEL.md §4.4/E6) never
-- actually shipped. M3's own scope note (20260817120070) deferred it alongside lot_disposals,
-- openings, trades and lot_transfers — but unlike those, nothing since M3 revisited it: M6 wired
-- grading fields onto `holdings` (grader/grade/cert_number) and E6 in FINANCIAL_MODEL.md has
-- described the grading-fee-as-adjustment flow since M2, yet the table backing it was never
-- created. This was invisible until now because nothing computed EUCB from real stored rows —
-- M9's `effectiveUnitCostBasis` domain function takes adjustments as a plain argument, never reads
-- this table. M10's `create_sale` is the first real caller (a sale must freeze EUCB, not just the
-- direct unit cost, DECISIONS.md D-060), so it is created now, exactly to DATA_MODEL.md §5.6's
-- documented shape — a genuine gap being closed, not a new design.

create type public.lot_cost_adjustment_kind as enum (
  'grading_fee', 'grading_shipping', 'restoration', 'other'
);

create table public.lot_cost_adjustments (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.acquisition_lots (id),
  user_id uuid not null references auth.users (id),
  kind public.lot_cost_adjustment_kind not null,
  -- F7: every adjustment traces to a real purchase line — no path to raise a cost basis without a
  -- corresponding real purchase.
  purchase_line_id uuid not null references public.purchase_lines (id),
  amount_minor bigint not null,
  currency text not null,
  amount_nok_minor bigint not null,
  occurred_on date not null,
  note text,
  created_at timestamptz not null default now(),
  constraint lot_cost_adjustments_amount_non_negative check (amount_minor >= 0 and amount_nok_minor >= 0),
  constraint lot_cost_adjustments_currency_shape check (currency ~ '^[A-Z]{3}$')
);

create index lot_cost_adjustments_lot_idx on public.lot_cost_adjustments (lot_id);

-- Same defence-in-depth shape as acquisition_lots_check_owner/sale_lines_check_owner: both SELECTs
-- run with invoker rights, so RLS hides a foreign lot_id/purchase_line_id entirely.
create or replace function public.lot_cost_adjustments_check_owner()
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
    raise exception 'lot_cost_adjustments.user_id must match the owner of lot %', new.lot_id;
  end if;

  select user_id into v_line_user_id from public.purchase_lines where id = new.purchase_line_id;
  if v_line_user_id is null or v_line_user_id <> new.user_id then
    raise exception 'lot_cost_adjustments.purchase_line_id must belong to the same owner';
  end if;

  return new;
end;
$$;

create trigger lot_cost_adjustments_owner_check
  before insert or update on public.lot_cost_adjustments
  for each row execute function public.lot_cost_adjustments_check_owner();

alter table public.lot_cost_adjustments enable row level security;

create policy lot_cost_adjustments_owner_select on public.lot_cost_adjustments
  for select to authenticated using (user_id = (select auth.uid()));
-- No INSERT policy: authenticated holds no INSERT grant on this table at all (see the grant below)
-- until M17's validated write path exists — an RLS policy with nothing to gate would be dead code.

-- SELECT only. No INSERT/UPDATE/DELETE grant to authenticated: nothing in M10 writes this table
-- from the browser — create_sale only reads it (see 20260828120010's EUCB computation) — and no
-- controlled write path exists yet for *creating* an adjustment (M17 owns the real "record a
-- grading submission" RPC, which will validate the fee against a real grading_submissions row
-- before writing here). Granting a direct INSERT now, with no such validation, would let a user
-- inflate their own cost basis by fabricating an adjustment that cites any purchase_line of theirs
-- with spare, unrelated spend — a real accounting integrity gap, not merely a self-forgery
-- curiosity. service_role (the migration/admin path) can seed rows directly until M17 ships the
-- real write RPC.
grant select on public.lot_cost_adjustments to authenticated;
grant all on public.lot_cost_adjustments to service_role;
