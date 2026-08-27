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

**M15 scanner suites (in `pnpm test`).** The scanner adds infrastructure-free Vitest coverage
alongside the existing domain/data/ui splits: pure geometry/ROI/preprocessing math
(`tests/ui/scanner-guide-geometry.test.ts`, `scanner-roi.test.ts`), the OCR pipeline against a
fake engine + canvas pool (`scanner-analyze.test.ts`), controller-level matcher/acquisition
integration with mocked data boundaries (`scanner-controller.test.ts`), session-defaults
scoping and identity-boundary clearing (`scanner-session.test.ts`), and a static network-
privacy audit over every scanner module (`scanner-network-audit.test.ts` — no Supabase/fetch/
TCGdex/logging surface, tesseract.js dynamically imported in exactly one engine file). Two
deliberate boundaries: REAL Tesseract execution is a manual smoke, not CI —
`node scripts/scanner-ocr-smoke.mjs` runs the pinned engine against the committed synthetic
fixtures (non-copyrighted programmatic renders under `tests/fixtures/scanner/`; regenerate via
`scripts/generate-scanner-fixture.mjs`) — because deterministic OCR output is too environment-
sensitive for required CI. And signed-in scanner UI on real iPhone hardware remains the §8
owner gate; Chromium E2E covers the session-guarded `/scan` route only.

**M15b visual recognition (P76, D-097, in `pnpm test`).** `tests/data/visual-index.test.ts`
(decode/search/quantization-bound/duplicate-id/corruption rejection — pure, no I/O),
`tests/domain/scanner/perceptual-hash.test.ts` (dHash math), `tests/domain/scanner/
visual-hybrid.test.ts` (OCR-absent-visual-present shortlisting, agreement/disagreement scoring,
near-equal ambiguity, same-art surfacing, no-auto-add, backward compatibility with the pre-P76
text-only call shape), and extensions to `tests/ui/scanner-network-audit.test.ts` (recursive over
the new `visual/` subdirectory; the visual worker's `fetch()` calls are the one exception to the
"no fetch in scanner code" rule, itself asserted same-origin-literal-only) and `tests/config/
security-headers.test.ts` (the `visual-v1` runtime-cache rule, and the precache-exclusion glob
for both the OCR tree and the visual-worker's own Vite-emitted chunk). A REAL model smoke (not
mocked) ran this session against real TCGdex images before the full benchmark, per the same
"real execution over reading the source" discipline as Tesseract's smoke test above — see D-097.

**M15b index-generation repair (P77, D-097 addendum, in `pnpm test`).**
`tests/domain/scanner/index-pagination.test.ts` (PAG1–PAG8: full-catalog multi-page fetch beyond
the 1000-row PostgREST cap, exact-boundary termination, deterministic ordering, cross-page
duplicate rejection, page-level query error propagation, exact-count mismatch rejection, a
pathological-loop guard), `tests/domain/scanner/checkpoint-identity.test.ts` (CP1–CP7: local vs.
hosted / hosted-A vs. hosted-B / model-revision / embedding-dimension identity mismatches all
invalidate a checkpoint, packing drops a stale id not in the current canonical fetch, a same-config
restart resumes, the 1224/1000 historical shape is structurally rejected by packing alone),
`tests/domain/scanner/index-coverage.test.ts` (the shared coverage-invariant assertion the
generator/verifier/runtime worker all now share), and `tests/ui/scanner-diagnostics-format.test.ts`
(the `/scan?scannerDebug=1` panel's plain-text "Copy diagnostics" output — every field present,
honest placeholders for null/empty values, never anything resembling a secret field name).

**M15b visual-runtime initialization repair (P78, D-097 addendum, in `pnpm test`).**
`tests/domain/scanner/visual-backend-selection.test.ts` (R2–R9: auto tries WebGPU first and uses
it on success; a successful WebGPU load never also triggers WASM; WebGPU unavailable falls
straight to WASM; a WebGPU init failure retries on WASM and can still succeed; a WASM failure
after WebGPU absence is a final attributable failure; both backends failing retains BOTH error
reasons, never just the last one; `force wasm` never even probes for a WebGPU adapter; `force
webgpu` failing — either by init error or no adapter — never silently substitutes WASM; an
invalid `?visualBackend=` value normalizes to `auto`), `tests/ui/scanner-visual-client.test.ts`
(R10–R13 against a fake `Worker` global: a processor-load failure is distinguishable from a
model-load failure; an index-load failure is distinguishable from a model-load failure with the
model still reporting ready; a full success reports the actual backend/card count, not a
placeholder; a worker crash's `error` event surfaces a safe message/filename/lineno reason, never
a secret), and an extension to `tests/ui/scanner-controller.test.ts` (R1: the worker's
`unavailableReason` now survives into `VISUAL_ERROR` when `analyzeVisualSafely` never throws —
exactly how a model-init failure behaves — reproducing the actual real-device bug this session
found; a real `analyzeVisualSafely` exception still takes precedence when both exist). Two new
real-world-scale cases in `tests/domain/scanner/index-coverage.test.ts` (R14/R15: the owner's real
19,501/20,946 hosted rebuild is accepted; an impossible-coverage manifest at the same scale is
still rejected). `tests/config/security-headers.test.ts` and
`scripts/verify-scanner-platform-build.mjs`/`scripts/deployment-check.mjs` now assert `blob:` IS
present in `script-src` (previously asserted absent) with the reasoning inline.

