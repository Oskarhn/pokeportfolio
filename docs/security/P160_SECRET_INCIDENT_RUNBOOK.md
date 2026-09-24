# P160 — secret-shaped value in a public build variable: containment runbook

Owner-facing. No value, key fragment, project reference or account id appears in this document, and
none should be added to it. Written 2026-09-24. Governing rules: [SECURITY.md](../SECURITY.md) §6,
[DECISIONS.md](../DECISIONS.md) D-160.

## 1. What is established, and what is not

| Fact | Status | Evidence |
|---|---|---|
| The repository Actions variable `VITE_SUPABASE_URL` holds a value shaped like a Supabase **secret** key (`sb_secret_…`) instead of a URL | **Still true on 2026-09-24** (variable last updated 2026-09-19 23:16 UTC) | `node scripts/check-github-public-vars.mjs` → `VITE_SUPABASE_URL: url_is_secret_key_shaped`; the value never left that process |
| `VITE_SUPABASE_PUBLISHABLE_KEY` is publishable-shaped | Shape only | same command, note `publishable_key_accepted_by_shape_only` |
| That value was printed into an AI-session transcript on 2026-09-19 (by `gh variable list`) | Reported by P159 | `output_159.txt` S-1 |
| No workflow run has evaluated either variable | Verified | 0 runs created since 2026-09-19 23:16 UTC (GitHub API); the P142 deploy job has never executed |
| The deployed public bundle (Production, commit `d8682e0`) contains no secret key or service-role JWT | Verified for that deployment | 65 served files scanned in memory: no `sb_secret_` key shape, no service-role JWT, one Supabase origin, a `sb_publishable_` shape present |
| No secret key shape exists in the git tree or in any ref's history | Verified | `git grep` on `HEAD`, `git log --all -G`; the only service-role JWT ever committed is Supabase's well-known local demo token (allowlisted in `.gitleaks.toml`) |
| The exposed key has **not** been used by anyone else | **Unknown** | Only the Supabase logs can speak to it, within their retention window |
| The key **has** been rotated | **Unknown — owner action** | `S1_SECRET_ROTATED=OWNER_UNVERIFIED` |
| The GitHub variable **has** been corrected | **No** (structurally still wrong) | as above; `GITHUB_VAR_CORRECTED=OWNER_UNVERIFIED` |
| Cloudflare Pages environment values are correct | **Unknown** | not readable by any available tool |

The `sb_secret_` prefix is evidence of a possible high-privilege credential exposure. It is not proof
that the credential is live or exploitable, and it is not proof of misuse.

**Production is not safe to deploy from this repository until the owner has completed §2 and the
deploy workflow has passed exact-head CI.**

## 2. Owner actions, in order

Source: Supabase, *API keys → "What to do if a secret key or `service_role` has been leaked or
compromised?"* (`supabase.com/docs/guides/getting-started/api-keys`, read 2026-09-24). Its own
advice is not to rush: confirm what leaked and remediate the root cause first.

1. **Identify the key.** Dashboard → Project Settings → API Keys → *Publishable and secret API keys*.
   Secret keys are listed by **name** with a masked preview. Match the suspect one by its name and
   the visible part of the preview against the GitHub variable's value (visible to you in GitHub →
   Settings → Secrets and variables → Actions → Variables). Do not copy either into a chat or a
   file. If more than one secret key exists, treat any you cannot account for as suspect.
2. **Assess.** In the Dashboard logs, look for requests since the earliest plausible exposure
   (2026-09-19, or earlier if the key was created before it was pasted) that you do not recognise.
   Note the log retention window on your plan; if it is shorter than the exposure window, non-use
   cannot be proven and the key should be treated as used.
3. **Create the replacement first.** Same page → create a new secret key with a new name. Delete
   nothing yet. Two keys work simultaneously, which is what makes this rotation zero-downtime.
