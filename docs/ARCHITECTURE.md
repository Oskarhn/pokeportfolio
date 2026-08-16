# Architecture

Selected stack and the reasoning behind each choice. Decisions with lasting consequences are
also logged in [DECISIONS.md](DECISIONS.md).

---

## 1. Shape of the system

```
┌─────────────────────────────────────────────────────────┐
│  Client — React SPA (installable PWA)                   │
│  Vite · TypeScript · TanStack Router/Query · Tailwind   │
│  Domain layer (pure TS): financial engine, allocators   │
└───────────────┬─────────────────────────────────────────┘
                │ HTTPS, anon key + user JWT
┌───────────────▼─────────────────────────────────────────┐
│  Supabase (EU North, Stockholm)                         │
│  ├ PostgREST      → CRUD, RLS-enforced                  │
│  ├ Auth           → email OTP, invite-gated             │
│  ├ Postgres 15    → schema, RLS, constraints, RPC       │
│  ├ Storage        → images (V1)                         │
│  ├ Edge Functions → ingest jobs, invite redemption      │
│  └ pg_cron+pg_net → daily scheduling                    │
└───────────────┬─────────────────────────────────────────┘
                │ server-side only
     ┌──────────┴──────────┬─────────────────┐
     ▼                     ▼                 ▼
  TCGdex API          Norges Bank        (future price
  cards, variants,    EXR SDMX API        providers)
  CM/TP prices        EUR·USD·GBP→NOK
```

Static assets deploy to **Cloudflare Pages**. There is no application server of our own.

---

## 2. Client: Vite + React SPA, not a meta-framework

**Chosen:** Vite 7 · React 19 · TypeScript strict · TanStack Router · TanStack Query.

The decisive question was whether server-side rendering buys this application anything.
It does not:

- Every screen is behind authentication and fully personalised. There is no cacheable,
  crawlable, or shareable server-rendered content.
- The backend is Supabase. Server components would mostly proxy PostgREST calls that the
  client can make directly, with RLS enforcing the same rules either way.
- The only true secret is the Supabase `service_role` key, which lives in Edge Functions.
  The client only ever holds the anon key, which is public by design.
- The scanner will be a long-lived, camera-holding, WebGPU-inferencing client surface.
  A pure client router gives exact control over what unmounts and when — see §6.
- Static output deploys anywhere. No hosting lock-in, no non-commercial licence clause.

**Rejected: Next.js.** Adds RSC, hydration boundaries, a build-time/runtime split and effective
coupling to a hosting model, in exchange for SSR we cannot use and server actions that duplicate
PostgREST. Its Hobby tier is also non-commercial, which is an awkward footnote for a repository
intended as a portfolio piece.

**Rejected: TanStack Start / React Router framework mode.** Both are credible, but both are
full-stack framings of a problem that is already client-plus-BaaS. Start's throughput advantage
is irrelevant for a ten-user app.

**TanStack Router over React Router** for typed routes and search params — the collection view
has substantial filter state that belongs in the URL and benefits from compile-time safety.
Its explicit control over route masking and component lifetime also matters for the scanner.

### Layering

```
src/
  domain/        pure TypeScript. Money, allocation, valuation, all FINANCIAL_MODEL formulas.
                 Zero imports from React or Supabase. 100% unit-testable, no mocks.
  data/          Supabase client, typed queries, TanStack Query hooks, provider adapters.
  features/      Vertical slices: collection, purchases, openings, sales, dashboard, scanner.
  ui/            Design-system components. No business logic.
  routes/        TanStack Router route definitions.
```

> **Rule:** no monetary arithmetic outside `domain/`. Components read numbers and format them;
> they never compute them. This is what makes FINANCIAL_MODEL testable in one place.

---

## 3. Backend: Supabase

**Chosen** for the combination of managed Postgres with RLS, an auth service that issues JWTs
Postgres can read, scheduled jobs inside the database, and a free tier that covers this scale.

Verified facts driving the choice (see [RESEARCH.md](RESEARCH.md) for sources and dates):

