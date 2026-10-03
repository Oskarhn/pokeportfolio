# Release pre-flight for the first CI-gated Production deploy (P163)

Owner-facing. Written 2026-09-24 for [DECISIONS.md](../DECISIONS.md) D-163. **Every step in Part A is
yours; none has been done or verified by any session.** No value, key fragment, project reference or
account id appears here, and none should be added. Never paste a key, token or secret value into a
chat, a file, a commit or a terminal argument.

State when this was written: nothing is pushed, no PR exists for this work, Production still serves
the last Cloudflare-Git deployment, Cloudflare's automatic deploys are believed to be **on** (inferred
from timing, never read), and P130-08 is **OPEN**.

## Why the order below matters

The exposed key and the public repository come first because they are ongoing harm; everything after
is release plumbing that is pointless until they are settled. Preview deployments are turned off
**before any branch is pushed**, because a pushed branch may otherwise spawn a preview that talks to
the Production Supabase project (an old one, `preview-m15-…`, still does).

## Part A — owner actions, in order

**(a) Rotate or revoke the exposed secret key.** Treat the key found in the `VITE_SUPABASE_URL`
Actions variable as exposed: it appeared in an AI-session transcript on 2026-09-19 and the
repository is public. Follow [P160_SECRET_INCIDENT_RUNBOOK.md](P160_SECRET_INCIDENT_RUNBOOK.md) §2
steps 1–7 exactly: identify, assess, create the replacement first, update the Edge Function
environment and any personal scripts, **check backend health**, delete the old key. Do not rotate
the JWT signing secret and do not rotate "all keys". Record only *rotated: yes/no*.

**(b) Replace the two build values.** Runbook §2 steps 8–9. In GitHub → Settings → Secrets and
variables → Actions → **Secrets**, create:

| Secret | Value |
|---|---|
| `PRODUCTION_SUPABASE_URL` | the project origin only, `https://<project-ref>.supabase.co` |
| `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_…` key from the same Supabase page |
| `CLOUDFLARE_API_TOKEN` | see (c) |
| `CLOUDFLARE_ACCOUNT_ID` | see (c) |

Use the GitHub UI or `gh secret set <NAME> --repo Oskarhn/pokeportfolio` (it prompts; do not use
`--body`). Then **delete** the Actions variables `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`. Then run:

```bash
node scripts/check-github-release-config.mjs
```

Expect `check-github-release-config: OK`. It reads **names only**. It proves the four secrets exist
and the two legacy variables are gone; it cannot prove a value is right. The deploy job's first step
judges the *shape* (a real `https://<ref>.supabase.co`, a `sb_publishable_` key) and refuses anything
else; whether it is the *correct project* is yours to confirm in the Supabase dashboard.

**(c) Inspect and repair the Cloudflare Pages Production build configuration.** In the Cloudflare
account that **owns** `pokeportfolio-dev` (an earlier session's browser was logged in to a different
account with no Pages projects — confirm Workers & Pages → `pokeportfolio-dev` exists first):

1. Settings → Environment variables → **Production**: `VITE_SUPABASE_URL` is the origin only and
   `VITE_SUPABASE_PUBLISHABLE_KEY` is the `sb_publishable_…` key. From the guard's merge onward a
   Cloudflare Pages build (`CF_PAGES=1`) **fails** on anything else; that is intended.
2. Settings → Environment variables → **Preview**: remove both, or make sure they cannot point at
   the Production project.
3. Deploy hooks (Settings → Builds): list them and delete any you do not recognise — a deploy hook
   is a second automatic Production path.
4. Create the deploy credential: Manage Account → Account API Tokens → Create Token → Custom
   token → **Account → Cloudflare Pages → Edit**, this account only, no zone permissions, a short
   expiry. Cloudflare cannot narrow it to one project, so anyone holding it can edit every Pages
   project in the account. Copy the token once and the Account ID (Workers & Pages overview) and put
   them into the two secrets from (b). Do not display them anywhere else.

**(d) Decide on repository visibility.** `Oskarhn/pokeportfolio` is **public** (P160), contradicting
`CLAUDE.md`, DEVELOPMENT.md §9 and PUBLICATION_CHECKLIST.md. Was that intended, and since when
(GitHub → Settings → Security log)? If not intended: Settings → General → Danger Zone → Change
visibility → private. That is your account setting; no session will change it. While it is public,
treat every Actions log as public. Making it private later does not undo what was already indexed or
cloned.

