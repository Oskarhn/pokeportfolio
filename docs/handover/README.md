# Handover archive

## Why this exists

Before P176 (2026-09-27), `HANDOVER.md` had grown to 268,674 bytes / 3,433 lines — a session
reported it was "too large to read whole" and had to search it instead of reading it. P176 split
it into a concise current-state file plus this archive, with no information discarded (verified —
see "No information was lost" below).

**`HANDOVER.md` at the repository root contains current state only.** This directory holds
historical narrative, preserved for reference. **Do not infer current project state from
anything in this directory** — cross-check against `HANDOVER.md` and `docs/PROJECT_STATE.json`
first, and see [STATE_RECONCILIATION.md](STATE_RECONCILIATION.md) for known contradictions
between old claims here and current reality.

## How to search

- **By prompt number:** `grep -rn "P123" docs/handover/archive/` (or the specific era file below).
- **By SHA:** `grep -rln "<short-or-full-sha>" docs/handover/archive/`.
- **By decision ID:** decisions themselves live in `docs/DECISIONS.md`, not here — this archive
  only has the narrative that led to them.

## Archive index

| Range | Period | Main topics | File |
|---|---|---|---|
| P101–P141 | 2026-09 | M15 scanner mega-integration, M16 openings release, P141 close-out | [archive/2026-09-p101-to-p141.md](archive/2026-09-p101-to-p141.md) |
| M9–M13, P26–P63 | 2026-08–09 | Pricing/snapshots, sales/history, sealed inventory, dashboard, export/backup, portfolio reset | [archive/2026-08-m9-to-m13-releases.md](archive/2026-08-m9-to-m13-releases.md) |
| M5–M8 | 2026-08 | Catalog/ingest, collection, portfolio, purchases/ledger; original environment and command reference | [archive/2026-08-m5-to-m8-foundations.md](archive/2026-08-m5-to-m8-foundations.md) |

These ranges follow the pre-P176 `HANDOVER.md`'s own reverse-chronological structure (newest
narrative first, oldest foundations last) rather than a forced even split by prompt number.

## Canonical source precedence

When archived material disagrees with current documentation, current documentation always wins,
in this order (same as `HANDOVER.md` §16 and `CLAUDE.md`'s documentation precedence):

1. The user's latest explicit instruction
2. `docs/PRODUCT_SPEC.md`, `docs/FINANCIAL_MODEL.md`, `docs/DECISIONS.md`
3. `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`
4. `HANDOVER.md` and `docs/PROJECT_STATE.json`
5. `docs/CURRENT_STATE/*.md`
6. This archive (historical context only)

## No information was lost

P176 extracted every `P[0-9]+` reference, 7–40-char hex SHA-like token, `D-\d+` decision id, and
`supabase/migrations/*.sql` filename from the pre-P176 `HANDOVER.md` and confirmed each one still
appears somewhere in {new `HANDOVER.md` + this archive + `STATE_RECONCILIATION.md`}. Counts are
recorded in `ai_outputs/Claude_outputs/output_176.txt`.
