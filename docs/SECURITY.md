# Security Model

Proportionate to what this is: a private application for 1–10 known users holding personal
financial records and a valuable physical-asset inventory. Not enterprise compliance; not
security theatre either.

---

## 1. What is being protected

| Asset | Sensitivity | Why |
|---|---|---|
| Purchase and sales ledger | High | Personal financial history |
| Collection inventory and valuations | High | Discloses value and, combined with other data, location of valuable physical property |
| Storage locations | High | Names where physical cards are kept |
| Account identity (email) | Medium | Personal data under GDPR |
| Card catalog and market prices | None | Public facts |

The realistic adversaries are: an uninvited person trying to create an account, one invited user
reaching another's data, a leaked credential in the Git repository, and casual scraping of a
publicly reachable URL.

---

## 2. Trust boundaries

```
Untrusted ─── browser client ─── Supabase edge ─── Postgres (RLS) ─── data
                    │                    │
             anon key + user JWT    service_role key
             (public by design)     (server-side only, never shipped)
```

| Boundary | Control |
|---|---|
| Browser → Supabase | Anon key plus a user JWT. The anon key grants nothing on its own; RLS is the gate. |
| Edge Function → Postgres | The secret (`service_role`) key, which bypasses RLS. Exactly one function holds it — `redeem-invitation` — and it does nothing with it but call four named, narrowly-granted database functions and the Auth Admin API. |
| Repository → GitHub | Private repo, `.gitignore`, `.env.example` placeholders only, secret scanning. |
| External providers | Outbound only, server-side only, no credentials required by any current provider. |

**The client is never trusted.** Frontend filtering is a UX convenience. Every access rule is
enforced in Postgres.

---

## 3. Authorization: RLS

RLS is enabled on every table. There are no tables with RLS disabled and no `USING (true)`
policies on user data.

### 3.1 Shared catalog and market data

```sql
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY cards_read ON cards
  FOR SELECT TO authenticated USING (true);
-- no INSERT/UPDATE/DELETE policy: writes require service_role
```

Applies to `card_series`, `card_sets`, `cards`, `card_variants`, `price_snapshots`,
`sealed_price_snapshots`, `fx_rates`. Curated `sealed_products` follow the same pattern;
user-created rows add `OR created_by_user_id = auth.uid()`.

