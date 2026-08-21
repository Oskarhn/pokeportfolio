# Testing Strategy

Written before implementation so that autonomous work has a target rather than a retrofit.

Two suites are **mandatory gates**: the financial suite and the authorization suite. A milestone
that touches money or ownership is not complete until both pass.

---

## 1. Layers

| Layer | Tool | Needs | Runs |
|---|---|---|---|
| Domain unit | Vitest | Nothing | Every commit, every push |
| Property | Vitest + fast-check | Nothing | Every commit |
| Database | Vitest + Supabase | Local Supabase (Docker) or a dev project | Before merge, before migration |
| Authorization | Vitest, two authenticated clients | Same | Before merge |
| Component | Vitest + Testing Library | jsdom | Every commit |
| E2E | Playwright | Running app + seeded dev database | Before milestone completion |

**Compilation is not evidence.** A feature is complete when its behaviour has been exercised,
not when TypeScript accepts it.

---

## 2. Financial suite — mandatory

Lives in `tests/financial/`. Pure functions from `src/domain/`. No database, no mocks, no
network. This is the suite that must be trustworthy above all others.

### 2.1 Worked examples as fixtures

Every example in [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) §8 becomes a test with the same
identifier, asserting every metric in its table:

| Test | Covers |
|---|---|
| `E1` | Single purchase, unrealized result |
| `E2` | Three lots, one sold, specific-lot selection, `TTEP = URC + RRC` when all lots are costed |
| `E3` | Mixed receipt, pro-rata shipping allocation, `GPO = CS + HS` |
| `E4` | Opening a sealed product; collectible spend unchanged; pulls with `NULL` basis |
| `E5` | Selling a pull; proceeds not counted as profit; opening return |
| `E6` | Grading costs as lot adjustments; manual valuation; grading delta |
| `E7` | Partial sale from a multi-unit lot; frozen `cost_basis_at_sale` |
| `E8` | Manual valuation replacing a missing provider price |
| `E9` | Stale price retained and flagged; never zeroed |
| `E10` | Foreign-currency purchase with frozen NOK conversion |
| `E11` | Pre-tracking card: `unknown` cost state; sold later shows proceeds and result **—** |
| `E12` | Gift: `not_paid` state; sold later shows proceeds, not profit |
| `E13` | Provisional opening purchase, then reconciliation — spend counted exactly once |
| `E14` | Trade: cash legs counted, item legs produce no realized result |
| `E15` | Collection with unpriced cards: excluded from value, counted in `UHC`, retained in card count |

If a formula changes, the document and these tests change together. A test that no longer matches
the document is a documentation bug, not a test to be adjusted quietly.

### 2.2 Invariants

One test per entry in the FINANCIAL_MODEL invariant register:

| ID | Assertion |
|---|---|
| M1 | No code path writes `0` where `NULL` is meant |
| M2 | `unit_cost_basis_minor IS NOT NULL` iff `cost_basis_state = 'known'`, over every origin |
| F1 | `GPO = CS + HS` over randomised purchase sets |
| F2 | Buyer-paid shipping only offsets seller cost |
| F3 | `CMV = ACMV + UMV` |
| F4 | **A price update never mutates a cost-basis column.** Apply a full price refresh over a seeded portfolio; assert every cost basis byte-identical. |
| F5 | `RRC + PUD = NSP − Σ cost_basis_at_sale` |
| F6 | Allocations sum exactly to the total (property test, §2.3) |
| F7 | Every lot cost adjustment references a purchase line |
| F8 | No aggregate sums opening return with `TTEP` (static check plus review) |
| F9 | Simulated provider outage: values retained, states age, nothing reaches zero |
| F10 | A graded holding with no manual valuation resolves to `missing`, never to a raw price |
| F11 | Recomputing after an FX change leaves historical NOK amounts unchanged |
| F12 | An opening never has two live cost sources; reconciliation does not double-count spend |
| F13 | No trade produces a realized P/L figure |
| F14 | A holding with no resolvable value is excluded from `CMV` and counted, never zeroed |