| Capability | Status |
|---|---|
| Free plan | 500 MB DB, 1 GB storage, 5 GB egress, 50 000 MAU, 2 active projects |
| Project pausing | Free projects pause after ~7 days without database activity; manual resume; restorable within 90 days |
| EU regions | `eu-north-1` (Stockholm) selected — closest to Norway |
| Scheduling | `pg_cron` enabled on all plans including Free; `pg_net` for HTTP from SQL |
| Backups | **No automated backups on Free.** Manual `supabase db dump` required. |
| Auth: email OTP | Stable |
| Auth: passkeys | Experimental, requires opt-in flag — not an MVP dependency |

**Escape path.** The database is plain PostgreSQL. The only Supabase-specific surfaces are
`auth.users`, `auth.uid()` in policies, Storage, and Edge Functions. A migration to any Postgres
host requires replacing the auth integration and re-homing the two cron jobs — days of work,
not a rewrite. Schema lives in versioned SQL migrations in this repository, never applied by
hand through a dashboard.

**Alternative considered: Neon + a separate auth provider + a separate scheduler.**
Better raw Postgres ergonomics and branching; worse integration, three vendors instead of one,
and RLS would need JWT plumbing built by hand. Rejected for this scale.

### Backup posture

Free-tier reality is that nobody is backing this up for us. The mitigation is layered:

1. `supabase db dump` run manually before every migration and after significant data entry.
2. In-app JSON export (V1) as the user-facing escape hatch.
3. Schema fully reproducible from `supabase/migrations/`.

No claim of automatic backup appears anywhere in the product.

---

## 4. Authentication and invitations

**Email OTP (six-digit code), invite-only, enforced server-side.**

Magic links were rejected for the primary flow on a specific mechanical ground: a link opened
from Mail on iOS launches Safari, not the installed PWA. The user then authenticates in a
browser context separate from their home-screen app and has to return and repeat. A six-digit
code keeps the entire flow inside the installed app.

Passkeys are deferred: Supabase's implementation is explicitly experimental and requires an
opt-in client flag. Revisit when it stabilises; the auth surface is small enough to extend.

**Invite enforcement.** Supabase's default is open signup. Disabling signup in the dashboard is
necessary but not sufficient, so:

- Dashboard signup is disabled.
- Account creation happens only through a `redeem_invitation` Edge Function that validates the
  token hash, expiry, use count and revocation, then creates the user with the service role.
- A `handle_new_user` trigger creates the `profiles` row and rejects any `auth.users` insert
  lacking a valid redemption record.

Full detail in [SECURITY.md](SECURITY.md).

---

## 5. Data ingestion

Two scheduled jobs, both Edge Functions invoked by `pg_cron` via `pg_net`.

| Job | Schedule | Work |
|---|---|---|
| `ingest-fx` | 17:00 CET daily | Norges Bank EXR API → `fx_rates` for EUR, USD, GBP → NOK |
| `ingest-prices` | 09:00 CET daily | Read `watched_card_variants`, fetch TCGdex in batches, write `price_snapshots`, then recompute dirty `portfolio_snapshots` |

Ordering matters: prices run after TCGdex's own ~08:03 UTC refresh; FX runs after Norges Bank's
~16:00 CET publication.

Both jobs are idempotent — a re-run for the same date upserts on the natural key. Both record
partial failures per variant rather than aborting the batch, and neither ever writes a zero
price (F9).

Legitimate daily activity keeps the Supabase project from idling. This is a side effect of work
the app genuinely needs, not a heartbeat contrived to game the free tier, and the app must still
behave sanely against a paused project during development.

### Provider abstraction

```ts
interface CardCatalogProvider {
  listSets(language: Language): Promise<CatalogSet[]>
  getSet(providerSetId: string): Promise<CatalogSetDetail>
  searchCards(query: CardQuery): Promise<CatalogCard[]>
}

interface MarketPriceProvider {
  readonly id: ProviderId
  fetchPrices(refs: VariantRef[]): Promise<PriceObservation[]>
}

interface FxRateProvider {
  fetchRates(base: CurrencyCode, quotes: CurrencyCode[], on: DateOnly): Promise<FxObservation[]>
}
```

Adapters translate provider shapes into canonical types at the boundary. No business or UI code
references `tcgdex`, `cardmarket.trend` or any provider field path. Deliberately three small
interfaces, not a plugin framework.

---

## 6. PWA and the scanner constraint

