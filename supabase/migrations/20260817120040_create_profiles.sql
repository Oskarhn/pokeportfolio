-- profiles (DATA_MODEL.md §5.1). One row per auth.users row, created automatically by the
-- handle_new_user trigger below — never inserted directly by a client.
--
-- `is_admin` grants invitation management only (SECURITY.md §4) and is deliberately excluded
-- from the client UPDATE grant below: a user can never set their own is_admin flag. This is
-- enforced at the SQL privilege level, not just by RLS, so it holds even if a future policy
-- mistake widens the USING/WITH CHECK clause.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  locale text not null default 'nb-NO',
  display_currency text not null default 'NOK',
  theme public.theme_preference not null default 'system',
  collection_grid_density smallint not null default 2,
  collection_default_view public.collection_view not null default 'grid',
  low_value_threshold_minor bigint not null default 1000,
  hide_low_value_by_default boolean not null default false,
  default_condition public.card_condition,
  default_language text,
  default_storage_location_id uuid references public.storage_locations (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint profiles_grid_density_range check (collection_grid_density between 1 and 4),
  constraint profiles_threshold_nonnegative check (low_value_threshold_minor >= 0)
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Creates the profile row the moment a new auth.users row is inserted. SECURITY DEFINER so the
-- insert succeeds regardless of which context created the user (the M4 redeem-invitation Edge
-- Function, using the service role, is the only path in the shipped product). search_path is
-- pinned to '' and every reference is schema-qualified, per the Postgres/Supabase linter
-- guidance on search_path hijacking (SECURITY.md checklist, prompt §51).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'auth.users AFTER INSERT trigger: creates the matching profiles row. See SECURITY.md §5.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT or DELETE policy for `authenticated`: rows are created only by handle_new_user
-- (running as the table owner, which bypasses RLS) and removed only by cascading account
-- deletion (SECURITY.md §8), never by a direct client delete.

grant select on public.profiles to authenticated;

-- Column-restricted UPDATE grant: id, is_admin, created_at and disabled_at are never
-- client-writable, at the SQL privilege level, independent of any RLS policy.
grant update (
  display_name,
  locale,
  display_currency,
  theme,
  collection_grid_density,
  collection_default_view,
  low_value_threshold_minor,
  hide_low_value_by_default,
  default_condition,
  default_language,
  default_storage_location_id
) on public.profiles to authenticated;

-- Read helper used by admin-only policies on system tables (invitations). Runs with the
-- caller's own privileges (no SECURITY DEFINER) — a user can already read their own is_admin
-- flag via profiles_select_own, so no elevation is needed.
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

grant execute on function public.is_admin() to authenticated, service_role;

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
grant all on public.profiles to service_role;
