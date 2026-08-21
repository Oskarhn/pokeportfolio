# Development Environment

Target: Windows 11 with PowerShell. Nothing here should be machine-specific.

---

## 1. Toolchain

| Tool | Version | Install |
|---|---|---|
| Node.js | 24.19.0 (Active LTS) | `winget install OpenJS.NodeJS.LTS` — installed 2026-08-16 |
| pnpm | 10.15.0, pinned via `packageManager` | See note below |
| TypeScript | 6.0.3 (pinned, not the newer 7.x line) | See note below |
| Git | 2.51.1+ | Present |
| GitHub CLI | latest | `winget install GitHub.cli` — installed 2026-08-16 |
| VS Code | latest | Present |
| Supabase CLI | latest | `pnpm add -D supabase` (project-local, version-pinned in the lockfile) |
| Docker Desktop | optional | Only needed for a local Supabase stack — see §4 |

Node 24 is Active LTS as of August 2026. Note that from October 2026 Node moves to one major
release per year with calendar-aligned numbering; revisit the pin then.

The version is pinned in three places that must agree: `.nvmrc`, `package.json` `engines`, and
`packageManager`. CI reads `.nvmrc`.

**pnpm** over npm for a strict, non-flat `node_modules` — a package cannot import something it
did not declare, which prevents a class of bug that only appears in CI. The lockfile is
committed and CI installs with `--frozen-lockfile`.

**pnpm activation note (this machine).** `corepack enable` fails with `EPERM` here because the
global Node install under `C:\Program Files\nodejs` is not user-writable without elevation. The
working alternative, used for this environment, is `npm install -g pnpm@10.15.0` (npm's global
prefix is the user-writable `%APPDATA%\npm`), with the exact version also pinned in
`package.json`'s `packageManager` field so CI and any machine where Corepack *does* work both
resolve to the same pnpm. CI uses `corepack enable && corepack prepare --activate`, which reads
that same pin.

**TypeScript pin note.** `create-vite` currently scaffolds TypeScript 7.x, but `typescript-eslint`
(the linting stack this project uses) caps its peer range at `<6.1.0` as of 2026-08-17. TypeScript
is pinned to the latest 6.x (`6.0.3`) so linting works; revisit the pin once `typescript-eslint`
publishes 7.x support.

---

## 2. First-time setup

```bash
corepack enable
pnpm install
cp .env.example .env.local
```

Then fill `.env.local` with values from the Supabase project dashboard. `.env.local` is
gitignored and must never be committed.

| Variable | Client-visible | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | Publishable key (M6, D-039; formerly `VITE_SUPABASE_ANON_KEY`/the legacy anon key) — public by design, RLS is the gate |
| `SUPABASE_PROJECT_REF` | no | CLI target for migrations |

`pnpm test:db` additionally reads `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` from the process environment (not `.env.local` — these are shell
exports, deliberately not part of the app's own env file, and deliberately still the legacy names:
this is what `supabase status -o env` actually prints for the **local** stack, which has not
changed). Locally: `pnpm db:start`, then export the three values from
`pnpm exec supabase status -o env`. In CI, the `db-tests` job exports them itself from the
ephemeral stack it starts — see `.github/workflows/ci.yml`. The service-role value here is the
**local** stack's well-known development key, not a production secret; it is still never written
to a committed file.

The Supabase secret key is **never** placed in any `.env` file in this repository. It lives only
in the Edge Function environment, injected by the platform as `SUPABASE_SECRET_KEYS` on
`pokeportfolio-dev` (M6) — `supabase/functions/_shared/service-key.ts` reads it, falling back to
the legacy `SUPABASE_SERVICE_ROLE_KEY` only for the local stack. Any variable without the `VITE_`
prefix is unreachable from the browser bundle, which makes the split reviewable at a glance.

---

## 3. Commands

Defined in `package.json`. Stable names, so documentation and CI do not drift.

Live since M1/M2:

