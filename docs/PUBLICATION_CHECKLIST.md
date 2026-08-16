# Publication Checklist

The repository is **private**. It must not be made public without the owner's explicit approval
and a completed pass through this document.

No agent, session or automation may change repository visibility. That is an owner decision.

---

## Why this exists

The repository is intended to eventually serve as a portfolio piece. It also contains, or will
contain, the structure of someone's personal finances and an inventory of valuable physical
property. Those two goals are compatible only with a deliberate review.

**Deleting a secret in a later commit does not remove it from Git history.** Anything ever
committed must be assumed compromised and rotated, not merely deleted.

---

## 1. Secrets

- [ ] No `.env`, `.env.local`, `.env.production` or any variant is tracked
- [ ] `.env.example` contains variable **names** and placeholder values only
- [ ] No Supabase `service_role` key anywhere in the working tree
- [ ] No database password, connection string with credentials, or direct Postgres URL
- [ ] No API keys, tokens or client secrets
- [ ] No SMTP credentials
- [ ] No session cookies or JWTs, including in test fixtures
- [ ] No private invitation tokens
- [ ] No signing keys or certificates
- [ ] No internal or privileged URLs (Supabase dashboard links with project refs are acceptable
      only if the project is already known to be the author's)

## 2. Git history

The working tree being clean is not sufficient.

- [ ] `gitleaks detect --no-git=false` over the **full history**, not just HEAD
- [ ] `git log -p --all -S "service_role"` — and repeat for `SUPABASE_`, `password`, `secret`,
      `api_key`, `eyJ` (the JWT prefix), `postgres://`
- [ ] Review every commit that touched `.env*`, `supabase/`, `.github/workflows/`
- [ ] Check stashes, tags, and any unmerged branches
- [ ] If anything is found: **rotate the credential first**, then rewrite history
      (`git filter-repo`) or start a fresh repository. Never assume a force-push scrubbed it.

## 3. Personal data

- [ ] No real purchase history, prices paid or spending totals
- [ ] No real collection contents or valuations
- [ ] No real storage locations — these name where valuable property is physically kept
- [ ] No email addresses, including the author's, in code, fixtures, seeds or commit messages
- [ ] No other users' data of any kind
- [ ] No receipt images
- [ ] No database dumps, backups or CSV exports
- [ ] No personal photographs
- [ ] Commit author identity is intentional (real name or pseudonym, decided deliberately)

## 4. Test and seed data

- [ ] All seed data is synthetic and obviously so
- [ ] No fixture derived from a real collection
- [ ] Test email addresses use `@example.com`
- [ ] Test amounts are invented, not real prices paid
- [ ] No production identifiers in test configuration

## 5. Screenshots and documentation

- [ ] Every screenshot uses demo data
- [ ] No screenshot shows a real collection value, spending total or storage location
- [ ] No project reference, URL or identifier that grants access
- [ ] README contains no personal financial information

## 6. CI and automation

- [ ] Workflow files reference secrets by name only
- [ ] No secret is echoed, printed or written to a log by any step
- [ ] Existing Actions run logs reviewed for leaked values — logs persist after the workflow changes
- [ ] Build artefacts reviewed; no `.env` or dump bundled
- [ ] Any deployment step reviewed for credential exposure

## 7. Dependencies and configuration

- [ ] No private registry credentials in `.npmrc`
- [ ] `pnpm-lock.yaml` contains no authenticated URLs
- [ ] `.vscode/` and IDE files contain no local paths that reveal personal information
- [ ] No `.claude/` session state, transcripts or agent logs are tracked

## 8. Legal and attribution

- [ ] A licence is chosen for the source code
- [ ] README states clearly that the project is unofficial and unaffiliated with The Pokémon
      Company, Nintendo, Creatures or GAME FREAK
- [ ] No official Pokémon logos, wordmarks or brand assets are used as application branding
- [ ] Card artwork is hotlinked from the provider, not redistributed from this repository
- [ ] Attribution present for TCGdex, Cardmarket, TCGplayer and Norges Bank
      (see [API_SOURCES.md](API_SOURCES.md))
- [ ] The image-rights uncertainty (U1 in [RESEARCH.md](RESEARCH.md)) is resolved or explicitly
      disclosed — private hotlinking and public distribution are different questions
- [ ] The working name `PokePortfolio` is reassessed for trademark proximity (D-026)
- [ ] No scanner index artefact containing derived card imagery is published without resolving
      the same rights question

## 9. Operational

- [ ] The public repository does not point at the project's live production Supabase instance
- [ ] Consider a separate demo project for any public deployment
- [ ] Any invited user has been told the repository is going public
- [ ] Supabase project settings reviewed for anything the anon key exposes
- [ ] Rate limiting considered — a public repository advertises the deployment's existence

## 10. Final

- [ ] Full `git log --stat` read, not skimmed
- [ ] `git ls-files` reviewed in full
- [ ] Fresh clone into a clean directory; confirm nothing unexpected arrives
- [ ] Owner has explicitly approved publication in writing
- [ ] Date, reviewer and outcome recorded in [PROJECT_JOURNAL.md](PROJECT_JOURNAL.md)

---

## If a secret is found

1. **Rotate immediately.** Assume it is compromised regardless of repository visibility —
   private repositories leak through forks, clones, backups and CI logs.
2. Remove it from history with `git filter-repo`, or start a clean repository if that is simpler.
3. Force-push, then verify by cloning fresh and searching again.
4. Record the incident in the journal: what leaked, how, what was rotated, what changed to
   prevent a recurrence.
5. Do not publish until step 3 verifies clean.
