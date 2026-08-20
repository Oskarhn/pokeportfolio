-- Shared catalog: card_series -> card_sets -> cards -> card_variants, plus sealed_products.
-- Ownership class "Shared catalog" (DATA_MODEL.md §1): readable by any authenticated user,
-- writable only by the service role (no INSERT/UPDATE/DELETE policy is granted to `authenticated`
-- at all). See SECURITY.md §3.1.
--
-- Internal uuid identity is canonical; tcgdex_* / cardmarket_* / tcgplayer_* columns are nullable
-- provider mapping metadata (DATA_MODEL.md §3.4), never the primary key.

create table public.card_series (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.card_sets (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.card_series (id),
  slug text not null unique,
  name text not null,
  language text not null,
  card_count_official int,
  card_count_total int,
  released_on date,
  logo_url text,
  symbol_url text,
  tcgdex_set_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index card_sets_tcgdex_set_id_key on public.card_sets (tcgdex_set_id) where tcgdex_set_id is not null;
create index card_sets_series_id_idx on public.card_sets (series_id);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.card_sets (id),
  local_id text not null,
  name text not null,
  rarity text,
  category text,
  illustrator text,
  image_base_url text,
  tcgdex_card_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (set_id, local_id)
);

create unique index cards_tcgdex_card_id_key on public.cards (tcgdex_card_id) where tcgdex_card_id is not null;
create index cards_name_trgm_idx on public.cards using gin (name extensions.gin_trgm_ops);

create table public.card_variants (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  variant_type public.variant_type not null,
  size public.card_size not null default 'standard',
  is_active boolean not null default true,
  tcgdex_variant_id text,
  cardmarket_product_id text,
  tcgplayer_product_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (card_id, variant_type, size)
);

create unique index card_variants_tcgdex_variant_id_key on public.card_variants (tcgdex_variant_id) where tcgdex_variant_id is not null;
create unique index card_variants_cardmarket_product_id_key on public.card_variants (cardmarket_product_id) where cardmarket_product_id is not null;
create unique index card_variants_tcgplayer_product_id_key on public.card_variants (tcgplayer_product_id) where tcgplayer_product_id is not null;
create index card_variants_card_id_idx on public.card_variants (card_id);

-- Sealed products are curated (created_by_user_id is null) or user-added (DATA_MODEL.md §3.3).
-- A user-added row is visible only to its creator until a future promotion process (§11) exists.
create table public.sealed_products (
  id uuid primary key default gen_random_uuid(),
  set_id uuid references public.card_sets (id),
  product_type public.sealed_product_type not null,
  name text not null,
  language text not null,
  pack_count int,
  image_url text,
  cardmarket_product_id text,
  tcgplayer_product_id text,
  created_by_user_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sealed_products_set_id_idx on public.sealed_products (set_id);
create index sealed_products_created_by_idx on public.sealed_products (created_by_user_id) where created_by_user_id is not null;

create trigger card_sets_set_updated_at before update on public.card_sets
  for each row execute function public.set_updated_at();
create trigger cards_set_updated_at before update on public.cards
  for each row execute function public.set_updated_at();
create trigger card_variants_set_updated_at before update on public.card_variants
  for each row execute function public.set_updated_at();
create trigger sealed_products_set_updated_at before update on public.sealed_products
  for each row execute function public.set_updated_at();

-- RLS -------------------------------------------------------------------------------------

alter table public.card_series enable row level security;
alter table public.card_sets enable row level security;
alter table public.cards enable row level security;
alter table public.card_variants enable row level security;
alter table public.sealed_products enable row level security;

create policy card_series_read on public.card_series for select to authenticated using (true);
create policy card_sets_read on public.card_sets for select to authenticated using (true);
create policy cards_read on public.cards for select to authenticated using (true);
create policy card_variants_read on public.card_variants for select to authenticated using (true);

-- Curated rows (created_by_user_id is null) are readable by everyone; user-added rows are
-- readable only by their creator. Writes are restricted to the creator's own rows — a user can
-- never edit a curated row or another user's row.
create policy sealed_products_read on public.sealed_products
  for select to authenticated
  using (created_by_user_id is null or created_by_user_id = (select auth.uid()));

create policy sealed_products_insert_own on public.sealed_products
  for insert to authenticated
  with check (created_by_user_id = (select auth.uid()));

create policy sealed_products_update_own on public.sealed_products
  for update to authenticated
  using (created_by_user_id = (select auth.uid()))
  with check (created_by_user_id = (select auth.uid()));

create policy sealed_products_delete_own on public.sealed_products
  for delete to authenticated
  using (created_by_user_id = (select auth.uid()));

-- Grants ------------------------------------------------------------------------------------
-- No grants to `anon` anywhere in this schema: every screen in the product is authenticated
-- (ARCHITECTURE.md §2), so there is no reason for the anon key to reach any table.
-- Catalog writes are service_role only (service_role is not subject to grants or RLS).

grant select on public.card_series, public.card_sets, public.cards, public.card_variants to authenticated;
grant select, insert, update, delete on public.sealed_products to authenticated;
