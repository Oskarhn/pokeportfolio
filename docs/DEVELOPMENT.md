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
| `VITE_SUPABASE_ANON_KEY` | yes | Anon key — public by design, RLS is the gate |
| `SUPABASE_PROJECT_REF` | no | CLI target for migrations |

The `service_role` key is **never** placed in any `.env` file in this repository. It lives only
in Supabase Edge Function secrets. Any variable without the `VITE_` prefix is unreachable from
the browser bundle, which makes the split reviewable at a glance.

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
loop.

Arriving with M3 (database) and later:

| Command | Does |
|---|---|
| `pnpm test:db` | Database and authorization tests (needs a database) |
| `pnpm db:start` | Local Supabase stack |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:reset` | Reset local database and re-seed |
| `pnpm db:seed` | Load synthetic seed data |
| `pnpm db:dump` | Logical backup — run before every migration |
| `pnpm db:types` | Regenerate TypeScript types from the schema |

---

## 4. Database workflow

Two ways to run a database. Both work; the local one is preferred.

**Local (preferred).** `pnpm db:start` runs the full Supabase stack in Docker. Fast, offline,
destructible, and the only way to test migrations safely. Requires Docker Desktop, which is not
currently installed on this machine.

**Remote dev project (fallback).** A second free Supabase project used only for development,
separate from any project holding real data. No Docker needed. Slower, and a bad migration
affects a shared resource — so `pnpm db:dump` first, always.

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

As it actually exists after M1/M2 — only directories with real content today. `src/data/`,
`src/features/` and `src/lib/` are not created yet; they arrive when M3+ gives them something to
hold, per the "no placeholder directories" rule in CLAUDE.md.

```
.
├─ docs/                     canonical documentation
├─ src/
│  ├─ domain/                pure TS: Money, allocation, FX, cost-basis, market-value,
│  │                         inventory, spending, sales, position — every FINANCIAL_MODEL formula
│  ├─ ui/                    design-system components (owned, not a dependency) — AppShell only so far
│  ├─ router.tsx             TanStack Router route tree (code-based, not file-based, for now)
│  ├─ main.tsx                entry point
│  └─ styles/                Tailwind v4 entry
├─ tests/
│  ├─ financial/             mandatory gate — worked examples E1/E3/E7, invariants, allocator properties
│  └─ e2e/                   Playwright smoke test
└─ .github/workflows/ci.yml  install → typecheck → lint → format:check → test → build → secret scan
```

Arriving with later milestones: `src/data/` (M3, Supabase client and typed queries), `src/features/`
(M6+, vertical slices), `supabase/migrations/` + `supabase/functions/` + `supabase/seed/` (M3),
`tests/authorization/` and `tests/db/` (M3).

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

## 7. Windows notes

- Line endings: `.gitattributes` enforces LF in the repository, so a Windows checkout does not
  produce diff noise.
- Long paths: `git config --global core.longpaths true` if `node_modules` ever hits the limit.
- Use PowerShell for tooling. Scripts in `package.json` stay POSIX-portable — no
  PowerShell-specific syntax in npm scripts.

---

## 8. Debugging

- Vite dev server with source maps.
- React DevTools and TanStack Query DevTools in development builds only.
- Supabase logs in the dashboard for Edge Function and Postgres errors.
- Mobile: Safari Web Inspector over USB for a real iPhone. Emulation is a first pass, not proof.
- Never log monetary amounts, collection contents, tokens or full email addresses — this applies
  to development logging too, because that is where such lines get committed by accident.