### 2.4 All-card tracking

The requirement that every physical card is trackable creates a class of case that a
valuable-cards-only model would never hit.

| Test | Assertion |
|---|---|
| Basic Energy | Can be found in the catalog, added, and appears in the collection as an ordinary card |
| Card with no market price | Can be added; excluded from `CMV`; counted in `UHC`; still counted as a physical card |
| Provider price of genuinely 0.00 | Stored and used as zero with `price_state = 'fresh'` — **not** conflated with a missing price |
| 80 identical energies | One holding, quantity 80, **one** price-snapshot row per day (D-019) |
| Physical vs unique count | Both computed; 80 energies contribute 80 to one and 1 to the other |
| Low-value filter | Matches on current resolved value; updates when the price moves; never materialised as membership |
| Low value vs no price | A card with no price never appears in the low-value filter |
| Hidden low-value cards | Still counted in totals and still contributing value; hiding is display-only |

### 2.5 Cost-basis states

| Test | Assertion |
|---|---|
| Purchased, cost known | `known`; contributes to `DCB` and `URC` |
| Purchased, cost explicitly unknown | `unknown`; no amount stored; contributes to `UMV` and `ULC` |
| Pulled | `unallocated_opening`; no cost field rendered; no per-card ROI available |
| Gifted | `not_paid`; distinct from `unknown` in both storage and UI copy |
| Traded in | `trade_in`; contributes to `UMV` |
| Sold with unknown basis | Result is `NULL`, rendered **—**; contributes to `PUD`, not `RRC` |
| Sort by result | Unknown-basis rows group separately; never sort as infinite profit |

### 2.6 Organisation and settings

| Test | Assertion |
|---|---|
| Collection membership | Adding or removing changes no financial figure |
| Delete a collection | Membership rows removed; every holding intact (C1) |
| Multi-membership | One holding in three collections behaves correctly in each |
| Grid density | Default 2; settable 1–4; persists across sessions |
| Per-user settings | Two users have independent density, threshold and theme |
| Threshold change | Low-value filter results change immediately; no data is rewritten |

### 2.3 Property tests

The allocator is the highest-risk pure function in the system — it runs on every purchase and
every sale, and an off-by-one øre compounds silently.

```
∀ total ≥ 0, ∀ weights (non-empty, non-negative):
  Σ allocate(total, weights) === total          // exact, no drift
  allocate is deterministic for identical input
  every allocated part ≥ 0
  weights of 0 receive 0 unless total must be distributed to them
  a single weight receives the entire total
```

Also property-tested: minor-unit conversion round-trips; `quantity_remaining` never goes
negative under arbitrary disposal sequences.

---

## 3. Ownership timeline tests

Portfolio history is reconstructable from transactions (FINANCIAL_MODEL §3). That claim needs
proving, not asserting.

| Scenario | Expected |
|---|---|
| Card acquired day 30, priced from day 1 | Contributes 0 on days 1–29 |
| Card sold day 100 | Contributes 0 from day 100 onward; days 30–99 unchanged |
| Purchase backdated today to day 20 | History from day 20 changes — correctly |
| Price for day 40 corrected | Day 40 value changes; no other day moves |
| Full rebuild vs incremental recompute | **Byte-identical output.** The snapshot cache can never diverge from canonical transactions. |

The last row is the one that catches cache drift, which is the failure mode that makes a
dashboard quietly lie.

---

## 4. Authorization suite — mandatory

Lives in `tests/authorization/`. Real users, real authenticated Supabase clients, every assertion
against the live API — not against application code that could be bypassed.

