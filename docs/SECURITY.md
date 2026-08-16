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
| Edge Function → Postgres | `service_role`, bypasses RLS. Only two functions use it, both with narrow, audited jobs. |
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

`profiles.is_admin` grants exactly three abilities:

1. Create invitations
2. Revoke invitations
3. Disable a user account

It grants **no read access to any other user's collection, purchases, sales, openings or
valuations.** No RLS policy anywhere references `is_admin` for user-private data. Admin actions
are limited to `invitations` and a narrow `admin_disable_user` RPC, and every one writes an
`audit_event`.

Operational database access through the Supabase dashboard is a separate, infrastructure-level
capability. It exists, it is unavoidable for whoever owns the project, and it is deliberately
not mirrored into the application UI. Any invited user should understand that the project owner
has infrastructure-level access; this is stated in the README rather than pretended away.

---

## 5. Invite-only enforcement

Hiding a signup button is not access control. The enforcement chain:

1. **Dashboard:** email signup disabled at the Supabase Auth level; no OAuth providers enabled.
   Password auth means the sign-up endpoint would otherwise be an open door, so this must be
   verified as part of the invite-only test suite, not assumed from a dashboard toggle.
2. **Invitation creation:** admin-only RPC generates a high-entropy token, stores only
   `sha256(token)`, returns the plaintext once. Tokens carry `expires_at`, `max_uses` and
   `revoked_at`.
3. **Redemption:** the `redeem-invitation` Edge Function is the sole account-creation path. It
   validates hash, expiry, use count and revocation inside a transaction, creates the user with
   the service role, and records a `redemption` row.
4. **Backstop:** a trigger on `auth.users` rejects any insert without a matching redemption.

> **Invariant S2:** no `auth.users` row can exist without a corresponding invitation redemption.
> Tested by attempting direct signup against the public API.

Tokens are single-use by default, time-limited, and revocable. Revoking after redemption
disables the account rather than deleting data.

### 5.1 Passwords

Authentication is email plus password (see [ARCHITECTURE.md](ARCHITECTURE.md) §4). Supabase
handles hashing; the application never sees or stores a password. Requirements:

- Minimum length enforced server-side, not only in the form.
- Password strength checked against a common-password list at registration.
- Rate limiting on sign-in attempts (platform default: 30 per hour per IP, non-configurable).
- Password reset uses the built-in low-volume email provider. Reset tokens are single-use and
  short-lived. If delivery fails, an admin-assisted recovery path exists — it must require
  out-of-band confirmation of identity, because at this scale "a friend says they're locked out"
  is a plausible social-engineering vector even with ten users.
- Passwords are never logged, never included in error messages, never in test fixtures.

Choosing password auth over one-time codes trades a delivery dependency for a credential to
protect. That is the right trade here — but it does mean credential handling is now in scope
where it previously was not.

---

## 6. Secrets

| Secret | Where it lives | Ever in the client? |
|---|---|---|
| Supabase anon key | `.env.local`, build-time env | Yes — public by design |
| Supabase project URL | Same | Yes |
| Supabase `service_role` key | Supabase Edge Function secrets only | **Never** |
| Database password | Password manager, never in the repo | Never |

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
the UI says so and offers an export first.

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
