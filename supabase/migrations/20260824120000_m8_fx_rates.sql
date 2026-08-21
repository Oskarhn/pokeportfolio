-- fx_rates: the Norges Bank exchange-rate cache (DATA_MODEL.md §4.3, FINANCIAL_MODEL.md §7).
-- Market data class (DATA_MODEL.md §1): global facts, read for any authenticated user, written
-- only by service-role infrastructure (the fetch-fx-rate Edge Function) — never directly by a
-- client, so one user's session can never poison another user's frozen conversion. A user's own
-- manual FX override is never written here; it lives entirely on their own `purchases` row
-- (fx_source = 'manual'), exactly as FINANCIAL_MODEL.md §7 already specifies.

create table public.fx_rates (
  id bigint generated always as identity primary key,
  base_currency text not null,
  quote_currency text not null,
  rate_date date not null,
  rate numeric(18, 8) not null,
  source public.fx_source not null,
  retrieved_at timestamptz not null default now(),
  constraint fx_rates_currency_shape check (
    base_currency ~ '^[A-Z]{3}$' and quote_currency ~ '^[A-Z]{3}$'
  ),
  constraint fx_rates_rate_positive check (rate > 0),
  constraint fx_rates_unique_observation unique (base_currency, quote_currency, rate_date, source)
);

create index fx_rates_lookup_idx on public.fx_rates (base_currency, quote_currency, source, rate_date desc);

alter table public.fx_rates enable row level security;

create policy fx_rates_read on public.fx_rates
  for select to authenticated using (true);
-- no insert/update/delete policy: writes are service_role only, same shape as price_snapshots.

grant select on public.fx_rates to authenticated;
grant all on public.fx_rates to service_role;