| Command | Does |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | Production build (`tsc -b && vite build`) |
| `pnpm preview` | Serve the production build locally |
| `pnpm typecheck` | `tsc -b --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm lint:fix` | ESLint, auto-fix |
| `pnpm format` | Prettier, write |
| `pnpm format:check` | Prettier, check only (CI uses this) |
| `pnpm test` | Domain and property tests (`tests/financial/`, no infrastructure) |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:e2e` | Playwright (`tests/e2e/`); builds and serves production first |
| `pnpm check` | typecheck + lint + format:check + test — the pre-commit gate |

`pnpm check` must pass before any commit that touches source. It intentionally excludes
`test:e2e` — full browser E2E is a milestone-completion gate (TESTING.md §10), not a fast local
loop. It also excludes `test:db` — the database and authorization suites, added in M3, need a
live Postgres and are a separate, infrastructure-dependent gate.

Live since M3 (database):

| Command | Does |
|---|---|
| `pnpm test:db` | Database and authorization tests (needs `pnpm db:start` first, or CI's ephemeral stack) |
| `pnpm db:start` | Local Supabase stack (needs Docker — see §4) |
| `pnpm db:stop` | Stop the local Supabase stack |
| `pnpm db:migrate` | Apply pending migrations to an already-running local database |
| `pnpm db:reset` | Reset local database to current migrations and re-seed from `supabase/seed/` |
| `pnpm db:seed` | Currently an alias for `db:reset` — the CLI has no standalone "just seed" command distinct from a full reset; see §4 |
| `pnpm db:dump` | Logical backup of the **linked remote** project — run before applying anything there |
| `pnpm db:types` | Regenerate `src/data/database.types.ts` from the local schema |

Live since M4 (auth), all through `pnpm exec supabase …` rather than a package script, because
each is a deliberate act against a remote project rather than part of a loop:

| Command | Does |
|---|---|
| `pnpm exec supabase login` | Authenticate the CLI. Needs a browser; stores a token outside the repo. |
| `pnpm exec supabase link --project-ref <ref>` | Bind this working copy to a remote project |
| `pnpm exec supabase db push` | Apply pending migrations to the linked remote |
| `pnpm exec supabase config push` | Push `config.toml` — **including the invite-only auth hook** — to the linked remote |
| `pnpm exec supabase functions deploy redeem-invitation` | Deploy the redemption function |
| `node scripts/remote-security-check.mjs` | Verify a **deployed** project's security posture. Needs `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; add `INVITE_TOKEN` for the full redemption phase. Run it after any deploy touching auth, invitations, policies or grants. |

Live since M4.1:

| Command | Does |
|---|---|
| `psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/grant-audit.sql` | Assert that `anon` and `authenticated` hold exactly the intended privileges. CI runs it against the ephemeral stack; against a deployed project, paste the file into the Supabase SQL editor instead — it reads catalog metadata only, no rows and no secrets. Clean means no output. |

That audit and `remote-security-check.mjs` answer different questions and neither replaces the
other: one reads what the catalog grants, the other tries to exploit it holding nothing but a
publishable key. SECURITY.md §5.9.

Live since M5 (catalog):

| Command | Does |
|---|---|
| `pnpm exec supabase functions deploy sync-catalog --use-api` | Deploy the ingest function. `--use-api` avoids needing Docker locally (this machine has none — §4). |
| `pnpm exec supabase secrets set CATALOG_SYNC_SECRET=<random>` | Set the ingest function's bearer secret (D-035) — an operator credential, not the service-role key |
| `CATALOG_SYNC_URL=https://<ref>.supabase.co/functions/v1/sync-catalog CATALOG_SYNC_SECRET=<secret> node scripts/run-catalog-sync.mjs --language=en --language=ja` | Full catalog sync, one Edge Function call per set, idempotent, resumable by re-running |
| `... node scripts/run-catalog-sync.mjs --only=<tcgdexSetId>` | Sync one set, for smoke-testing a change |

