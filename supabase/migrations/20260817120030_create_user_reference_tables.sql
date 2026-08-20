-- User-scoped reference data: retailers, storage_locations, tags (DATA_MODEL.md §5.2).
-- Ownership class "User-private": full CRUD restricted to user_id = auth.uid() (SECURITY.md §3.2).
-- These are top-level tables (user_id is the row's own identity, not reached through a parent),
-- so no ownership-matching trigger is needed here — RLS alone is sufficient.

create table public.retailers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  name text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.storage_locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  name text not null,
  kind public.storage_location_kind not null default 'other',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create trigger retailers_set_updated_at before update on public.retailers
  for each row execute function public.set_updated_at();
create trigger storage_locations_set_updated_at before update on public.storage_locations
  for each row execute function public.set_updated_at();
create trigger tags_set_updated_at before update on public.tags
  for each row execute function public.set_updated_at();

alter table public.retailers enable row level security;
alter table public.storage_locations enable row level security;
alter table public.tags enable row level security;

create policy retailers_owner on public.retailers
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy storage_locations_owner on public.storage_locations
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy tags_owner on public.tags
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.retailers, public.storage_locations, public.tags to authenticated;