A real-browser smoke (not part of automated CI — Chromium via the Browser pane, against the
actual production `dist/` build with the actual generated `_headers`) proved model
load→embed→search end to end for all three backend modes (`auto`, forced `wasm`, forced
`webgpu`), each returning real candidates from the real 19,501-card hosted index, with
`crossOriginIsolated=false` throughout — see D-097's P78 addendum for the exact reproduction.

**M15b recognition-quality repair (P79, D-097 addendum, in `pnpm test`).** A confirmed real-iPhone
diagnostic (model loaded, embedding created, index searched — every candidate LOW-tier and wrong)
shifted the gate from "does the runtime work" to "is the crop/preprocessing good enough."
`tests/domain/scanner/rectify.ts`'s own suite (`tests/domain/scanner/rectify.test.ts`) pins the new
pure card-rectification math directly: greyscale conversion agrees with roi.ts's own weighting;
bilinear quadrilateral warping is exact at the corners and uniform across a solid-color region for
both axis-aligned and genuinely skewed quads; edge detection finds a card boundary sitting inside
an over-generous nominal rect and a genuinely tilted one, returns null over a uniform image with no
real edge (never a first-position-wins guess) and rejects a nonsense sliver rect; composed
`rectifyCard` falls back to a plain crop+resize (pixel-equivalent, same code path) on detection
failure and never throws on a degenerate input. `tests/ui/scanner-rectify-capture.test.ts` pins the
canvas-glue's pure geometry decisions (expansion-with-clamping, never-upscale working scale,
cardRect-to-working-space mapping, the detection-margin floor for zero-expansion inputs like file
uploads) and the graceful-fallback contract when `createImageBitmap` is unavailable. Extended
`tests/ui/scanner-camera.test.ts` pins the new resolution hint on `getUserMedia` (`{ideal: 1920}`
on both width and height, never `exact`/`min` — a capped device must still open) — traced from the
real diagnostic's `CAPTURE_CROP_DIMENSIONS=252x352`, which the guide-geometry math reproduces
almost exactly against a plausible ~480×640 unconstrained-default video track. A new debug-mode
suite in `tests/ui/scanner-controller.test.ts` pins the widened debug-only visual shortlist (50 vs
production's 30), the up-to-20 `topVisualCandidatesExtended` list populated ONLY in debug mode, the
memory-only debug image object URLs (`getLastDebugImages`) being revoked on the next scan and on
`dispose()`, and that NONE of this debug collection happens outside `?scannerDebug=1` (privacy and
performance floor in one assertion). `tests/ui/scanner-diagnostics-format.test.ts` gained the new
`CAPTURE_FRAME_DIMENSIONS`/`RECTIFICATION_USED`/`TOP_20_VISUAL_CANDIDATES` lines.

**Harder visual benchmark (`scripts/scanner-visual-benchmark/run-hard-benchmark.ts`, P79 §7, NOT
part of `pnpm test` or CI — same exclusion reasoning as the P76 harness below).**
`pnpm scanner:visual:benchmark:hard` composes a genuinely harder query than the P76 benchmark's
resize/rotate/blur-in-place profiles: the clean reference card is tilted, sheared and placed
OFF-CENTER on a larger background canvas (`lib/hard-augment.mjs`), so a query actually needs
cropping/rectification before it resembles the tight reference images the index was built from —
the exact gap the real-device diagnostic exposed and the P76 corpus structurally could not
exercise. Compares simple-crop / tightened-crop / the REAL `rectify.ts` detect+warp pipeline /
rectified+OCR+rerank (the same real domain matcher) against the same real production embedding
code. Report and full interpretation: `ai_outputs/Claude_outputs/output_79.txt`.

**Visual benchmark harness (`scripts/scanner-visual-benchmark/`, NOT part of `pnpm test` or
CI).** `pnpm scanner:visual:benchmark` — downloads a real, diverse TCGdex reference corpus,
applies deterministic synthetic camera-distortion augmentations, and compares OCR-first/
perceptual-hash/visual-embedding/hybrid recognition using the real production domain matcher.
Excluded from CI deliberately: it needs live network access (TCGdex image downloads, a
Hugging Face model fetch on first run) and takes minutes, not seconds — the same category as
`remote-security-check.mjs`. `pnpm scanner:index:build` / `pnpm scanner:index:verify` are the
offline index-generation/verification pair (D-097); `build` needs `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` (never `.env.local`, same posture as `portfolio-perf-benchmark.mjs`).

**M15 scanner idempotency (`tests/db/m15_scanner_idempotency.test.ts`, in `pnpm test:db`).**
21 cases (I1–I21) against real Postgres pin D-096's per-item idempotency key on
`add_card_acquisition`: sequential and concurrent replay (including a forced-overlap race for
both known- and unknown-cost paths), response-loss late replay, cross-user key independence,
different-key-same-holding, every material-mismatch dimension (identity, quantity, condition,
origin, cost, date, storage) rejected as `idempotency-key-reuse`, a voided lot's key rejected
rather than resurrecting inventory, NULL-key legacy behaviour unchanged, reset-then-reuse, and
the manual-card/card-variant/sealed-product/manual-valuation paths. This suite exists
specifically because the design had been reviewed multiple times on paper before it ever ran
against a real database — see PROJECT_JOURNAL.md 2026-08-26 ("P75: a PL/pgSQL record-null trap
silently disabled an idempotency check that every review had approved") for what that first real
run actually found.

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

**M12 (`tests/db/m12_dashboard_snapshots.test.ts`, `tests/db/m12_queue.test.ts`,
`tests/db/m12_retention_rebuild.test.ts`, `tests/authorization/m12_dashboard.test.ts`,
`tests/data/dashboard.test.ts`).** The equality gate runs over a deliberately rich corrected
fixture — backdated acquisitions, partial sale, sale void restoring history, manual set/update/
clear plus a backdated correction landing inside cleared history, a price correction, a genuine
zero observation, an unpriced variant, sealed and graded holdings on manual-only valuation —
with every semantic column compared exactly (`computed_at` excluded). Around it: the ownership
boundaries (acquire/sale day edges, same-day acquire+sell ending at zero), as-of freshness
measured from D (a 60-day-old observation is real history at D−55; exact 30/31-day inclusion
edge), no future prices, no pre-tracking fabrication, the D-062 interval model including
deterministic resolution of a correction that backdates past an earlier-effective row AND the
reviewed clear-then-later-insertion corner (an explicit clear stays cleared — with provider
fallback proving the gap actually resolves automatically, and an unpriced gap staying honestly
missing; the atomic-replacement boundary pinned separately), per-date
CMV/ACMV/DCB/URC/CS/NSP/TTEP against hand-derived ledgers (F3/F5), the D-068 adjustment-share
DCB rule at its occurred_on boundary including a multi-unit lot with a real partial disposal and
indivisible flooring remainders (data proof, not just formula reading), NULL-not-zero honesty for
TTEP and THP before a user's first snapshot exists, reversed-range rejection (D-069), mixed
data-quality counts (automatic/manual/priced/unpriced/uncosted), monthly-spend F1 reconciliation
against `purchase_spending_summary`, the RRC/PUD split never collapsing into "profit", D-067
historical display-FX across a mid-history re-rate, zero-coverage gap flags, empty-account
honesty, queue LEAST-coalescing/drain/idempotence/concurrent-drain/future-work retention, shared
price/FX fan-out (sealed-only users excluded), and grant-level refusals for every engine routine
plus cache-forgery, cross-user read, admin-no-bypass and anon-denial coverage.

**M9.1 × M12 compaction (`tests/db/m12_retention_rebuild.test.ts`, D-070).** The cross-milestone
gate: dense daily observations older than 60 days → snapshot built → the REAL
`thin_price_snapshots()` runs → invalidation fires from the oldest deleted observation → drain
recomputes → the affected historical CMV point adjusts exactly once to derive from the retained
weekly facts (no fabricated zero/missing transition; a day whose covering fact survived stays
byte-identical) → every frozen ledger column identical before/after → deleting the cache and
rebuilding from scratch reproduces the post-compaction series exactly. Monday-aligned week
anchors keep survivor identity deterministic regardless of the run date.

The independent adversarial package (`test/m12-independent-adversarial`) mirrors the same
semantics from its implementation-blind oracle: scenario S/S2 pin the clear-vs-replacement
distinction end-to-end through the real RPCs, and the pure-domain suite asserts the resolved
interval rule directly (cleared value never resurrected; atomic replacement keeps the
replacement boundary; wedged backdated corrections never read as clears).

**P28 (`tests/db/p28_holding_quantity_removal.test.ts`,
`tests/authorization/p28_quantity_reduction.test.ts`,
`tests/data/collection-reduce-wire.test.ts`).** The quantity-correction RPC end to end against
real rows: remove/adjust/remove-all lifecycle effects on `list_portfolio`, per-lot chosen
provenance for multi-lot holdings, unknown-cost lots staying unknown (never 0), purchased-lot and
partially-disposed refusals with money/disposals/sale lines byte-identical after the refused
attempt, receipt-edit routing reconciling inventory and allocated money exactly, forged
cross-user lot ids rejected indistinguishably from unknown ones, M12 queue enqueued only when a
correction actually applied, hostile JSONB shapes with zero mutation each, and concurrency:
simultaneous strip-to-zero attempts both refused, reversed multi-lot payload orders never
deadlocking (one clean win, one refusal against the winner's committed state), and a racing
`create_sale` vs adjust serializing on one lock order. The wire-format suite pins that the client
passes the reduction array as jsonb, not a JSON string scalar.

**P43 (`tests/db/p43_reset_and_history.test.ts`,
`tests/authorization/p43_reset_history.test.ts`, plus entries in
`tests/authorization/function_grants.test.ts`).** The full reset matrix: User A seeded with a
raw known-cost quick-add, a graded holding + manual valuation, a sealed holding, a multi-line
purchase with an accessory line, a sale + disposal, tags/collections/memberships, M12 snapshot +
queue rows and every class of preserved setup metadata; reset asserts zero live holdings/lots/
transactions/valuations/snapshots/queue, an intact profile, preserved metadata counts exactly,
and B's canonical state untouched; idempotent second reset; the dashboard reading honestly empty
(no snapshot, nothing pending, zero totals) afterward. History read surface: every event kind
present, kind filters narrowing correctly, voided entries hidden by default and revealed by the
toggle, keyset pagination covering all events exactly once across pages of 3, purchase-origin
lots never double-reported as acquisitions. Authorization: anon denied both functions, no
`p_user_id` overload exists for reset (forged-target attempt fails in the schema cache), A's
feed never contains B's events, and A resetting never touches B. Atomicity is structurally
asserted rather than fault-injected — PostgREST executes one request in one transaction and the
FK-safe order is exercised by the full matrix; injecting a mid-function failure needs DDL the
test harness cannot reach (same disclosure class as M12's deep drain fault-injection).

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

**M9 (`tests/db/m9_valuation_resolver.test.ts`, `tests/data/tcgdex-pricing.test.ts`).** The
valuation resolver is proven at the SQL layer, not just via the pure-TypeScript domain module
(`tests/financial/market-value.test.ts`, unchanged) — FX conversion, the `use_eu_pricing`
provider-preference branch and the F10 graded-card exclusion only exist in
`resolve_variant_market_values`/`get_holding_value_provenance`, so those need their own coverage
against real persisted rows: manual overriding fresh, fresh vs. stale vs. missing at the exact
3/30-day boundaries, a genuine zero observation resolving to `fresh` rather than `missing` (F14), a
graded holding never picking up its underlying printing's raw price even when one exists, quantity
multiplication for the holding-total figure, a simulated outage aging a snapshot from `fresh` →
`stale` → `missing` without ever zeroing the value (F9), and both directions of the
`use_eu_pricing` preference including its unambiguous fallback. The variant-safe price *mapping*
(TCGdex payload → candidate price per exact variant) is a separate, deterministic, no-network suite
against real captured payloads (`tests/data/tcgdex-pricing.test.ts`, same pattern as
`tests/data/tcgdex-provider.test.ts`/`norges-bank.test.ts`) — it locks in the embedded-vs-card-level
mapping rules and proves an ambiguous card-level shape resolves to no price rather than a guess
(prompt §15), including a real zero-price observation and a real missing-provider case captured
live rather than synthesized.

**M10 (`tests/db/m10_sales.test.ts`, `tests/authorization/m10_sales.test.ts`).** E2 and E7 are
proven against real stored rows (not just the pure-TypeScript version in
`tests/financial/worked-examples.test.ts`), with the explicit lot chosen exactly as the caller
specified — no averaging. Also covered directly against real rows: a gift/unknown-basis sale
(`cost_basis_at_sale`/`realized_result` both `NULL`, proceeds still counted, never a fabricated
profit); a mixed known/unknown sale (line-level split, sale-level `realized_result_nok_minor`/
`proceeds_from_uncosted_nok_minor` reconcile exactly to the frozen NOK total); partial-lot disposal
across two separate sales; the residual-consumption rule (D-060) across three separate sales of an
awkwardly-divisible lot, reconciling to the exact minor unit; `lot_cost_adjustments` division with
its own residual; fee/outbound-shipping/buyer-shipping allocation exactness (`Σ allocated = total`,
F6, for all three independently) including the zero-line-gross edge case; a genuine negative-NSP
loss sale (prompt §109-110, not rejected or clamped); a foreign-currency (manual FX) sale with
per-line NOK amounts reconciling exactly to the sale-level frozen total; void and double-void
(the second a named error, quantity never double-restored); D1 after a mixed history of partial
sale and void; concurrency (two simultaneous attempts to sell a lot's last unit — exactly one
succeeds, verified via `Promise.all` against real row locking); idempotency (a retried `create_sale`
call with the same key returns the original sale, never a duplicate); result-sort `NULLS LAST` in
both directions (an unknown-basis sale never sorts as +/-infinity); and F5
(`RRC + PUD = NSP − Σ known frozen cost_basis_at_sale`) aggregated over every non-voided line.

The authorization file proves what M10's SECURITY DEFINER choice (D-060) is actually for: a direct
`INSERT`/`UPDATE` against `sales`/`sale_lines`, even on one's own row, is rejected at the grant
level — not a business-logic check, a genuine absence of privilege. Also: a foreign `lot_id` in
`create_sale` fails with the same generic message as a nonexistent one (prompt §106, no existence
oracle); a stranger cannot update or void another user's sale; read isolation on all three tables;
and admin has no bypass (`sales_summary()` never mixes proceeds across users, matching the existing
`purchase_spending_summary()` pattern in `tests/authorization/m8_purchases.test.ts`).

**M9.1 (`tests/db/m91_retention.test.ts`, `tests/db/m91_value_pagination.test.ts`,
`tests/db/m91_market_movers.test.ts`, `tests/data/pricing.test.ts`).** Closes gaps the M9 review
found: `thin_price_snapshots` proven against an 18-month synthetic dataset (recent-vs-thinned
boundary, per-week/per-provider/per-variant separation, idempotency, history still usable after
thinning — TESTING.md §6a's own lesson about DROP+CREATE regressions is why this one is written as
an explicit gate, not assumed from code review); `list_portfolio`'s value_desc/value_asc keyset
pagination walked one row at a time against a seeded tie group (manual vs provider, fresh vs stale,
same unit different quantity, different unit same total, real zero vs missing, custom-collection
scope) to prove no duplicate or omitted row under a real tie; `get_market_movers`'s sort modes,
quantity-non-distortion (D-056) and cross-user isolation; and `summarizeCardPricing`
(`src/domain/pricing-summary.ts`) — the honest range/from-price logic Search result tiles render
from — as a pure, no-network unit-test matrix (one priced variant, several, partial coverage, all
missing, a genuine zero, an ambiguous/ignored candidate, one card's provider failure never
affecting another card in the same batch).

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

**M8 (`tests/db/m8_purchase_ledger.test.ts`, `tests/authorization/m8_purchases.test.ts`,
`tests/data/norges-bank.test.ts`).** E3 and E10 are now proven twice — once as pure TypeScript
(`tests/financial/worked-examples.test.ts`/`fx.test.ts`) and once against real persisted rows via
`create_purchase`, which is the "database parity with the domain engine" requirement (the SQL port
of the largest-remainder allocator, `allocate_largest_remainder`, is asserted byte-identical to
`src/domain/allocation.ts`'s `allocate()` across a shared corpus in the same file). F1 (`GPO = CS +
HS`) is asserted over `purchase_spending_summary()`, including after a void. `void_purchase`'s and
`update_purchase`'s downstream-blocker checks were originally exercised only by directly setting a
lot's `quantity_remaining` below `quantity` under the service role — a proxy for the real thing,
since no disposal-producing milestone had shipped yet to create one for real. M10 is the first real
one; a genuine `create_sale`-produced partial disposal now exercises the identical blocker path in
practice (a source purchase becomes uneditable/unvoidable the moment any of its lots has a real
sale against it) — proven as a regression test, not a re-write of the M8 fixture-based coverage,
which stays exactly as useful for openings/grading/trades once those milestones ship too. The
`void_acquisition_lot` correction (D-047's neighbour, M8 prompt §62) is proven by
voiding one of a two-card-line purchase's two lots and confirming the parent purchase does not void
prematurely, then voiding the second and confirming it now does. `tests/data/norges-bank.test.ts` is
a deterministic, no-network regression against a real captured Norges Bank response (TESTING.md's
own "deterministic, no-network" pattern for provider adapters, matching
`tests/data/tcgdex-provider.test.ts`) — it proves the BASE_CUR/rate orientation and the
weekend-fallback behaviour without CI ever depending on the live API, per M8 prompt §92.

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

**M13 export (`tests/db/m13_export.test.ts`, `tests/db/m13_export_perf.test.ts`,
`tests/data/export-*.test.ts`, `tests/data/pagination-integrity.test.ts`,
`tests/ui/export-*.test.ts`, `test/m13-independent-adversarial/`):**

- DB/authorization (ephemeral stack, real JWTs through real RLS): full export as synthetic user B
  returns B's profile and zero rows owned by A across all sections; >2^53 money arrives exact
  end-to-end; null ≠ zero on a gift lot; forced pageSize=1 multi-page assembly with progress
  callbacks; identity manifest = exactly the referenced variants/curated products; cancellation
  propagation; unauthenticated refusal; production pagination constants pinned; an EMPTY account
  still yields a complete envelope and ten header-only CSVs (§22 honesty — "no files came back"
  fires only on literally zero artifacts)
- Pure domain: envelope validation incl. the strict-v1 policy (unknown data keys refused;
  same-version file with a new section refused — D-076); byte-identical determinism modulo
  exported_at; money-cast audit proving every declared money field is selected `::text` in its own
  section's select string plus frozen FX verbatim (§19); microsecond timestamp precision (§21);
  RFC 4180 writer matrix + property round-trips + free-text-only injection sanitization with
  legitimate numeric negatives untouched; pagination-integrity walker (truncation/gap/duplicate
  detection); reminder cadence
- UI: delivery dispatch matrix (share/picker/download, cancellation quiet, NotAllowedError surfaced
  per D-079) and the two-step flow reducer (D-078), including retained-artifacts retry
- Independent adversarial package (implementation-blind P37 source, PR #45): pure oracle suites run
  everywhere via `pnpm test:m13-adversarial`; its DB-backed cross-user suite and implementation-gated
  backup contract execute in CI's `db-tests` job against this same ephemeral stack (typecheck step +
  execution step, mirroring the M12 pattern). First-contact [M13 CONTRACT] failures were classified
  and bound deliberately (D-076); artifact-level owner-completeness asserts every seeded row arrives
  exactly once with frozen FX/allocations verbatim
- Export scale audit (D-059-style catastrophic-only gate): opt-in `M13_EXPORT_PERF=1` CI step seeds
  ~10k lots / 2k sales / 4k valuations on a throwaway account and times the real pipeline under the
  owner JWT, reporting duration, request count and artifact size

**M16 openings (`tests/db/m16_openings.test.ts`, `tests/authorization/m16_openings.test.ts`,
`tests/data/opening.test.ts`, `tests/ui/opening-*.test.ts`, `tests/e2e/openings.spec.ts`,
`tests/m16-independent/`):**

- DB core (ephemeral stack): E1–E16 scenario map — spend invariance with the exact frozen share
  (E1); the corrected 29995 residual proof in BOTH split orders (E2, D-060's once-only argument);
  gift/not-paid unknown-cost honesty (E3); all-card tracking incl. basic energy as first-class
  inventory and priced-path cross-checks against the resolver itself (E4); selected-pulls +
  both-or-neither remainder (E5); sell-pull NULL-basis discipline and proceeds (E6); over-open
  refusal (E7); concurrent 6+6 serialization (E8); anon denial ×6 surfaces + cross-user
  attacks + service-role defence-in-depth trigger (E9/E10); void lifecycles with the P53 §10
  purchase-stays policy (E11/I7/I8) and sold-pull void block naming the blocker (E12);
  backdated dirty_from (E13); reset isolation incl. counts + B-survival (E14, I15); History
  single-event discipline + no pull double-reporting (E15, I11) plus ONE Opening recent-activity
  row (I12); audit_events absence (E16)
- P53 integration cases layered onto the same suites: server-side idempotent create retry — one
  opening (I2), material-mismatch key reuse refused (I2b), key identifies the ORIGINAL operation —
  different pulls on the same key return the original opening unchanged (I2c), idempotent
  PROVISIONAL retry — one
  purchase, one opening, replay checked before the ledger write (I3); bought-and-opened total-paid
  29995 = unit 9998 + residual 1 with line-level honesty (I10); known-zero ≠ unknown (I6);
  explicit separate purchase correction after an opening void (I9); composite-uniqueness
  cross-user same-UUID independence
- P56 repair cases: post-reconcile canonical world — provisional purchase, source lot AND old
  disposal all voided while the opening stays live at the real lot with exactly one live opened
  disposal and GPO/CS equal to the real purchase only; re-open/re-sell of the retired provisional
  lot refused (P54 H1); reconcile target from a PROVISIONAL purchase refused, from a VOIDED
  purchase refused, from a live ordinary purchase succeeds (F55-10); retained-only coverage
  counts — a fully-sold pull leaves priced/unpriced counts and retained value but stays in sold
  count/proceeds, a partial sale contributes by remaining quantity (L1); direct constraint audit
  of the widened line-total CHECK envelope (below-unit rejected, above unit×qty+qty−1 rejected,
  legal residual accepted, quantity>0 and non-negative prices hold, create/update_purchase write
  excess-0); user-scoped draft store isolation and RESOLVE_MANUAL_CARDS persistence
  (tests/ui/opening-draft.test.ts)
- P59 integration-cleanup cases: Home recent-activity contract — the 'opening' type renders a
  nonblank "Opened" label and routes to `/openings/$openingId`, a bought-and-open coexists as one
  Purchase row plus one Opening row both clickable, null amount does not break the row
  (tests/ui/home-activity.test.ts); draft idempotency — ONE key per logical draft surviving every
  editing action, remount and failure, rotated only by RESET/post-success (R2); stale-'submitting'
  recovery loads back as retryable editing with all fields incl. resolved manual-card ids intact,
  editing/submitted drafts pass through untouched (R3); full integrated manual-card remount
  sequence reuses ONE definition identity across mounts (R16); route-scope reconciliation matrix —
  holding-scoped draft → generic entry drops the scope keeping pulls (no false "Nothing to open"),
  generic draft → explicit holding honors it, matching scope unchanged, submitted never reusable
  (R14); copy pins for honest provisional/reconciled wording, reconciliation sheet, wrapped
  manual-card failure, unpriced-retained marker and sold/partial pull states (R8/R9/R10/R11/R12);
  controller coverage-count/reconciledAt exposure + reconcile delegation and safe refusal mapping
  (R6-pure/R7); DB-gated: same key + different total paid refused with spend counted once (R4),
  same key + different purchased_on refused while full-match replay still returns the original
  (R5), list_opening_sources provenance columns distinguish provisional vs manual parents so the
  picker can mirror the server rule (R6)
- Pure domain: §5.3 return formula vs the worked examples; exact preview rule reproducing the
  writer byte-for-byte incl. 19996→9999 (I4/I5); ROI rounding; completeness marker pairing;
  bought-and-opened draft gates and input assembly; copy pins (never-0, no per-pull ROI, void-does-
  not-undo-purchase wording); controller mapping matrix against a mocked data layer (I1) incl.
  blocked-void outcomes and concise error mapping (§29)
- Export: backup v2 envelope (schema_version 2 only; v1 refused post-M16; openings section,
  counts, canonical ordering, `opening_id` linkage round-trip — I13); openings.csv projection
  incl. unknown-cost empty cell and provenance markers (I14)
- Independent adversarial package (implementation-blind P52 source, PR #53): pure oracles run
  everywhere via the standalone config (`pnpm exec vitest run --config
  tests/m16-independent/vitest.config.ts`); DB-gated economic/lifecycle/security/provisional/
  integration oracles bind execution-bound to the shipped atomic create-with-pulls surface
  (folded pulls, dedicated provisional RPC, total-paid slot — P53 §4 binding decisions recorded in
  helpers/contract.ts). First-contact classification at integration: ORACLE_BINDING_MISMATCH ×2
  adapted without loosening assertions (scalar lot dialect + folded pull attachment; provisional
  total-paid binder); UNEXECUTED_DB_GATED for everything needing the ephemeral stack. Its backup
  oracle arms the v2 BLOCKER: a generated post-M16 backup claiming v1 or missing
  openings/linkage fails the release. P62: discovery now enumerates the PostgREST OpenAPI with a
  dedicated AUTHENTICATED test user's JWT (a service-role fetch omits every user RPC under this
  project's exact grant model), so all implementation-gated oracles actually execute — 53/53,
  zero skips.

**M16 DB CI status:** EXECUTED FOR REAL AGAINST LOCAL POSTGRESQL (P60 execution + P62 repair and
re-run). GitHub Actions remains billing/startup-blocked repo-wide, so P60 reproduced the entire
db-tests CI job on this machine against an ephemeral local Supabase/Postgres stack (Docker
Desktop; repo-pinned CLI), and P62 re-ran it green after repairing what that first real execution
exposed: two runtime SQL bugs in the unhosted M16 migrations (provisional path wrote a
nonexistent `holdings.sealed_intent`; `openings` carried a `set_updated_at` trigger without the
column), the F-61-1 late-replay provenance seam, and the stale/binding test classes the run
adjudicated (CHECK-name semantics, backup v2 oracle, shared-catalog/FX fixture isolation, E15
recent-activity isolation). Final local gate state at the P62 head: fresh migrate from blank ✓;
db+authorization suites 578 passed / 0 failed / 1 opt-in skip (M13_EXPORT_PERF, executed
separately: ~10k lots exported in 2142 ms vs 60 s budget) ✓; grant audit clean ✓; hostile-grant
convergence via the M16 baseline ✓; m16-independent 53/53 with zero skips ✓; M12 scale audit,
10k-lot benchmark, snapshot performance/storage and price-snapshot storage all inside their
unchanged thresholds ✓. The hosted project is untouched; the first HOSTED execution remains the
pre-merge gate when CI or a manual hosted window exists.

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
- **The 10 000-lot Portfolio gate.** `scripts/portfolio-perf-benchmark.mjs` seeds an isolated
  synthetic account (never the owner's real one — M7 prompt §101) with 10 000+ lots — duplicates,
  five conditions, tags, storage locations, custom-collection membership, and (M9.1) real
  `price_snapshots` for ~70% of the variant pool so value_desc/low-value/missing-value exercise
  the resolver realistically — and times `list_portfolio` across every sort mode (3 repeated runs
  each, reporting first/median/max), filtered/scoped queries, both value_desc keyset pages and
  `portfolio_counts()`.
  **M9.1 wired this into CI itself** (`db-tests`, after the database/authorization suites): the
  script only needs the ephemeral stack's own local well-known service-role key, already exported
  for `pnpm test:db`, so the real 10k-lot timings are measured on every push rather than only when
  a session happens to have production credentials.
  **M9.2 fixed a real benchmark-validity defect (DECISIONS.md D-059):** immediately after the bulk
  seed, every seeded table's planner statistics are Postgres's literal "never analyzed" sentinel (a
  fresh ephemeral instance has had no autovacuum cycle in that short a window) — the planner falls
  back to no-information defaults and produces a catastrophic plan for *any* query touching those
  tables, `portfolio_counts()` included, regardless of that function's own shape. This is not a
  production risk (real holdings accumulate incrementally, and autovacuum's autoanalyze keeps
  statistics continuously current), but it made the benchmark measure the wrong thing. The script
  now runs `ANALYZE` on the seeded tables before timing anything — the same effect autovacuum
  provides in production, just synchronous rather than eventually-consistent — closing the gap
  between "milliseconds after a synthetic bulk insert" and a representative production state.
  **The benchmark now fails the step (non-zero exit, failing `db-tests`) if any call exceeds one
  generous catastrophic threshold (1.5s) or errors outright** — D-059's policy change: this defect
  class recurred three times without CI ever failing on its own benchmark, and with representative
  statistics guaranteed before every timed call, a multi-second result is no longer measurement
  noise. This is still not a tight per-sort millisecond budget (the "microbenchmark theatre" this
  section warns against) — it is one wide backstop wide enough that ordinary CI-runner variance
  cannot trip it. `scripts/portfolio-perf-explain.sql` (`--explain` flag, not run by default) is
  available for a future investigation: it captures real `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`
  evidence pre- and post-`ANALYZE`, impersonating the seeded synthetic user via the same JWT-claim
  technique Supabase's own stack uses. The milestone gate itself is still also behavioural — a real
  browser at this scale stays interactive, verified manually and recorded in
  HANDOVER.md/PROJECT_JOURNAL.md, not by this script's numbers alone.
- **Price-snapshot storage capacity.** `scripts/price-snapshots-storage-benchmark.sql`, also run in
  CI's `db-tests` job against the same disposable ephemeral database, seeds a representative
  365,000-row synthetic `price_snapshots` dataset (500 variants × 2 providers × 365 days) and
  measures real `pg_total_relation_size`/`pg_relation_size`/`pg_indexes_size` and the resulting
  bytes/row — the actual number COST_POLICY.md's capacity projection is built on, not the earlier
  computed estimate. Never run against a database holding real data.
- **M12 snapshot-engine gate.** `scripts/portfolio-snapshots-benchmark.mjs`, also a permanent
  `db-tests` step: seeds one synthetic account at realistic scale (~10k lots across ~400 days, a
  ~3,500-variant catalog with daily observations over the trailing 120 days for ~70% of it,
  disposals across time, manual valuations), ANALYZEs post-seed (D-059), then times full-cache
  rebuilds over 30/90/365-day ranges, one production-shaped mutation→queue→drain incremental
  cycle plus its idempotent repeat, and all four signed-in Home read RPCs; finally measures real
  `portfolio_snapshots` storage via `pg_total_relation_size`. Same single-generous-threshold
  policy as above: background rebuilds fail past 60s, Home reads past 1.5s, any outright error
  fails — a multi-second Home read is a defect, a slow-but-bounded background rebuild is a
  finding to investigate (prompt §99).

---

## 6a. Standing checklist — DROP+CREATE-ing a nontrivial function

D-054 (M9.1): M7.1's number-sort migration had to `DROP FUNCTION`+`CREATE FUNCTION` `list_portfolio`
(a new parameter changes a function's identity, so `CREATE OR REPLACE` was not available) and, in
retyping the body from scratch, silently reverted M7's real 10,000-lot performance fix back to a
per-holding `LATERAL` aggregate. CI's ephemeral fixtures were far too small to expose the regression;
it survived undetected until M9 needed to rewrite the same function anyway and a real benchmark
caught it.

Whenever a migration `DROP`s and re`CREATE`s a nontrivial function for a signature change:

- [ ] Diff the old and new function body side by side, not just against a mental model of "what
      changed" — a full retype makes it easy to silently lose an unrelated fix.
- [ ] Inspect the aggregate/join architecture specifically: materialized CTE + `GROUP BY` shapes
      are deliberate performance fixes in this codebase (`list_portfolio`, `portfolio_counts`,
      `select_price_sync_batch`) — a `LATERAL` correlated subquery reappearing is the specific
      regression class this checklist exists to catch.
- [ ] Explicitly confirm every known performance and security fix that touched the old body
      survived into the new one (grep DECISIONS.md/PROJECT_JOURNAL.md for the function's name).
- [ ] Run the relevant regression test — for `list_portfolio`/`portfolio_counts`, that means the
      real large-Portfolio benchmark (§7), not just CI's small fixtures.

Do not rely on developer memory for this. A migration that touches one of these functions should
treat this list as part of its own review, every time.

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
- [ ] M15 scanner on installed iPhone PWA: one permission prompt per cold start; zero prompts
      across a 20+ card in-route session; guide framing comfortable at arm's length; OCR reads
      real cards end-to-end; no upward memory drift across a long session (the standing P68
      IPHONE_DEVICE_GATE — Chromium cannot certify any of this)
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
