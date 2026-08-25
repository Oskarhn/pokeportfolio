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
                │ HTTPS, publishable key + user JWT
┌───────────────▼─────────────────────────────────────────┐
│  Supabase (EU West, Paris — see §3)                     │
│  ├ PostgREST      → CRUD, RLS-enforced                  │
│  ├ Auth           → email + password, invite-gated      │
│  ├ Postgres 17    → schema, RLS, constraints, RPC       │
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
- The only true secret is the Supabase secret key, which lives in Edge Functions. The client
  only ever holds the publishable key, which is public by design (SECURITY.md §6).
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
| EU regions | Planned `eu-north-1` (Stockholm), closest to Norway. The development project was actually created in **`eu-west-3` (Paris)** — still EU, so the GDPR posture is unchanged, and roughly 20 ms of latency did not justify recreating it. A future production project should choose deliberately rather than inherit this. |
| Scheduling | `pg_cron` enabled on all plans including Free; `pg_net` for HTTP from SQL |
| Backups | **No automated backups on Free.** Manual `supabase db dump` required. |
| Auth: email + password | Stable. Built-in email limited to 2/hour project-wide, so login must not depend on it. |
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
2. In-app versioned JSON export, **in MVP**, as the user-facing escape hatch. It carries a schema
   version and export timestamp so an export taken today survives future migrations.
3. A periodic in-app reminder to export, because a manual routine nobody performs is not a backup.
4. Schema fully reproducible from `supabase/migrations/`.

No claim of automatic backup appears anywhere in the product.

---

## 4. Authentication and invitations

**Email and password, invite-only, enforced server-side.**

Both email-based alternatives were rejected on mechanical grounds, not preference.

*Magic links:* a link opened from Mail on iOS launches Safari, not the installed PWA. The user
authenticates in a browser context separate from their home-screen app and has to start again.

*Email OTP:* Supabase's built-in email provider allows **2 auth emails per hour, project-wide** —
not per user — and its documentation describes it as unsuitable for production. One login is one
email. Onboarding two people in a single sitting exhausts the quota. Fixing this means adding a
custom SMTP provider to the critical path of every login: another account, another free tier to
depend on, another deliverability failure mode. For a login that could simply not send email,
that is a poor trade.

Password auth sends nothing during normal login. Account creation is gated by an invitation whose
token was delivered out of band, so the account is created already confirmed — a confirmation email
would prove less than the 256-bit secret the person already used, and would spend the mail quota
that password recovery needs.

**Password reset** is the one remaining email path, and it is genuinely rare at this scale — a
handful of events per year against a limit of two per hour. It uses the built-in provider, with
an admin-assisted recovery path documented as the fallback. If reset volume ever becomes a real
constraint, a free SMTP tier can be added at that point; it is not on the critical path today.

Passkeys are deferred: Supabase's implementation is explicitly experimental and requires an
opt-in client flag. Revisit when it stabilises; the auth surface is small enough to extend.

**Invite enforcement.** Supabase's default is open signup. The dashboard/config "disable signup"
toggle is **not** the fix — verified in M3 (docs/PROJECT_JOURNAL.md, 2026-08-20): it disables the
email/password login grant type for every existing user, not only new self-registration, which
would break sign-in for legitimate invited users too.

What closes it instead, as of M4, is two independent server-side gates:

- **The Before User Created auth hook** rejects every self-service account-creation path GoTrue
  exposes. It does not fire for the Auth Admin API, which is the asymmetry the whole design rests
  on — so the hook can deny unconditionally rather than trying to distinguish good signups from
  bad ones.
- **A `BEFORE INSERT` trigger on `auth.users`** demands a live invitation claim. This is
  distinct from `handle_new_user` (AFTER INSERT, M3), which creates the `profiles` row: a single
  AFTER INSERT trigger cannot reject the insert it fires on, which is why there are two.

`redeem-invitation` is the only Edge Function in the system, because account creation is the only
operation that needs the Auth Admin API. Issuing and revoking invitations are Postgres RPCs — the
one privileged thing they do is generate a token, which Postgres does natively, and an Edge Function
would have added a deployment surface and a secret to protect for nothing.

Full detail in [SECURITY.md](SECURITY.md) §5.

### 4.1 Scale: all-card tracking

Every physical card is individually tracked, so a user may reach 10 000+ lots. The architectural
consequences are decided here rather than discovered later:

| Concern | Response |
|---|---|
| Price history | Keyed per `card_variant`, never per copy. Volume scales with distinct printings owned, which plateaus. ~105 MB/year against a 500 MB ceiling. |
| Collection queries | Keyset pagination server-side, virtualisation client-side. Never a full fetch. |
| Images | Lazy-loaded, sized to the current grid density, served from the provider CDN. |
| Portfolio figures | Read from `portfolio_snapshots`, so dashboard cost is near-independent of collection size. |
| Grouped display | Quantity on one row, not N rows. A display concern, not a storage one. |

The binding free-tier constraint is price history, and price history is decoupled from collection
size. That is what makes tracking every energy card viable at zero cost.

---

## 5. Data ingestion

Three scheduled jobs (M9, `20260826120050_m9_cron_schedule.sql`), all `pg_cron` entries; the two
that call an Edge Function do so via `pg_net`, reading the bearer secret from Supabase Vault at
call time rather than a literal in the schedule.

| Job | Schedule | Work |
|---|---|---|
| `ingest-prices` | every 15 minutes | `select_price_sync_batch` (oldest-last-synced-first, bounded) → dedup by `cards.id` → fetch TCGdex → variant-safe map → upsert `price_snapshots` |
| `ingest-fx` | 17:00 UTC daily | Norges Bank EXR API → `fx_rates` for EUR, USD → NOK (well after Norges Bank's ~16:00 CET publication) |
| `thin_price_snapshots` (retention) | weekly, Sunday 03:00 UTC | A plain SQL command, no Edge Function/HTTP round trip |

`ingest-prices` runs frequently and in small batches rather than once daily — Edge Functions have a
wall-clock budget, and ~3,000-4,000 watched variants do not fit one invocation. At batch size 200
this cycles the whole watched set roughly once a day with comfortable margin, one variant refreshing
again only once its snapshot becomes the oldest in the queue. GBP is not ingested — nothing in the
current product needs it, and adding an unused currency to a scheduled job would just be cost with
no consumer.

All three jobs are idempotent — a re-run for the same provider observation upserts onto the same
`(card_variant_id, provider, snapshot_date)` row rather than fabricating a new day's fact
(DATA_MODEL.md §4.2's idempotency note). `ingest-prices` records partial failures per card rather
than aborting the batch, and never writes a zero price on failure — the last known snapshot is
simply left untouched, aging into `stale` then `missing` (F9). Run observability for all three
lives in `price_sync_runs` (service-role-only, same shape as `catalog_sync_runs`).

An on-demand fourth path, `search-prices` (Edge Function, user-JWT-gated), answers Search/Card
Detail's "what does this cost right now" for catalog cards the user has not necessarily acquired —
it never persists to `price_snapshots`; only the scheduled `ingest-prices` job produces history
(DATA_MODEL.md §4.2).

**M12 adds the snapshot-recompute pair** (`20260830120040_m12_cron.sql`, D-064), plain SQL
commands against same-database functions — no HTTP, no secret:

| Job | Schedule | Work |
|---|---|---|
| `m12-recompute-snapshots` | every minute (D-082) | `drain_portfolio_recompute_queue(20)` — bounded, SKIP LOCKED, per-user failure isolation |
| `m12-daily-snapshot-sweep` | 05:11 UTC daily | `enqueue_portfolio_daily_maintenance()` — current-date snapshot guarantee for every user with data |
| `m12-run-log-prune` | 04:33 UTC daily (D-082) | deletes `portfolio_recompute_runs` older than 30 days — bounds the run log now that ticks are minutely |

The original :07/:22/:37/:52 schedule deliberately trailed M9's */15 ingest ticks so a freshly
ingested price batch was consumed on the NEXT tick. P42 replaced it with an every-minute drain
(D-082): after an owner mutation, Home's "Updating…" state now settles within about a minute
plus one poll tick instead of up to fifteen. Measured cost basis: hosted no-op ticks complete in
~0.0 s; the drain is bounded and SKIP LOCKED, so a slow rebuild never collides destructively
with the next tick. The nightly prune keeps the resulting run-log growth (~1 440 tiny rows/day)
bounded at 30 days of history. The daily sweep is what still keeps "current" honest on a quiet
weekend when neither transactions nor prices move (prompt §50). All entries are part of the
migration set and therefore reach a project only through `supabase db push` — never applied by
anything automatic.

The dashboard read path is four bounded SECURITY INVOKER RPCs
(`20260830120030_m12_dashboard_reads.sql`) served from the cache plus small live aggregates;
Home never recomputes portfolio history on page load (UX_FLOWS.md F10). The chart library is
lazy-loaded in its own chunk and only mounts once history has ≥2 covered points (D-066).

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

**M5 implements the catalog half.** `supabase/functions/_shared/tcgdex.ts` is the
`CardCatalogProvider` adapter — hand-rolled explicit validators rather than a schema library,
proportionate to the ~10 fields actually read out of a much larger provider payload. `supabase/
functions/sync-catalog` ingests one `(language, set)` per invocation (bounded by the Edge Function
wall-clock budget, D-035's rationale for why it is operator-triggered rather than a browser-facing
admin action), and `scripts/run-catalog-sync.mjs` drives a full sync set-by-set with backoff and
pacing. `public.search_cards(...)` is the read side — a `SECURITY INVOKER` Postgres function, not a
service, since the app's own database already holds everything a search needs (M5 prompt §6: the
product never calls TCGdex live for an ordinary search). See API_SOURCES.md's "Catalog ingest
strategy" and DATA_MODEL.md §3.3a for the shapes.

**M9 implements the pricing half inside the same adapter, not a separate `MarketPriceProvider`
module.** `_shared/tcgdex.ts#fetchCardPricing` extends the existing catalog adapter (same file,
same "everything about TCGdex's shape lives here" boundary) rather than a new interface — pricing
and catalog data arrive in the same TCGdex response, so splitting them into two provider objects
would mean fetching the same payload twice or threading it through an extra layer for no real
decoupling benefit at the current one-provider scale. The variant-safe mapping rules (embedded
per-variant pricing preferred; card-level fallback only when unambiguous; ambiguous → no price) are
documented in the file's own header, evidenced by real captured payloads in
`tests/data/tcgdex-pricing.test.ts`. `FxRateProvider` is realized directly as `_shared/norges-bank.ts`,
unchanged since M8 and reused by `ingest-fx` without modification.

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
bundle size for two chart types. **The M12 spike validated `lightweight-charts` v5.2.1 and it is
now locked in (D-066)**: Apache-2.0 with its attribution implemented (NOTICE + visible link +
built-in logo), 62 KB gzip in a lazy chunk that loads only once history has ≥2 covered points,
whitespace gap items for honest missing-coverage rendering, theme re-application without reload,
and canvas performance comfortably above this product's scale. The `visx` fallback was never
needed and remains uninstalled. Card Detail's small M9 SVG price chart stays as-is — a full
chart library there would be weight without benefit.

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

**Cloudflare Pages, Free plan, no payment method.** Static SPA build, unlimited bandwidth,
commercial use permitted, no egress billing. Vercel Hobby was rejected on its non-commercial
restriction.

Git-connected: Cloudflare builds `main` on merge, so the deployed development app is whatever last
passed CI and review. Build command `pnpm build`, output `dist`, and the only environment variables
are the two browser-safe Supabase values that ship in the bundle anyway. Preview deployments are
off — one branch, one deployment. No custom domain; the provider URL is the URL.

The Cloudflare build carries **no secret of any kind.** The Supabase secret key and the database
password live in the Supabase platform and the owner's password manager respectively, and neither
has any business in a frontend build.

**SPA routing** needs no configuration: Pages serves `index.html` for unmatched paths when the
output has no top-level `404.html`, which a Vite build does not produce. `/invite/<token>` therefore
resolves on a cold load, before any service worker exists.

**Security headers** are emitted as `_headers` by a small plugin in `vite.config.ts` rather than
checked in, so the `connect-src` in the Content-Security-Policy is derived from the
`VITE_SUPABASE_URL` the bundle was actually built against and cannot drift from it. The policy is
`script-src 'self'` with no inline script — the build emits none — plus `'unsafe-inline'` for style
*attributes*, which the safe-area padding needs. `_headers` is ignored by `vite dev` and
`vite preview`, so the policy is exercised on the deployment and has to be verified there.

Cloudflare's own default `Access-Control-Allow-Origin: *` on Pages assets is left alone
deliberately. Everything served from this origin is the public bundle, and no credential lives
here — the Supabase session is in `localStorage`, which CORS cannot reach, and there are no cookies
on this domain. Removing it would buy nothing and risks the kind of manifest or font fetch that
quietly needs it. The service worker precaches the static shell and registers exactly one route, a
navigation fallback to `index.html`; there is no `runtimeCaching` rule, so no Supabase response is
ever written to a cache.

CI (GitHub Actions): install → typecheck → lint → unit tests → build → E2E → secret scan, plus an
ephemeral Postgres job for migrations, privileges and authorization. **No remote credential appears
in CI at all** — not Supabase's, not Cloudflare's. Migrations, `config push` and function deploys
are deliberate acts through the Supabase CLI, never automatic.

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