**(e) Turn off unsafe previews and remove the stale one.** Pages project → Settings → Builds → Branch
control: preview branch → *None (Disable automatic branch deployments)*. Leave "Enable automatic
production branch deployments" **on for now** (it comes off in Part B, after the PR's CI is green).
Then Deployments → delete `preview-m15-…` (it serves the Production Supabase project). Earlier
sessions recorded a Cloudflare deletion limitation; if it refuses, note the exact message.

**(f) Check GitHub Actions capacity.** Settings → Billing and plans → Usage: minutes used against
2,000, the cycle reset date, and that there is **no failed-payment notice**. Keep the spending limit
at $0. The last observed refusal was on 2026-09-18 ("recent account payments have failed or your
spending limit needs to be increased"), so this may still be exhausted. One full run is about 42–47
runner-minutes plus a few for the deploy job; budget at least 200 minutes for a PR run and a `main`
run, more if the known M13 export-scale flake needs a rerun.

**(g) Tell the next session** exactly: *rotated yes/no; secrets created yes/no; previews off yes/no;
repository visibility decision; Actions minutes available*. Nothing else — no values.

## Part B — a separate session, only after Part A

1. Push the branch and open the PR (previews are already off). Get **exact-head** CI green: both
   `build-and-test` and `db-tests`, on the head that will be merged. `deploy-production` must show
   *skipped* on the PR.
2. Run `node scripts/check-github-release-config.mjs` (names only). Do not read a value.
3. **Before the merge**, in Cloudflare: turn **off** "Enable automatic production branch
   deployments". Never leave both paths on: two deployers of one SHA prove nothing about ordering.
   Rollback is the same toggle; while it is off Production keeps serving its last deployment.
4. Squash-merge. The first push-to-`main` run is the proof that closes nothing by itself. It counts
   only if, in that one run: `deploy-production` starts strictly after both required jobs succeed;
   its first guard passes; `/build-meta.json` then reports that exact SHA and the update came from
   the job (not from Cloudflare's Git integration, which is off); and `deployment-check.mjs` passes.
   The upload with `--branch=main` while automatic Production deploys are off is expected to create a
   Production deployment but is **not documented** by Cloudflare (P150 R1) — this run is the first
   proof. If the job goes red and Production is unchanged, that is the safe failure mode.
5. Only then record P130-08 as closed, with the run id and timestamps.

## What this cannot protect against

- **The header disclosure is handled by masking, not by the guard.** GitHub writes each step's
  resolved `env:` block to the log before the step runs; it redacts secrets and does not redact
  variables. The deploy job therefore uses secrets only (D-163) and a test forbids `vars.*` and any
  `env:` above step level. Masking matches the exact string: a transformed copy is not masked, so do
  not add a step that prints, encodes or reformats these values. Never add a workflow input or an
  `echo` for them.
- The values are **public in the built browser bundle** regardless of where GitHub stores them.
- The exposure that already happened (a key in a transcript, and in a variable's history) is only
  fixed by rotation (a).
- The guard judges shape. `sb_publishable_…` acceptance does not prove it is this project's key.
- The strict deploy profile accepts only `https://<20-character ref>.supabase.co`; a custom domain in
  front of Supabase is refused until someone decides to support it.
- A green `deploy-production` on a **stale** run means it deployed nothing on purpose; check the log
  line `STALE RUN` before reading a green as "deployed". An unreadable `origin` fails instead.
- The Cloudflare token is account-wide. Keep it out of any workflow that can run untrusted code and
  rotate it if it was ever displayed.
- Repository secrets are not environment-scoped on this plan, and a same-repository pull request
  could reference one. Acceptable for a single-owner repository; revisit if that changes.

## Status ledger

| Item | Status |
|---|---|
| Exposed key rotated | `OWNER_UNVERIFIED` |
| GitHub variable replaced by secrets, old variables deleted | `OWNER_UNVERIFIED` |
| Cloudflare Pages configuration | `OWNER_UNVERIFIED` |
| Repository visibility | PUBLIC as of 2026-09-24; decision pending |
| P130-08 | **OPEN** |
