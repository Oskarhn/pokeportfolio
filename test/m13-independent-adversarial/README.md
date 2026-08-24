# M13 independent adversarial export/backup contract (P37)

Implementation-blind adversarial contract suite for **M13 — Export and backup**. Written against
current `origin/main` plus the canonical documents (ROADMAP "M13", PRODUCT_SPEC §4.12,
DATA_MODEL, FINANCIAL_MODEL, SECURITY, TESTING, DECISIONS D-025/D-070) and the pre-implementation
research dossier — WITHOUT reading any concurrent implementation branch.

Test-only: no file under `src/` or `supabase/` is touched. The suite cannot make `main` red:
its default-test/db-test include lists never reach this directory, and every database- or
implementation-dependent case gates itself on explicit runtime probes.

Run:

```bash
pnpm test:m13-adversarial
```

Environment: the same ephemeral-stack variables `pnpm test:db` uses (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Without them, pure-oracle suites run and
database-backed suites skip with stated reasons. Never point this at a hosted project.

## Case classification

| Class | Meaning | Where |
|---|---|---|
| `ACTIVE_TESTS` | Run today, pass on current main | `domain/*` (pure oracles), `platform/delivery.test.ts`, `security/cross_user.test.ts` when a stack exists |
| `IMPLEMENTATION_GATED_TESTS` | Skip until an M13 implementation is discovered under `src/`; then assert the contract for real | `integration/backup_contract.test.ts` |
| `ORACLE_ONLY` | Executable specification of required behavior, no implementation binding yet | helpers + the delivery contract constants |

The discovery gate lives in `helpers/contract.ts`: it probes `src/domain/export*` /
`src/data/export*` for export-, backup- or csv-named modules, dynamically imports them, and
classifies capabilities (`envelope-version`, `csv-sanitizer`, `csv-writer`, `backup-builder`) by
export-name patterns. On main nothing matches → skips. Against an implementation, a missing or
divergent capability fails LOUDLY as `[M13 CONTRACT] …` so integration fixes bindings
deliberately instead of silently loosening assertions.

## The canonical export oracle (`helpers/inventory.ts`)

Every relation in `public` classified exactly once:

- **MUST_EXPORT** (18): profiles (minus `is_admin`/`disabled_at`), retailers,
  storage_locations, tags, holdings, acquisition_lots, manual_card_definitions,
  manual_valuations (full history), holding_tags, custom_collections(+members),
  purchases(+lines incl. voided + stored allocations verbatim), lot_cost_adjustments,
  sales(+sale_lines+lot_disposals incl. voided), sealed_products **restricted to**
  `created_by_user_id = self`.
- **IDENTITY_REFERENCE**: card_series/card_sets/cards/card_variants → identity manifest only.
- **MUST_NOT_EXPORT**: portfolio_snapshots (+queue/runs — the derived-cache trap, D-070),
  fx_rates, price_snapshots, price/catalog sync runs, invitations/claims/redemptions.

Negative money is legal ONLY on the six sales-side columns whose CHECK constraints allow it;
every other negative is corruption or sanitizer damage. `audit_events` is named by DATA_MODEL §7
prose but verified ABSENT from migrations; its creation must come with a deliberate inventory
decision (see `FORWARD_COMPAT_TABLES`).

## Pagination contract (`helpers/pagination.ts` + `domain/pagination.test.ts`)

Offset pagination has two SILENT failure modes (truncation; gaps) that walking-until-short-page
cannot detect. The oracle walker therefore reconciles against the transport's expected total and
detects duplicate identity keys across pages, with a pathological-loop guard (M7.1 precedent).
Tests demonstrate each fault on simulated sources — including the trap itself, where a naive
walker happily exports 1000 of 2500 rows.

## Integration guidance (for whoever merges M13)

1. Run `pnpm test:m13-adversarial` against a branch containing the implementation.
2. Expect `[M13 CONTRACT]` failures naming any surface whose signature diverged; update
   `helpers/contract.ts` bindings deliberately.
3. The end-to-end cases validate a generated backup against `validateBackupEnvelope`
   (version envelope, counts reconciliation, empty-array-vs-missing-section, exclusions),
   privilege-column leakage, and re-export determinism modulo `exported_at`.
4. Wire DB-backed suites into CI's db-tests only once they are expected to pass everywhere.
