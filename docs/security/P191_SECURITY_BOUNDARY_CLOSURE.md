# P191 — Security boundary closure (P130-13, -14, -20, -26, -29, -30, -36, -09)

Development RC only (PR #113). Nothing here is merged to `main`, deployed, or applied to the hosted
project. Three new migrations (`20261003120000`, `…0010`, `…0020`; 114 in the tree) are an owner-gated
release step like every other unreleased migration. Decision record: DECISIONS.md D-191.

| Item | Status | One line |
|---|---|---|
| P130-13 direct-edit ledger grants | **CLOSED** (in the RC; hosted DB unchanged) | A write gate refuses direct client writes to the five ledger tables; ten INVOKER writers announce themselves. Grants deliberately unchanged. |
| P130-14 private sealed-product id oracle / pin | **CLOSED** (in the RC; hosted DB unchanged) | Reproduced three ways, fixed by an ownership trigger and by taking `id` out of the client INSERT grant. |
| P130-20 password change | **OWNER_ACTION_REQUIRED** | Local config enforces reauthentication for stale sessions and is tested against the real Auth service; the hosted project's setting is the owner's. |
| P130-26 raw technical errors | **CLOSED** (web and native UI) | One closed vocabulary; static audits fail on any new raw read. Residual: developer-only scanner debug panel. |
| P130-29 CI hygiene | **PARTIALLY_CLOSED** | Runners and pnpm pinned, every remaining input classified. Several inputs are version-pinned, not hash-pinned (table below). |
| P130-30 model / ONNX supply chain | **PARTIALLY_CLOSED** | Download bounded; a floating Android ONNX runtime found and pinned; an unverified NuGet install download stopped. No upstream binary attestation exists to check against. |
| P130-36 advisories | **CLOSED as a review**; no shipped-path advisory | 29 web / 2 native advisories, none reachable in a shipped artefact; classified below, none upgraded for show. |
| P130-09 stale deployment loses typed input | **CLOSED** | Add card, Add sealed, Manual card and the Openings wizard now defer an automatic reload while dirty. |

## 1. P130-13 — direct-edit ledger grants

### Access map (read from the live catalog, `tests/db/p191_definer_hygiene.test.ts`)

`authenticated` held INSERT/column-UPDATE on `purchases`, `purchase_lines`, `acquisition_lots`,
`holdings` (also DELETE) and `manual_valuations` because the functions that legitimately write them are
`SECURITY INVOKER` and run with the caller's own privileges. The sale family (`sales`, `sale_lines`,
`lot_disposals`, `lot_cost_adjustments`) and `openings` already had **no** write grant: their writers are
`SECURITY DEFINER`.

| RPC | Mode | Writes | Reads (beyond catalog) | Intended caller |
|---|---|---|---|---|
| `add_card_acquisition` | INVOKER | holdings, acquisition_lots, manual_valuations, purchases, purchase_lines | storage_locations, sealed_products | web, native scanner/add |
| `create_purchase`, `update_purchase`, `void_purchase` | INVOKER | purchases, purchase_lines, holdings, acquisition_lots, manual_valuations | retailers, fx | web, native |
| `void_acquisition_lot`, `remove_holdings_from_portfolio`, `reduce_holding_quantity`, `set_sealed_lot_intent` | INVOKER | acquisition_lots (+holdings, purchases) | holdings, lot_disposals | web |
| `set_manual_valuation`, `clear_manual_valuation` | INVOKER | manual_valuations | holdings | web, native |
| `create_sale`, `update_sale`, `void_sale` | DEFINER, `search_path=''` | sales, sale_lines, lot_disposals | acquisition_lots | web, native |
| `create_opening`, `create_opening_from_provisional`, `void_opening`, `reconcile_opening_cost` | DEFINER | openings, lots, holdings, purchases, lot_disposals | — | web, native |
| `reset_my_portfolio_data` | DEFINER | everything the user owns | — | web |
| account purge, erasure, restore-gate functions | DEFINER, operator-only | per P189 | — | service role only (not browser-executable; asserted) |

Direct client writes the clients really make (and the gate allows): `holdings.is_favorite`,
`holdings.notes`, `acquisition_lots.storage_location_id`, `acquisition_lots.acquired_on`,
`acquisition_lots.notes` (found by searching `src/data` and the native `src`).

### Why not revoke, and why not flip to DEFINER

