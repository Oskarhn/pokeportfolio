-- M9 (DATA_MODEL.md §4.1, prompt §8-9): the shared, market-data price history table. One row per
-- (card_variant, provider, snapshot_date) — never per physical copy (D-019) and never per user:
-- ten users owning the same printing share one snapshot series, exactly like the catalog itself.
--
-- Storage-volume correction from the original DATA_MODEL.md §4.2 sketch (prompt §19-20, recorded
-- in DECISIONS.md): rather than persisting every Cardmarket price_kind (avg/low/trend/avg7/avg30)
-- plus every TCGplayer field for every watched variant every day, the ingest function resolves the
-- FINANCIAL_MODEL.md §6 fallback chain *before* writing and stores only the one winning value per
-- provider per variant per day — `price_kind` records which candidate won, so provenance stays
-- fully auditable without the 5-6x storage multiplier the original sketch implied. This is why the
-- unique key below is `(card_variant_id, provider, snapshot_date)`, not `..., price_kind, ...` as
-- DATA_MODEL.md originally sketched — updated in the same commit as this migration.

create type public.price_provider as enum ('tcgdex_cardmarket', 'tcgdex_tcgplayer');
create type public.price_kind as enum ('cm_trend', 'cm_avg30', 'cm_avg7', 'cm_avg', 'tp_market');

create table public.price_snapshots (
  id bigint generated always as identity primary key,
  card_variant_id uuid not null references public.card_variants (id),
  provider public.price_provider not null,
  price_kind public.price_kind not null,
  source_currency text not null,
  value_minor bigint not null,
  -- The provider's own business date for this observation, not the day we happened to fetch it —
  -- see the ingest function header for why this matters for idempotency (prompt §21).
  snapshot_date date not null,
  provider_updated_at timestamptz,
  retrieved_at timestamptz not null default now(),
  constraint price_snapshots_value_nonnegative check (value_minor >= 0),
  constraint price_snapshots_currency_shape check (source_currency ~ '^[A-Z]{3}$'),
  constraint price_snapshots_kind_matches_provider check (
    (provider = 'tcgdex_cardmarket'
       and price_kind in ('cm_trend', 'cm_avg30', 'cm_avg7', 'cm_avg')
       and source_currency = 'EUR')
    or
    (provider = 'tcgdex_tcgplayer' and price_kind = 'tp_market' and source_currency = 'USD')
  ),
  constraint price_snapshots_unique_per_day unique (card_variant_id, provider, snapshot_date)
);

create index price_snapshots_variant_date_idx
  on public.price_snapshots (card_variant_id, snapshot_date desc);
-- Retention thinning (prompt §63-64) scans by date across all variants.
create index price_snapshots_date_idx on public.price_snapshots (snapshot_date);

alter table public.price_snapshots enable row level security;

-- Market data (DATA_MODEL.md §1): SELECT for any authenticated user, writes only from trusted
-- ingest infrastructure under the service role. No insert/update/delete policy exists for
-- `authenticated` at all — a hostile client cannot poison a shared price, claim a fabricated
-- Cardmarket observation, or overwrite another variant's history (prompt §10).
create policy price_snapshots_read on public.price_snapshots
  for select to authenticated using (true);

grant select on public.price_snapshots to authenticated;
revoke insert, update, delete on public.price_snapshots from authenticated;
revoke all on public.price_snapshots from public, anon;
grant all on public.price_snapshots to service_role;

comment on table public.price_snapshots is
  'Shared market-data price history, one row per (card_variant, provider, day) — the already-chosen '
  'FINANCIAL_MODEL.md §6 fallback candidate, never every raw provider field. Written only by '
  'ingest-prices under the service role.';

-- ── watched_card_variants (DATA_MODEL.md §4.2, prompt §11) ──────────────────────────────────────
--
-- Bounds daily snapshotting to variants that matter: currently owned, plus anything ever legitimately
-- acquired (so a sold or removed card's price history stays intact) — never the full ~47k-variant
-- catalog. `acquisition_lots` existing at all (voided or not) is sufficient: a lot is only ever
-- created through a real acquisition path (add_card_acquisition/create_purchase), so its mere
-- existence is real ownership history, whether the lot was later voided as a correction or as an
-- ordinary disposal-shaped event (M8.1's Remove from Portfolio). Distinguishing "corrected same-day
-- mistake" from "genuine later removal" is not safely decidable from the schema alone (prompt §11's
-- own "if the model can distinguish them safely" — it cannot here), so this errs toward preserving
-- too much history rather than silently destroying a real one; the cost of watching one extra
-- variant is negligible against the cost of losing real price history.
--
-- Service/infrastructure-only (prompt §11's last paragraph): the browser has no legitimate reason
-- to learn which variants are watched, and this view spans holdings across every user — exposing it
-- to `authenticated` would leak "someone on this app owns this card" in aggregate. Only `service_role`
-- (which already bypasses RLS, so it sees every user's holdings the way the ingest job needs to) can
-- read it.

create view public.watched_card_variants
with (security_invoker = true) as
select distinct h.card_variant_id
from public.holdings h
join public.acquisition_lots l on l.holding_id = h.id
where h.card_variant_id is not null;

revoke all on public.watched_card_variants from public, anon, authenticated;
grant select on public.watched_card_variants to service_role;

comment on view public.watched_card_variants is
  'Service-role-only. card_variant_ids ever legitimately acquired by any user — what ingest-prices '
  'is bounded to. Never exposed to a browser-reachable role (prompt §11).';

-- ── price_sync_runs (observability, mirrors catalog_sync_runs, M5) ─────────────────────────────

create table public.price_sync_runs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('prices', 'fx', 'retention')),
  status text not null check (status in ('succeeded', 'failed', 'partial')),
  batch_size int not null default 0,
  cards_fetched int not null default 0,
  variants_considered int not null default 0,
  snapshots_written int not null default 0,
  snapshots_unchanged int not null default 0,
  missing_provider_count int not null default 0,
  ambiguous_mapping_count int not null default 0,
  provider_error_count int not null default 0,
  -- Truncated error text only, never a full payload (prompt §28: "Do not store giant provider
  -- payloads in the database").
  error text,
  started_at timestamptz not null,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

-- Same shape as catalog_sync_runs/invitation_claims: RLS enabled, zero policies, unreachable
-- through the Data API under every role a browser can hold.
alter table public.price_sync_runs enable row level security;
revoke all on public.price_sync_runs from public, anon, authenticated;
grant all on public.price_sync_runs to service_role;

comment on table public.price_sync_runs is
  'Service-role-only ingest observability for ingest-prices/ingest-fx/retention. No provider '
  'payloads stored — counts and a truncated error string only.';
