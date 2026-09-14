# Changelog

Notable changes, newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file records **what changed**. [HANDOVER.md](HANDOVER.md) records **current state**, and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) records **why hard things were done the way
they were**.

---

## [Unreleased]

### Fixed — 2026-09-14 — Ledger integrity: split purchase lines and correction races (P132, P130-01, P130-03, D-129–D-131)

- A receipt edit after a sealed-intent split no longer fabricates units or cost basis: every live
  sibling keeps its quantity and shares the line's cost exactly; removed siblings stay removed; a
  quantity change on a split line, a line with removed lots or a line with no live lot is refused.
- Voiding one split sibling no longer voids the purchase while another sibling is live.
- `update_purchase`, `void_purchase`, `void_acquisition_lot`, `remove_holdings_from_portfolio`,
  `void_opening`, `void_sale` and `set_sealed_lot_intent` lock the lots they affect (ascending id)
  before validating or writing: no voided lot with a live sale, no stale D1 restore, no raw
  constraint error or deadlock under a concurrent sale.
- Three migrations (`20260914120000`, `20260914121000`, `20260914122000`); RPC signatures unchanged.

### Fixed — 2026-09-02 — M15 scanner: evidence-aware matcher redesign closes the F-02 visual/text scoring gap; OCR confidence weighting; retrieval consistency (P88, D-102, isolated repair branch `fix/m15-p88-matcher-ocr-correctness` — draft PR #66 against PR #63's integration branch, NOT on PR #63 itself, not merged, not deployed)

Redesigns `visual-evidence.ts`'s point curve (calibrated bands matching P84's real similarity
distributions) and adds a new visual-dominance guard (`engine.ts`) that discounts a coincidentally
text-matching WRONG candidate when a DIFFERENT candidate carries strong, dedicated visual evidence
it lacks — closes the audited F-02 CRITICAL/P0 finding (a single OCR misread could always outrank
a correct, strong visual match by construction). Re-running the project's own existing 240-card
benchmark with the new matcher: hybrid TOP1 99.4% vs. the documented OLD hybrid's 95.8% (visual-
alone stays 99.7%) — the hybrid-vs-visual-alone gap shrank from -3.9 to -0.3 points. Also fixes
F-12 (OCR confidence now gates collector-number ROI selection and matcher text-evidence
reliability), F-16 (recovers OCR separator noise in collector numbers), F-17 (adds a Basic-Energy
name-ROI layout), F-26 (visual-text-disagreement now actually caps tier), F-27 (non-finite
similarity fails closed), F-28/F-29 (the visual-shortlist enrichment channel now filters
`is_active`/`language`, matching `search_cards`), F-34 (real-OCR fixtures + a real-Tesseract smoke
test for every layout family), and a generic attack/rules body-text-contamination penalty (P88
§13). Full account: `docs/DECISIONS.md` D-102, `docs/SCANNER_RESEARCH.md` §8,
`ai_outputs/Claude_outputs/output_88.txt`.

### Fixed — 2026-09-02 — M15 scanner: OCR forensics, a bounded multi-line collector-number recovery pass, name-lexicon/structured-parser tooling (P85, D-101, isolated research branch `feat/m15-p85-ocr-recognition` — NOT on PR #63, not merged, not deployed)

Built this project's first real, ground-truthed OCR accuracy corpus (`scripts/scanner-ocr-benchmark/`,
reusing the existing TCGdex fetcher and the P76/P79 augmentation modules for 9 realistic
perturbation profiles/card) and used it to actually forensically test Tesseract.js 7's
configuration space instead of reasoning from single real-device screenshots.

- **PSM forensics**: the pre-existing PSM 7 (single-line) default was already correct for both
  fields when a candidate crop genuinely is one line — measured directly against 4 alternative
  modes, not assumed.
- **Real bug found and fixed**: a correctly-cropped collector-number strip routinely contains TWO
  visual lines (the id plus an adjacent illustrator-credit or copyright line) on both vintage and
  modern layouts, confirmed by direct visual inspection of real crop images — PSM 7 cannot read a
  two-line image at all. Fixed with a bounded THIRD pass (PSM 6, "uniform block") for the
  collector-number field only, tried only when both existing single-line passes already found
  nothing — zero added cost on an already-working scan.
- **A second real bug found and fixed before shipping**: the naive fix let a copyright YEAR
  ("© 1995") win as a fake collector number (a bare 4-digit token that structurally parses).
  Closed with a stricter plausibility check used only by the new pass.
- **`src/domain/scanner/name-lexicon.ts`** (fuzzy OCR-name resolution against a local unique-name
  list) and **`src/domain/scanner/collector-parse.ts`** (structured collector-number parse with a
  confidence band) ship as tested, available domain tooling — neither wired into production
  retrieval/scoring this session (no real production-scale name lexicon exists yet; no Supabase
  credentials available to generate one).
- **`?scannerDebug=1` OCR debugger**: every considered ROI/preprocess/segmentation attempt is now
  listed (`OCR_TRIALS`), winner flagged.

Full account: D-101 in DECISIONS.md, SCANNER_RESEARCH.md §7f, `ai_outputs/Claude_outputs/output_85.txt`.
Gates: typecheck/lint/format clean, build green, unit tests green (see output_85.txt for the exact
count). DB not run (diff touches zero DB files). This branch is an isolated OCR-only research
track (P85) run in parallel with P84/P86 — not integrated into PR #63 this session.

### Fixed — 2026-08-30 — M15b scanner: live prewarm-stall diagnostics, FAST (OCR) baseline reprioritized, lightweight hash retrieval evaluated and rejected (P82, D-099, on PR #63, DRAFT — not merged, not deployed)

P81's cold-start fixes did not close the gap: a real-iPhone retest still showed
`VISUAL_MODEL_STATE=loading` for over a minute with every phase-timing field unreadable ("—"), and
a Shieldon scan OCR also failed despite the debug screenshot showing the name clearly legible.

- **Live worker-progress instrumentation**: the worker now posts a message at every phase boundary
  (module-eval, processor/model load, backend attempts, index sub-steps) instead of only at a
  terminal ready/unavailable message — a stalled init is now attributable to a specific phase WHILE
  it is still loading. New debug fields: `WORKER_BOOTED`/`WORKER_BOOT_MS`/`VISUAL_CURRENT_PHASE`/
  `DINO_CURRENT_PHASE`/`VISUAL_CURRENT_PHASE_ELAPSED_MS`/`VISUAL_LAST_PROGRESS_MS_AGO`.