Revoking the table grants breaks the ten INVOKER writers. Making them DEFINER would silently drop RLS
from every statement in ten large bodies — each query would need re-auditing for cross-user reach, and
a miss is a silent cross-user hole. (A dedicated definer *role* would avoid that by keeping RLS applicable,
but creating it and granting it `authenticated` cannot be verified against the hosted project from here.)

### The gate

`20261003120000_p191_ledger_write_gate.sql`: a `BEFORE INSERT/UPDATE/DELETE` trigger
`a00_ledger_write_gate` on the five tables. If `current_user` is `authenticated` or `anon` **and**
`app.ledger_write` is not `rpc`, it refuses (42501) — except an UPDATE whose changed columns are all in the
organisational set above. The ten INVOKER writers re-create themselves verbatim with one added first
statement, `perform set_config('app.ledger_write','rpc',true)`. Definer-owned functions, `service_role` and
operators run as another `current_user` and pass untouched. A function-level `ALTER FUNCTION … SET
app.ledger_write` would have needed no body edit, but Postgres refuses a non-superuser that `SET`
("permission denied to set parameter" — observed on the local stack, same image family as hosted).

What keeps a client from setting the flag: PostgREST gives a request no `SET`/`set_config`
(`tests/db/p191_ledger_write_gate.test.ts` calls `set_config` as a client: refused, and the ledger stays
locked). **Residual, stated:** the flag is transaction-local, so inside a *raw SQL* transaction that has
called a writer it stays set until commit. A client has no raw SQL; an operator already bypasses the gate.

Fail-closed maintenance: a later migration that re-creates a writer from an old copy loses the line, the
gate refuses the writer's own statements, and every test of that RPC fails. `scripts/grant-audit.sql` also
asserts, independently of the migration, that the five tables carry the gate and the ten writers carry the
call. No grant changed for this item.

### Evidence

- 16 tests (`p191_ledger_write_gate.test.ts`): hostile direct writes by user A on all five tables
  (insert purchase / change amount / void; insert or change a line; insert lot, rewrite
  `quantity_remaining`, basis, residual, void; insert/retype/delete a holding; insert a manual valuation;
  another user's rows), the allowed organisational edits, a mixed update refused whole, every official RPC
  still succeeding, catalog completeness.
- 23 tests (`p191_definer_hygiene.test.ts`): every DEFINER function pins `search_path`; no
  browser-executable function takes a user-id/owner/uid argument; anon executes exactly one function; the
  sale/opening/adjustment tables refuse direct writes; user A calling twelve financial RPCs on user B's ids
  leaves B's ledger byte-identical.
- The whole pre-existing suite (1183 tests before) passes; six legacy authorization tests that **created
  fixtures through direct client inserts** now create them with the service role (the attacks they assert
  are still client attempts, and the underlying S1 owner triggers are additionally exercised under the
  service role). That is a deliberate rewrite, not a weakening.

## 2. P130-14 — private sealed-product id oracle

**Reproduced first** (before any fix), as user B naming user A's private product id:

1. `INSERT INTO holdings … sealed_product_id = A's id` was **accepted** where a random UUID raised 23503 —
   existence signal; the accepted row then made A's product undeletable (A's DELETE failed 23503) and made
   A's account purge fail closed: one user blocking another's erasure.
2. `INSERT INTO sealed_products (id = A's id …)` raised 23505 where a random id succeeded.
3. The RPC paths (`create_purchase`, `add_card_acquisition`, `create_opening_from_provisional`) were already
   uniform.

**Fix.** `…0010_p191_sealed_product_visibility.sql`: a `SECURITY DEFINER` (`search_path=''`) trigger on
`holdings` and `purchase_lines` allows a sealed reference only if the product is curated or created by the
row's own `user_id`, raising **one** error (23503, no key in the detail) for "missing" and "not yours".
`openings` needs none: `openings_check_owner` already pins it to the source lot's holding. `…0020`
restates the privilege baseline with `sealed_products` INSERT granted **per column excluding `id`**
(`scripts/grant-audit.sql` gained `expected_column_insert`). A pre-flight warns (does not abort) if
existing rows already violate the rule; to look for them on the hosted project:

```sql
select 'holdings' t, count(*) from holdings h join sealed_products s on s.id=h.sealed_product_id
 where s.created_by_user_id is not null and s.created_by_user_id <> h.user_id
union all
select 'purchase_lines', count(*) from purchase_lines l join sealed_products s on s.id=l.sealed_product_id
 where s.created_by_user_id is not null and s.created_by_user_id <> l.user_id;
```