Fixture users are created the way the `redeem-invitation` function creates them: issue an
invitation, claim it, create the user through the Auth Admin API, record the redemption. Since M4
that is the only way, for anyone — the S2 trigger rejects an Auth Admin insert with no claim just as
it rejects a public signup. Every step of that route needs the secret key, which is exactly why a
browser cannot walk it.

For every user-private table:

| Attack | Expected |
|---|---|
| A reads B's row by id | Empty result, not an error leak |
| A updates B's row by id | 0 rows affected |
| A deletes B's row by id | 0 rows affected |
| A inserts a row with `user_id = B` | Rejected by `WITH CHECK` |
| A updates their own row, setting `user_id = B` | Rejected by `WITH CHECK` |
| A inserts a child row pointing at B's parent | Rejected by trigger (S1) |
| A reads B's data through an embedded resource (`/purchases?select=*,purchase_lines(*)`) | No B rows |
| A reads B's data through an RPC with B's id as an argument | Rejected |
| A enumerates `profiles` | Only own row |
| A reads B's Storage objects | Denied (once storage exists) |

Plus invite-only enforcement (`tests/authorization/invite_only.test.ts`). Every row here is a
named test, and the ones that matter most are the ones a weaker design would pass:

| Attack | Expected |
|---|---|
| `signUp` for an address nobody invited | Rejected by the hook, with an invite-only message |
| **`signUp` for an address that holds a valid outstanding invitation** | **Rejected — and the invitation still works for the real invitee afterwards, with their password, not the attacker's** |
| `signUp` carrying forged `user_metadata` claiming an invitation | Rejected |
| Hand-built `/auth/v1/signup` body with `app_metadata`, `role: service_role` | Rejected |
| Auth Admin `createUser` with no invitation claim | Rejected by the S2 trigger — this is the test that fails if the trigger is dropped |
| Redeem a token nobody issued, or one altered by a character | Rejected |
| Redeem an expired invitation | Rejected |
| Redeem a revoked invitation | Rejected |
| Replay a token that already worked | Rejected; still exactly one redemption row |
| Redeem with an attacker's address in the request body | Ignored; the account is the invited address, and no account exists for the attacker's |
| Redeem with a password below the policy | Rejected, **and the invitation is still usable** |
| Two redemptions of one invitation in flight at once | Exactly one account, one redemption row, `use_count` of 1 |
| Guess a token | Infeasible: 256 bits, and only the hash is stored |
| Read `token_hash` as an admin, by column or by `*` | Refused at the SQL privilege level |
| Insert an invitation row directly to plant a chosen hash | Refused; no write grant |
| Call `claim_invitation` / `finalize` / `release` as a user **or as an admin** | Refused; service role only |
| Read `invitation_claims` from any session | Nothing; no policy, no grant |
| Set `is_admin` on your own profile | Refused; column has no client UPDATE grant |
| Admin reads another user's purchases, holdings or lots through the app API | Denied — `is_admin()` grants no data access |

**The suite is proven, not assumed.** Both gates were deliberately disabled on a throwaway branch
and CI was watched to fail on the named tests, before being reverted — the same technique M3 used
on an RLS policy. A security assertion nobody has watched fail is a security assertion nobody has
tested. See PROJECT_JOURNAL.md.

The suite is written table-driven so adding a table means adding a row, not a file. A new
user-private table without an entry fails a meta-test that compares the table list against the
covered list.

**M7 (`tests/authorization/m7_portfolio.test.ts`, `tests/db/m7_constraints.test.ts`).**
`custom_collections` fits the generic owned-table attack matrix and is folded into it; what needs
its own coverage is `custom_collection_members` (ownership depends on *two* parent rows, like
`holding_tags`) and the `list_portfolio`/`portfolio_counts` RPCs, which have no `user_id` argument
to forge — every predicate derives from `auth.uid()`. Tested there: a stranger cannot read, insert
into or delete membership from another user's collection either direction (their holding into the
stranger's collection, or the stranger's holding into their own collection); `list_portfolio` never
returns another user's rows; sort correctness (`name_asc` actually sorts alphabetically); filter
correctness (favourite, custom collection); and keyset-pagination completeness (walking the cursor
one row at a time returns every matching holding exactly once, in the same order as a single large
page). Invariant C1 (deleting a collection touches no holding/lot) is asserted directly against the
service-role client in the `tests/db/` file, matching the existing C1-style pattern in
`tests/db/m6_constraints.test.ts`.

