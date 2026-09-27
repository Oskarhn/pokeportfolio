# Project Instructions

Instructions for Codex sessions working in this repository. Project-specific; the user's
global instructions still apply.

---

## Start every session

1. Read [HANDOVER.md](HANDOVER.md) in full. It is the current-state document and takes
   precedence over assumptions carried from anywhere else.
2. Read [docs/PROJECT_STATE.json](docs/PROJECT_STATE.json) for machine-readable pointers
   (released SHA, local candidate SHAs, migration counts).
3. Read only the canonical docs relevant to the task at hand (HANDOVER.md §16 has the map). Do
   not load all of `docs/`.
4. Run `git status` and `git log --oneline -10`.
5. Do not redo work marked complete in HANDOVER.
6. Never ask the user to re-explain the project. Reconstruct state from the repository.

**Do not infer current project state from `docs/handover/archive/`.** That directory holds
historical narrative only; it is known to contain claims later superseded (see
`docs/handover/STATE_RECONCILIATION.md`). If HANDOVER.md and the archive disagree, HANDOVER.md
and `docs/PROJECT_STATE.json` win, always.

## Planning is frozen

Scope and product semantics are settled — see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md).
Implementation should not reopen them as a side effect of coding. Discovering that something is
harder than expected means a milestone takes longer, not that scope changes. Reopening requires
meeting the criteria in PLANNING_FREEZE §9.

## Documentation precedence

When sources disagree, resolve in this order and then **fix the losing document** — do not leave
a contradiction in place:

1. The user's latest explicit instruction
2. [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) — product behaviour
3. [docs/FINANCIAL_MODEL.md](docs/FINANCIAL_MODEL.md) — every monetary semantic
4. [docs/DECISIONS.md](docs/DECISIONS.md) — accepted decisions
5. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATA_MODEL.md](docs/DATA_MODEL.md), [docs/SECURITY.md](docs/SECURITY.md)
6. [HANDOVER.md](HANDOVER.md) and [docs/PROJECT_STATE.json](docs/PROJECT_STATE.json) — execution state
7. The implementation

## Canonical documents

See [HANDOVER.md](HANDOVER.md) §16 for the full, current canonical-documentation map (one
authoritative file per concept, including the current-state expansions under
`docs/CURRENT_STATE/`). Do not duplicate content across documents — link instead.

---

## Hard rules

**Cost.** Target operating cost is **$0/month**. The owner has separately approved a **$50 USD
lifetime discretionary ceiling** for the whole project (D-027) — this is *not* pre-authorized
spending. Codex's standing spending authorization remains **$0**; every paid item still requires
its own explicit owner approval against the checklist in
[docs/COST_POLICY.md](docs/COST_POLICY.md) §1a, and nothing may be spent before the free
functional baseline in §1b exists. Ordinary subscriptions stay prohibited by default. Before
introducing any external dependency or service, answer: *does this introduce a cost now, or a
realistic possibility of automatic billing?* If yes — research free alternatives, document the
trade-off, and **stop and ask the owner.** Never enter payment details, enable billing, upgrade a
plan, or treat a free trial as production infrastructure. Do not adopt Sentry, PostHog, Resend, a
paid scanner API, PriceCharting, Scrydex, paid storage, paid monitoring, a paid domain or paid AI
inference merely because they are common SaaS defaults. When a feature cannot be built well for
free, the default is to **postpone the feature**, not to spend. Full policy, the running cost
ledger and the verified service matrix: [docs/COST_POLICY.md](docs/COST_POLICY.md).

**Money.** No monetary arithmetic outside `src/domain/`. Components format numbers; they never
compute them. Integer minor units with an ISO 4217 code, never float. `NULL` money means "not
applicable", never zero.

**Financial semantics.** Do not change a formula, invariant or term in FINANCIAL_MODEL without
an entry in DECISIONS and updated tests. The worked examples in §8 are the test fixtures; if a
test stops matching the document, the document is what needs examining first.

**Security.** RLS enabled on every table, `WITH CHECK` on every write policy, `user_id`
denormalized onto child tables with a trigger asserting it matches the parent. Never rely on
frontend filtering for access control. The `service_role` key never reaches the client bundle.

**Secrets.** Never commit any. Never print one into documentation, logs, error messages, test
fixtures or commit messages. `.env.example` holds names and placeholders only.

**GitHub visibility.** The repository should be private; publishing it requires the owner's
explicit approval plus a completed pass through PUBLICATION_CHECKLIST. **As of this writing the
repository is actually PUBLIC** — see [HANDOVER.md](HANDOVER.md) §1/§14. This is an open owner
decision, not something to silently fix or silently ignore; do not assume it has been resolved
without checking `gh repo view` yourself.

**Real data.** Everything committed is synthetic. Never commit the user's actual collection,
purchases or valuations.

**Migrations.** Every schema change is a timestamped SQL file in `supabase/migrations/`. Never
edit an applied migration. Never change the schema through the Supabase dashboard. Run
`pnpm db:backup` before applying anything — migration or data repair — to a database holding real
data, and do not proceed unless it prints `BACKUP_COMPLETE`. Restore is validated only through the
dedicated runbook ([docs/RESTORE_RUNBOOK.md](docs/RESTORE_RUNBOOK.md)), never a plain `psql`
replay.