**Contract.** For a product the caller cannot see, the answer is the answer for an id that does not exist.
Timing equality is not asserted. `tests/db/p191_sealed_product_oracle.test.ts` (15 tests): random, other-user
private, deleted, malformed, own, curated, and eight rapid probes over every write path; the one
`tests/db/p152_account_deletion.test.ts` case that *constructed* the pin now asserts the construction is
refused and builds a legacy row with the trigger disabled to keep proving the purge still fails closed.

## 3. P130-20 — password change

**What `secure_password_change` means (verified, not assumed).** In the CLI source it maps to GoTrue's
`SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION` (`apps/cli/src/commands/start/services/gotrue.service.ts`,
`apps/cli-go/pkg/config/auth.go`). The CLI reference page describes the key as "requires the current
password"; that is wrong for this key. Semantics, observed against local GoTrue v2.195.0
(`tests/authorization/p191_password_change.test.ts`): a session **created within 24 h** may change the
password; an older one gets `reauthentication_needed` and must call `auth.reauthenticate()` and send the
emailed nonce; a made-up nonce gets `reauthentication_not_valid`. **Reproduced the gap:** with the setting
off, a 25-hour-old session changed the password with no further proof.

| Case | With the setting on |
|---|---|
| stolen but **stale** session (>24 h) | cannot change the password without the emailed nonce |
| stolen **fresh** session (<24 h) | can — the setting does not protect this window |
| recently authenticated (recovery link) | can; this is the product's only password-change path |
| MFA / OAuth account | MFA and every external provider are disabled in the local config (the hosted settings were not checked); an OAuth-only account has no password to change |

So this is a reduction, not full verification. The stronger control — "require current password when
updating" — is a **separate hosted setting** (`SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` in the
dashboard source; supabase-js ≥ 2.102 `updateUser({password, current_password})`) with **no key in this
CLI version's `config.toml`**, so it cannot be set or tested locally; it is part of the owner action.