`vite-plugin-pwa` with Workbox. Precache the app shell; runtime-cache catalog reads with
stale-while-revalidate; **never** cache authenticated financial data in the service worker —
that data lives in TanStack Query's in-memory cache and is refetched on focus.

Offline scope for MVP: the shell loads, cached catalog data renders, and mutations fail with a
clear message. No offline mutation queue, no conflict resolution. That is a large, bug-prone
subsystem and there is no evidence yet that it is needed.

**iOS camera lifecycle.** WebKit re-prompts for camera permission on URL changes inside a
standalone PWA (webkit.org bug 215884, still open). The architectural response, decided now so
it is not retrofitted later:

- The scanner is a single route that owns its `MediaStream` for the whole session.
- Card confirmation happens in an **overlay within that route** — no navigation, no route change,
  no hash mutation, per-card.
- Filter and session state during scanning is component state, not URL state.
- The stream is acquired once on entry and released once on exit.

The scanner is not built in this phase, but the routing shape that allows it is fixed now.

---

## 7. UI system

**Tailwind CSS v4 + shadcn/ui on Base UI primitives.**

shadcn/ui is not a dependency — components are copied into `src/ui/` and owned outright. That
matters here for two reasons: it removes the "default component library" look this project
explicitly rejects, and it means no upstream release can restyle the app.

Base UI over Radix: shadcn/ui defaults to Base UI for new projects as of July 2026, Base UI
reached 1.0 in December 2025, and it is the more actively maintained primitive layer. Radix
remains available for the few components Base UI lacks.

**Charts: TradingView `lightweight-charts` (Apache 2.0).** Canvas-rendered, explicitly
touch-optimised, purpose-built for financial time series, and small. It provides area series
for portfolio value and histogram series for monthly spend, which covers both time-indexed
charts. Category breakdowns and sparklines are plain SVG/CSS — no second chart library.

Recharts was rejected: SVG-per-point performance degrades on multi-year daily series, and its
visual defaults are the exact generic dashboard aesthetic to avoid. ECharts was rejected on
bundle size for two chart types. A spike during the dashboard milestone validates
`lightweight-charts` before it is locked; the fallback is `visx`.

---

## 8. Testing

| Layer | Tool | Scope |
|---|---|---|
| Domain | Vitest | Every formula and invariant in FINANCIAL_MODEL. No mocks, no DB. |
| Property | Vitest + fast-check | Allocator: sums exactly, deterministic, never negative (F6). |
| Database | Vitest against local or dev Supabase | Constraints, triggers, lifecycle transitions. |
| Authorization | Vitest, two authenticated clients | User A cannot read/write/delete User B's rows, including via joins. |
| E2E | Playwright | Auth, purchase entry, collection, sale, dashboard. Mobile viewport included. |

Financial and authorization tests are mandatory gates. See [TESTING.md](TESTING.md).

---

## 9. Deployment

**Cloudflare Pages.** Static SPA build, unlimited bandwidth on the free plan, commercial use
permitted, no egress billing. Vercel Hobby was rejected on its non-commercial restriction.

CI (GitHub Actions, added once the application scaffold exists): install → typecheck → lint →
unit tests → build → secret scan. Migrations are applied deliberately via the Supabase CLI, not
automatically from CI.

---

## 10. Future native clients

A SwiftUI or Android client would talk to the same Supabase project: same PostgREST endpoints,
same RLS policies, same JWTs. No web-specific server sits in the path, so no API layer has to be
built or duplicated.

The one piece that would need porting is `src/domain/`. It is deliberately pure TypeScript with
no runtime dependencies, so the formulas are readable and re-implementable, and
FINANCIAL_MODEL.md plus its test fixtures serve as the specification. No native work happens now.

---

## 11. Rejected wholesale

| Option | Why not |
|---|---|
| Custom Node/Express backend | Reimplements auth, RLS and PostgREST for no gain at this scale |
| Event sourcing for the ledger | Enormous complexity; normalised tables with explicit disposal rows already give full provenance |
| Client-side price fetching | Would put rate-limit pressure on TCGdex per user and produce inconsistent snapshots |
| Monorepo | One deployable app; workspace tooling would be pure overhead |
| GraphQL | One consumer, one schema, PostgREST already generates typed access |
