# Scanner matching domain (M15, P67)

Deterministic layer between a noisy OCR/visual observation and the EXISTING canonical catalog
identity (`cards.id`; variants are chosen later by the user, never fabricated here). Pure
TypeScript — no React, no Supabase, no network. P68 integrates this with the camera UI; nothing
here mutates the Portfolio, ever.

## Module map

| File | Owns |
|---|---|
| `types.ts` | `ScannerObservation` (untrusted text in), `ScannerCandidateRecord` (catalog row in), `RankedScannerCandidate`, `ScannerMatch`, tier + reason codes |
| `normalize.ts` | Deterministic text normalization applied IDENTICALLY to observations and catalog strings; language-hint parsing |
| `collector-number.ts` | Parser for observed collector numbers against real `cards.local_id` shapes (`4`, `001/165`, `TG01`, `SV049`, `H31`) |
| `collector-compare.ts` | Observed-vs-canonical id comparison: `exact` / `folded` / `numeric` evidence levels |
| `edit-distance.ts` | Bounded Damerau-Levenshtein (OSA) — the one fuzzy primitive; no dependency |
| `name-similarity.ts` | Length-aware name comparison: exact / close / partial / none |
| `set-hint.ts` | Weak textual set-name hint comparison (no symbol→text fantasy) |
| `engine.ts` | Weight table, score bands, margin-based confidence demotion, stable bounded ranking |

The data side lives in `src/data/scanner/scanner-catalog.ts`: bounded candidate retrieval over
the existing `search_cards` RPC (max two queries × 40 rows per scan, deduplicated, zero calls
without a usable signal, provider errors mapped to a sanitized error type).

## Invariants pinned by tests

1. **No second identity system** — every candidate IS an existing catalog row; the engine only
   ranks what the data adapter fetched.
2. **No automatic Portfolio mutation at any tier.** HIGH means "safe to preselect"; the user
   still confirms in the review step (UX_FLOWS F12).
3. **No signal → no match and zero provider calls.** Under 3 normalized name characters and no
   parseable number returns `tier: 'none'` without querying anything.
4. **No single signal implies uniqueness.** The weight arithmetic makes name-only results LOW
   and id-only results MEDIUM-at-best; HIGH requires convergent printed evidence AND a ≥15-point
   margin over the runner-up.
5. **Determinism** — equal input yields equal output; ordering is total (score desc, then
   cardId asc); duplicates collapse; iteration order of inputs cannot change results.
6. **Conservative OCR folding** — O/I/L/S letter→digit folds exist ONLY inside collector-number
   handling where a digit is structurally expected; names are never digit-folded, and "0"↔"O"
   swaps never happen globally.
7. **Variant boundary** — OCR text can identify the PRINTING, not the finish/foil/stamp/
   condition. Candidates carry printing identity plus `variantCount`; exact variant choice is a
   later, user-owned step over the existing `card_variants`.
8. **Visual seam** — `ScannerObservation.visualSimilarity` is reserved and ignored by V1 scoring;
   its presence must not change any result (P65 decides whether M15 needs real vision).

## What P68 should document canonically when integrating

- UX_FLOWS F12: how candidates/tiers render, and that HIGH only preselects.
- ARCHITECTURE §2: the `src/data/scanner` adapter's place in the data-layer list.
- TESTING.md: the scanner suites' gate status (they are infrastructure-free unit suites).
- No DECISIONS entry was needed for the matcher itself; add one if integration changes product
  semantics (e.g. auto-preselect behaviour or candidate display count).