**Completion.** A feature is complete when its behaviour has been exercised, not when TypeScript
accepts it. Compilation is not evidence. Browser-test UI work; run the financial and
authorization suites for anything touching money or ownership.

**Honesty in the product.** Absent data is displayed as absent. No fabricated history, no
invented precision, no metric labelled as something it is not. Missing cost is never `0`; missing
price is never `0`; a missing result renders as **—**. This is the project's core quality bar —
see the journal entries on zero-cost pulls and condition multipliers.

**All cards are trackable.** Basic Energy, commons, duplicates and unpriced cards are ordinary
first-class inventory. Never special-case them, never aggregate them away to keep a view tidy.
Organisation and filtering are how large collections stay navigable.

---

## Working style

- Keep chat output short. Results, findings, blockers, questions, and what the user must do
  personally. Detailed reasoning goes into the documentation, not the conversation.
- Batch genuine questions. Continue every unblocked task while one is outstanding.
- Decide reversible, cheap, internal choices yourself and record them.
- Ask before: spending money, creating external accounts, irreversible external actions,
  deleting real data, changing accounting semantics, changing repository visibility.
- Use current official documentation when facts matter. APIs, pricing, browser support and
  library versions all move.
- Update the relevant canonical doc in the same commit as the change it describes.
- Update HANDOVER (and docs/PROJECT_STATE.json, if a fact there changed) before ending a session
  or when context grows large.
- No time estimates unless asked.

---

## Skill routing

| Skill | Use for |
|---|---|
| `find-docs` | Official docs for any framework, library, API, browser capability, Supabase feature. Prefer over recalled knowledge. |
| `frontend-design` | Design system, page and component design, responsive behaviour, visual polish. |
| `webapp-testing` | Browser verification once something runs: flows, mobile viewport, console, network, forms, auth, regressions. |
| `filesystem-context` | Understanding related files before a significant change. Avoid editing one file blind. |
| `long-horizon-prompting` | Milestone structure and continuity across sessions. |
| `harness-engineering` | Repeatable install, run, test, lint, typecheck, build, seed, migrate. |
| `context-optimization` | Continuously. Push durable conclusions into docs; keep active context focused. |
| `stop-slop` | Quality control on UI, copy, docs and architecture. Guard against generic output. |
| `pick-ui-library` | Before adopting any significant UI or component dependency. |
| `apple-design` | iPhone interaction, safe areas, mobile patterns. **Not** a reason to build native. |

Use them when the task matches. Do not invoke them mechanically.

---

## Git workflow

Full detail in [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md) — this is the summary a session needs
without opening it.

- **`main` is stable.** Routine implementation and milestone work happens on a branch
  (`feat/m3-database-rls`-style names), never as direct commits to `main`. Direct pushes to `main`
  are a rare, justified exception (typo fixes, urgent CI-config fixes) — not a shortcut for
  finishing a milestone's leftover documentation after its feature PR already merged.
- **PR → CI → merge is the standard path for a milestone**, and doing it does not require asking
  again each time once a work cycle's prompt has authorized it — but the merge itself still
  deserves the same care as any shared-state action: green CI, a reviewed diff, no secrets. Squash
  merge; delete the source branch after.
- Never force-push, never bypass a red CI gate with an admin override, never skip hooks.
- `pnpm check` passes before any commit that touches source.
- Conventional prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- Coherent units of work. Not one giant commit, not dozens of trivial ones.
- Review the staged diff for secrets, personal data and machine-specific paths before every commit.
- No AI, Codex, Anthropic or co-author attribution in commit messages or PR descriptions.
- No release tag per milestone. Tags are for genuinely usable, user-testable builds — see
  GIT_WORKFLOW.md §8.

## Repository contents

This repository documents the project, not the conversation that produced it. Never commit chat
transcripts, prompts or agent logs. Record the decision, the reasoning, the evidence and the
result — not who typed it. Canonical documentation must not contain phrasing that frames the work
as AI-generated or reference the prompt cycle that produced it. Do not falsify authorship either;
simply keep engineering documents focused on the engineering.

## Mentor handoff files

After each major project phase, write a detailed phase summary to
`ai_outputs/<MODEL>_outputs/output_N.txt` — exactly that naming (`output_1.txt`, `output_2.txt`,
…), matching the convention already used throughout `ai_outputs/` (e.g. `Claude_outputs/`,
`Ox_Alpha_outputs/`). Pick the subdirectory matching the model actually running the session.

**The phase number is given explicitly in the prompt. Never infer it.** Do not derive it from
the number of files present, commit count, message count, timestamps, or apparent gaps. If a
prompt states `PROMPT_NUMBER = 7`, write `output_7.txt` and nothing else.

**Never backfill historical outputs.** A missing `output_5.txt` is not a task. Do not
reconstruct, renumber or regenerate past outputs unless the owner explicitly asks for an
archive-repair operation. Creating files nobody asked for makes the archive harder to trust, not
easier.

One number per major phase. Do not increment for clarification answers, follow-up questions, or
the owner answering questions that belong to the current phase.

These files are a handoff channel to an external technical reviewer who has none of this
session's context, so they carry substantially more detail than the chat response: decisions,
research findings, architecture state, risks, open questions and verification results. They
contain no secrets, tokens or credentials.

`ai_outputs/` is gitignored and **must never be committed.** Verify with `git check-ignore`
before any commit that touches `.gitignore`.