**M6 (`tests/authorization/m6_collection.test.ts`, `tests/db/m6_constraints.test.ts`).** The
generic table-driven attack matrix above covers `manual_card_definitions` (folded into
`simple-owned-tables.test.ts` — its shape is uniform enough to fit) but not `holding_tags` or
`manual_valuations`, whose ownership depends on *two* parent rows rather than one, or the
`add_card_acquisition`/`void_acquisition_lot` RPCs, which have no `user_id` argument to forge in
the first place — every write derives its owner from `auth.uid()` inside the function body
(SECURITY INVOKER). What is tested there instead: the RPC's resulting rows always belong to the
caller regardless of what else is asked for; a caller-supplied `storage_location_id` or
`manual_card_id` belonging to another user is rejected; a stranger cannot void another user's lot;
and `holding_summaries` (a `security_invoker` view) hides another user's holding exactly as the
underlying tables would.

---

## 5. Database tests

Constraints and triggers, exercised directly:

- `holdings` check: exactly one of `card_variant_id` / `sealed_product_id`
- `holdings_identity` partial unique index prevents duplicate state rows
- `acquisition_lots` check: `origin = 'purchase'` ⟺ cost basis present (M1)
- `purchases` check: `total = subtotal + shipping + customs − discount`
- Invariant D1: `quantity_remaining = quantity − Σ non-voided disposals`, enforced by trigger
- Void guards: voiding a purchase whose lot has been sold is rejected, and the error names the
  blocking sale
- Voiding an opening restores the source lot and voids pull lots; blocked if a pull was sold
- Cascade on account deletion removes all user-private rows and no catalog rows
- Every migration applies to an empty database and to a seeded one

**M5 catalog (`tests/db/catalog_constraints.test.ts`, `tests/db/search_cards.test.ts`,
`tests/data/tcgdex-provider.test.ts`, `tests/authorization/catalog.test.ts`):**

- `card_variants_identity_key` rejects a duplicate `(card_id, finish, stamp, subtype, size)`, and
  allows two rows differing only by stamp/subtype on the same card (the shape D-033 exists for)
- Two sibling variants of one card may share a `tcgplayer_product_id`/`cardmarket_product_id`
  (D-034 — no longer a unique column)
- The same `tcgdex_set_id` is accepted in two different languages; a genuine duplicate within one
  language is still rejected
- `cards.language` must match its set's language, enforced on insert and on re-pointing `set_id`
- `catalog_sync_runs` accepts a service-role write and is invisible to `authenticated`
- `search_cards`: name, set, collector number, combined name+number (including a `4/102`-style
  query), Japanese text, language filter, Energy category, no-result, wildcard/SQL-special input,
  pagination stability, a multi-variant card's `variant_count`, a missing-image card's
  `image_base_url` staying `NULL` rather than a placeholder
- The TCGdex provider adapter's mapping, pinned against real captured payloads (not synthesized
  shapes): the finish/stamp/subtype split, the `"generated"` sentinel, the boolean-flags fallback,
  Pocket-series detection

---

## 6. E2E

Playwright, against a seeded synthetic dataset. Both desktop (1440×900) and mobile
(iPhone viewport, 390×844) for every flow.

Deterministic browser coverage runs against a build configured with a **placeholder** Supabase URL,
so every network call fails identically and public CI needs no remote credential. That is enough for
routing, guards, form semantics, error states and layout. Flows that need a live stack are proven in
the authorization suite instead, which is also where they belong — the browser is not what enforces
any of them.