Neither env var above belongs in `.env.local` — they are shell exports for a one-off operator
command, same posture as `pnpm test:db`'s `SUPABASE_SERVICE_ROLE_KEY` (§2), and `CATALOG_SYNC_SECRET`
is not that key or any Supabase platform secret (SECURITY.md §6).

`supabase db query --linked -f <file.sql>` runs arbitrary SQL against the linked remote project
through the CLI's own authenticated session — no `psql`, no database password needed. Used for
`grant-audit.sql` against the deployed project without pasting into the dashboard SQL editor, and
for one-off inspection during development. Same trust level as the SQL editor (DEVELOPMENT.md §7):
privileged, deliberate, never for routine schema changes (those stay in `supabase/migrations/`).

`config push` is not optional housekeeping. Gate 1 of the invite-only enforcement lives in
`config.toml`, so a remote project that has had migrations pushed but not config is running with
one of its two gates missing. Gate 2, the `auth.users` trigger, travels with the migrations and
would still hold — but "one gate is enough" is not the posture this project takes.

---

## 4. Database workflow

Three ways to run a database, each serving a different purpose — this is a hybrid, not a
either/or choice.

**CI (authoritative for the M3+ gate).** `.github/workflows/ci.yml`'s `db-tests` job runs the
full local Supabase stack in Docker on GitHub's `ubuntu-latest` runner — which has Docker
preinstalled — on every push and PR. It applies every migration to an empty database, resets and
reapplies to prove reproducibility, runs the database and authorization suites, and generates
TypeScript types. This never touches any remote project or credential, so it is safe to run on
every commit and is what actually proves the M3 gate ("migrations apply to an empty and a seeded
database; the isolation suite passes"), independent of this machine's local setup.

**Local (optional, needs Docker).** `pnpm db:start` runs the same stack locally. Fast, offline,
destructible, and the most convenient way to iterate on a migration before pushing. Requires
Docker Desktop, which is **not currently installed on this development machine** — installing it
is a reasonable future convenience but was never a blocker, since CI covers the gate without it.

**Remote dev project (for manual/interactive work, once linked).** A second free Supabase
project, separate from any project holding real data — see the Supabase environment note in
HANDOVER.md for whether one is linked yet. Useful for `pnpm dev` against real persisted data and
for the owner to poke around in Studio. Not what CI depends on. A bad migration here affects a
shared resource, so `pnpm db:dump` first, always, and never treat Dashboard-applied SQL as
canonical — capture it into a migration immediately or it does not count as done (§ migration
rules below).

### Migration rules

- Every schema change is a timestamped SQL file in `supabase/migrations/`. No exceptions.
- Never edit a migration that has been applied anywhere. Write a new one.
- Never change the schema through the Supabase dashboard. The repository is the source of truth.
- `pnpm db:dump` before applying anything, on any environment holding real data.
- Every migration must apply cleanly to both an empty database and a seeded one — asserted by test.
- Regenerate types (`pnpm db:types`) in the same commit as the migration, so the schema and its
  TypeScript view never disagree.

### Backups

Supabase's free plan provides **no automated backups**. The discipline that replaces them:

1. `pnpm db:dump` before every migration and after significant data entry.
2. Dumps go to a gitignored local directory and are copied off-machine.
3. In-app JSON export (V1) as the user-facing escape hatch.

Nothing in the product may imply that backups happen automatically.

---

## 5. Project layout

As it actually exists after M1/M2/M3 — only directories with real content today. `src/features/`
and `src/lib/` are not created yet; they arrive when a later milestone gives them something to
hold, per the "no placeholder directories" rule in CLAUDE.md.

```
.
├─ docs/                     canonical documentation
├─ supabase/
│  ├─ config.toml            local stack config — the invite-only auth hook, password policy,
│  │                         Postgres 17. Pushed to a remote with `supabase config push`.
│  ├─ migrations/            timestamped SQL, one reviewable concern per file (§ below)
│  ├─ functions/             Deno Edge Functions — redeem-invitation, sync-catalog (M5),
│  │                         plus _shared/tcgdex.ts, the TCGdex provider adapter
│  └─ seed/                  synthetic catalog fixtures loaded by `db:reset`
├─ scripts/
│  └─ run-catalog-sync.mjs   drives sync-catalog set-by-set for a full catalog refresh (M5)
├─ src/
│  ├─ domain/                pure TS: Money, allocation, FX, cost-basis, market-value,
│  │                         inventory, spending, sales, position — every FINANCIAL_MODEL formula
│  ├─ data/                  Supabase client (src/data/supabase-client.ts), the bigint/money
│  │                         serialization boundary (src/data/money.ts), catalog.ts (search/detail
│  │                         queries, M5); database.types.ts is generated by `pnpm db:types`, not
│  │                         hand-written
│  ├─ auth/                  session context, the useAuth hook, and the route guards
│  ├─ features/              vertical slices — auth screens, admin invitations, home, catalog (M5)
│  ├─ ui/                    design-system components (owned, not a dependency)
│  ├─ router.tsx             TanStack Router route tree (code-based, not file-based, for now)
│  ├─ main.tsx                entry point
│  └─ styles/                Tailwind v4 entry
├─ tests/
│  ├─ financial/             mandatory gate — worked examples E1/E3/E7, invariants, allocator properties
│  ├─ data/                  pure unit tests for the src/data/ boundary (no database)
│  ├─ db/                    constraint/trigger tests and the money-boundary proof — needs a database
│  ├─ authorization/         two-client RLS attack suite, table-driven — needs a database
│  └─ e2e/                   Playwright — app-shell smoke plus the auth screens
├─ vitest.db.config.ts       separate Vitest project for tests/db + tests/authorization (`pnpm test:db`)
└─ .github/workflows/ci.yml  build-and-test (install → typecheck → lint → format:check → test →
                              build → secret scan) plus db-tests (ephemeral Supabase stack → migrate
                              → authorization suite → generate types)
```

`src/lib/` still does not exist, deliberately — it arrives when a later milestone gives it real
content, per the "no placeholder directories" rule in CLAUDE.md.

**Boundary rule:** `src/domain/` imports nothing from React, Supabase or any UI library. If a
formula needs data, it takes it as an argument. This is what keeps the financial suite free of
mocks. Verified today: every `src/domain/*.ts` file's only imports are other `src/domain/*.ts`
files.

---

## 6. Conventions

- TypeScript `strict`, plus `noUncheckedIndexedAccess` and `noImplicitOverride`. No `any` in
  committed code.
- Zod (or an equivalent parser) validates every external payload — provider responses and form
  input alike — once M3+ introduces external payloads. Not adopted yet; nothing external exists
  for it to validate in M1/M2.
- Money never crosses a boundary as a bare number. A `Money { minorUnits: bigint, currency:
  CurrencyCode }` type (`src/domain/money.ts`) makes unit mistakes a compile error. Values are
  created only through the factory functions in that module — never through a struct literal or a
  JS float.
- Prettier for formatting; no debate.
- Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- Comments explain intent and constraints. Code that needs a comment to explain *what* it does
  gets rewritten instead.

---

## 7. Bootstrapping the first administrator

Once per environment, and it takes privileged database access on purpose. There is no
"first user to register becomes admin" path, and no email address is hardcoded anywhere in this
repository.

The bootstrap runs through the same two gates as every other account — it does not bypass them, it
uses the privileged half of the same flow the redeem-invitation function uses.

**1. Issue a bootstrap invitation.** In the Supabase SQL editor, or `psql` against the project,
both of which already require credentials the owner alone holds:

```sql
with fresh as (
  select lower(btrim('<the owner''s address>')) as email,
         replace(replace(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='),
                 '+', '-'), '/', '_') as token
),
ins as (
  insert into public.invitations (token_hash, email, created_by, label, expires_at)
  select public.hash_invitation_token(f.token), f.email,
         null,                                  -- null created_by = issued out of band
         'bootstrap', now() + interval '2 hours'
  from fresh f
  returning id
)
select f.token from fresh f;
```

The token is generated *in the database* and returned once, rather than typed in. That matters for
more than convenience: a token pasted into a statement has been on a clipboard, in a scrollback,
and possibly in a chat window, whereas this one exists in exactly one place — the query result in
front of the person running it. The database stores only the SHA-256 either way.

Keep the expiry short; this one is redeemed within minutes. Data-modifying CTEs run to completion
whether or not the outer query reads them, so the `ins` branch executes even though nothing selects
from it.

**2. Redeem it through the ordinary UI**, at `/invite/<that string>`. A normal, non-admin account
is created, with a normal profile.

**3. Promote it**, again through privileged database access:

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = lower(btrim('<the same address>')));
```

`profiles.is_admin` has no client UPDATE grant at all, so this is the only way it can happen.

From here the owner invites everyone else through the application. The bootstrap is never repeated
in that environment.

**Do not commit the address or the token.** Neither belongs in this repository, in a migration, in
a seed file or in a commit message.

---

## 8. Windows notes

- Line endings: `.gitattributes` enforces LF in the repository, so a Windows checkout does not
  produce diff noise.
- Long paths: `git config --global core.longpaths true` if `node_modules` ever hits the limit.
- Use PowerShell for tooling. Scripts in `package.json` stay POSIX-portable — no
  PowerShell-specific syntax in npm scripts.

---

## 9. Deployment

The development app is served from **Cloudflare Pages, Free plan, no payment method**, at
`https://pokeportfolio-dev.pages.dev`. Git-connected: merging to `main` triggers a build. Nobody
deploys by hand, and nothing is uploaded from a laptop.