4. **Update every legitimate consumer of a secret key, then check each:**
   - Edge Functions in this repository take the platform-injected `SUPABASE_SECRET_KEYS` map and use
     `parsed.default ?? <first entry>` (`supabase/functions/_shared/service-key.ts`). While a key
     named `default` exists, functions keep using it — so the order "create new, delete old" only
     changes what they use once the old one is gone. This has **not** been tested here; confirm in
     step 6.
   - Your own shell or password-manager entries where you exported a secret key for a hosted script
     (`scripts/scanner-visual-index/build-index.ts --target=hosted` and similar).
5. **Retire nothing else.** Do **not** rotate the JWT signing secret, do **not** rotate "all keys",
   do **not** delete the publishable key, and leave `PRICE_SYNC_SECRET` / `CATALOG_SYNC_SECRET`
   alone. Supabase documents the JWT secret as separate and disruptive (it invalidates sessions);
   nothing here indicates it was exposed.
6. **Validate backend health before deleting.** Exercise the flows that reach Edge Functions
   (admin invitations page, an invitation redemption) and watch the function logs for 401 / invalid
   API key errors.
7. **Delete the compromised key.** Irreversible ("gone forever" per the docs). Repeat the step-6 check.
8. **Correct the GitHub variable.** `VITE_SUPABASE_URL` = the project **origin only**,
   `https://<project-ref>.supabase.co` (Dashboard → Project Settings → General/API). No path, no
   query, no trailing content. Confirm `VITE_SUPABASE_PUBLISHABLE_KEY` is the `sb_publishable_…`
   key from the same page.
9. **Verify without exposing anything:**

   ```bash
   node scripts/check-github-public-vars.mjs
   ```

   Expect `public-env-guard: OK (profile: hosted)`. This proves shape only.
10. **Check Cloudflare Pages** (Workers & Pages → project → Settings → Environment variables) holds
    the same URL and publishable key. From this change on, a Cloudflare Pages build refuses to run
    with anything else (§4).
11. **Report** two facts only: rotated yes/no, variable corrected yes/no. Never a value.

## 3. Repository visibility — separate, urgent finding

`gh repo view` and an **unauthenticated** request both show `Oskarhn/pokeportfolio` as **PUBLIC**
(HTTP 200 on the repository, its Actions runs and its web page). `CLAUDE.md`,
[DEVELOPMENT.md](../DEVELOPMENT.md) §9 and [PUBLICATION_CHECKLIST.md](../PUBLICATION_CHECKLIST.md)
all state it is private, and forbid making it public without the owner's approval and a completed
checklist. Nothing in this session changed visibility, and no session should.

Consequences of "public" that were not planned for:

- Run pages and job logs are readable by anyone who can reach GitHub (unauthenticated log download
  via the API returns 403, so at minimum every signed-in GitHub account).
- Everything in git history is public. The Production Supabase project reference appears in 16
  tracked files (for example [DECISIONS.md](../DECISIONS.md) D-133). That is not an added exposure:
  the reference is a URL component and is already in the publicly served JavaScript. The relevant
  point is the rest of the history — 66 remote branches, 27 draft pull requests and the
  [PUBLICATION_CHECKLIST.md](../PUBLICATION_CHECKLIST.md) pass that was never done.

Decision needed (owner): was this intended, and since when (GitHub → Settings → Security log shows
the visibility change)? If not intended: Settings → General → Danger Zone → *Change visibility*.
That is an account-settings change and remains the owner's.

## 4. What the guard now enforces

Implementation: `scripts/lib/public-env-guard.mjs` (pure), `scripts/check-public-env.mjs` (first
`prebuild` step), a `config`-hook plugin in `vite.config.ts` (first plugin; covers a direct
`vite build`, `vite`, `vite preview`), `scripts/check-dist-secrets.mjs` (artefact scan, CI step
right after the build), `scripts/check-github-public-vars.mjs` (GitHub-side shape check).

- Output is a **field name and a category**, nothing else — no value, prefix, length, query string,
  stack trace or `new URL` error text. Tests assert that no 10-character window of a synthetic
  secret reaches stdout, stderr or the thrown error, through the library, the CLI and a real
  `vite build`.
