# P175 — Native financial write layer (identity-leased write seam)

Branch `feat/p175-native-financial-write-flows` (worktree `Pokemonapp-worktrees\p175`), based on P173's
final commit `0600361f71ee2dd5591fbbbfb2fe260ab68ba7a2`. Independently mergeable from P172 (no shared
commits beyond the P173 base). Local only: not pushed, no PR, nothing hosted changed.

Status: the native app can now **write** — add a card acquisition, record a purchase, record a sale,
open a sealed lot (minimal), and set/clear a manual valuation — through one identity-leased write seam,
with exact bigint money, blank-vs-zero/unknown semantics, and per-form idempotency. Read paths (catalog
search, Price Check, collection browsing) are byte-for-byte what P173 left them: an entirely separate
client, fetch guard and RPC allow-list.

## 1. Migration integration plan

P173's local stack was released 104 + P173's own `20260926120000_p173_search_cards_stable_paging.sql`
= 105 migrations. Full server-side finance semantics for the write flows this phase adds (a purchase
discount above the goods subtotal, a negative net proceeds on an uncosted sale, and the server-enforced
completed-event date bound) require P144's two migrations
(`20260918120000_p144_financial_boundary_semantics.sql`,
`20260918120010_p144_privilege_baseline.sql`), which predate P173's own migration by timestamp and touch
disjoint objects (P144: `create_purchase`/`update_purchase`/`allocate_purchase_discount`/the date-bound
triggers/the privilege baseline; P173: `search_cards`'s ORDER BY). Copied verbatim (not re-authored) from
the P144 worktree.

**Plan (executed and verified this phase):**

1. Copy the two P144 migration files into `supabase/migrations/` unmodified.
2. Copy P144's own updates to `scripts/grant-audit.sql` and `scripts/finance-integrity-diagnostics.sql`
   (the grant audit's expected-privilege list is a hand-maintained snapshot, not derived from the
   migrations at runtime — P144's patch added the one new grant `allocate_purchase_discount(bigint,
   bigint[], bigint[], bigint[])` to `authenticated`; the diagnostics script's date-bound queries needed
   the same 1996-10-20 / UTC-today+1 window P144 introduced).
3. Vendor P144's fixed `src/domain/allocation.ts` (the two-tier `allocatePurchaseDiscount` /
   `allocatePurchaseCharges` functions) — purely additive over the released file, and required so the
   purchase screen's client-side preview total matches what `create_purchase` actually computes.
4. Fresh `supabase db reset` on an isolated stack (own project id/ports): **107 migrations apply
   cleanly**, in filename-timestamp order (P144's two land before P173's one; verified no functional
   collision since they touch disjoint routines).
5. `grant-audit.sql` → "privilege baseline OK". `finance-integrity-diagnostics.sql` → all 45 keys zero
   on the fresh stack.
6. Ran P144's own DB test file (`tests/db/p144_financial_boundary.test.ts`, copied in for this purpose)
   against the 107-migration stack: **49/49 pass** — the migration's actual fixed behaviour (not just
   "applied without a SQL error") is verified: a receipt whose discount exceeds the goods subtotal
   succeeds and allocates exactly; a negative net proceeds succeeds for both known- and unknown-basis
   lots; the six completed-event date triggers accept 1996-10-20..today and refuse outside it.
7. Ran the **full root DB suite** (`pnpm test:db` at the repository root, not just the mobile-spike
   project) against the 107-migration stack: **732 passed, 13 failed, 1 skipped**. The 13 failures are
   all in `tests/authorization/invite_only.test.ts` / `tests/db/invitation_claims.test.ts`, failing with
   503 "name resolution failed" — the isolated mobile-spike stack's `edge_runtime` is deliberately
   disabled (`scripts/local-backend.mjs`'s `DISABLED_SECTIONS`, unrelated to this phase), so
   invitation redemption (which calls the `redeem-invitation` Edge Function) cannot succeed on this
   stack. This is the exact, previously-documented limitation of this isolated stack configuration
   (see P162 §WARNINGS), not a regression. No other suite failed: m8/m10/m11/m12/m13/m15/m16, P132/P133/
   P136/P138 all pass.

**Local migration count: 107** (released 104 + P144's 2 + P173's 1). **Hosted database: unchanged, still
104** — nothing in this phase touched Production or any hosted resource; a hosted migration is a
separate, owner-gated decision this phase does not make or recommend timing for.

**Order note for a later integrator:** if P144 is integrated into a release candidate through a
different path (e.g. cherry-picked rather than copied), reconcile migration filenames so the same two
files are not authored twice under different timestamps — check `supabase/migrations/` for an existing
`*p144*` pair before adding another.

## 2. The single write seam

Every financial write goes through one path:

```
screen/form (draft state, string inputs)
  -> write/money-input.ts / write/event-date.ts (pure validation, exact bigint, no Number())
  -> WriteFormStore.submit(renderedUserId, action)
       -> IdentityAuthority.begin(renderedUserId)   (a lease for the identity the screen was RENDERED under)
       -> runWithLease(lease, () => action(writeDb(lease), draft, idempotencyKey))
            -> write/write-db.ts's WriteDbBinder: one LeasedWriteDb PER LEASE (memoised)
                 -> write/leased-write-client.ts: a NEW supabase-js client whose accessToken
                    provider re-checks the lease AND the live session on every request
                      -> write/write-fetch.ts: an allow-list of exactly the 6 finance write RPCs
                           -> the real RPC (add_card_acquisition / create_purchase / create_sale /
                              set_manual_valuation / clear_manual_valuation / create_opening)
```

This mirrors the unreleased web branches' own design (P145's `IdentityLease`/`runWithLease`, P149's
`sessionForLease`/`AuthCredentialsUnavailableError`, P164/165's per-lease `LeasedDb`) — **ported, not
imported**, for the same reason P173 ported `IdentityAuthority` instead of importing P149: those
branches are not on `main`, and this native app must not silently depend on unmerged web work. The names
and semantics are deliberately identical so that adopting the released implementations later is an
import swap, documented per-file.

**Why a second `createClient`, not a second EXPORT of the same client.** The ambient `supabase` singleton
(`seam/supabase-client.ts`) stays exactly as read-only as P173 left it — Price Check, catalog search and
collection browsing cannot reach a write RPC even by accident, because their client's fetch guard
(`net/spike-fetch.ts`) never changed. The write seam's client is a **separate, ephemeral** instance per
identity lease, with its own fetch guard (`write/write-fetch.ts`) that allows only the six write RPCs
and nothing else — not a read, not the auth endpoints (a leased write client has no usable `auth`
subsystem: supabase-js makes `client.auth` throw once `accessToken` is set). `tests/unit/
read-only-vs-write-policy.test.ts` pins that the two allow-lists never overlap.

**Identity pinning in detail.** The lease is taken from `authority.begin(renderedUserId)` — the identity
the screen's Confirm button was rendered under, read from the screen's own `useStore(runtime.auth)`, NOT
`authority.userId` (a stale screen must not silently adopt whatever identity is current). The write
client's `accessToken` provider is the ONE place that reads a session on behalf of that lease
(`sessionForLease`): it re-verifies both that the lease's epoch is still current AND that the session
Supabase holds right now belongs to the lease's user, synchronously after the last `await` before
returning the token — so nothing between that check and `fetch()` can make the request authenticate as
anyone else. A request already in flight when the identity changes therefore still completes as the
identity it started under (the mission's "may finish as A, must never continue as B"); a request that
has not yet asked for a token is refused outright, before anything is sent.

## 3. What is implemented

| Flow | RPC | Scope |
|---|---|---|
| Add card acquisition | `add_card_acquisition` | Known cost (any bigint, incl. >2^53) or explicitly unknown (never a fabricated 0); quantity; date; notes. Origin fixed to `'other'` (the schema's most permissive origin for cost-basis state) — a gift/found-specific workflow with its own origin mapping is out of scope (see §5). |
| Record purchase | `create_purchase` | One line per receipt (the confirmed card from Price Check), quantity, unit price (known, required), shipping/customs/discount (optional, blank = 0), date, notes. The preview total is computed by the SAME pure allocator (`@shared/domain/allocation`'s `allocatePurchaseCharges`) the server uses — never re-derived. Multi-line receipts are supported by the RPC and the allocator; this phase's screen keeps to one line because there is no card picker inside the Collection tab to add a SECOND line's card yet. |
| Record sale | `create_sale` | One line, an existing lot (picked from the holding's own writable lots), quantity, price paid per unit (known, required), fees/shipping (optional). Known- and unknown-basis lots are sold through the identical call; the server alone decides `realized_result_nok_minor` (null for unknown, signed for known) — the client never computes or rejects a negative net. |
| Manual valuation | `set_manual_valuation` / `clear_manual_valuation` | An explicit amount (including an explicit 0) or Clear (return to the automatic resolved value) — two different requests, never conflated. |
| Record opening | `create_opening` | An ALREADY-OWNED sealed lot only. `create_opening` takes no cost argument at all, so "not a second spend" holds by construction. `trackingCompleteness` is always `'unknown'` (no pulled-card tracking); `create_opening_from_provisional` (buy-and-open, which also creates a purchase) is not implemented. |

**Not implemented (disclosed, not silent):** `update_purchase`, `void_purchase`, `update_sale`,
`void_sale`, `void_opening`, `create_opening_from_provisional`, retailer management (a purchase's
retailer/source is folded into free-text notes — there is no `p_retailer_id` lookup/creation RPC ported),
manual card/sealed-product creation (only catalog cards confirmed through Price Check can be acquired or
purchased), and multi-line purchases/sales in the UI (the domain and RPC support them; the screens do
not yet offer a second-line picker).

## 4. Forms, idempotency, identity adversarial behaviour

Each write screen has its own `WriteFormStore` (identity-scoped, registered in the runtime's
`ScopedRegistry` exactly like the existing collection/price-check stores):

- **Draft persistence**: a plain string-field draft per screen; `updateDraft` never touches the network.
  `ensureContext(freshDraft)` starts a NEW draft (and a NEW idempotency key) only when the entity the
  screen was opened for changes (`contextKey`) — navigating away to pick a lot and back keeps what was
  typed; opening the form for a different card/holding never shows the previous one's values.
- **Reset on identity change**: `reset()` (called by the registry's `onIdentityChange`, synchronously,
  before any re-render) clears the draft AND rotates the idempotency key. A → B: gone before B's first
  render. A → B → A: the second A gets a fresh instance's worth of state, never the first A's draft or
  key. Same-user token refresh: `reset()` is NOT called (`IdentityAuthority.observe` returns `false` for
  a repeat of the same user), so the draft and its key survive exactly as typed.
- **Idempotency**: one key per fresh form instance (`write/idempotency-key.ts`, a UUID), sent as
  `p_idempotency_key` and reused verbatim on every submit attempt until one SUCCEEDS, at which point a
  fresh key is generated for the next logical write. A FAILED attempt keeps the same key (so retrying is
  really a retry of the same attempt, per the RPCs' own idempotency contract — P107/P138/P140,
  unmodified). A second submit while one is still in flight is refused outright (no concurrent writes
  from one store); a `reset()` that lands mid-submit marks that submit's eventual result as superseded
  so it can never overwrite the fresh state it interrupted.
- **No write on open**: constructing a store, mounting a screen, or `updateDraft` never call the network
  — only an explicit `submit()` (behind a Confirm button) does.

## 5. Scope boundaries / blockers (for the next phase)

1. **Edit/void flows** (`update_purchase`, `void_purchase`, `update_sale`, `void_sale`, `void_opening`)
   are not implemented. The mission's own scope note ("edit/void flows only where existing backend
   contracts are mature") is read here as permission to defer all of them to a dedicated pass, since
   each has its own multi-line/ownership-check surface worth its own review.
2. **`create_opening_from_provisional`** (buy-and-open in one call, which also creates a purchase) is not
   implemented — it would duplicate the whole purchase-flow surface inside the opening form. The RPC is
   NOT in the write allow-list.
3. **Retailer management**: no `create_retailer`/`list_retailers` RPC is ported; a purchase's
   retailer/source name is appended to its free-text notes rather than silently discarded.
4. **Manual card / sealed product definitions**: only catalog items reachable through Price Check's
   search can be acquired or purchased. A "can't find this card" manual-entry flow is not built.
5. **Multi-line purchases/sales in the UI**: the pure domain and the RPCs already support N lines; only
   the screens are single-line, for lack of a second card/lot picker.
6. **Device / Hermes runtime execution**: the write-side money boundary (`write/money-input.ts`,
   `write/money-wire.ts`, `write/idempotency-key.ts`) is proven exact under Node (this phase's unit
   suite) and its bytecode compiles cleanly under `hermesc` 1.0.0 (`scripts/hermes-money-proof.mjs`,
   extended this phase with 12 new write-side checks, 31/31 passing under Node). It was **not** executed
   on an actual Hermes VM (emulator/device) in this phase — no release APK was built and no on-device
   driver was run, a deliberate scope cut given the size of the rest of this phase (see
   `output_175.txt`'s `WARNINGS`). The mechanism for that proof already exists
   (`EXPO_PUBLIC_RUNTIME_PROOF=1`, `src/diagnostics/runtime-proof.ts`, `scripts/android-runtime-check.mjs`,
   established by P166) and is the natural next step to extend with the write-side checks added here.
7. **Production**: not touched, not attempted. `config/backend-config.ts`'s guard against a hosted or
   Production origin was not weakened, consistent with P173's own precedent.

## 6. Test evidence

- **Unit** (`pnpm test`, no Docker): 513 tests, 52 files, all passing — including 10 new files covering
  the money-input parser, the money-wire serializer, the write-policy allow-list, the leased write
  client's identity checks (with a scripted `fetch` recording the Authorization header), the generic
  write-form store's idempotency/identity lifecycle, exact RPC wire shapes for all six writes, a
  structural check that the purchase screen uses the shared allocator, and the disjointness of the two
  RPC allow-lists.
- **Backend** (`pnpm test:backend`, real isolated local Supabase, synthetic data): 46 tests across 7
  files (17 skipped = the Deno-backed Price Check function tests, env-gated). The new
  `tests/backend/write-seam.test.ts` (9 tests) proves, against the REAL RPC surface: an acquisition's
  known cost above 2^53 stored exactly and its unknown cost never defaulting to 0; a purchase discount
  above the goods subtotal succeeding (the P144 migration, exercised through this exact call path);
  idempotent replay returning the same purchase with no duplicate row; a negative net proceeds on an
  unknown-basis lot succeeding with a null realized result; an explicit-0 manual valuation vs Clear as
  genuinely different requests; an opening consuming its source lot without creating a second purchase
  line; the write allow-list refusing an unimplemented RPC through the real transport; a lease refusing
  to produce a token once its session is signed out; and a same-tab A→B switch during an in-flight write
  completing as A, never as B. Every row this suite creates is tracked and removed in `afterAll` (FK-safe
  order), verified to leave `identity.test.ts`'s and `collection.test.ts`'s hardcoded seed counts
  (10,006 / 40 holdings) untouched on a fresh reset.
- **Mutation campaign**: 18 mutants (P1-P18, output_175.txt's own numbering) added to the existing
  `scripts/mutation-proofs.mjs` runner alongside the pre-existing M1-M18. 17/18 killed by this repo's own
  no-Docker runner; #9 ("opening creates a second spend") is not meaningfully source-mutable without a
  real database, so it is proven instead by the backend test's before/after `purchase_line_id` equality
  check against the real RPC, documented in the mutant's own title rather than silently skipped.
- **Migration / DB**: see §1.