- **Lightweight perceptual-hash retrieval (dHash + new pHash) evaluated on REALISTIC capture noise
  and REJECTED**: re-run against the same hard, off-center/tilted corpus P79's rectification
  benchmark uses (not the easy corpus P76's original 86.7% TOP1 came from) shows same-card vs.
  different-card similarity distributions overlapping almost completely — no usable threshold, an
  order of magnitude worse than DINO's 93.3% TOP1 on the identical profile. Not wired into
  scoring; ships as tested, unused domain tooling (`computePHash` etc.) only.
- **FAST baseline reprioritized**: OCR + text search now starts warming BEFORE the heavyweight DINO
  channel (reverses P81's own stagger order) — the only real signal that doesn't need DINO's ~45MB
  cold start. The intro screen's loading copy now gates on OCR readiness
  (`getFastScannerState()`), not the DINO channel, so it clears far sooner on a cold device.
- **OCR preprocessing**: Otsu binarization (`roi.ts`) added as a bounded fallback retried only when
  the existing contrast-stretch pass found nothing usable from any ROI candidate for a field —
  zero added cost for an already-working scan.

Full account: D-099 in DECISIONS.md, SCANNER_RESEARCH.md §7e, `ai_outputs/Claude_outputs/output_82.txt`.
Gates: 845/845 unit tests, typecheck/lint/format clean, build green, 12/12 platform verifier,
64/64 E2E. DB/M13/M16 not re-run (Docker unavailable — diff touches zero DB files).

### Fixed — 2026-08-30 — M15b scanner: iPhone cold-start/reliability repair (P81, D-098, on PR #63, DRAFT — not merged, not deployed)

Real-device evidence: cold visual-channel initialization took 106–388 seconds on repeated
attempts, and one scan never produced a usable result after 6–7 minutes. A real-browser benchmark
against the actual production worker chunk (new `pnpm scanner:visual:benchmark:cold-start`) showed
localhost cold total time of ~1.5–2.1s — evidence the bottleneck is network transfer over the real
device's connection, compounded by two confirmed configuration gaps, not WASM compile cost or
model size.

- **Cache-Control fixed**: scanner assets served `max-age=0, must-revalidate` (Cloudflare Pages'
  default for non-hashed filenames) despite living under version-pinned, revision-verified paths.
  `vite.config.ts` now emits `Cache-Control: public, max-age=31536000, immutable` for
  `/scanner-assets/*`.
- **Route-entry prewarm**: the visual worker now starts loading the instant `/scan` mounts
  (`controller.prewarm()`), staggered ~1.5s ahead of the OCR engine's own cold start instead of
  both contending for network/CPU from the same instant. The intro screen shows honest,
  non-blocking "Preparing card recognition…" copy.
- **Bounded visual wait**: a capture that starts before the visual channel is warm now waits at
  most 8 seconds before degrading to OCR-only with an honest `VISUAL_ERROR` message, instead of
  hanging on a multi-minute cold model load.
- **New cold-start phase instrumentation** (`visual/phase-timing.ts`): per-asset fetch time/bytes,
  decode time, worker-start time and a compile+session-create remainder, read via the Resource
  Timing API (a `self.fetch` monkey-patch alone missed transformers.js/onnxruntime-web's internal
  fetches — a real finding from this session's own benchmark run, documented in the code).
- **Worker-owned Cache Storage layer** for the worker's own index fetches, independent of whether
  the page's Service Worker intercepts fetches issued from inside a dedicated Worker.
- `numThreads` explicitly set to 1 when not cross-origin-isolated (documents the existing
  single-thread fallback instead of relying on internal auto-detection).
- **Model replacement evaluated and rejected** (evidence-gated, same discipline as P80's photometric/
  auxiliary-signal decisions): no benchmarked case for a smaller model, real risk of regressing
  P80's still-open discriminative-power gap, and any swap forces an irreversible multi-hour
  re-embedding of the 19,501-card index. See D-098.

Zero database/migration/RPC files touched. Full account: `ai_outputs/Claude_outputs/output_81.txt`.

### Fixed — 2026-08-28 — M15b scanner: exact-card matching, adaptive OCR ROI, candidate rescue (P80, D-097 addendum, on PR #63, DRAFT — not merged, not deployed)

P79's camera-resolution and rectification fixes still left two concrete real-device misses: Mega
Chandelure ex (absent from the top-20 visual candidates) and Shieldon (present at raw rank 6, never
shown). Investigated and fixed the actual causes:

- **Adaptive OCR ROI.** The fixed name/number ROI fractions encoded the vintage card layout (name
  top-left, number bottom-right); modern SM/SWSH/SV-era cards print the name across the top edge
  and the number bottom-left. `analyze.ts` now tries a bounded set of named layout candidates per
  field, scores each by OCR confidence plus field-specific parseability, and keeps the winner, with
  an early-exit once a candidate is confident (same one-call-per-field cost as before in the common
  case). Closed a real permissiveness bug in `parseCollectorNumber` (a long garbage OCR string with
  a stray digit run could structurally parse as an id) with a length guard.
- **Candidate rescue.** The engine's own candidate retention bound (5) matched the UI's display
  bound exactly, so a correct card at raw rank 6 was discarded before the UI could ever show it.
  Retention raised to 10; the UI's display limit widens from 5 to 8 only when the ranking near the
  cutoff is genuinely flat (within the engine's own ambiguity margin), never merely for low
  confidence — a HIGH-tier match never expands.
- **Photometric normalization** (`domain/scanner/photometric.ts`) built, tested, and evaluated via
  a new bounded benchmark (`pnpm scanner:visual:benchmark:photometric`): a wash on the available
  corpus, which cannot ground-truth-test the real foil/style-confusion hypothesis at full index
  scale. Shipped as tested tooling; not wired into the default pipeline.
- **Auxiliary visual signal** (second/inner-art embedding) evaluated and rejected again, with a
  corrected rationale: the existing benchmarks measure robustness to capture noise, not
  discriminative power at scale — genuinely untested, not disproven; rejected this session on
  cost/risk (re-embedding all 19,501 cards is multi-hour and irreversible) pending real evidence.

Full account: `ai_outputs/Claude_outputs/output_80.txt`. Unit 789/789 (+12 new); typecheck/lint/
format clean; build/platform-verifier/E2E green. DB gates not run this session (no local
Docker/Supabase available); zero DB/migration/RPC files touched.

### Fixed — 2026-08-27 — M15b scanner: real-device recognition quality repair (P79, D-097 addendum, on PR #63, DRAFT — not merged, not deployed)

The first real iPhone scan with a working runtime (P78) returned real candidates — all wrong, all
LOW tier. Repairs the actual recognition-quality causes:

- **Camera resolution was never requested.** `getUserMedia`'s `video` constraints carried only
  `facingMode`; the diagnostic's `CAPTURE_CROP_DIMENSIONS=252x352` reproduces almost exactly by
  hand against the unchanged guide-geometry math and a plausible unconstrained-default ~480×640
  video track. Fixed: `{ width: { ideal: 1920 }, height: { ideal: 1920 } }` added to the same
  constraints (never `exact`, so a capped device still opens exactly as before).
- **Card rectification added.** New pure domain module `src/domain/scanner/rectify.ts` (Sobel
  edge detection + outlier-rejected line fit + corner intersection + bilinear quadrilateral warp)
  plus canvas glue `src/features/scanner/rectify-capture.ts`, wired into `controller.ts` as one
  new step feeding OCR and the visual channel the same canonical, rectified card image. Falls
  back to a plain crop (pixel-identical to before) whenever detection finds nothing plausible —
  never a crash.
- **Debug tooling gained real image previews** (raw crop, rectified image, both OCR ROI strips —
  memory-only, never persisted) and a debug-only widened 50-candidate visual shortlist (up to 20
  shown with thumbnails); production matching is unchanged. New `CAPTURE_FRAME_DIMENSIONS` /
  `RECTIFICATION_USED` fields in the plain-text diagnostics.
- **New harder local benchmark** (`pnpm scanner:visual:benchmark:hard`) composes an actual
  off-center/tilted synthetic phone photo instead of P76's resize-in-place profiles. Results:
  rectification lifts TOP3/TOP5 on the geometry-only distortion case without regressing TOP1;
  combined glare+shadow+blur collapses every method to near-chance — a photometric-normalization
  problem disclosed as out of this session's scope, not hidden.

Full account: `ai_outputs/Claude_outputs/output_79.txt`. Unit 777/777 (+29 new); typecheck/lint/
format clean; build/platform-verifier/E2E green. DB gates not run this session (no local
Docker/Supabase available); zero DB/migration/RPC files touched.

### Fixed — 2026-08-27 — M15b scanner: visual model never initialized on real iPhone (P78, D-097 addendum, on PR #63, DRAFT — not merged, not deployed)

Repairs a real-device `VISUAL_MODEL_STATE=failed` report against the FULL hosted index (P77's
pagination/checkpoint/crop fixes and the owner's real 19,501/20,946 hosted rebuild were both
already in place). Two independent, confirmed root causes — both reproduced directly against the
real production build in a real browser, not inferred:

- **`env.allowLocalModels` was never set.** `@huggingface/transformers` defaults it to `false`
  inside a Web Worker; combined with the (correct) `allowRemoteModels = false`, every model load
  attempt threw before touching the ONNX runtime at all — on every browser, reproduced identically
  on desktop Chromium with no COOP/COEP change. Fixed in `visual-worker.ts`.
- **CSP `script-src` was missing `blob:`,** which onnxruntime-web's WASM factory needs for its own
  dynamic-import glue-module loading — without it, model loading failed for both the `webgpu` and
  `wasm` device paths. Fixed in `vite.config.ts`; verified end to end (real model load, real
  embedding, real 19,501-card index search) with `crossOriginIsolated=false` throughout —
  cross-origin isolation was never the blocker.
- **WebGPU→WASM fallback added:** the worker used to pick exactly one backend up front and never
  retried WASM if that choice failed. Now a pure, unit-tested module
  (`src/domain/scanner/visual-backend-selection.ts`) tries WebGPU first under `auto` and falls
  back to WASM on any failure/absence; an explicit `?visualBackend=wasm`/`webgpu` diagnostic
  override skips backend guesswork entirely.
- **Diagnostics used to drop the real failure reason** (`VISUAL_ERROR=—` even when the worker had
  recorded one) — fixed in `controller.ts`, plus new phased
  `PROCESSOR_LOAD`/`MODEL_LOAD`/`INDEX_LOAD` and per-backend attempt fields in the debug panel.
- **Index failure-counter bug fixed:** `coverage.failures` used to accumulate across resumed
  builds without deduplicating by card id (the owner's build logged "404: 6" while the shipped
  manifest read "7 failures"); now derived fresh as `cardsWithUsableImage - cardsIndexed` at pack
  time — no re-embedding required.

Model, architecture and migration count unchanged. The committed hosted index (19,501/20,946) is
untouched. No card was special-cased.

### Fixed — 2026-08-27 — M15b scanner: full-catalog index pagination, checkpoint contamination, crop mismatch (P77, D-097 addendum, on PR #63, DRAFT — not merged, not deployed)

Repairs the real-device failure ("Couldn't identify this card" on both a Shieldon and a Mega
Chandelure ex) the P76 preview hit. Two independent bugs plus one preprocessing mismatch, all
fixed:

- **Full-catalog pagination:** `build-index.ts`'s unpaginated query was silently truncated at
  1000 rows by Supabase's hosted API cap (the owner's rebuild logged exactly "1000 active English
  cards"). Fixed with an exact-count-then-paginate walk (`src/domain/scanner/
  index-pagination.ts`) reusing M13 export's proven completeness primitive; proven against real
  local PostgREST with 1,203 seeded rows.
- **Checkpoint contamination:** the resumable build checkpoint is now bound to
  `{schemaVersion, sourceProjectIdentity, modelId, modelRevision, embeddingDim, quantization}`
  (`src/domain/scanner/checkpoint-identity.ts`); a mismatched/pre-P77 checkpoint is discarded
  loudly instead of silently mixed in (the exact class of bug behind P76's own 1224/1000 fix).
  Packing is separately constrained to the current fetched canonical id set.
- **Coverage invariants enforced,** not just logged: `src/domain/scanner/index-coverage.ts` is
  asserted by the generator before writing, by `verify-index.ts` after reading, and by the browser
  worker at runtime — cardsIndexed can never exceed totalCanonicalCards or cardsWithUsableImage.
- **Crop mismatch fixed:** the visual channel was embedding the ENTIRE captured camera frame
  instead of the card-only crop OCR already used (`capture.cardRect`) — a real preprocessing-parity
  gap from the reference index's tight card-only images. `controller.ts`'s `analyzeVisualSafely`
  now crops via `createImageBitmap`'s `(sx, sy, sw, sh)` overload.
- **Diagnostic mode implemented:** `/scan?scannerDebug=1` — a debug-only panel with a "Copy
  diagnostics" button, deferred in P76.

Model, architecture and migration count unchanged. No card was special-cased.

### Added — 2026-08-26 — M15b scanner: hybrid visual recognition (P76, D-097, on PR #63, DRAFT — not merged, not deployed)

Replaces the OCR-only recognition bottleneck P75's real device test exposed ("Couldn't identify
this card") with a hybrid on-device pipeline: a DINOv2-small visual embedding channel now scores
alongside OCR text in the same `src/domain/scanner/engine.ts` matcher.

- **Model:** `Xenova/dinov2-small` (converted from `facebook/dinov2-small`), pinned revision
  `c2bb04a51fab207c420665f1946016107bffc701`, Apache-2.0, quantized INT8 ONNX (24.5 MB), vision-only
  (no text encoder). MobileCLIP was evaluated and **rejected on licensing** — Apple's Machine
  Learning Research Model License explicitly excludes "commercial exploitation, product
  development or use in any commercial product or service."
- **Benchmark:** 240 real TCGdex reference cards across 6 sets, 6 synthetic camera-distortion
  profiles, 1,440 augmented queries, all four methods scored by the REAL production matcher.
  OCR-first 30.5/39.7/42.1% (TOP1/3/5) vs. hybrid 95.8/99.9/100% — clears both product targets
  (TOP5≥90%, TOP3≥85%) with wide margin. Perceptual hashing (dHash) evaluated, not wired into
  production (measurably weaker once the embedding channel exists).
- **Architecture:** LOCAL versioned INT8 index (384 bytes/card; full catalog ≈8.6 MB), not
  pgvector — no new migration, no new RPC, no new user-facing DB privilege. Hosted migration
  count unchanged at 90.
- **Privacy/supply chain:** captured photos never leave the device; model + onnxruntime-web WASM
  binaries staged same-origin under `/scanner-assets/visual-v1/`, pinned by SHA-256, remote model
  loading explicitly disabled; the visual-recognition worker (~500 KB) is excluded from the
  service-worker install-time precache, same as the OCR engine assets.
- **Known gap:** the committed reference index was generated against the LOCAL dev stack (no
  hosted-catalog read access was available to this session) — hosted-scale, hosted-ID-matching
  index generation is one remaining owner-run command (`pnpm scanner:index:build` with a hosted
  service-role key, never shared with an assistant). Until that runs, real physical-card scans
  degrade gracefully to OCR-only behavior.
- Full reasoning: DECISIONS.md D-097; full benchmark methodology and results:
  docs/SCANNER_RESEARCH.md §7b.

### Fixed — 2026-08-26 — M15 scanner: real-Postgres idempotency repair (P75, on PR #63, backend applied to hosted)

The first end-to-end run of the M15 idempotency DB tests against actual Postgres (not just read
against the source) exposed that the replay check in `add_card_acquisition` never fired for a
non-voided lot: `v_replay is not null` is a row-wise NULL test that evaluates false for a
`record` with a mixed-null shape, which every non-voided replay has. Execution silently fell
through to a plain insert every time, relying on the coarser outer `unique_violation` handler —
which has no material-mismatch or voided-lot check at all. Fixed by testing the NOT NULL
`lot_id` column instead of the whole record. Two inverted null-safe comparisons in the
material-mismatch predicate (`IS DISTINCT FROM` where `IS NOT DISTINCT FROM` was needed) were
fixed in the same pass — they would have rejected every legitimate replay had the surrounding
block ever run. All 21 idempotency DB tests (I1–I21) now pass against real Postgres, including
both concurrent-race cases and every material-mismatch case. Full account: DECISIONS.md D-096
point 11. The two M15 migrations are now applied to `pokeportfolio-dev` (backend-only; no
frontend merged to main). Also fixed 10 pre-existing unit test failures (stale mocks and two
intentional behavior changes the tests hadn't caught up with) and several fixture bugs in the
new DB test suite.

### Added — 2026-08-26 — M15 scanner: on-device recognition integrated candidate (P68, DRAFT PR #63 — backend applied, frontend not merged, no Cloudflare preview yet)

The M15 integrated candidate combines three parallel source candidates deliberately (source
PR #60 deterministic matcher + source PR #61 camera/batch UI + source PR #62 CSP/WASM security
boundary) and adds the real recognition pipeline on top. DRAFT: still needs a Cloudflare preview
(blocked on the project's Pages settings — preview deployments are off) and the owner's
real-iPhone check before it can merge.

- **On-device OCR (D-094)** — pinned `tesseract.js` 7.0.0 / `tesseract.js-core` 7.0.0 /
  `@tesseract.js-data/eng` 1.0.0, LSTM-only English; assets staged same-origin under
  `/scanner-assets/v7/` by a reproducible prebuild script (no CDN at runtime, nothing binary
  committed); one worker per scanner session created lazily on first analysis and terminated on
  exit; tesseract.js stays out of the main bundle entirely (entry delta +0.26 KB gzip).
- **Shared guide geometry** — one pure model maps the rendered 5:7 framing guide through
  object-fit: cover into captured pixels; every capture carries a trustworthy card rectangle;
  picked files follow a deterministic full-image-or-centred-crop policy shown honestly in the
  review step.
- **Matcher integration** — OCR text becomes P67 observations, retrieval rides the existing
  `search_cards` surface, confidence is P67's deterministic tier mapped to HIGH/MEDIUM/LOW/
  NO_MATCH (≤5 shortlist; HIGH only ever preselects).
- **Printing before batch** — active variants are fetched only after a candidate is chosen;
  multi-printing cards require an explicit choice labelled from real finish/stamp/subtype/size.
- **Session defaults** — user-scoped in-memory origin/condition/language/storage/date applied at
  commit; standalone origins exclude Opening (M16 owns pulls), default pre_tracking "Existing
  collection"; basis derived via the shared extracted origin-basis helper; cleared by both auth
  exit paths (D-093 sweep extension).
- **Honest batch commit** — sequential `add_card_acquisition` per confirmed item with per-item
  outcomes: successes are never resubmitted on retry, definite server refusals stay editable,
  and interrupted transports are flagged "may already have been added — check Portfolio" with
  no automatic retry (no idempotency migration added).
- **Entry points live** — Quick Add "Scan card" and Search's camera affordance open `/scan`
  (the "not available yet" placeholders are gone). Privacy copy now states the literal truth:
  photos are processed on this device and aren't uploaded or saved.
- **Verification** — typecheck/lint/format clean; unit 637/637 (131 new integration tests incl.
  I1–I20 mapping and a static network-privacy audit); build green with same-origin assets
  deployed into dist and excluded from SW precache; E2E 64/64; real Tesseract smoke read the
  synthetic fixture at confidence 93 (~106 ms warm, dev machine); local Docker DB gate green
  (578/0/1 after fresh reset) plus grant-audit clean.

### Fixed — 2026-08-26 — M16 real-PostgreSQL repair: first full local DB gate green (P62; same child PR, DO NOT MERGE until P63/P64 integration)

P60 executed the repository's entire db-tests CI job for the first time on a local
Docker/Supabase Postgres stack and found the candidate RED; this change repairs every root cause
and re-runs the full local gate GREEN (db+authorization 578/0, m16-independent 53/53 with zero
skips, m13-adversarial 62/62, grant audit + hostile-grant convergence clean, all performance and
normal gates within thresholds):

- **Provisional opening path repaired (SQL)** — `create_opening_from_provisional` wrote a
  nonexistent `holdings.sealed_intent` column (D-061/M11 moved it to acquisition_lots); removed.
  Bought-and-open now creates purchase, line, sealed holding, sealed acquisition lot, opening,
  opened disposal and pulls atomically — execution-proven.
- **Openings lifecycle repaired (SQL)** — dropped the `set_updated_at` trigger that made every
  UPDATE of `openings` fail (`record "new" has no field "updated_at"`); `void_opening` and
  `reconcile_opening_cost` execute for real. No `updated_at` column added: openings carry explicit
  lifecycle timestamps and backup v2 mirrors exactly those.
- **Late idempotency replay after reconciliation (F-61-1)** — the provisional replay now recovers
  the ORIGINAL receipt's total paid / purchased_on through `provisional_purchase_id` instead of
  the current `source_lot_id` (which reconciliation repoints), so a late retry of the user's own
  original request replays correctly after linking; wrong facts still refused; cross-path reuse
  still refused. D-089/FINANCIAL_MODEL wording corrected to describe the implementation.
- **Reconciliation world execution-proven** — provisional purchase, source lot and old disposal
  voided; opening live at the real lot with provenance set; real purchase counted exactly once;
  re-open/re-sell of the retired lot refused.
- **Recent Activity adjudicated** — the opening arm works; E15's failure was shared-user fixture
  pollution truncating at LIMIT over same-day ties. Both History/Recent-activity cases now run
  dedicated isolated users and pin the full per-row contract.
- **Test adjudications without weakening** — CHECK-constraint cases assert refusal semantics
  (either firing constraint) with attributable columns moved together under the D-090 envelope;
  backup oracles adjudicated to schema_version 2 (`openings` classified MUST_EXPORT in the
  independent validator; counts reconciliation executing); M16 pricing fixture moved to a private
  synthetic card; market movers owns private variants + self-seeded ancient FX fallback +
  rate-gap snapshot legs (order-independent); gifted-sealed helper find-or-creates.
- **m16-independent discovery fixed** — OpenAPI enumerated with a dedicated authenticated test
  user's JWT (a service-role fetch omits user RPCs under this grant model): implementation-gated
  oracles actually run, 53/53, zero skips.
- **Type drift folded in** — `acquisition_lots.Update.opening_id` and `id`/`idempotency_key` on
  the three opening-writer RPC returns.

### Added — 2026-08-26 — M16: Openings, pulls and backup v2 — integrated candidate (sources PR #55 + #54 + #53; integration branch, DO NOT MERGE until DB CI runs)

Openings ship end to end as the single integrated M16 candidate on `feat/m16-openings-integrated`,
combining three parallel sources deliberately — P50 canonical core (PR #55), P51 user experience
(PR #54) and the independent implementation-blind adversarial contract package (PR #53). The
integration branch is the ONLY candidate that can eventually merge to main; the source PRs stay
open/draft and unmerged. **Release stays blocked until a full green DB CI run** (fresh migrate,
grant audit + hostile-grant convergence, db/authorization suites incl. M16, M12 rebuild gate, M13
adversarial execution, 10k benchmark) — GitHub Actions was billing/startup-blocked repo-wide
throughout; recorded per TESTING.md.

What exists:

- **Canonical openings ledger** — `openings` table (one source sealed lot per opening, D-087);
  consumption via the M10 `lot_disposals.kind='opened'` writer with the exact frozen share
  (residual rule identical to sales); pulled-card lots structurally carry NO cost basis
  (`unallocated_opening`, NULL columns — per-pull ROI is unrepresentable, not hidden); tracking
  completeness owner-declared; bulk remainder both-or-neither. Opening creates NO spend; voiding
  an opening restores sealed inventory but NEVER undoes its purchase (D-090).
- **Buy-and-opened flow with total-paid exactness** (D-090) — the wizard's second entry mode takes
  the RECEIPT TOTAL ("3 packs, paid 299,95"), never a per-unit price; one real provisional
  purchase plus the opening in one transaction; largest-remainder split keeps every figure øre-
  exact (unit 9998 ×2 = 19996, exhausting final unit 9999); the line-total equality CHECK gained
  a widening largest-remainder tolerance to represent the exact total honestly.
- **Server-side idempotency** (D-089) — `openings.idempotency_key` unique per owner; retries with
  the same key return the same committed opening; on the provisional path the key is resolved
  BEFORE the purchase row exists so a lost-response retry can never double-spend; materially
  different reuse is refused by name.
- **Exact cost preview** — `list_opening_sources()` returns already-derived preview components
  (effective unit basis + exhaustion residual) matching the writer byte-for-byte; one tested
  domain boundary (`computeOpeningCostPreview`) composes them; no client re-implements SQL
  arithmetic.
- **Provisional reconciliation without audit_events** — provenance on the opening row itself
  (`provisional_purchase_id` / `reconciled_at` / `reconciled_to_purchase_id`); F12 holds at every
  instant inside the single commit; repeat-refused.
- **History & Home** — one Opening event per opening in History (Openings chip/badge/route);
  opening-linked pulls never double-report as additions; exactly ONE Opening row per opening in
  Home recent activity.
- **Backup v2 (D-091)** — schema_version 2 adds the canonical `data.openings` section plus
  `opening_id` linkage on acquisition lots/disposals; v1 files remain valid pre-Openings
  artifacts; post-M16 writers emit v2 only; validator, counts, ordering and tests updated.
- **CSV** — `openings.csv` joins the full human export suite.
- **Reset extension** — reset clears openings, their pull lots and disposals in FK-deterministic
  position with honest counts.
- **Independent adversarial binding** — the P52 oracle package binds execution-bound to the shipped
  surface (folded create-with-pulls, dedicated provisional RPC, total-paid slot) without loosening
  assertions; two first-contact mismatches classified ORACLE_BINDING_MISMATCH and adapted
  deliberately; everything DB-backed remains gated pending CI.

### Fixed — 2026-08-25 — M16 final integration cleanup: audit findings completed end-to-end (P59; same child PR as the P56 repair, DO NOT MERGE until DB CI runs)

Closes the remaining P57/P58 integrated-audit findings on top of the P56 repair, in the same
reviewable child branch:

- **Home Recent Activity renders openings (P58 F1)** — the 'opening' activity type the M16
  backend already emits is now understood client-side: a nonblank "Opened" label and a working
  `/openings/$openingId` route. A bought-and-open legitimately shows one Purchase row AND one
  Opening row; the opening's analytical amount still never enters any Home total.
- **The idempotency key belongs to the logical draft (P58 F5)** — the key now lives inside the
  user-scoped draft instead of per-wizard-mount state, so it survives route remounts and
  browser-back returns: a committed-but-unanswered submission can no longer be duplicated by a
  remount minting a fresh key. Rotated only when a new logical opening starts.
- **Stale-'submitting' recovery (P58 F4)** — a draft saved mid-request whose wizard unmounted
  before the failure landed used to stay 'submitting' forever, bricking the flow. It now loads
  back as retryable editing with every field intact; the persisted idempotency key makes that
  retry safe whether or not the interrupted request actually committed.
- **Provisional replay compares money and business date (P57 F-57-4)** — same key + same identity
  but a different total paid (or purchased_on) is refused as `idempotency-key-reuse` instead of
  silently replaying the old financial fact; D-089's wording states exactly what is compared.
- **Reconciliation UI shipped (P57 F-57-3 / P58 F7)** — Opening Detail offers **Link to purchase**
  while an opening is active, provisionally costed and unreconciled. The picker reads new
  owner-only provenance columns (`purchase_id/purchase_origin/purchased_on`) on
  `list_opening_sources` and mirrors the server's own target rule; with no eligible purchase it
  says so plainly. Success invalidates detail, sources, Portfolio, dashboard, spending, history
  and recent-activity queries.
- **Honest provisional/reconciled copy (P58 F6)** — the false "Cost entered manually — not linked
  to a purchase" marker is replaced by where the figure actually came from ("Cost from the total
  you entered…"), with "Linked to recorded purchase · date" after reconciliation.
- **Coverage surfaced (P58 F9)** — priced/unpriced/sold pull counts and reconciledAt travel
  through the detail contract; fully-sold pulls render "Sold", partials state what remains ("1 of
  2 remaining"); an unpriced-retained honesty marker guards the retained-value aggregate ("—" when
  nothing retained carries a price).
- **Sweeps** — manual-card creation failures show a safe retry sentence instead of raw backend
  text (P58 F10); the Review step repeats the exact Opening cost being frozen for existing-lot
  mode (P58 F11); generic ↔ holding-specific wizard entries re-scope to the explicit route
  without discarding entered pulls (P58 F12).

database.types.ts hand-updated for the widened `list_opening_sources` return shape. Backup v2
unchanged (no new canonical columns).

### Fixed — 2026-08-25 — M16 integrated-candidate repair: reconciliation lifecycle and review findings (D-092; child PR against the integration branch, DO NOT MERGE until DB CI runs)

Closes the P54/P55 integrated-review findings on `feat/m16-openings-integrated`:

- **Phantom provisional lot after reconciliation (P54 H1)** — reconcile retired the provisional
  consumption, which let D1 restore the provisional source lot to full live availability while
  its purchase was being voided: known-basis sealed inventory citing money that had left the
  ledger. `reconcile_opening_cost` now voids that lot in the same transaction — purchase, lot
  and consumption annihilate as a unit; historical rows retained (D-092).
- **Reconciliation target guard (P55 F55-10)** — the real target must belong to a LIVE purchase
  whose origin is not `provisional_opening` (joined explicitly; refused like foreign/missing).
- **Retained-only coverage counts (P54 L1)** — `get_opening`'s priced/unpriced pull counts and
  retained value now count only pulls with `quantity_remaining > 0`; a fully-sold pull stays in
  sold-provenance counts and proceeds, and in Opening Detail history.
- **User-scoped opening drafts** — the session-memory draft store is keyed by authenticated user
  id and cleared on sign-out: account B never inherits account A's draft, anonymous visitors see
  none, the same user's draft still survives wizard remounts.
- **Manual-card retry/remount dedupe** — created definition ids persist into the user-scoped
  draft, so a retry after a failed opening RPC reuses the same definition row across wizard
  remounts without any heuristic identity merging.
- **Reset copy** names "Openings and their pulled-card records" among what reset permanently
  removes.
- **Integer-division wording** corrected where plpgsql bigint division truncates toward zero
  ("floor" prose misled for negative adjustment sums); executable arithmetic unchanged. The
  widened line-total CHECK stands unchanged, documented as a global purchase-line invariant with
  direct constraint tests.

### Fixed — 2026-08-25 — Home's Current Portfolio Value updates immediately (P48, D-086; PR #51)

Owner-reported: after adding a card, the value breakdown and spending figures were already
correct but Home's primary "Current Portfolio Value" sat on the previous snapshot — under an
"Updating…" badge — until the background snapshot worker drained. The headline is now LIVE
current state: raw + graded + sealed as `get_dashboard_summary()` already resolves for open
holdings, and current TTEP is that live CMV + live NSP − CS. A mutation shows in both figures as
soon as its invalidated summary refetch returns; no second request, no per-card computation. The
chart/period-change history stays snapshot-backed by design: while a recompute is queued a small
"Updating history…" status in the chart area says only that background tracking is catching up
(never that the current value is stale), disappearing on its own when pending clears. Missing-vs-
zero discipline holds in live terms: no priced holdings → "—", never 0; mixed coverage shows the
partial sum with unpriced counts still surfaced; sold-out-of-everything shows its real 0.
Every ownership/ledger mutation surface (add card/sealed acquisition, manual valuation set/
clear, purchase create/edit/void, sale create/edit/void) now invalidates `dashboard-summary` —
the surfaces P28/P43 built already did. No migration, no new RPC, no grant or cron change.

### Added — 2026-08-24 — M13: Export and versioned backup (PR #47; sources PR #44+#45+#46)

Profile › Data › **Export & backup** (`/profile/export`): a ten-file CSV analysis suite and a
lossless versioned JSON backup ("pokeportfolio-backup" v1), generated entirely client-side under the
signed-in owner's JWT — RLS is the access boundary; no user-id parameter exists to forge. Money
travels as exact integer minor-unit strings (proven past 2^53 end-to-end); canonical timestamps stay
verbatim wire strings; null stays null. The backup carries an identity manifest for referenced
shared-catalog rows instead of copying the ~47k-variant catalog; user-created sealed products are
data, curated rows are identity reference only; `is_admin`/`disabled_at` never travel. Delivery is a
two-step ready→share flow so `navigator.share()` always runs under fresh transient user activation
(D-078) — the single-tap design threw NotAllowedError on installed iOS PWAs; NotAllowedError is now
surfaced with explicit "Try sharing again"/"Download instead" choices (D-079). Export pagination is
offset-with-reconciliation — honest name, one COUNT per section up front, cross-page duplicate
detection over full primary keys, exact received-vs-expected reconciliation, loud failure on any
mismatch (D-074). Multi-query export is documented as NOT snapshot-isolated (D-077). Strict v1:
section names equal canonical table names (`profiles`, `sealed_products`); unknown data keys are
refused; evolution goes through schema_version bumps only (D-076). A periodic local-only export
reminder ships with a recorded 30-day default cadence (D-080); the M7.1 quick Portfolio CSV is
retained and relabelled "Quick CSV" as a distinct filtered-view report (D-081). No combined
everything-export: client-zip was evaluated by the export-core draft and removed again because no
exposed flow needs it (D-075). The implementation-blind adversarial contract package (PR #45) is
bound deliberately and its DB-backed cross-user suite plus generated-backup contract now execute in
CI's db-tests job; an opt-in ~10k-lot export scale audit joins the performance steps. Restore/import
does not exist yet (M19 per D-025/BACKLOG).

### Fixed — 2026-08-24 — Home settles automatically after a correction; recompute drain runs every minute (P42)

Owner-reported: after removing a quick-add test card, Home sat on "Updating…" for many minutes
and spend appeared not to return to its prior value. Hosted read-only diagnosis proved the
ledger correct (the removed lot's parent purchase had been auto-voided synchronously — zero
ghost purchases), so the fix targets refresh latency on both sides. Backend: one additive
migration (`20260901120000_p42_cron_cadence.sql`) reschedules `m12-recompute-snapshots` from
every 15 minutes to every minute (measured no-op ticks ~0.0 s; bounded batch; SKIP LOCKED) and
adds a nightly `m12-run-log-prune` keeping 30 days of run history. Frontend: Home polls
`dashboard-summary` only while `pending_recompute` is true (3 s; no idle polling); when pending
flips false the value history refetches with it, so the "Updating…" badge can never vanish over
a stale chart. Holding Detail's per-lot Void and Portfolio select-mode's Remove now invalidate
the dashboard summary like every other correction path already did. New suites:
`tests/db/p42_owner_refresh.test.ts` (quick-add→remove→baseline restored exactly, multi-line
accessory spend preserved, partially-disposed stays blocked, cross-user untouched) and pure
domain tests for the poll/settle decisions. Decisions D-082/D-083.

### Added — 2026-08-24 — Portfolio reset and unified correction-aware History (P43)

Profile gains a restrained **Danger zone** with one action — *Reset portfolio data* — behind an
explicit "Are you sure?" confirmation stating what is removed and what is kept. The reset itself
is one atomic server operation, `reset_my_portfolio_data()` (SECURITY DEFINER out of necessity —
browsers hold no DELETE grants on the financial ledger at all; every statement filters
`auth.uid()`, no user-id parameter exists): holdings, acquisition lots, purchases/purchase_lines,
sales/sale_lines, lot_disposals, lot_cost_adjustments, manual_valuations, collection/tag
memberships, portfolio snapshots and the recompute queue are deleted in FK-safe order with the
queue row locked first; account, settings, retailers, storage locations, tags, collection
definitions, manual card definitions and the user's own sealed products are preserved (D-084).
An empty account is genuinely empty — no fabricated zero rows, no stale dashboard value.

History is rebuilt from Sold/Traded/Other tabs into a single correction-aware feed over the
canonical event sources that exist today: purchases, sales, non-purchase acquisitions ("Added")
and active manual valuations (`list_history_events` — one bounded SECURITY INVOKER RPC, keyset
pagination on (recorded_at, primary_id), money as text, voided entries hidden by default behind
a "Show corrections / voided" toggle that never touches accounting). Every event navigates to its
existing correction surface rather than offering deletion. Openings/Trades/Grading become event
kinds when M16/M17/M18 land (D-085). Two migrations (`20260901120010`/`20260901120020`) applied
to `pokeportfolio-dev` before the frontend merge (destructive owner-data operation; released as
PR #49, squash `59401e4`).

### Added — 2026-08-24 — Holding-level quantity correction and removal (P28, PR #42)

From a holding's detail page, without Portfolio select mode: quantity 1 offers "Remove from
Portfolio"; quantity > 1 offers "Adjust quantity" and "Remove all". Removal reuses the M8.1 void
lifecycle exactly. Reduction is a new `reduce_holding_quantity(uuid, jsonb)` RPC (SECURITY
INVOKER, `search_path = ''`, ownership from `auth.uid()` alone): the owner explicitly picks the
non-purchase lot(s) to shrink; `quantity` and `quantity_remaining` move together so D1 holds by
construction; purchased lots are refused and route to purchase correction; partially-disposed
lots are refused with frozen sale basis untouched; a request that would leave any lot or the
holding at zero copies is refused in layers (per-lot floor guard → locked aggregate pre-invariant
→ post-image refusal → schema CHECK backstop). All validation happens under sibling-lot row locks
acquired ascending (create_sale's convention) before the first write — all-or-nothing. A
correction here is NOT a sale: no proceeds row, no sale line, no realized result (D-072). The M12
recompute queue updates from the existing trigger automatically. Two migrations
(`20260831120000`/`20260831120010`) shipped to `pokeportfolio-dev`; hosted security verified
(no PUBLIC grant, authenticated-only EXECUTE, grant audit clean).

### Changed — 2026-08-24 — Home polish and Search set showcase (PRs #40/#41)

Home (owner feedback after the first real signed-in dashboard session): removed the redundant
"as of" date under Current Portfolio Value and the TTEP explanation sentence (no financial
semantic changed); the privacy eye now sits directly beside the value it masks instead of at a
fixed screen edge; Most Valuable Cards tiles show their real resolved holding value from the
already-fetched response (missing renders "—", never 0); range buttons show an unambiguous
selected state owned by the URL; the insufficient-history placeholder describes history as just
beginning instead of showing snapshot dates, and Market Movers' empty state says tracking has
not yet spanned its window rather than looking broken.

Search: the Sets showcase is now English-only by owner decision, browses vertically downward in
larger tiles (the horizontal carousel is gone, D-073), and set images load reliably via the TCGdex
set-asset convention (extension appended on the path segment only). Catalog reads retry once on a
transient auth failure (`PGRST301`) and never retry anything else — including "invalid api key" —
a defensive backstop for an unreproduced cold-start report.

### Fixed — 2026-08-30 — M12 review findings (merged with M12)

The independent adversarial review of the M12 candidate returned CHANGES_REQUIRED; every finding
is closed. H1: a manual valuation ended by an explicit clear now STAYS cleared when an unrelated,
later valuation arrives with a higher effective date — only an atomic set-over-set replacement
keeps the replacement-date boundary (D-062's resolved corner), with regression tests in the DB
suite, the independent oracle and the adversarial scenarios, including a provider-priced gap that
proves real fallback and an unpriced gap that stays honestly missing. H2/M1: before a user's
first snapshot exists, TTEP renders "—" instead of a fabricated "0 kr" and THP propagates NULL in
the RPC instead of coalescing unavailable CMV to 0; a genuine zero still renders as 0.
H3/D-070: portfolio_snapshots is explicitly recorded as a derived, rebuildable cache relative to
CURRENTLY RETAINED canonical facts — M9.1's weekly compaction may adjust an older historical
market-value point exactly once, frozen ledger fields never change, nothing is fabricated, the
dashboard discloses it in one sentence, and a new cross-milestone DB test proves the whole loop
(dense → real thinning → invalidation → drain → from-scratch-rebuild equality). Also: D-069
records reversed-range rejection as ratified; D-071 documents MAX = up to four years of history;
the drain worker's per-user savepoint semantics are stated precisely in comments/docs; the
initial-backfill runbook specifies one-user-at-a-time draining; the stale privilege comment on
`m12_recompute_pending_for_self` is corrected; D-068 gained a concrete multi-unit partial-disposal
data proof.

### Added — 2026-08-30 · M12 Dashboard (released)

Home is now the real investment-style portfolio dashboard. A derived `portfolio_snapshots` cache
(one end-of-business-day state per user per date) is maintained by a database-side recompute
engine: transactional invalidation triggers mark the earliest affected business date, and a
bounded SKIP LOCKED worker rebuilds forward from there on a 15-minute cron cycle offset from the
price ingest, plus a daily sweep that keeps "current" honest with zero activity. Historical
snapshots replay the ownership timeline from canonical disposals (never projecting current
quantity backward), resolve provider prices as-of each date with freshness measured from that
date and FX observed on or before the observation, apply the manual-valuation interval model
(D-062), and accumulate frozen-ledger spend/proceeds cumulatives. The central invariant — a full
rebuild equals incremental recompute byte-for-byte over every semantic column — is a permanent
test gate exercised over a richly corrected fixture.

The headline Current Portfolio Value renders from the latest snapshot in one bounded request,
with Total tracked economic position secondary (never labelled profit), period change across
1D–MAX ranges (default 3M; zero bases render an undefined percentage), data-quality counts
(priced/unpriced, automatic/manual, uncosted lots), a raw/graded/sealed value breakdown,
monthly-spend bars reconciling GPO = CS + HS, sales figures split into realized-on-costed vs
proceeds-from-uncosted, recent activity from canonical events only, and empty/no-history states
that never fabricate. The chart is TradingView Lightweight Charts v5.2.1 (Apache-2.0), validated
by spike and lazy-loaded at 62 KB gzip with its attribution implemented in full (D-066); the
privacy eye masks the headline, change figures, chart axis/tooltips and the screen-reader
summary together. Custom-collection scopes show correct current figures and say plainly that
historical membership tracking does not exist (D-065).

Security posture: snapshots are owner-read-only with no browser write grant of any kind; the
recompute queue/run log are invisible to browsers; every engine routine refuses authenticated
callers at the privilege level; admin gains no dashboard bypass.

Released through PR #35 (squash `e794368`) after an APPROVED independent delta review, then
deployed in a controlled release: all six M12 migrations applied to `pokeportfolio-dev`, cron
live and tick-verified, initial backfill converged at one-user-per-drain batches, hosted grant
audit and remote security checks green, Cloudflare deployment verified by the full automated
`deployment-check.mjs` (28/28). The signed-in Dashboard check remains with the owner.

### Added — 2026-08-29 · M11 Sealed Inventory

Sealed products (booster packs/boxes, ETBs, bundles, tins, etc.) are first-class Portfolio
inventory, reusing the existing card acquisition/purchase/valuation/sale machinery rather than a
parallel system. A curated catalog (a deliberately modest, individually-sourced seed of seven real
products — never a generated combination of every set × every product type) plus user-created
private products fill real gaps ("Add custom sealed product"); a user-added row is visible only to
its creator, enforced server-side, not merely hidden from Search. Sealed products can be added
directly (`/portfolio/sealed/new`) or as a purchase line, with the same origin/cost-basis semantics
cards already have — no fabricated cost for a gift or a pre-tracking item.

Sealed valuation is manual-only, permanently — no automatic sealed pricing exists anywhere
(reverified this session against current TCGdex/Cardmarket/TCGplayer/PriceCharting sources; the
conclusion is unchanged from D-010). A sealed holding's manual value multiplies by quantity, is
visibly marked "Manual" with the date it was set, and clearing it returns to **—**, never `0`.
Portfolio's value header now shows Cards and Sealed as a distinct segment that always sums to the
total — sealed value never silently disappears into an unexplained combined figure.

A real cardinality defect was found and fixed before any UI was built on top of it: `sealed_intent`
had been sketched on `holdings`, which cannot represent a user owning three identical boxes with two
"keep sealed" and one "planned to open" — a holding-level column has exactly one value for the
whole position. Relocated to `acquisition_lots` (D-061), where a per-lot intent aggregates correctly
for display and a new `set_sealed_lot_intent` RPC splits a lot when only part of its remaining
quantity changes intent — organisational only, never touching cost basis, spend or realized result.

Portfolio/Search/Holding Detail all gained sealed support: a type filter (Raw/Graded/Sealed), a
Sealed search tab, sealed product detail, and Holding Detail's lot list showing each lot's own
intent. Selling a sealed lot uses M10's sale engine completely unmodified — proven directly, not
assumed. `scripts/deployment-check.mjs`'s Cloudflare chunk fetch changed from one unbounded
`Promise.all` to a bounded 5-way concurrency pool with an explicit per-request timeout, closing the
harness gap M10 hit (a local Node/undici connection-limit timeout, not a deployment defect) so the
full automated gate runs again. Full account: `ai_outputs/Claude_outputs/output_19.txt`. Decisions:
DECISIONS.md D-061.

### Added — 2026-08-28 · M10 Sales and History

Real sales, with explicit lot selection every time — FIFO is only a pre-filled suggestion, never a
silent default. Recording a sale (`/sales/new`, reached from the central + menu, Portfolio's
"Sell" bulk action, or a Holding Detail's Sell button) freezes each line's cost basis at the moment
of sale, allocates fees/outbound shipping/buyer-paid shipping across lines exactly (largest
remainder, `Σ allocated = total`), and supports NOK or a foreign currency (Norges Bank or manual
rate). A gift or opening-pull sale shows real proceeds with a result of **—**, never a fabricated
profit — the central rule this milestone exists to enforce. Sales can be safely corrected (price/
fees/shipping) or voided (restoring the sold quantity); a lot's or quantity's choice cannot be
edited in place, by design — void and re-record instead.

`/history` is real for Sold (list, sale detail, result sorting that never ranks an unknown-basis
sale as infinite profit); Traded and Other honestly say they have nothing to show yet.

Three real, previously-unaddressed gaps closed as prerequisites: `acquisition_lots.residual_nok_minor`
(the NOK-side counterpart of M6's original-currency lot residual, silently missing since M8 for any
foreign-currency multi-unit lot), `lot_cost_adjustments` (documented since M3, never actually
created), and the residual-consumption rule itself — which disposal of a lot sold across several
separate sales gets the leftover øre (D-060).

`create_sale`/`update_sale`/`void_sale` are `SECURITY DEFINER`, a deliberate, documented exception
to this project's SECURITY INVOKER default: frozen cost basis, allocated amounts and realized
result are unreachable by any direct write from the browser, not merely policed after the fact —
`authenticated` holds no `INSERT`/`UPDATE` grant at all on `sales`/`sale_lines`/`lot_disposals`.
Full account: `ai_outputs/Claude_outputs/output_18.txt`. Decisions: DECISIONS.md D-060.

### Added — 2026-08-27 · M9.1 Pricing closeout

Closes the explicit M9 acceptance gaps found by review before M10 begins. Search result tiles show
batched real prices (honest range/from-price display, no N+1). Card Detail has an exact selected-
variant price/history (fixes the M9 defect where the chart always used the first declared variant).
Market Movers is a real dedicated screen (`/market-movers`, 1D/7D/30D periods, four sort modes,
ranked by per-unit % change never quantity-weighted kroner — D-056). Display currency is a real,
presentation-only NOK↔EUR/USD conversion everywhere a resolved value is shown (D-057).

`price_snapshots` storage capacity is measured against a representative synthetic dataset (245.30
bytes/row, not the earlier estimate) and retention shortened from 12 months daily to 60 days daily
+ weekly beyond — the previous policy projected to exceed the entire free-tier database budget at
documented realistic scale (D-058). The 18-month retention test, the value_desc/value_asc
pagination edge matrix, and the real 10,000-lot Portfolio benchmark are now permanent CI steps
(previously disclosed as "not measured" since M7).

Two real bugs found and fixed before merge: a stale privilege-baseline/grant-audit entry for
`get_market_movers`'s changed signature, and a `search-prices` bug where `fx_rates.rate` arrives as
a JSON number (not decimal text) over a plain PostgREST `select` — would have made every
`search-prices` call fail silently in production. Full account: `ai_outputs/Claude_outputs/output_16.txt`.

### Added — 2026-08-26 · M9 Pricing and snapshots

Real raw-card market valuation. `price_snapshots` (shared market data, one already-fallback-chosen
row per provider per variant per day — D-053), `watched_card_variants` (service-only, bounds
snapshotting to ever-owned printings), and a single set-oriented resolver
(`resolve_variant_market_values`) implementing FINANCIAL_MODEL.md §6: manual → fresh → stale →
missing, with `use_eu_pricing` (D-044) finally activated as a real provider preference (D-052).

Variant-safe price mapping (`_shared/tcgdex.ts#fetchCardPricing`) prefers TCGdex's own embedded
per-variant pricing when present and falls back to card-level fields only when unambiguous — an
ambiguous shape resolves to no price rather than a guess, evidenced by real captured payloads
(`tests/data/tcgdex-pricing.test.ts`). `ingest-prices` (bounded, oldest-synced-first batches every
15 minutes) and `ingest-fx` (daily) run on `pg_cron`/`pg_net`, secret held in Supabase Vault;
`thin_price_snapshots` retains 12 months of daily history and weekly beyond that. `search-prices`
answers on-demand, non-persisted current references for Search/Card Detail.

Wired into Portfolio (`list_portfolio`/`portfolio_counts` — value_desc now sorts by real holding
total, D-052), Home (real Portfolio value, priced/unpriced counts, a real Market Movers section),
Holding Detail (full provenance, manual value set/clear via `clear_manual_valuation`), and Card
Detail (on-demand current price per variant, a real price-history chart from actual snapshots
only — never a fabricated point, D-008).

Also fixed in passing (found while rewriting `list_portfolio`'s body regardless): M7.1's number-sort
migration had silently reverted the M7 10,000-lot performance fix back to a per-holding `LATERAL`
aggregate (D-054) — restored to the materialized-CTE shape.

### Added — 2026-08-24 · M8 Purchases and the spending ledger

Multi-line purchase ledger over the existing M3/M6 `purchases`/`purchase_lines` tables:
`create_purchase`, `update_purchase`, `void_purchase`, `purchase_spending_summary` (GPO/CS/HS in
one query). Shipping, customs and discount allocated with a SQL port of the M2 largest-remainder
allocator — proven byte-identical to the TypeScript reference — and the frozen NOK total is itself
allocated the same way rather than rounded per line, keeping `GPO = CS + HS` (F1) exact for a
foreign-currency purchase. Retailers, backdating, card/sealed/manual-card/accessory/grading/
bulk/standalone lines, spend-class default and override, safe edit (quantity/price/spend-class/
charges only — a line set cannot change, D-047), safe void with downstream-blocker detection. Card
and sealed lines always produce a real holding and lot (D-048); `bulk_lot` remains the line for
deferred individual entry.

**Foreign currency.** `fx_rates` (market-data cache, service-role writes only) and a new
`fetch-fx-rate` Edge Function resolving/caching a Norges Bank rate for a (currency, date) pair —
orientation and endpoint re-verified live against the real API this milestone. Manual FX override
supported, written only to the caller's own purchase, never the shared cache. A zero-decimal
currency (JPY) is exercised end to end, proving money never assumes a 2-digit exponent.

**UI.** `/purchases`, `/purchases/new`, `/purchases/$purchaseId`, `/purchases/$purchaseId/edit` —
reachable from the central + menu ("Record purchase") and a new Home "Total spent" shortcut. No
market value or P/L anywhere in this milestone (D-023 untouched; M9 still owns pricing).

**Corrected two pre-existing, previously-unexercised gaps** (PROJECT_JOURNAL.md 2026-08-24):
`retailers.user_id` had no `default auth.uid()` since M3; `purchases.retailer_id` had no
ownership-check trigger at all. Also corrected `void_acquisition_lot`'s (M6) parent-purchase void
scope, which only checked the one purchase line a lot belonged to — safe while every purchase had
exactly one line, wrong once M8 makes multi-line purchases real; a strict generalization, so every
existing purchase's behaviour is unchanged.

### Added — 2026-08-22 · M7 Portfolio: organisation, display and navigation

The Collection screen becomes **Portfolio** (user-facing rename, D-040; `/collection*` routes
redirect) and gains the display/organisation surface the product was missing: grid density 1–4
(mobile default 2, desktop 4), list and table views (table also on mobile, horizontally
scrollable), a visible Sort by control, quick and full filters, and playlist-like custom
collections. Real primary navigation ships for the first time: a mobile bottom bar
(Home/Search/Portfolio/More/Profile, central quick-add) and an equivalent desktop top nav.

**Schema.** `custom_collections`/`custom_collection_members` (DATA_MODEL.md §5.2.1), shipped
exactly as originally specified — plain owner-RLS tables, no RPC layer, invariant C1 enforced by a
plain `on delete cascade`. `profiles.collection_default_sort` (new enum `portfolio_sort_order`,
default `value_desc`) joins the existing density/view preferences.

**Read surface.** `list_portfolio(...)` and `portfolio_counts()` — both `SECURITY INVOKER`,
replacing the M6 client-side full-column count sum — are the Portfolio's entire sort/filter/keyset-
pagination query. "Value" sorting resolves to a graded holding's real manual valuation and nothing
else pre-M9 (D-041): never the acquisition cost standing in for market value, and every raw-card
holding's `NULL` value sorts deterministically by name rather than as zero. Pagination is real
keyset (never `OFFSET`) via an explicit two-bucket cursor.

**Search.** Cards/Sets segmented search; set results carry real metadata (name, language, symbol,
release date, card count) from a plain `card_sets` read, no new RPC. Every card result — in Cards
mode or inside a set — carries an independent quick-add **+** that preselects a card's only variant
or opens its detail page for a real choice among several, reusing the M6 add flow exactly.

**Security.** Closed the PUBLIC-EXECUTE privilege blind spot SECURITY.md §5.9 had documented as a
known gap since M6 (D-042): every routine in `public` is now swept clear of PostgreSQL's implicit
PUBLIC grant, a new default-privilege statement stops a future function from arriving
PUBLIC-executable, and `scripts/grant-audit.sql` gained its own PUBLIC-grant check —
`tests/db/sql/hostile_grants.sql` proves it can fail before proving the baseline fixes it.

**Performance.** TanStack Virtual windows the grid/list/table views. `list_portfolio`/
`portfolio_counts` were measured against a real 7,500-holding/10,109-lot synthetic account on
`pokeportfolio-dev`: the first version (a per-holding `LATERAL` aggregate) took 5.5-8 s per call
with two sort modes timing out; rewritten as a `LEFT JOIN ... GROUP BY` CTE (the shape
`holding_summaries` already used correctly) and re-measured at 130-570 ms across every sort mode
and keyset page. `scripts/portfolio-perf-benchmark.mjs` is the repeatable version of the same
measurement for a future session with local Docker.

**Tests.** `tests/db/m7_constraints.test.ts` (S1 trigger on the two-parent membership table,
invariant C1, and account-deletion cascade for both new M7 tables — found missing on
`custom_collection_members.user_id` by the real benchmark cleanup, fixed with
`20260822120050_m7_custom_collection_members_cascade_fix.sql`). `tests/authorization/m7_portfolio.test.ts`
(custom-collection CRUD and cross-tenant attacks; `list_portfolio` isolation, sort correctness,
filter correctness, keyset-pagination completeness; `portfolio_counts` correctness). Updated
Playwright route-guard coverage for the renamed/new routes and the legacy-redirect behaviour.

See DECISIONS.md D-040 through D-042, HANDOVER.md and `ai_outputs/Claude_outputs/output_11.txt` for full detail.

### Fixed — 2026-08-22 · Content-Security-Policy blocked M7's card artwork in production

`img-src` had no external host, so every card thumbnail M7 renders (search results, Portfolio grid
tiles) was silently blocked by the deployed CSP — a gap flagged in a `vite.config.ts` comment since
M5 and never revisited once M7 started actually rendering artwork. Found by browser-verifying the
merged M7 build against `pokeportfolio-dev.pages.dev`, since `_headers` only applies on Cloudflare
Pages and CI never exercises it. Fixed by naming `https://assets.tcgdex.net` explicitly in
`img-src` (docs/API_SOURCES.md's documented image CDN host), not by loosening to `https:`. See
PROJECT_JOURNAL.md 2026-08-22.

### Added — 2026-08-21 · M6 Collection: holdings, acquisition lots, origin and cost

The application becomes usable as a personal collection tracker: search a card, add it, record how
it was acquired and (where applicable) what it cost, see it in `/collection`, add another copy
later without losing the first acquisition's provenance, inspect the lots behind a holding.

**Schema.** A holding now has three possible identity sources, not two: `manual_card_id`
alongside `card_variant_id`/`sealed_product_id`, exactly one non-null (D-037) — the honest fallback
for a physical card the shared catalog does not (yet) list, user-private and never written into
the catalog tables. `storage_location_id` moved from `holdings` to `acquisition_lots` (D-036) after
a concrete two-binder scenario proved the original one-per-holding cardinality wrong. `lot_origin`
gained `opening` ("Pulled") and `trade_in`, and `cost_basis_state` gained `unallocated_opening` and
`trade_in`, both pulled forward from their originally-planned M16/M18 arrival without the
`opening_id`/`trade_line_id` linking columns, which still wait for those milestones (D-038).
`manual_valuations` shipped early too, for a directly-owned graded card's manual value, currency
fixed to NOK pending FX (M9). `holding_tags` is the new many-to-many join for M6's tags.

**Read/write surface.** `add_card_acquisition` — a single SECURITY INVOKER RPC that finds-or-creates
the identity-matching holding (race-safe via the real `holdings_identity` unique index) and writes
one acquisition lot, plus a real single-line purchase when the cost is known — is the one atomic
add-to-collection operation; nothing about it can leave an orphaned holding or a lot with no valid
parent. `void_acquisition_lot` is the mistake-correction path (void semantics, never a raw delete;
voids the sole purchase a known-cost lot created too, so a corrected mistake never leaves a ghost
spend in `GPO`/`CS`). `set_manual_valuation` supersedes-then-inserts so a graded holding's value
history stays append-only. `holding_summaries` is a `security_invoker` view giving the Collection
list one query instead of one per row.

**UI.** `/collection` (2-column mobile grid, desktop responsive, empty/loading/error states),
`/collection/$holdingId` (identity, lots, void, favourite, manual value for graded), `/add`
(progressive form: quantity, raw/graded, origin-driven cost disclosure, storage, favourite, notes),
`/collection/manual/new` (the catalog-missing fallback). "Add to collection" now lives on
`/catalog/$cardId`'s variant list; an empty catalog search offers the manual-entry link.

**Security.** Migrated `pokeportfolio-dev` to Supabase's current `sb_publishable_…`/`sb_secret_…`
key pair (D-039), closing out the M5 key-exposure note: the legacy service-role value returned by
`supabase projects api-keys` into a prior session's transcript is deactivated once the new pair is
verified working end to end, without rotating the JWT signing secret (which would have invalidated
every user session for no reason connected to the actual exposure). `VITE_SUPABASE_ANON_KEY`
renamed to `VITE_SUPABASE_PUBLISHABLE_KEY`; both Edge Functions read `SUPABASE_SECRET_KEYS` first,
falling back to the legacy variable only for the local stack. CI's hostile-grant convergence step
no longer hardcodes a baseline migration filename — it selects the lexicographically-latest
`*_privilege_baseline.sql` and fails outright if none exists, closing the fragility SECURITY.md
§5.9 flagged after M5.

**Tests.** `tests/db/m6_constraints.test.ts` (identity XOR, origin/cost-state consistency, S1
ownership triggers for the three new relationships), `tests/authorization/m6_collection.test.ts`
(RPC happy paths — energy, manual card, graded with manual value, pulled, reused holding — and
cross-tenant attacks against the RPC's caller-supplied arguments), `manual_card_definitions` folded
into the generic owned-tables attack matrix, five new Playwright route-guard cases.

See DECISIONS.md D-036 through D-039, HANDOVER.md and `ai_outputs/Claude_outputs/output_10.txt` for full detail.

### Added — 2026-08-20 · M5 Pokémon catalog, TCGdex ingestion and search

The application exposes real Pokémon TCG product functionality for the first time. TCGdex
re-verified from live requests rather than assumed: REST chosen over GraphQL (undocumented, no
language argument on the list queries) and over a bulk dump (none exists).

Two real schema defects, found by inspecting live TCGdex responses before M6 attaches holdings to
`card_variants`: the variant model (a real card — Base Set Charizard — is holo, shadowless and
first-edition at once, which the M3 `variant_type` enum could not represent; replaced with
independent `finish`/`stamp`/`subtype` columns) and provider-id scoping (TCGdex reuses ids like
`neo1` across English and Japanese; every provider-id uniqueness constraint is now scoped to
`(language, id)`, and `card_series` gained the provider-id column M3 omitted). A third defect —
marketplace product ids are not one-per-variant — dropped uniqueness from `card_variants`'
`cardmarket_product_id`/`tcgplayer_product_id`.

`sync-catalog` (Edge Function) ingests one `(language, set)` per invocation: idempotent upserts,
Pokémon TCG Pocket excluded via `serie.id` (checked server-side), upstream deletions deactivate
rather than destroy identity. Gated by an operator bearer secret rather than a user session.
`scripts/run-catalog-sync.mjs` drives a full sync. The real English and Japanese physical catalog
was ingested into the development Supabase project — counts in HANDOVER.md.

`search_cards` (Postgres function) ranks cards by name/set trigram similarity plus a collector-
number-token heuristic, language-filterable, invoker rights. `/catalog` and `/catalog/$cardId`:
debounced search, language filter, infinite-scroll results, card detail with real variant data, no
"Add to collection" (that is M6). Browser-verified against the real remote catalog, desktop and
mobile.

CI's hostile-grant privilege-convergence test needed its own fix: re-applying only the M4.1 baseline
migration dropped `search_cards`'s grant, since that file's sweep predates the function. A new
pure-privilege migration restates the complete current surface.

### Added — 2026-08-20 · M4.1 privilege convergence, deployment and real end-to-end validation

M4 closed a live privilege escalation. M4.1 answers the question that fix raised: whether the
migrations reach the intended privilege surface from a project that starts out wrong, rather than
only from an empty database. Three gaps said no.

Function grants were revoked from a hand-written list of names, so a function arriving pre-granted
would have survived — swept now, then granted back to exactly four. Default privileges were never
neutralized, and they turned out to be the real mechanism: `pg_default_acl` carries entries granting
`anon` and `authenticated` everything on new objects in `public`, in every environment. The ones
owned by `postgres` are revoked; the ones owned by `supabase_admin` are unreachable, documented, and
harmless because a default privilege attaches only to objects its own role creates. And `UPDATE` was
granted whole-table on every user-owned table except `profiles`, leaving `user_id`, primary keys,
`created_at` and the provenance columns writable by their owner with only RLS standing there — now
granted column by column, with identity and provenance absent.

`scripts/grant-audit.sql` asserts that surface against the catalog as an independent second
statement of intent, and runs unchanged in the Supabase SQL editor against a deployed project — the
check that was missing when CI and the real project disagreed. CI makes the database hostile first,
proves the audit rejects that state, re-applies the baseline and proves it converges.

Also: the deferred `invitation_claims.consumed_user_id` foreign key tested from both sides, claim
expiry recovery, `finalize_invitation_redemption` idempotency, the GoTrue Admin-API assumption
re-verified against current upstream source, and the SHA-256 token decision re-examined and kept.

Deployment: the application is served over HTTPS from Cloudflare Pages on the Free plan, built from
`main`, with a Content-Security-Policy generated from the Supabase URL the bundle was built against
so the two cannot drift.

### Added — 2026-08-20 · M4 invite-only authentication and account security

Account creation is closed. Two independent server-side gates enforce it: a **Before User Created
auth hook** that rejects every self-service signup path GoTrue exposes, and a `BEFORE INSERT`
trigger on `auth.users` requiring a live invitation claim (invariant S2). The hook rejects
unconditionally rather than checking anything, because GoTrue does not invoke it from the Auth Admin
API — verified against the `supabase/auth` source — which means there is no forgeable metadata and
no race window. A hook that merely allowed signup for invited addresses was considered and rejected:
it would have let anyone who knew an invited address set the password first.

Invitations now bind to a single address, store only `sha256(token)`, expire (7 days by default),
are single-use and revocable, and expose no `token_hash` through the Data API even to an admin.
Redemption is a three-step claim/create/finalize flow whose availability is computed from claims
rather than a counter, so an abandoned attempt frees itself in two minutes and no sequence of
failures can burn an invitation permanently; concurrency is handled by a row lock plus a partial
unique index, not by application-level check-then-act. `redeem-invitation` is the only Edge
Function — invitation issue and revocation are admin-gated Postgres RPCs, because generating a token
needs no Deno runtime and no second copy of the secret key.

Application: sign-in, invitation redemption, password recovery, an admin invitation screen, session
handling, and public/protected/admin route classes. Provisional visually, but with the parts that
would be a bug in any visual direction — password-manager `autocomplete` attributes, paste never
blocked, errors announced rather than only coloured, 44px touch targets, and one sign-in error
message so the form does not become an account-enumeration oracle.

Testing: an 18-case invite-only attack suite run against the live API with the publishable key
(uninvited signup, **invited-address signup**, forged `user_metadata`, a hand-built
`/auth/v1/signup` carrying `app_metadata` and `role: service_role`, Auth Admin creation with no
claim, replay, tampering, expiry, revocation, an attacker-supplied address in the redemption body, a
rejected password leaving the invitation usable, and two redemptions racing one token), 22 admin
authorization cases, and 26 browser cases at desktop and iPhone viewports. Both gates were
deliberately disabled on a throwaway branch and CI watched to fail on the named tests before being
reverted. CI now runs the browser suite and asserts the Edge Function is reachable before the auth
tests, so redemption cases cannot pass by being skipped.

Fixed, from an adversarial review of the M3 foundation: account deletion was impossible — eight
`user_id` foreign keys to `auth.users` had no `ON DELETE` action, contradicting SECURITY.md §8
— `token_hash` was admin-readable through the Data API, and functions relied on `PUBLIC`'s
default `EXECUTE`. Password policy is now 12 characters minimum with no composition rules.

Deployed to a free `pokeportfolio-dev` project, and verifying it there found what CI could not:
the project auto-grants the Data API roles broad privileges on new tables and functions, and a
`GRANT` is additive — so M3's column-restricted `profiles` grant restricted nothing, and a
signed-in non-admin could set their own `is_admin` flag while the authorization suite was green.
Every privilege is now restated as revoke-then-grant for tables and functions alike, `anon` holds
no table privileges at all, and `scripts/remote-security-check.mjs` runs the same assertions
against a real deployment with nothing but the publishable key. Final remote run: 33/33, with the
escalation asserted on the stored value rather than the HTTP status.

Cost: $0; no billing enabled anywhere. Detail: `ai_outputs/Claude_outputs/output_7.txt` (not committed).

### Added — 2026-08-17 · M3 database foundation, migrations and RLS

Real persistent-storage foundation. Supabase project structure (`supabase/`), CLI pinned as a
project devDependency, eight timestamped migrations covering the shared catalog
(`card_series`/`card_sets`/`cards`/`card_variants`/`sealed_products`), profiles, invitations
(schema only — enforcement lands with M4's Edge Function), user-scoped reference data
(`retailers`/`storage_locations`/`tags`), purchases/purchase_lines and holdings/acquisition_lots.
Row Level Security enabled on every table with explicit `WITH CHECK` on every write policy;
`user_id` denormalized onto every child table with an ownership-verifying trigger (invariant S1);
`profiles.is_admin` locked down at the SQL column-privilege level, not just RLS. A two-client
authorization suite (`tests/authorization/`) exercises the real PostgREST API as two distinct
authenticated users, covering every user-private table plus the critical cross-tenant
child-parent attack and the "admin has zero access to other users' private data" property. A
database constraint suite (`tests/db/`) proves the FINANCIAL_MODEL invariants the schema is
supposed to enforce (M1/M2 cost-basis-state consistency, the holdings identity index, purchase
total/line-total arithmetic checks) actually reject bad data. The Postgres `bigint` /
PostgREST JSON-number precision boundary for money columns is documented and proven with a real
round-trip test, not assumed. CI gained a `db-tests` job that runs the full migration and
authorization suite against an ephemeral local Supabase stack on every push and PR — no remote
credentials involved. Existing M1/M2 gates (64 domain tests, Playwright smoke tests, typecheck,
lint, format, build) remain green throughout. Cost: $0; no billing enabled anywhere. Detail:
`ai_outputs/Claude_outputs/output_6.txt` (not committed).

### Added — 2026-08-17 · M1 foundation and M2 financial domain core

First application code. Vite + React 19 + TypeScript strict scaffold, ESLint/Prettier, Vitest +
fast-check, Playwright, a minimal PWA shell, and GitHub Actions CI with an open-source secret
scan — all zero-cost. Pure-TypeScript financial domain layer: `Money` (integer minor units, no
float), currency metadata, a largest-remainder allocator, FX conversion, `CostBasisState` and
`MarketValue` as discriminated unions, and the inventory/spending/sales/position metrics from
FINANCIAL_MODEL.md. Worked examples E1, E3 and E7 reproduce exactly against the real domain
functions; 64 tests pass, including property tests for the allocator (invariant F6) and
randomised checks for F1, F3 and F5. No database, no auth, no external service yet — M1/M2 are
deliberately infrastructure-independent. Detail: `ai_outputs/Claude_outputs/output_5.txt` (not committed).

### Changed — 2026-08-17 · Cost policy: $50 USD lifetime discretionary ceiling

Target operating cost stays $0/month; a separate, owner-approved, **lifetime** ceiling of $50 USD
now exists for genuinely excellent one-time options. Not pre-authorized spending — every purchase
still needs individual approval, and nothing may be spent before a free functional baseline
exists. See D-027 and docs/COST_POLICY.md §1.

### Changed — 2026-08-16 · Planning frozen

Scope and product semantics settled; implementation has an authoritative target.

- **Every physical card is individually trackable** — energies, commons, duplicates and unpriced
  cards are first-class inventory. Replaces a proposal to aggregate low-value cards. Organisation
  and filtering, not aggregation, keep large collections navigable.
- **Custom collections, smart value filters and a configurable grid density** added to MVP as the
  organisational answer to a ten-thousand-card collection. Mobile gallery defaults to two columns
  and is user-settable 1–4.
- **Cost basis became a state** — `known` / `unallocated_opening` / `not_paid` / `unknown` /
  `trade_in` — so a gift, a forgotten purchase price and a pack pull are no longer
  indistinguishable `NULL`s.
- **Manually costed openings now create a real provisional purchase**, reconciled and voided when
  the real receipt is entered. Previously such costs were excluded from lifetime spending, which
  made the product's headline metric understate reality.
- **A dedicated History area** for items no longer owned: sold, traded, other disposals. Disposals
  with no cost basis show proceeds and a result of **—**, never a fabricated profit.
- **Trades modelled in the schema**, with the item-leg accounting rule deliberately left open and
  disposal-time cost and market value frozen so either rule remains adoptable.
- **Authentication changed from email OTP to email and password.** The built-in mail provider
  allows two auth emails per hour project-wide, which makes OTP a lockout risk; password login
  sends no email at all.
- **Scanner moved ahead of openings** post-MVP, and **JSON backup moved into MVP**.
- Zero-cost audit re-verified against all-card tracking: price history is keyed per card variant
  rather than per copy, so snapshot volume is decoupled from collection size.

### Added — 2026-08-16 · Project foundation

- Canonical documentation set covering product, financial model, data model, architecture,
  security, testing, development, roadmap, decisions, research, external sources, UX flows,
  design system, scanner research, backlog, publication checklist and engineering journal.
- Financial model with ten worked examples and eleven named invariants, each mapped to a
  planned test.
- Data model covering the full lifecycle from purchase through sealed, opening, grading and
  sale without provenance loss.
- Architecture selected: Vite + React SPA, Supabase (PostgreSQL with RLS), Cloudflare Pages.
- Security model: RLS on every table, invite-only enforced server-side, admin role with no
  access to other users' data.
- Development toolchain: Node 24.19.0 LTS, pnpm, GitHub CLI.
- Repository initialised with secret-prevention configuration.

No application code in this release.
