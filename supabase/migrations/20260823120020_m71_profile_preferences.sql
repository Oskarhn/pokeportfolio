-- M7.1 (prompt §19/§56): two new profile preferences.
--
-- `hide_values`: the Home/Portfolio value-privacy "eye" toggle. Persisted so the choice survives a
-- reload, same reasoning as every other display preference on this table. Purely a display
-- concern — it never changes what is computed, only whether an already-honest figure or its
-- "••••" mask is what gets rendered (src/ui/MoneyDisplay.tsx). Defaults to visible.
--
-- `use_eu_pricing`: "use European pricing when available" — stored now, ahead of M9's price
-- resolver, per D-038's established pattern of shipping a preference/enum value before its
-- consuming milestone exists rather than making the user wait. Defaults true: the product's own
-- FX/pricing plan is Europe/Norway-oriented (Cardmarket EUR via TCGdex, Norges Bank FX — see
-- ARCHITECTURE.md). Genuinely inert until M9 — no code path reads it yet — and the Profile UI says
-- so rather than implying it already changes a value.

alter table public.profiles
  add column hide_values boolean not null default false,
  add column use_eu_pricing boolean not null default true;

grant update (hide_values, use_eu_pricing) on public.profiles to authenticated;