| Setting | Value |
|---|---|
| Repository | `Oskarhn/pokeportfolio` (private, via the Cloudflare GitHub App) |
| Production branch | `main` · preview deployments **off** |
| Build command | `pnpm build` · output `dist` |
| Node / pnpm | `.nvmrc` pins Node; `PNPM_VERSION` pins pnpm — Pages does not read `packageManager` |
| Environment | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `PNPM_VERSION` |

**Those are the only three variables, and none of them is a secret.** The publishable key ships in
the bundle by design. The Supabase secret key lives in the Edge Function environment and the
database password in the owner's password manager; neither belongs in a frontend build, and a
frontend build has no use for either.

**Environment variables are baked in at build time.** Editing one in the dashboard changes nothing
until a redeploy. This is not theoretical — the first deployment of this project went out with two
transposed characters in the Supabase project ref, so every request failed and the invite page said
"Could not reach the server". Verify after any change to them:

```bash
curl -s https://pokeportfolio-dev.pages.dev/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
curl -s https://pokeportfolio-dev.pages.dev/assets/<that file> | grep -o 'https://[a-z]*\.supabase\.co'
```

**Three things outside Cloudflare have to agree with the deployed origin**, and all three fail
quietly rather than loudly:

| What | Where | Symptom if wrong |
|---|---|---|
| `ALLOWED_ORIGINS` | `supabase secrets set` | Redemption blocked by CORS before the token is read |
| `site_url` | `config.toml` → `config push` | Recovery links point at the wrong host |
| `connect-src` in the CSP | derived from `VITE_SUPABASE_URL` at build | Every Supabase call blocked |

The third is generated rather than written precisely so it cannot be the one that drifts —
`vite.config.ts` emits `_headers`, and the build fails outright if `VITE_SUPABASE_URL` is unset.

**After any deploy, run the gate in [SECURITY.md](SECURITY.md) §13.** Nine checks, against the
environment that was deployed to. A green CI run is not one of them.

---

## 10. Debugging

- Vite dev server with source maps.
- React DevTools and TanStack Query DevTools in development builds only.
- Supabase logs in the dashboard for Edge Function and Postgres errors.
- Mobile: Safari Web Inspector over USB for a real iPhone. Emulation is a first pass, not proof.
- Never log monetary amounts, collection contents, tokens or full email addresses — this applies
  to development logging too, because that is where such lines get committed by accident.
