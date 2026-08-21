-- manual_valuations (DATA_MODEL.md §5.12), brought forward from its originally-planned M9 arrival
-- because the M6 gate requires a directly-owned graded card to carry a manual value in MVP
-- (ROADMAP.md's M6 entry: "Graded cards as a collection type with manual value"). Only this entry
-- table ships now — the valuation *resolver* (manual → fresh → stale → missing,
-- FINANCIAL_MODEL.md §6) and every provider-price table stay M9's, exactly as
-- ROADMAP/DATA_MODEL originally sequenced them. M6 UI reads the single active row per holding
-- directly; it does not implement price fallback because there is no other price source to fall
-- back to yet. See DECISIONS.md D-038 for the reconciliation of this sequencing note.
--
-- History preserved, never updated in place (DATA_MODEL.md §5.12): setting a new value supersedes
-- the old row rather than overwriting it, so what a holding was believed worth on a given date
-- stays inspectable.
--
-- Currency fixed to NOK for M6, matching the direct-acquisition-cost scope cut in
-- 20260821120050_m6_add_card_acquisition.sql: no FX ingestion exists before M9, so a non-NOK
-- manual value would have no honest NOK conversion to freeze. Lifting this is a future migration,
-- not an application-layer decision, once FX exists.

create table public.manual_valuations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  holding_id uuid not null references public.holdings (id),
  value_minor bigint not null,
  currency text not null default 'NOK',
  value_nok_minor bigint not null,
  effective_from date not null default current_date,
  superseded_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  constraint manual_valuations_value_nonnegative check (value_minor >= 0 and value_nok_minor >= 0),
  constraint manual_valuations_currency_nok_only check (currency = 'NOK'),
  constraint manual_valuations_nok_matches check (currency <> 'NOK' or value_nok_minor = value_minor)
);

-- F10 (FINANCIAL_MODEL.md §6.2 — raw prices never value graded cards) is enforced by application
-- logic reading this table only for holding_kind='graded_card', not by a schema-level join here:
-- a manual valuation is meaningful for a sealed or an unusual raw holding too, and the resolver
-- that decides which source wins for which holding kind belongs to M9, not to this table.

create index manual_valuations_holding_idx on public.manual_valuations (holding_id, effective_from desc);

-- At most one active (non-superseded) valuation per holding at a time.
create unique index manual_valuations_one_active on public.manual_valuations (holding_id)
  where superseded_at is null;

-- S1 defence in depth: holding_id must belong to the same owner.
create or replace function public.manual_valuations_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  holding_owner uuid;
begin
  select user_id into holding_owner from public.holdings where id = new.holding_id;
  if holding_owner is null or holding_owner <> new.user_id then
    raise exception 'manual_valuations.user_id must match the owner of holding %', new.holding_id;
  end if;
  return new;
end;
$$;

create trigger manual_valuations_owner_check
  before insert or update on public.manual_valuations
  for each row execute function public.manual_valuations_check_owner();

alter table public.manual_valuations enable row level security;

-- Read and append only from the client. Superseding a row means setting superseded_at, which the
-- narrow column-grant below allows; no other field is ever edited in place (history, not a cache).
create policy manual_valuations_owner_select on public.manual_valuations
  for select to authenticated using (user_id = (select auth.uid()));
create policy manual_valuations_owner_insert on public.manual_valuations
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy manual_valuations_owner_update on public.manual_valuations
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert on public.manual_valuations to authenticated;
grant update (superseded_at) on public.manual_valuations to authenticated;

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
grant all on public.manual_valuations to service_role;