- Hosted profile (Cloudflare Pages builds — `CF_PAGES=1` — and any job setting
  `PP_REQUIRE_HOSTED_PUBLIC_ENV=1`): the URL must be exactly `https://<20-character ref>.supabase.co`
  (no credentials, query, fragment, path, port) and the key must be a `sb_publishable_…` key.
  Localhost URLs, placeholders and legacy JWTs are refused.
- Local profile: a loopback/RFC 1918 URL; a `sb_publishable_…` key, the `*-placeholder-not-a-key`
  convention CI and Playwright already use, or a legacy `anon` JWT (reported as a note — an opaque
  JWT is never declared safe by its shape).
- Always refused: anything containing `sb_secret_`, a JWT whose payload role is `service_role`, a
  key in the URL slot or the reverse, whitespace/control characters, and any other `VITE_*`
  variable whose name looks like a credential or whose value is secret-shaped.
- Failure happens in the `config` hook or in `prebuild`, before any transform, asset copy or `dist/`
  write. Measured baseline before this change: a bare `sb_secret_…` in the URL slot failed late, in
  `generateBundle`, **after** leaving a partial `dist/` (`sw.js`, `workbox-*.js`, no `index.html`);
  and a *valid* URL carrying `?apikey=sb_secret_…` **built successfully (exit 0) and inlined the
  value into two public chunks**. Both are now refused.
- Categories: `missing`, `not_a_url`, `url_scheme_not_allowed`, `url_not_https`,
  `url_host_not_supabase`, `url_has_credentials`, `url_has_query_or_fragment`, `url_has_path`,
  `url_is_secret_key_shaped`, `url_is_service_role_jwt_shaped`, `url_is_publishable_key_shaped`,
  `url_is_jwt_shaped`, `key_secret_shaped`, `key_service_role_jwt`, `key_legacy_jwt_not_allowed_here`,
  `key_jwt_unverifiable`, `key_is_url`, `key_placeholder_not_allowed_here`, `key_unrecognized_shape`,
  `local_config_not_allowed_in_production`, `value_has_whitespace_or_control`,
  `project_ref_malformed`, `project_ref_mismatch`, `sensitive_variable_name`,
  `value_secret_key_shaped`, `value_service_role_jwt_shaped`, `value_malformed`.
- Adding a new public variable is a deliberate act: add its name to `KNOWN_PUBLIC_VARS`, give it a
  validator, and the source-scan test (`tests/config/public-env-guard.test.ts`) will insist on it.

## 5. Residual risk the guard cannot remove

GitHub prints each step's resolved `env:` block in the job log, and **variables are not masked**
(confirmed on a real past run: the placeholder values appear in the `Build` step's header). In the
P142 deploy job the expressions `${{ vars.VITE_SUPABASE_URL }}` are evaluated before any step runs,
so a wrong value would be printed in that step's header — in a public repository, before the guard
can object. The guard turns a silent leak into a loud failure; it cannot un-print. Options for the
owner:

1. Make the repository private (§3) — then the log audience is the owner alone.
2. Store the two values as repository **secrets** instead of variables (masked as `***`, at the cost
   of masking the URL in verifier output too). Changes the P142 setup instructions.
3. Accept it, on the grounds that once §2 is done both values are public by design.

Recommendation: 1, and 3 afterwards. Nothing has run against these variables, so nothing has leaked
through this path yet.

## 6. P142 integration

`docs/security/p160-p142-integration.patch` (unified diff, `git apply -p1`) adds to the P142
`deploy-production` job: a guard step in the deploy profile before the build, the
`PP_REQUIRE_HOSTED_PUBLIC_ENV` selector on the build step, and the artefact scan between build and
identity check. It was checked to apply cleanly to both P142's committed `ci.yml` (`7430f66`) and
its working tree including the uncommitted F1–F4 edits; the P142 worktree was not modified.
`tests/config/public-env-guard.test.ts` ("any workflow that deploys to Pages…") fails on the
un-patched P142 workflow and passes on the patched one — it is inert on `main` until P142 lands, and
then it is the gate that stops a deploy path without these steps.

## 7. Stitch

Not part of the secret incident; see [design/p160/STITCH_ACCESS_AND_PROMPTS.md](../design/p160/STITCH_ACCESS_AND_PROMPTS.md).