**Done in code.** `supabase/config.toml`: `secure_password_change = true` (CI's stack uses it).
`src/auth/password-update-error.ts` maps `reauthentication_needed|_not_valid`, `same_password`,
`weak_password`, `session_not_found` and 401 to fixed copy; the recovery page uses it. The product has no
nonce flow on purpose: a stale session is told to request a new reset link. No native password-change flow
exists. The D-139 client identity check stays.

**Owner action (hosted project, not done by P191).** Supabase Dashboard → Authentication → the Email
provider / Security settings: enable **Secure password change** (API field
`security_update_password_require_reauthentication`) and **Require current password when updating**;
then run `tests/authorization/p191_password_change.test.ts`-style checks by hand. Production Auth is not
touched in this phase.

## 4. P130-26 — raw technical errors

`src/platform/user-error.ts`: `userMessage(error, context?)` answers from a **closed vocabulary** —
connection problem, session expired, not authorized, invalid input, temporary service issue, could not be
completed, price unavailable. Only a `UserFacingError` (or `InvalidMoneyInputError`) passes its own text,
and even that is refused if it matches `TECHNICAL_DETAIL`. `FxRate*`, delivery and identity errors became
`UserFacingError`s. About thirty rendering sites changed (login/password flows were already fixed text;
Price Check, scanner, exports, purchase/sale/opening/acquisition/holding/profile forms and sheets now go
through it). Native already rendered fixed `classifyFailure` text; no raw read was found.

Guards: `tests/ui/user-error.test.ts` (representative injected failures: unique violation, RLS, schema-cache
miss, rpc path, edge-function path, JWT, check constraint, stack trace, 503), `tests/config/ui-error-exposure.test.ts`
and native `p191-user-facing-errors.test.ts` — static audits whose allowlists carry a **per-file count**, so
one new `error.message` read in an already-allowlisted file fails too. Residual: the developer-only
`?scannerDebug=1` panel (P130-41) and the dev build-config refusal screen show diagnostics by design.

## 5. P130-29 — CI / supply chain

| Input | Class | Pin / source / update |
|---|---|---|
| GitHub Actions (checkout, setup-node, cache, upload-artifact) | IMMUTABLY_PINNED | 40-hex commit SHAs (P190); bump deliberately |
| gitleaks image | IMMUTABLY_PINNED | `v8.30.1@sha256:c00b6bd0…` (P190) |
| pnpm | IMMUTABLY_PINNED | `packageManager` now carries the registry tarball's sha512 (corepack verifies; a wrong hash was shown to fail). Update: `npm view pnpm@X dist.integrity` → hex |
| Runner | VERSION_PINNED | `ubuntu-24.04` (was `*-latest`, which moves on 2026-10-19). Bump deliberately |
| Node | VERSION_PINNED | `.nvmrc` exact `24.19.0` (setup-node downloads from the Node distribution; no hash) |
| npm packages incl. wrangler, Playwright, Supabase CLI | VERSION_PINNED | exact lockfile versions with registry integrity; installs `--frozen-lockfile` (now tested) |
| Playwright browsers | VERSION_PINNED | determined by the locked Playwright version, downloaded from its CDN (no hash) |
| Supabase stack images | VERSION_PINNED (transitive) | chosen by the CLI version; this repository names no tag. Not digest-pinned — overriding the CLI's image list is not maintainable |
| `psql` (apt, only if absent) | MUTABLE_TAG (distro) | signed apt repo; the runner image normally ships it |
| model + index | IMMUTABLY_PINNED | HF revision + SHA-256 per file (P130-30) |

`tests/config/workflow-supply-chain.test.ts` additionally fails on floating runners, piped installers,
`npx`/`pnpm dlx`, an unfrozen install, `@main`/floating-major actions, `:latest`, an unhashed `packageManager`
and a non-exact `.nvmrc`; every check has a mutation.

## 6. P130-30 — model and ONNX supply chain

**Download path** (`scripts/scanner-visual-index/lib/pinned-download.mjs`, used by the web and native
staging scripts): source `https://huggingface.co/<repo>/resolve/<pinned revision>/<file>`; **timeout** 120 s
on the request *and* the body read (a stalled stream is a timeout); **size** ceiling = pinned size + 1 KiB
(1 MiB when unpinned), enforced while streaming, `Content-Length` checked early; **redirects** followed
manually, https only, ≤ 5, hosts limited to `huggingface.co` / `*.hf.co`; **verification** SHA-256 and exact
byte count against the pin; bytes go to a temp file and are renamed in only after the hash matches, so
nothing unverified is ever at the destination, and a failure never falls back or retries to anything.
Verified live against Hugging Face (the model's CDN redirect passes the host policy). 17 tests.

**Where each runtime comes from**

| Runtime | Source | Version | Finding / action |
|---|---|---|---|
| Web (browser) | npm `onnxruntime-web` via `@huggingface/transformers` | `1.26.0-dev.20260416-…` (a **dev build**, locked) | lockfile integrity only; noted |
| Node tooling | npm `onnxruntime-node` | 1.24.3 | its `postinstall` downloads **CUDA provider binaries from NuGet on linux/x64 — i.e. on the GitHub runner — with no integrity check**. Never used here. **Closed:** removed from `pnpm.onlyBuiltDependencies` (CPU binaries ship in the tarball) |
| Native JS + glue | npm `onnxruntime-react-native` | 1.24.3 | exact, lockfile integrity, patched |
| **Android runtime** | Maven `com.microsoft.onnxruntime:onnxruntime-android` | upstream asks for **`latest.integration`** | **Floating.** Maven Central's latest is 1.30.0 against a 1.24.3 JS package; P186's shipped arm64 `libonnxruntime.so` is 32,990,472 B, whereas 1.24.3's is 25,831,632 B — the shipped runtime was **not** 1.24.3. **Pinned** to 1.24.3 in the pnpm patch (new `patch_hash`); the dead extensions AAR line stays floating and a test asserts extensions stay off |
| iOS runtime | CocoaPod `onnxruntime-c` | pinned to the package version by `with-ios-onnxruntime-pin` | no pod hash |

Observed provenance of the pinned AAR (not an attestation): Maven Central `…/onnxruntime-android/1.24.3/`,
40,948,335 B, SHA-256 `67397e4a970e75617f765d2015ceaf911917e1d822276cfb5792744e8085cbce`; a detached `.asc`
exists upstream and was **not** verified. A Gradle `verification-metadata.xml` using that hash is the
follow-up if the owner wants build-time enforcement. **Consequence:** the Android runtime changes
(1.30.x → 1.24.3) — §9 records the emulator run.

## 7. P130-36 — advisories (`pnpm audit`, 2026-10-02)

Root: 3 low, 11 moderate, 15 high, 0 critical. Native: 1 moderate, 1 high. **Production dependency
closure (`--prod`): 2 high (`sharp` via `@huggingface/transformers`), nothing else.**

| Package | Advisory class | Path | Classification |
|---|---|---|---|
| `sharp` < 0.35.4 (libvips, libheif) | high ×2 | devDependency + `@huggingface/transformers` (Node-only optional) | **TRANSITIVE_UNREACHABLE** in the shipped web bundle (the built `dist/` contains no sharp/libvips; browser build resolves it to nothing) and **DEV_ONLY** in the offline index/benchmark scripts, which decode remote card images on the developer's machine. **UPGRADE_AVAILABLE (0.35.4)** but **deliberately not applied**: the scanner's committed index was built through this preprocessing and the parity tests pin it; a resize change is a model-quality change, not a patch |
| `fast-uri`, `brace-expansion` ×7 | high/moderate | `vite-plugin-pwa>workbox-build`, `eslint>minimatch` | DEV_ONLY (build/lint time), not in `dist` |
| `undici` ×10 | high/moderate/low | `wrangler>miniflare` | DEV_ONLY (deploy tooling) — wrangler is pinned to 4.134.0; bump with wrangler |
| `vitest`, `@vitest/mocker` | moderate | test runner | DEV_ONLY; in-range patch exists (4.1.11) |
| `node-forge` ≤ 1.4.0 | high | `expo>@expo/cli` | DEV_ONLY (build CLI); **NO_FIX_AVAILABLE** |
| `uuid` < 11.1.1 | moderate | `expo>@expo/config-plugins` | DEV_ONLY (build time) |

No high or critical advisory is reachable in a shipped artefact (web `dist/` scanned; native app bundles
neither Expo CLI nor config-plugins). Nothing was upgraded to quiet the audit.

## 8. P130-09 — stale deployment and typed input

The deferral mechanism already existed (`unsaved-work-registry`, consulted by the freshness runtime, the
banner and the router). It covered purchase, sale, their edit forms and the scanner batch; P191 registers
**Add card, Add sealed product, Manual card and the Openings wizard** with their own baselines (reset on a
user or entity change, so another account never inherits a dirty form; blank and `0` are different
snapshots; money stays the typed string). No draft persistence was invented. If the user chooses "Reload
now" the typed input is lost, as for the forms that were already covered. `tests/ui/p191-unsaved-form-coverage.test.ts`:
every form id is present, a dirty source defers the reload and a clean one lets it proceed, and with no
source the reload happens (mutation).

## 9. Android check of the pinned runtime, and what was not verified

**Run (emulator, x86_64, own stack/AVD, release build with R8):** `gradlew assembleRelease` resolved
`onnxruntime-android:1.24.3@aar` and built (4 m 40 s). The APK's `lib/x86_64/libonnxruntime.so` is
**31,316,520 B — exactly the 1.24.3 AAR's x86_64 library** (P186's shipped x86_64 runtime was 39,348,480 B, a
different release). `scripts/p186/smoke.mjs`: steps 1–5 and 7–9 **pass** — dark cold launch, sign-in, scanner
entry, a real synthetic image recognised on-device through OCR + ONNX (candidate shown), Add to Collection
form with nothing written, cancel, Collection list. Logcat: fatal 0, ANR 0, OOM 0, native crash 0,
`NoClassDefFoundError` 0. **Step 6 (Price Check) failed in this ad-hoc environment:** the app showed
its honest "price provider failed — not a price of zero" state because the mock provider was not wired to this
stack's port; it is a read-only path unrelated to the ONNX runtime and was not re-run to green. One
`ortOrMlKit` logcat hit is Google Play services failing to download an optional ML Kit module (no network).
Cold photo→result took ~23 s on this software-rendered emulator (not comparable to P186's figures).

Not verified: arm64 (no device; static only, as in P186); iOS (no Mac); the hosted project (migrations, Auth
settings — untouched, owner-gated); the 1.24.3 AAR's PGP signature (present upstream, not checked).

## 10. Mutation proofs (all killed)

Each was applied to the working tree or the live local database, the named suite run, and the change
reverted (a first run's two survivors were an unreachable test input and a no-op `sed`; both were fixed and
re-run): direct purchase / lot write allowed (gate disabled), direct sale update granted, DEFINER without
`search_path`, browser function with a user-id parameter, sealed visibility trigger disabled (holdings,
purchase_lines), `sealed_products.id` insertable again, an INVOKER ledger writer without the flag, the audit
accepting a missing gate, `error.message` rendered in a web and a native screen, downloader without timeout /
with no size bound / accepting a wrong hash / following any redirect, the stale reload ignoring the registry,
a form no longer registering, `ubuntu-latest`, `onnxruntime-node` install allowed, an auth message shown on
password failure.