**`search_cards(...)` (M5)** is the one read path that is a function rather than a table grant: a
`SECURITY INVOKER`, `STABLE` Postgres function, `EXECUTE` granted to `authenticated` only (never
`anon` — ARCHITECTURE.md §2's "every screen is authenticated" holds here too). Invoker rights
because the function reads only tables `authenticated` can already `SELECT` directly; a `DEFINER`
would grant nothing a plain grant does not already. Every parameter is bound — nothing concatenates
caller input into SQL text — and `tests/authorization/catalog.test.ts` asserts wildcard/SQL-special
input degrades to "no match" rather than an error.

**`catalog_sync_runs` (M5)** is RLS-enabled with zero policies and zero grants to `anon` or
`authenticated` — the same shape as `invitation_claims` (§5.4): unreachable through the Data API
under every browser-held role, written only by `sync-catalog` under the service role.

### 3.2 User-private tables

Every user-private table carries `user_id uuid NOT NULL REFERENCES auth.users(id)` and:

```sql
CREATE POLICY <table>_owner ON <table>
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
```

`user_id` is **denormalized onto child tables** — `purchase_lines`, `acquisition_lots`,
`sale_lines`, `lot_disposals` — rather than reached through a join to the parent.

This is deliberate. A policy of the form
`EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id AND p.user_id = auth.uid())`
is correct but pushes a subquery into every row check and creates a class of bug where a child
row with a mismatched parent becomes invisible rather than rejected. A direct column plus a
trigger asserting `child.user_id = parent.user_id` is simpler to verify and faster.

> **Invariant S1:** for every child row, `child.user_id = parent.user_id`. Enforced by trigger,
> asserted by test.

`WITH CHECK` is mandatory on every policy. Without it a user can `UPDATE` a row they own and
reassign `user_id` to someone else.

### 3.2.1 M7: custom collections and the Portfolio browsing RPCs

`custom_collections` follows the plain user-private shape above with no RPC layer at all — create,
rename, delete and browse are ordinary owner-scoped table operations under RLS, the same shape as
`storage_locations`/`tags`. `custom_collection_members` has two parents (a collection and a
holding) and follows `holding_tags`' shape exactly: `user_id` denormalized, a trigger asserting it
matches *both* parents' owners (S1), no `UPDATE` policy since a membership row is inserted or
deleted, never edited. Deleting a collection cascades to membership rows only via a plain FK
`on delete cascade` — invariant C1, DATA_MODEL.md §5.2.1.

**M7.1**: `list_portfolio`'s signature grew a trailing cursor parameter for the new
`number_asc`/`number_desc` sort (DATA_MODEL.md §15) — dropped and recreated rather than
`CREATE OR REPLACE`d, since a new parameter changes a Postgres function's identity, and the
privilege baseline (`20260823120030_m71_privilege_baseline.sql`) restates the complete grant
surface the same way every prior milestone's baseline has. `natural_sort_key(text)` is a new
`IMMUTABLE SQL`, `STABLE`-safe helper with no table access at all — `authenticated`-only,
`PUBLIC` revoked like every other function since D-042.

`portfolio_counts()` and `list_portfolio(...)` are both `SECURITY INVOKER` (M7 prompt §74):
`authenticated` already holds `SELECT` on every table they read, so a `DEFINER` would grant
nothing a plain grant does not already, and RLS on `holdings`/`acquisition_lots`/
`custom_collection_members` applies to every statement exactly as if the caller had issued it
directly — the same reasoning `search_cards` and `add_card_acquisition` already use. Every filter
parameter is bound; the sort parameter is a Postgres enum, so an invalid value cannot even reach
the function body, and every `ORDER BY`/cursor comparison branches on that enum explicitly rather
than concatenating caller input into SQL text (M7 prompt §75).

### 3.2.2 M8: the purchase-ledger write surface and the FX cache

`create_purchase`/`update_purchase`/`void_purchase`/`purchase_spending_summary` follow exactly the
`add_card_acquisition` shape (§3.2.1's reasoning, restated): `SECURITY INVOKER`, ownership derives
from `auth.uid()` alone with no `user_id` argument to forge, and every statement they run is subject
to RLS exactly as if the caller had issued it directly. What *is* caller-supplied — a retailer id, a
storage location id, another purchase's line id — is checked explicitly: a new
`purchases_check_retailer_owner()` trigger (S1 defence in depth, the same pattern
`acquisition_lots_check_owner`/`holdings_check_manual_card_owner` already use) rejects a
`retailer_id` belonging to someone else, and `create_purchase`'s card-line path reuses
`acquisition_lots_check_owner`'s existing `storage_location_id` check for free, since it writes
through the same `INSERT INTO acquisition_lots` any other code path would.

`fx_rates` (DATA_MODEL.md §16) is market data, not user-private: `SELECT` for `authenticated`, no
`INSERT`/`UPDATE`/`DELETE` grant at all. Writes happen only inside the `fetch-fx-rate` Edge
Function under the service role, so no signed-in session — however many browsers it authenticates
from — can insert a hostile rate into another user's automatic FX resolution. A user's own manual
override never touches this table; it is a plain column on their own `purchases` row.

`fetch-fx-rate` itself requires a real user JWT (`verify_jwt = true` in `supabase/config.toml`,
unlike `redeem-invitation`/`sync-catalog`, which both have a documented reason to opt out). It talks
to exactly one fixed host (`_shared/norges-bank.ts`'s `NORGES_BANK_HOST` constant — no
caller-supplied URL, no SSRF surface), validates the currency code and date shape before making any
network call, bounds the request with an 8-second timeout, and structurally validates the response
shape before trusting any field in it.

### 3.2.3 M9: price snapshots, the watched-variant view, and the resolver surface

`price_snapshots` follows the exact `fx_rates` shape: market data, `SELECT` for `authenticated`, no
`INSERT`/`UPDATE`/`DELETE` grant to that role at all. Only the `ingest-prices` Edge Function, under
the service role, writes — no signed-in session can claim a fabricated Cardmarket/TCGplayer
observation, overwrite another variant's history, or poison the shared price series (prompt §10).

`watched_card_variants` (a view) and `price_sync_runs` (observability) carry **no grant to `anon`
or `authenticated` at all** — the same shape `catalog_sync_runs`/`invitation_claims` already
established. `watched_card_variants` spans every user's holdings by design (the ingest job needs to
know the union of everyone's owned variants), so exposing it to a browser-reachable role would leak
"someone on this app owns this card" in aggregate — a real, if narrow, privacy concern the schema
avoids by construction rather than by policy.

`resolve_variant_market_values`/`get_holding_value_provenance`/`get_card_variant_price_history`/
`get_market_movers` are `SECURITY INVOKER`, scoped entirely by `auth.uid()` — same reasoning as
every other M9-adjacent RPC (§3.2.1). `resolve_variant_market_values` takes an array of
`card_variant_id`s with no ownership check on the array itself (it only reads shared market data:
`price_snapshots`, `fx_rates`, and the caller's own `profiles.use_eu_pricing`), so a signed-in user
asking about a variant they do not own is not a privilege question — the same way `search_cards`
answers questions about cards nobody in particular owns. `get_holding_value_provenance`/
`get_market_movers` *do* check ownership, because they read `holdings`/`acquisition_lots` for a
specific holding or the caller's own portfolio.

`select_price_sync_batch`/`thin_price_snapshots` are `service_role`-only — never granted to
`authenticated`, and their bodies are not `SECURITY INVOKER` in the ownership sense (there is no
`auth.uid()` to scope by; they operate across every user by design, which is exactly why they must
never be reachable from a browser).

`search-prices` (Edge Function, on-demand catalog pricing for Search/Card Detail) requires a real
user JWT like `fetch-fx-rate`, validates a bounded (≤20) array of catalog `card_variant_id`s, talks
to the fixed TCGdex host only (no caller-supplied URL), and writes nothing — a search never becomes
persisted history (prompt §50). `ingest-prices`/`ingest-fx` are the operator-secret-gated shape
(`PRICE_SYNC_SECRET`, `verify_jwt = false`), called only by `pg_cron`/`pg_net` — see §6 for how the
secret itself is held.

### 3.2.4 M10: the sale ledger — SECURITY DEFINER, deliberately (DECISIONS.md D-060)

`create_sale`/`update_sale`/`void_sale` break the SECURITY INVOKER pattern every other write RPC in
this project follows, for a reason the M10 prompt (§107) states explicitly: frozen cost basis,
allocated amounts and realized result must be genuinely unreachable by a direct write, not merely
policed by a `CHECK` constraint after the fact — a materially stronger bar than M8 accepted for
`purchases.total_nok_minor` (still directly `UPDATE`-grantable, because `update_purchase`'s
SECURITY INVOKER body needs the grant, and the only exposure is a user corrupting their own private
ledger, never a cross-tenant issue).

**What this actually buys.** `authenticated` holds `SELECT` only on `sales`/`sale_lines`/
`lot_disposals` — **no** `INSERT`/`UPDATE` grant at all, verified directly in
`tests/authorization/m10_sales.test.ts` ("authenticated holds no INSERT/UPDATE grant on any of the
three tables, even for own rows"). Every write happens inside the three functions, which run with
the owning role's privileges rather than the caller's. What replaces the grant/RLS layer as the
authorization boundary is the same discipline every SECURITY INVOKER RPC in this codebase already
has: `v_user_id := auth.uid()` resolved once at the top, and every subsequent `SELECT`/`UPDATE`
explicitly filtered by `user_id = v_user_id` before it touches a caller-supplied id (a foreign
`lot_id` or `sale_id` therefore fails as "not found"/"unavailable", never confirming the row exists
— prompt §106, no cross-tenant existence oracle). "No `p_user_id` argument" and "derive the caller
from `auth.uid()`" — the parts of the SECURITY INVOKER convention that actually guard against
impersonation — are unchanged; only the INVOKER/DEFINER choice moves.

`recompute_lot_quantity_remaining` (the D1 trigger on `lot_disposals`, DATA_MODEL.md §5.7) is
SECURITY DEFINER for the identical reason, applied to `acquisition_lots.quantity_remaining` — the
one column a user could otherwise "revive" to sell twice.

`lot_cost_adjustments` (DATA_MODEL.md §5.6 — documented since M3, finally created in M10) gets
`SELECT` only, no `INSERT` at all: no validated write path exists yet (M17 owns the real "record a
grading submission" RPC), and a bare `INSERT` grant with no such validation would let a user inflate
their own cost basis by citing any unrelated purchase line of theirs.

**M11 preflight correction (documentation only, no behaviour change).** `acquisition_lots_check_owner`
(M3), `sale_lines_check_owner` and `lot_disposals_check_owner` (both M10) were written, and
commented, before this project had any SECURITY DEFINER RPC — each one's own inline comment says
something like "runs with invoker rights, so RLS hides a foreign row entirely." That is accurate
exactly when the INSERT/UPDATE that fires the trigger comes from a plain SECURITY INVOKER caller
(`create_purchase`, `add_card_acquisition`, `void_acquisition_lot`, and now `set_sealed_lot_intent`
— M11). It stops being the operative mechanism the moment the same trigger fires as a side effect of
a SECURITY DEFINER caller: `create_sale`/`update_sale`/`void_sale` writing `sale_lines`/
`lot_disposals`, or `recompute_lot_quantity_remaining` (itself DEFINER) writing
`acquisition_lots.quantity_remaining`. Inside a DEFINER function's execution, the statement that
fires the trigger runs as the function's *owning* role, not the original caller — a role RLS
typically does not constrain the same way it constrains `authenticated` — so "RLS hides the row"
is not actually available as a defence in that path.

It was never load-bearing there, either way. The real guarantee in every one of these trigger
functions is the explicit comparison written in its body —
`if parent_user_id is null or new.user_id <> parent_user_id then raise exception` (and the
equivalent for `sale_line_id`/`lot_id`) — which fires regardless of whether RLS was in effect for
the row it just read. Nothing a SECURITY DEFINER cascade does ever forges `holding_id`/`sale_id`/
`lot_id`/`user_id` on the row it writes (M10/M11's DEFINER functions each resolve and constrain
those explicitly before the write, per §3.2.4 above), so the comparison always has a genuine value
on both sides to check. The correct standing statement, replacing the older per-trigger comments
for reasoning purposes (the migration files themselves are not edited — DECISIONS.md/PROJECT_JOURNAL
convention is that applied migrations are historical record, not living documentation):

- Caller identity comes from `auth.uid()`, resolved once, never a caller-supplied argument.
- A SECURITY DEFINER function explicitly constrains the parent/lot ownership it writes against
  before writing (§3.2.4) — it does not rely on the trigger to catch a mistake it could have made
  itself.
- Every owner-check trigger explicitly compares a denormalized `user_id` against the actual parent
  owner it just read, independent of whether RLS filtered that read.
- RLS remains the real boundary for the browser's own direct `SELECT`/`INSERT`/`UPDATE` traffic
  (§3.1-3.2, unaffected) — it is just not the mechanism protecting a trigger invoked from inside an
  already-elevated DEFINER transaction, and no comment should claim otherwise going forward.

No test failed, no exploit exists today, and no SQL changed because of this — see
`ai_outputs/Claude_outputs/output_19.txt`'s M10 SECURITY PREFLIGHT section for the full audit trail.

### 3.2.5 P43: the full reset — the one deliberate SECURITY DEFINER destroyer (DECISIONS.md D-084)

`reset_my_portfolio_data()` is destructive and security-sensitive by design: it permanently
deletes every owned tracking row the caller has. The adversarial review it must satisfy:

1. **Why DEFINER at all.** Browser roles hold no DELETE grant on `acquisition_lots`,
   `purchases`/`purchase_lines`, `sales`/`sale_lines`/`lot_disposals`, `lot_cost_adjustments`,
   `manual_valuations` or `portfolio_snapshots`, and no grant whatsoever on
   `portfolio_recompute_queue` — that is D-060/§8's void-only ledger discipline. A SECURITY
   INVOKER reset would require handing raw DELETE on all of them to `authenticated`, permanently.
   DEFINER keeps every one of those grants exactly as narrow as before while adding EXECUTE on
   ONE function. The alternative (widening table grants forever so an INVOKER could work) is
   strictly worse.
2. **What confines it to the caller.** There is no user-id parameter anywhere in the signature;
   `v_user := auth.uid()` is resolved once and every DELETE filters `user_id = v_user`. No
   dynamic SQL exists; the statement list is fixed text. A caller therefore cannot aim it at
   another user even in principle — proven by a test asserting PostgREST finds NO overload
   accepting `p_user_id`.
3. **What it can never touch.** auth.users, profiles, invitations/claims/redemptions, shared
   catalog, price_snapshots, fx_rates, cron rows, and any other user's rows are outside its
   statement list entirely.
4. **Atomicity.** One function call = one PostgREST request = one transaction; the fixed
   child-before-parent FK order means any failure aborts with zero mutations. The queue row is
   deleted FIRST so a concurrently-running snapshot drain either waits for this commit and then
   finds nothing to do, or commits first and has its freshly written snapshots removed by this
   transaction's final statement — no committed state ever shows stale values or a stuck
   "Updating" flag.
5. **Grants posture.** Revoked from PUBLIC/anon/authenticated at creation, granted back to
   authenticated only; restated in the P43 privilege baseline; asserted in
   `scripts/grant-audit.sql`; anon-denial and cross-user behaviour covered in
   `tests/authorization/p43_reset_history.test.ts`.
6. **Residual risk, disclosed.** A mid-reset concurrent write by the SAME user (impossible from
   one browser session doing one click, but not from two sessions) would simply be deleted like
   any other row — reset is documented as destroying everything the user owns, so that is the
   contract working, not a leak.

### 3.3.1 M12 derived cache and engine (implementation candidate)

The snapshot layer adds one new class of surface — a service-owned write path with no browser
counterpart — and holds it to the same three-statement discipline (§5.9):

- **`portfolio_snapshots` is owner-read-only.** RLS policy `portfolio_snapshots_select_own`
  scopes rows to `auth.uid()`; there is no INSERT/UPDATE/DELETE policy and no browser write
  grant at all. The sole writer is `rebuild_portfolio_snapshots` under `service_role`, so a
  browser cannot forge, inflate or erase its own history — asserted at the privilege level,
  not merely as an RLS row rejection (`tests/authorization/m12_dashboard.test.ts`).
- **Queue and run log are invisible.** `portfolio_recompute_queue`/`portfolio_recompute_runs`
  follow the `invitation_claims` shape: RLS enabled, zero policies, zero grants to
  anon/authenticated. The dashboard's "Updating…" signal comes from
  `m12_recompute_pending_for_self()`, a DEFINER function answering exactly one boolean about
  exactly `auth.uid()`. It holds an explicit `authenticated` EXECUTE grant — required, because
  `get_dashboard_summary` calls it as a nested function call and PostgreSQL checks EXECUTE on
  such references — and is safe by construction: no user-id parameter, hardcoded `auth.uid()`,
  one boolean about the caller's own queue row. It cannot be aimed at another user regardless of
  who calls it (`tests/authorization/m12_dashboard.test.ts`).
- **Engine routines are service/internal-only.** `rebuild_portfolio_snapshots`,
  `drain_portfolio_recompute_queue`, `enqueue_portfolio_daily_maintenance` and
  `enqueue_portfolio_recompute` are SECURITY DEFINER (the minimal departure that shared
  market-data triggers and the pg_cron worker require), each with fixed empty `search_path`,
  no dynamic SQL, and every statement scoped to an explicit target user. EXECUTE is revoked
  from PUBLIC/anon/authenticated; only `service_role` holds it on the three worker-facing
  functions. A browser calling any of them — including `rebuild_portfolio_snapshots` with
  another user's id, the exact attack the design exists to forbid — fails at the grant level.
- **Invalidation triggers never leak or mutate.** Shared-market-data triggers (price writes,
  retention thinning, FX) fan out queue rows statement-level via transition tables, so a batch
  enqueues once, not per row; they write only queue metadata — never purchases, sales or cost
  basis (prompt §95). Trigger functions are revoked from named roles too; PostgreSQL does not
  require EXECUTE for implicit trigger firing (the same production property that lets
  `supabase_auth_admin` fire `handle_new_user`), so user-facing writes are unaffected while a
  direct `selects.enqueue_portfolio_recompute(...)` from a session is impossible.

### 3.3 Attack surface the tests must cover

- Direct read of another user's row by id
- `UPDATE`/`DELETE` of another user's row by id
- Reassigning `user_id` on a row the attacker owns
- Reading another user's data through a join or embedded PostgREST resource
  (`/purchases?select=*,purchase_lines(*)`)
- Inserting a child row pointing at another user's parent
- Reading another user's Storage objects
- Enumerating `profiles` beyond one's own row
- Calling any RPC with another user's id as an argument

Each is a named test in the authorization suite. See [TESTING.md](TESTING.md) §4.

---

## 4. Admin role

`profiles.is_admin` grants exactly two abilities today:

1. Create invitations (`create_invitation`)
2. Revoke invitations (`revoke_invitation`)

Disabling an account is a third intended capability. `profiles.disabled_at` exists for it, but no
RPC does yet — it arrives with the milestone that gives it a workflow, alongside `audit_events`,
which is likewise not yet a table (DATA_MODEL.md §12). Until then, disabling is an infrastructure
operation, not an application one, and this document does not pretend otherwise.

Admin status grants **no read access to any other user's collection, purchases, sales, openings or
valuations.** No RLS policy anywhere references `is_admin()` for user-private data — the only
policies that call it are on `invitations` and `invitation_redemptions`, which are the admin's
own management surface rather than anybody's private records.

The one thing admin legitimately sees about another person is the address they were invited at, and
`invitation_redemptions` links that address to a user id. That link is the closest thing to a
bridge into user-private data, so it has its own negative test: holding it opens nothing else.

Admin is also not a privilege level in the database. The privileged redemption internals
(`claim_invitation`, `finalize_invitation_redemption`, `release_invitation_claim`) are granted
to `service_role` alone and are refused for an admin exactly as they are for anyone else.

Operational database access through the Supabase dashboard is a separate, infrastructure-level
capability. It exists, it is unavoidable for whoever owns the project, and it is deliberately
not mirrored into the application UI. Any invited user should understand that the project owner
has infrastructure-level access; this is stated in the README rather than pretended away.

---

## 5. Invite-only enforcement

Hiding a signup button is not access control. Implemented in M4; every claim below is asserted by
a named test in `tests/authorization/invite_only.test.ts`.

> **Invariant S2:** no `auth.users` row can exist except as the result of redeeming an invitation
> token the redeeming party actually possesses.

The adversary this is written against knows the project URL, holds the publishable key, knows an
invited person's email address, ignores our frontend, edits the JavaScript, and calls
`/auth/v1/signup` directly with a body of their choosing.

### 5.1 Two gates

**Gate 1 — the Before User Created auth hook.** `public.before_user_created` rejects
unconditionally, with a 403 and a message naming the reason.

GoTrue invokes this hook on every self-service account-creation path — password signup, magic link,
anonymous, OAuth, SAML, OIDC, Web3, admin invite-by-email. It does **not** invoke it from the Auth
Admin API. Verified by reading `supabase/auth` at master: `triggerBeforeUserCreated` is called from
`signup.go`, `mail.go`, `anonymous.go`, `external.go`, `web3.go`, `samlacs.go`, `token_oidc.go` and
`invite.go`, while `internal/api/admin.go` contains no hook invocation at all.

That asymmetry is the whole design. Because the only account-creation path we use is the Admin API,
called from a server-side function that has already proven token possession, the hook needs to
inspect nothing. There is no metadata to forge, no address to be "on the list", and no window to
race.

It also fails in the right direction. If a future GoTrue release started calling the hook from the
Admin API too, redemption would stop working and the authorization suite would fail loudly, rather
than the gate quietly opening.

**Gate 2 — a `BEFORE INSERT` trigger on `auth.users`.** `public.enforce_invited_signup` demands a
live row in `invitation_claims` matching the address, and consumes it in the same transaction as
the insert it authorizes.

The hook is configuration: it lives in `supabase/config.toml` and reaches a project through
`supabase config push`. A trigger travels with the migrations and cannot be left un-toggled in an
environment. The trigger also closes what the hook does not — creating a user through the Auth
Admin API or the Supabase dashboard — so even service-role access cannot mint an account outside
the redemption flow without deliberately writing a claim first.

### 5.2 Why not "allow signup if this address has an invitation"

Because it would be a hole, not a gate. If the hook permitted public signup for any address with an
outstanding invitation, anyone who knew that address could call `/auth/v1/signup` and choose the
password before the invited person ever opened their link. **Knowing an address is not possessing
the token.** Making the hook deny everything, and creating accounts only through a path that proves
token possession first, removes the attack rather than narrowing its window.

For the same reason, nothing in the enforcement chain reads `user_metadata`. Anything a public
signup client can send is attacker-controlled by definition, so it can never be the authorization.

### 5.3 What `enable_signup` does not do

An earlier draft of this document listed "disable email signup at the dashboard" as step one. That
toggle (`[auth] enable_signup`) does not do what its name implies: disabling it also disables the
email/password *login* grant for every existing user, not only new self-registration — a documented
GoTrue behaviour (supabase/gotrue#330), confirmed empirically when it broke sign-in for
admin-created test users in M3's CI. It stays at the platform default and is **not** part of the
enforcement chain.

### 5.4 The invitation itself

| Property | How |
|---|---|
| Unguessable | 32 bytes from `gen_random_bytes`, base64url — 256 bits, 43 characters |
| Never stored | Only `encode(sha256(token), 'hex')` reaches the database |
| Never re-readable | `create_invitation` returns the raw token once; `token_hash` has no column-level SELECT grant for `authenticated`, so not even an admin can read it back |
| Address-bound | `invitations.email` fixes the account the token can create; a redeemer's own address in the request body is ignored |
| Time-limited | `expires_at`, default 7 days, configurable between 1 hour and 30 days |
| Single-use | `max_uses`, default 1, counted from claims |
| Revocable | `revoke_invitation` stamps `revoked_at` and drops any in-flight claim |

SHA-256 rather than bcrypt or argon2 is deliberate. Password hashing is slow because a password has
perhaps 40 bits of entropy and must survive an offline dictionary attack. A 256-bit CSPRNG token
has no dictionary, so a slow hash has nothing to slow down. What matters is that the database never
holds anything replayable as a token, even to someone holding a full dump — and a fast
cryptographic hash gives exactly that. Lookup is equality on the hash through a unique index: a
comparison of hashes, never of the secret, and no hand-written byte comparison anywhere.

### 5.5 Redemption, and what happens when it fails

`redeem-invitation` is the sole account-creation path. Three steps, in this order:

1. `claim_invitation` — validates the token hash, expiry, revocation and remaining uses under a
   `FOR UPDATE` lock on the invitation row, then issues a two-minute claim.
2. `auth.admin.createUser` — creates the account. Gate 2 spends the claim inside GoTrue's own
   transaction.
3. `finalize_invitation_redemption` — records the redemption and increments `use_count`.

Availability is counted from claims — consumed ones plus live unexpired ones — rather than from a
stored counter. That is what makes failure deterministic: a redemption that dies after claiming
releases its hold when the claim expires, with no cleanup job, and **no sequence of failures can
burn an invitation permanently**. A rejected password releases the claim immediately rather than
waiting out the two minutes.

Concurrency is handled by the database, not by a check-then-act in application code: the row lock
serializes claims on one invitation, and a partial unique index on
`invitation_claims (email) WHERE consumed_at IS NULL` makes a second live claim for an address
impossible. Two simultaneous redemptions of one invitation produce exactly one account.

The account is created with `email_confirm: true`. Confirmation would be theatre here: an
administrator chose the address and delivered a 256-bit secret to it out of band, and possession of
that secret is stronger evidence of control over the address than a confirmation click. It also
keeps account creation off the built-in mail provider's two-emails-per-hour budget, which is
reserved for password recovery. **The trust assumption is explicit:** the owner is responsible for
sending an invitation link only to the person they intend, over a channel they trust. The link is
the credential.

### 5.6 The initial administrator

There is no "first user to register becomes admin" path, and no email address hardcoded anywhere.
Bootstrapping an environment takes privileged database access, once, and is documented in
[DEVELOPMENT.md](DEVELOPMENT.md) §7: issue an invitation with `created_by` null through the SQL
editor or `psql`, redeem it through the ordinary UI, then set `is_admin` on that profile with the
same privileged access. The bootstrap runs through the same two gates as every other account.

`profiles.is_admin` has no client UPDATE grant at all — the column is excluded from the
column-level grant, so a user cannot set it regardless of any RLS policy. Promotion is a
service-role operation.

### 5.7 Passwords

Authentication is email plus password (see [ARCHITECTURE.md](ARCHITECTURE.md) §4). Supabase handles
hashing; the application never sees or stores one.

- **Minimum 12 characters**, enforced by GoTrue server-side (`minimum_password_length`), so it
  holds for any caller. Re-checked in `redeem-invitation` before the invitation is claimed, so a
  too-short password never consumes one.
- **No composition rules.** `password_requirements` is empty. Requiring "one uppercase, one symbol"
  reliably produces `Passw0rd!` and fights password managers; NIST SP 800-63B advises against it.
- **A short obvious-password list**, plus rejection of near-single-character passwords and
  passwords containing the address' local part. Deliberately not a breach corpus: Supabase's
  HaveIBeenPwned check is a paid-plan feature, and shipping our own would cost more than it buys
  for ten invited users choosing a 12-character password.
- **Maximum 72 bytes**, rejected rather than truncated, because bcrypt silently ignores the rest.
- Rate limiting on sign-in is the platform default (`sign_in_sign_ups`, 30 per 5 minutes per IP).
- Passwords are never logged, never in error messages, never in test fixtures.

### 5.8 Password recovery

Self-service recovery uses the built-in low-volume email provider — around two auth emails per hour
project-wide, described by Supabase as best-effort. For five to ten users that is an acceptable
recovery channel, and it is precisely why account creation sends no email at all. Reset tokens are
single-use and short-lived. The request form confirms unconditionally, so it does not become the
account-enumeration oracle the Supabase API deliberately is not.

If delivery fails, an **admin-assisted path** exists. It is documented and manual rather than a
polished UI, because at this scale "a friend says they're locked out" is a plausible
social-engineering vector even with ten users:

1. The owner confirms identity **out of band**, over a channel already associated with that person
   — not over email, and not through whatever channel made the request.
2. The owner generates a recovery link with the Auth Admin API
   (`generateLink({ type: 'recovery' })`) and delivers it over that confirmed channel.
3. The person sets their own password through the ordinary reset screen.

An admin never types, sets or reads another user's password. The old password is never revealed and
never needs to be.

### 5.9 The privilege surface, and why it is stated rather than inferred

RLS decides which **rows** a session sees. SQL privileges decide which **tables and columns** exist
for it at all. M4 shipped an escalation because those two were confused: `profiles` had a
column-restricted `UPDATE` grant that was intended to exclude `is_admin`, the deployed project had
already granted `authenticated` everything on that table, and **a `GRANT` adds — it never
restricts**. A signed-in non-admin could set their own admin flag. The authorization suite was
green, because it tested behaviour and every behaviour it thought to try was correct.

The fix is not "remember to be careful". It is three independent statements of the same fact, each
of which can fail:

| Leg | What it asserts | Where it runs |
|---|---|---|
| `supabase/migrations/20260820157000_m5_privilege_baseline.sql` | The **current** intended surface, as revoke-then-grant — supersedes `20260820140000_m41_privilege_baseline.sql` for this purpose without editing it | Every environment, applied |
| `scripts/grant-audit.sql` | That the catalog agrees, privilege by privilege | CI, and by hand against a deployed project |
| `scripts/remote-security-check.mjs` | That none of it is exploitable, holding only a publishable key | By hand, after any deploy |

**A pure-privilege baseline migration needs restating, not just extending, whenever a milestone
adds a browser-reachable table or function.** Found by M5's first real CI run, not by inspection:
the hostile-grant convergence test below re-applies "the baseline migration" by a fixed filename,
and that file's own sweep (`revoke execute on all routines ...`) revokes every function's grant,
including ones written after it. Re-applying only the M4.1 file converges to a stale surface. Each
milestone that adds to the browser-reachable surface should therefore create a new pure-privilege
migration restating the *complete* current grant list (M5's does; PROJECT_JOURNAL.md has the
failure), and point the CI convergence step at that newest one.

`grant-audit.sql` is written as a second, independent statement of intent, not as a summary of the
migration. If the two disagree, one is a defect — do not reconcile by copying the database's
answer into the expectation.

**The rule every future migration answers to.** A migration that creates a table, view or function
in `public` ends with an explicit `revoke … from anon, authenticated` and then grants back exactly
what is intended, and updates the baseline assertion. An object with no privilege decision is a
defect, not a default. Naming a column list in a `GRANT` limits nothing if the role already holds
more.

**System-owned columns.** Every user-owned table now grants `UPDATE` by column list. Absent
everywhere: `id`, `user_id`, `created_at`, `updated_at`, the parent foreign key on child rows, and
the provenance columns (`purchases.origin`, `acquisition_lots.origin`,
`sealed_products.created_by_user_id`). RLS already stops a row moving to another user; taking these
out of the grant means that is no longer the only thing stopping it. `INSERT` stays whole-table:
`user_id` must be writable on insert, and RLS `WITH CHECK` is the correct mechanism for a value the
client legitimately supplies.

**What CI proves, and what it cannot.** CI applies the migrations to an empty database, so on its
own it can only ever demonstrate that a clean database ends up clean — which is exactly why it
missed the escalation. It therefore also makes the database *wrong* first
(`tests/db/sql/hostile_grants.sql`, the legacy auto-expose state the deployed project was in),
proves the audit rejects that state, re-applies the baseline, and proves it converges. The middle
step is not decoration: an audit that cannot fail is not a check.

**The PUBLIC-EXECUTE blind spot, closed in M7 (D-042).** PostgreSQL grants `EXECUTE` on a newly
created function to `PUBLIC` by default — a separate ACL entry from anything granted to or revoked
from a *named* role, so `REVOKE ... FROM anon, authenticated` never touches it. Through M6,
`grant-audit.sql` only ever compared `anon`/`authenticated` grants against an expected list, so a
function that skipped the "revoke ... from public" step at creation (the convention M4 established
after finding exactly this gap for three named-role grants) could carry a live PUBLIC grant the
audit could not see. M7 closes this the same three-part way as the named-role surface: a one-time
`revoke execute on all routines in schema public from public` sweep in the privilege baseline, an
`alter default privileges ... revoke execute on functions from public` so a future function that
forgets the per-creation revoke does not arrive PUBLIC-executable either, and a new PUBLIC-grant
check in `grant-audit.sql` asserting the expected PUBLIC-EXECUTE surface on every `public`-schema
routine is empty (`invitation_status`'s deliberate `anon` reachability is a named-role grant, not a
PUBLIC one, and is unaffected). `tests/db/sql/hostile_grants.sql` now also grants blanket PUBLIC
execute as part of its hostile state, so the convergence test proves this new check can fail before
proving the baseline fixes it.

**One accepted exception.** `supabase_admin` holds default privileges in `public` granting `anon`
and `authenticated` everything on tables, sequences and functions, in the local stack and in a
hosted project alike. They are unreachable — `postgres` is not a member of that role — and they are
harmless, because a default privilege attaches only to objects its own role creates and everything
in `public` here is created by `postgres`. The audit records that grantor as accepted and fails on
any other. It also checks the resulting grants independently, so if the assumption ever stops
holding, it surfaces as a failure rather than as silence.

**`graphql_public` is not a second door.** The Data API exposes `public` and `graphql_public`;
pg_graphql resolves against the same tables under the same role, so it is bounded by the same RLS
policies and the same column grants. It widens nothing, and needs no separate baseline.

## 6. Secrets

| Secret | Where it lives | Ever in the client? |
|---|---|---|
| Supabase publishable key (`VITE_SUPABASE_PUBLISHABLE_KEY`) | `.env.local`, build-time env, Cloudflare Pages env | Yes — public by design |
| Supabase project URL | Same | Yes |
| Supabase secret key | Edge Function environment only, injected by the platform via `SUPABASE_SECRET_KEYS` | **Never** |
| Database password | Password manager, never in the repo | Never |
| Supabase CLI access token | `supabase login` keyring, never in the repo | Never |
| `CATALOG_SYNC_SECRET` (M5) | Edge Function environment (`supabase secrets set`), plus the operator's own shell environment when running `scripts/run-catalog-sync.mjs` | **Never** |
| `PRICE_SYNC_SECRET` (M9) | Edge Function environment (`supabase secrets set`) **and** Supabase Vault (`select vault.create_secret(..., 'price_sync_secret', ...)`), so `pg_cron`/`pg_net` can read it at call time | **Never** |

**`CATALOG_SYNC_SECRET` is not the Supabase secret key and is not a step up from a CI deploy key**
(D-035). It gates exactly one capability — invoking `sync-catalog` — and is checked with a
constant-time comparison against a single bearer header. It is never the Supabase secret key, never
placed in `.env.local`, and no code path ships it to the browser bundle.

**`PRICE_SYNC_SECRET` (M9) is the same shape, gating `ingest-prices`/`ingest-fx`, with one added
wrinkle: the *caller* is `pg_cron` via `pg_net`, running inside the database itself, not an operator
script with its own shell environment.** A scheduled SQL command cannot read an Edge Function's
environment variable, so the secret is additionally stored in Supabase Vault
(`vault.create_secret`) and read back at call time via `vault.decrypted_secrets` — never as a
literal in migration SQL, never logged, never printed into a Claude session or `ai_outputs/`.
Setting both copies (the Vault secret and the matching Edge Function secret) is a one-time,
deliberate act against the real project, the same trust level as setting `CATALOG_SYNC_SECRET` —
this session generated the value itself via `supabase secrets set`/`vault.create_secret` and never
displayed it. If the secret is ever rotated, both copies must be updated together or scheduled
ingestion starts failing closed (a 401 from the Edge Function) rather than silently — a safe
failure mode, not a security gap.

**Current hosted key model (M6, D-039).** `pokeportfolio-dev` uses named
`sb_publishable_…`/`sb_secret_…` keys, created through the dashboard and never printed into a
session — `supabase projects api-keys` is not used, because that exact command is what returned the
legacy secret into a transcript in M5 (see PROJECT_JOURNAL.md). Edge Functions read the secret from
`SUPABASE_SECRET_KEYS` (a JSON map, `supabase/functions/_shared/service-key.ts`), falling back to
the legacy `SUPABASE_SERVICE_ROLE_KEY` environment variable only because that is the shape the
*local* Supabase stack still emits — the fallback exists for `supabase start`, never for a deployed
project. The frontend reads `VITE_SUPABASE_PUBLISHABLE_KEY` (renamed from `VITE_SUPABASE_ANON_KEY`
in the same migration). The legacy `anon`/`service_role` keys are deactivated, not deleted, once
the new pair is verified working end to end — reversible if a missed client turns up depending on
them, and does not invalidate any issued user session, since deactivating an API key and rotating
the JWT signing secret are different operations.

Three vocabulary layers, kept distinct so a future session does not conflate them: the **current
hosted keys** above (what `pokeportfolio-dev` actually uses); the **local stack's legacy fixture
variables** (`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`, still emitted by `supabase start` and
read only by `tests/db/setup.ts` and CI's ephemeral stack — never a real project); the
**browser-safe key** (whichever of the two client-visible forms is in play, public by design,
RLS is the actual gate); and the **privileged backend key** (whichever of the two server-only forms
is in play, never shipped to a client, never fetched by a command that prints the whole key set).

Rules:

- `.env*` is gitignored except `.env.example`, which contains variable **names** and placeholder
  values only.
- No secret is ever written into documentation, log output, error messages, test fixtures or
  commit messages.
- All client-visible variables are prefixed `VITE_`. Anything without that prefix is not
  reachable from the bundle, which makes the split reviewable at a glance.
- `gitleaks` runs in CI once CI exists, and is documented as a pre-publication step regardless.

If a secret is ever committed: rotate first, then remove. Deleting it in a later commit does not
remove it from history — see [PUBLICATION_CHECKLIST.md](PUBLICATION_CHECKLIST.md).

---

## 7. Storage

Not used in MVP. When images arrive in V1:

- Private buckets only; no public bucket for user uploads.
- Object paths are prefixed with the owner's uid: `user-images/{auth.uid()}/...`.
- Storage RLS policies match the path prefix against `auth.uid()`.
- Access through short-lived signed URLs, never public links.
- Uploads validated on content type and size, re-encoded server-side, EXIF stripped
  (phone photos carry GPS coordinates — a real disclosure risk for an inventory of valuables).
- Catalog card artwork is hotlinked from the provider CDN, not copied into our storage. See
  [API_SOURCES.md](API_SOURCES.md) for the licensing reasoning.

---

## 8. Destructive operations

Financial records use void semantics rather than deletion where downstream references exist
(see [DATA_MODEL.md](DATA_MODEL.md) §9). Every void, hard delete and identity correction writes
an `audit_event`.

Confirmation dialogs name the concrete downstream impact — "this purchase is the source of an
opening with 3 tracked pulls" — rather than asking a generic "are you sure?".

**Account deletion** removes all user-private data by cascade and deletes the `auth.users` row.
Catalog and market data are unaffected. The action requires re-authentication and is irreversible;
the UI says so and offers an export first. No UI exists yet — the capability arrives with its own
milestone — but the cascade behind it is real as of M4: every `user_id` foreign key to
`auth.users` declares `ON DELETE CASCADE`, which M3 had left as the default `NO ACTION`,
making deletion impossible for any user who owned a single row. `invitations.created_by` is the
deliberate exception, using `ON DELETE SET NULL`, because an invitation is an audit record of an
administrative action and outliving its issuer is the point.

---

## 9. Transport, sessions, logging

- HTTPS only. HSTS at the Cloudflare Pages edge.
- Supabase sessions in `localStorage` with refresh-token rotation, which is the trade the SPA
  model implies; the mitigation is short access-token lifetime and no XSS surface (no
  `dangerouslySetInnerHTML`, no user-supplied HTML rendering).
- A strict Content-Security-Policy is set at the edge, allowing the Supabase origin and the
  provider image CDN and nothing else.
- Logs never contain monetary amounts, collection contents, tokens or full email addresses.
  Edge Function errors log the provider, the operation and a variant id — never a user's data.

---

## 10. Dependency and supply chain

- `pnpm` with a committed lockfile; `--frozen-lockfile` in CI.
- Dependabot for security advisories, batched.
- New dependencies require a stated reason. The current list is intentionally short:
  React, TanStack Router/Query, Supabase JS, Tailwind, Base UI, lightweight-charts, Zod, Vitest,
  Playwright.
- No `curl | sh` installs. No postinstall scripts from unvetted packages.

---

## 11. Threats accepted without further mitigation

Stated explicitly rather than left implicit:

| Threat | Position |
|---|---|
| Project owner has infrastructure DB access | Inherent to self-hosting the project. Disclosed, not engineered around. |
| Supabase compromise | Outside our control. Mitigated only by data minimisation and export availability. |
| XSS leading to session theft | Mitigated by React's default escaping, CSP, and no HTML injection surfaces. Not further hardened. |
| An invited user photographing their own screen | Not a technical problem. |
| Traffic analysis, timing attacks, side channels | Out of scope for a ten-user hobby application. |
| DDoS | Cloudflare's default protection; no further work. |

---

## 12. Security checklist per milestone

Every milestone that adds a table or an endpoint must confirm:

- [ ] RLS enabled on every new table
- [ ] `WITH CHECK` present on every write policy
- [ ] `user_id` denormalized and trigger-asserted on new child tables
- [ ] Authorization test added for the new surface
- [ ] No new secret reachable from the client bundle
- [ ] Destructive paths write an `audit_event`
- [ ] No user data in new log statements
- [ ] Any new `SECURITY DEFINER` function pins `search_path = ''` and uses no dynamic SQL
- [ ] **Privileges are revoked before they are granted.** A `GRANT` adds; it never restricts.
      `revoke all on <table> from anon, authenticated` (or `revoke execute on function … from
      public, anon, authenticated`) and then grant back exactly the intended set. Naming a column
      list in a `GRANT` does not limit the role to those columns if it already held more.
- [ ] **The privilege baseline in `scripts/grant-audit.sql` was updated** for every new table,
      view, function and column, and CI is green on it. §5.9.
- [ ] The deployed project was verified, not just CI. Run `scripts/remote-security-check.mjs`
      after any deploy touching auth, invitations, policies or grants.

The last three are not generic advice. They were written after the deployed project and CI
disagreed — the second time about whether a signed-in user could set their own `is_admin` flag. See
PROJECT_JOURNAL.md, 2026-08-20.

### 12.1 M16 openings checklist (applied)

- RLS: `openings` is owner-SELECT only — NO browser INSERT/UPDATE/DELETE grant or policy exists;
  every write happens inside SECURITY DEFINER RPCs (the D-060 frozen-figure standard), so there is
  no write policy to check by construction.
- `openings_check_owner()` trigger re-asserts ownership of the source lot, the denormalized sealed
  product identity and both referenced purchases on EVERY write path including privileged direct
  writes; `lot_disposals_check_owner` / `acquisition_lots_check_owner` were extended full-body
  with opening-linkage checks.
- All four writers are SECURITY DEFINER with `search_path = ''`, no dynamic SQL, caller identity
  from `auth.uid()` alone, explicit ownership verification of every caller-supplied id inside the
  body (DEFINER bypasses RLS — verified explicitly, the M11 bug-5 rule). Reads (`get_opening`,
  `list_opening_sources`) are SECURITY INVOKER over ordinary RLS rows.
- Idempotency keys are scoped by composite `(user_id, idempotency_key)` uniqueness — one user's
  key can never collide with, replay, or reveal another's operation; cross-user material mismatch
  is refused identically to not-found (no existence oracle).
- Authorization suite covers anon denial across all six functions, cross-user open/read/void/
  reconcile/pull-attach attacks, admin-promotion granting nothing, forged provisional-link and
  opening_id attachments, and direct-write grant refusals.
- Error mapping in the UI layer never echoes raw PostgreSQL internals, UUIDs or financial
  payloads to logs or screens beyond the concise mapped messages.

---

## 13. Deployment gate

Nine checks, run **against the environment that was deployed to**, after applying migrations,
pushing config, or deploying a function. Not after a green CI run — CI is a reproducibility gate
and says nothing about a deployed project. This list exists because every item on it was true in CI
and one of them was false on the real project.

|   | Check | How |
|---|---|---|
| 1 | Public signup is blocked | `POST /auth/v1/signup` → 4xx, message names the invite-only hook |
| 2 | Auth Admin create without a claim is blocked | Covered by the authorization suite; on a deployed project, by the fact that redemption is the only path that works |
| 3 | A valid invitation redeems | `scripts/remote-security-check.mjs` phase 2, with `INVITE_TOKEN` set |
| 4 | A normal user cannot self-promote | Read `is_admin` back after the `PATCH`, not just the status code |
| 5 | User A cannot read user B | Two sessions, or the suite |
| 6 | `token_hash` is unreadable, by anyone | `GET /rest/v1/invitations?select=token_hash` → 4xx |
| 7 | Privileged functions are unreachable | `claim_invitation`, `finalize_…`, `release_…`, `hash_invitation_token`, `before_user_created` |
| 8 | The auth hook is active on **this** project | It lives in `config.toml`, so it arrives via `supabase config push` — never a dashboard toggle |
| 9 | The privilege surface matches | Paste `scripts/grant-audit.sql` into the SQL editor; clean means no rows |

1, 3, 4, 6, 7 are what `scripts/remote-security-check.mjs` automates from the attacker's side with
nothing but a publishable key. 9 is the catalog's own answer, and is the check that would have
caught M4's escalation before a user could.