| Flow | Assertions |
|---|---|
| Anonymous visit to `/` or `/admin/invitations` | Lands on sign-in; the admin screen does not render |
| Anonymous visit to `/catalog` or `/catalog/$cardId` | Lands on sign-in; the catalog screen does not render |
| Sign-in form | Password-manager `autocomplete` attributes; show/hide preserves the value; paste never blocked |
| Failed sign-in | One message, announced via `role="alert"`, naming neither half as the wrong one |
| Unusable invitation link | One message plus a way forward |
| Recovery request | Same confirmation regardless of the address |
| Recovery link with no session | Reported as unusable rather than silently blank |
| Layout | No horizontal overflow; controls clear a 44px touch target |
| Redeem invitation → sign in → session persists across reload | Against a live stack; manual or remote, not public CI |
| Add a card manually | Appears in collection; correct lot; dashboard totals move by the right amount |
| Add a card manually | Appears in collection; correct lot; dashboard totals move by the right amount |
| Multi-line purchase with shipping | Allocation matches E3 exactly, visible in the UI |
| Foreign-currency purchase | Original and NOK both shown; rate prefilled |
| Sell part of a multi-lot holding | Lot selector works; remaining quantity correct; realized result matches E7 |
| Void a purchase with a downstream sale | Blocked with a message naming the sale |
| Stale price | Marker rendered; value retained |
| Collection with 10 000 seeded lots | Grid interactive at every density; keyset pagination; no unbounded query; no image stampede |
| History view | Sold item absent from Collection, present in History with correct figures |
| Add a gift, then sell it | No profit figure anywhere in the flow |
| CSV export | Downloads; row count matches; amounts parse |
| Install as PWA | Manifest valid, icons present, standalone mode, safe areas correct |

Console errors and failed network requests fail the test. A flow that renders correctly while
throwing in the console is not passing.

---

## 7. Performance

Not micro-benchmarks. Two checks that map to real failure:

- Dashboard first meaningful paint with 10 000 lots and 12 months of snapshots: under 2 s on a
  throttled connection. It reads `portfolio_snapshots`, so this should be nearly independent of
  collection size — if it is not, the aggregation is in the wrong place.
- Collection grid with 10 000 lots: virtualised, keyset-paginated, no layout thrash, no N+1
  query. Asserted by counting network requests, not by timing.
- Image requests on first paint at 4-column density: bounded by what is actually visible plus a
  small prefetch margin.
- Price-snapshot volume: one row per watched variant per price kind per day. A seeded collection
  with heavy duplication must not inflate it (D-019).
