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
| `supabase/migrations/20260820140000_m41_privilege_baseline.sql` | The intended surface, as revoke-then-grant | Every environment, applied |
| `scripts/grant-audit.sql` | That the catalog agrees, privilege by privilege | CI, and by hand against a deployed project |
| `scripts/remote-security-check.mjs` | That none of it is exploitable, holding only a publishable key | By hand, after any deploy |

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
| Supabase publishable key (legacy: `anon`) | `.env.local`, build-time env | Yes — public by design |
| Supabase project URL | Same | Yes |
| Supabase secret key (legacy: `service_role`) | Edge Function environment only, injected by the platform | **Never** |
| Database password | Password manager, never in the repo | Never |
| Supabase CLI access token | `supabase login` keyring, never in the repo | Never |

Supabase is migrating from `anon`/`service_role` JWTs to `sb_publishable_…`/`sb_secret_…` keys,
with the legacy pair deprecated at the end of 2026. The security semantics are unchanged — one is
public by design, the other never leaves the server — and the local stack still emits the legacy
pair, so both names appear in this repository. Remote projects use the new keys.

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
