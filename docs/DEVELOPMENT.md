# Development Environment

Target: Windows 11 with PowerShell. Nothing here should be machine-specific.

---

## 1. Toolchain

| Tool | Version | Install |
|---|---|---|
| Node.js | 24.19.0 (Active LTS) | `winget install OpenJS.NodeJS.LTS` — installed 2026-08-16 |
| pnpm | via Corepack | `corepack enable && corepack prepare pnpm@latest --activate` |
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

Defined in `package.json` once the scaffold exists. Stable names, so documentation and CI do not
drift:

| Command | Does |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | Production build |
| `pnpm preview` | Serve the production build locally |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier, write |
| `pnpm test` | Domain and property tests (no infrastructure) |
| `pnpm test:db` | Database and authorization tests (needs a database) |
| `pnpm test:e2e` | Playwright |
| `pnpm db:start` | Local Supabase stack |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:reset` | Reset local database and re-seed |
| `pnpm db:seed` | Load synthetic seed data |
| `pnpm db:dump` | Logical backup — run before every migration |
| `pnpm db:types` | Regenerate TypeScript types from the schema |
| `pnpm check` | typecheck + lint + test — the pre-commit gate |

`pnpm check` must pass before any commit that touches source.

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

```
.
├─ docs/                     canonical documentation
├─ src/
│  ├─ domain/                pure TS: money, allocation, valuation, all formulas
│  ├─ data/                  Supabase client, typed queries, provider adapters
│  ├─ features/              vertical slices
│  ├─ ui/                    design system components (owned, not a dependency)
│  ├─ routes/                TanStack Router definitions
│  └─ lib/                   small shared utilities
├─ supabase/
│  ├─ migrations/            timestamped SQL
│  ├─ functions/             edge functions
│  └─ seed/                  synthetic seed data
├─ tests/
│  ├─ financial/             mandatory gate
│  ├─ authorization/         mandatory gate
│  ├─ db/
│  └─ e2e/
└─ .github/workflows/        CI, added with the scaffold
```

**Boundary rule:** `src/domain/` imports nothing from React, Supabase or any UI library. If a
formula needs data, it takes it as an argument. This is what keeps the financial suite free of
mocks.

---

## 6. Conventions

- TypeScript `strict`, plus `noUncheckedIndexedAccess`. No `any` in committed code; `unknown`
  plus a Zod parse at boundaries.
- Zod validates every external payload — provider responses and form input alike.
- Money never crosses a boundary as a bare number. A `Money { minor: bigint, currency: string }`
  type makes unit mistakes a compile error.
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