- **M7's 10 000-lot Portfolio gate.** `scripts/portfolio-perf-benchmark.mjs` seeds an isolated
  synthetic account (never the owner's real one — M7 prompt §101) with 10 000+ lots — duplicates,
  five conditions, tags, storage locations, custom-collection membership — and times
  `list_portfolio` across every sort mode, one filtered query, a keyset second page and
  `portfolio_counts()`, reporting milliseconds/rows/payload bytes rather than asserting a fixed
  threshold (a hardcoded millisecond budget on a shared CI runner would be exactly the
  "microbenchmark theatre" this section already warns against). The milestone gate itself is
  behavioural — a real browser at this scale stays interactive, verified manually and recorded in
  HANDOVER.md/PROJECT_JOURNAL.md, not by this script's numbers alone.

---

## 7a. Privilege-convergence tests

Three steps in `db-tests`, and the order is the point (SECURITY.md §5.9):

1. `scripts/grant-audit.sql` against the freshly migrated database — the intended surface is what
   the catalog actually holds.
2. `tests/db/sql/hostile_grants.sql` puts the database into the legacy auto-expose state the
   deployed project was in, and asserts that state took effect. The audit must then **fail**; if it
   passes, CI fails on that instead, because an audit that cannot fail is not a check.
3. `supabase/migrations/20260820140000_m41_privilege_baseline.sql` is re-applied — the real
   migration file, not a copy, so the test cannot drift from the thing it verifies — and the audit
   must come back clean.

The suites then run against a database that has been through that cycle, rather than one that was
never wrong. That distinction is what M4's escalation cost.

**M7 extends step 2** to also grant blanket `EXECUTE` on every routine to `PUBLIC` — the privilege
class named-role revokes cannot touch (SECURITY.md §5.9/§3.2.1, D-042) — so the audit's new
PUBLIC-grant check is proven able to fail before the re-applied baseline is trusted to have fixed
it, the same "an audit that cannot fail is not a check" reasoning applied to the gap M6's own
journal entry flagged as unclosed.

`tests/authorization/system_owned_columns.test.ts` asserts the same restrictions behaviourally, one
column at a time, probing with a filter that matches no rows: PostgreSQL checks column privileges
when it plans the statement, so this asserts the privilege rather than an interaction between a
privilege and a fixture.

---

## 8. Real-device checks

Emulation is not Safari. A manual checklist, recorded with dates in
[PROJECT_JOURNAL.md](PROJECT_JOURNAL.md):

- [ ] Install to iPhone home screen; correct icon and name
- [ ] Standalone launch, no browser chrome
- [ ] Safe areas correct with the home indicator, in both orientations
- [ ] Keyboard does not obscure form fields; numeric keypad for amount inputs
- [ ] Session survives an app switch and a cold start
- [ ] An invitation link opens, shows the invited address, and the platform password manager offers
      to generate and save a password
- [ ] Sign in with the saved credential, without leaving the installed app
- [ ] Password recovery email arrives and the link opens the reset screen
- [ ] Camera permission persists through a scanner session (the R9 risk, when the scanner exists)
- [ ] Charts respond to touch; pinch and pan behave
- [ ] Android: install, launch, core flows

---

## 9. Test data

All fixtures committed to Git are synthetic. Real collection data never enters the repository.

Seeds live in `supabase/seed/` and produce: two users (for isolation tests), a small catalog
subset referencing real TCGdex ids (public facts, safe to reference), invented purchases with
round numbers chosen so allocation edge cases appear, one opening with tracked pulls, one
grading submission, one partial sale, one holding with a missing price and one with a stale
price.

Amounts are deliberately chosen to produce inexact division — a shipping charge of 100 over
three lines is worth more as a test than one of 90.

---

## 10. CI

Added when the application scaffold exists, not before — an empty pipeline in a docs-only
repository is noise.

Two jobs, on every push to `main` and every pull request.

```
build-and-test  install → typecheck → lint → format → domain + property tests → build
                → browser E2E (desktop + iPhone) → secret scan
db-tests        supabase start → db reset → assert redeem-invitation is reachable
                → database + authorization suites → generate types
```

`db-tests` runs a full ephemeral Supabase stack on the runner — migrations from empty, seed, then
every database and authorization test. It uses **no remote credentials of any kind**, which is what
keeps CI reproducible from Git alone and keeps the real project out of the blast radius.

**CI is a reproducibility gate, not a statement about a deployed project.** That distinction cost
a real finding: the same migrations produced different privileges on CI and on the dev project,
because the project auto-granted the Data API roles more than the migrations then revoked. Green CI
coexisted with a live privilege escalation. `scripts/remote-security-check.mjs` closes the gap —
the same assertions against a real deployment, using only the publishable key, so running it can
never leak a credential. It is a step in the security checklist, not an optional extra.

The reachability check before the auth suite is not ceremony. If the edge runtime were not serving
`redeem-invitation`, the redemption tests would fail for an unrelated reason, or worse, a future
refactor could make them vacuous. Asserting a nonsense token comes back `400` from our own handler
proves the thing under test is actually there.

Migrations are applied deliberately through the Supabase CLI, never automatically from CI.
