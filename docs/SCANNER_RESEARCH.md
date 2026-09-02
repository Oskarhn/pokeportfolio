# Scanner — Research Note

Preparatory only. The scanner is **M15, the first post-MVP milestone**; nothing here is
implemented.

It moved ahead of openings because every physical card is now individually tracked (D-017), which
makes manual entry the dominant cost of using the application — a booster box is 360 searches.
The scanner is what removes that cost.

**Re-research before building.** The findings below are dated August 2026. Vision model
availability moves quickly, and inheriting a specific model choice from a note written a year
earlier would be exactly the wrong way to start.

---

## 1. Goal

Bulk card entry that is meaningfully faster than searching for each card by name. That is the
bar. A scanner that identifies cards accurately but requires a form per card fails it.

Target flow:

1. Open the scanner. Camera starts once.
2. Point at a card. Recognition proposes an identity.
3. Confirm with one tap, or pick from a short candidate list.
4. Next card. No navigation, no form, no waiting.
5. End the session; review and adjust the batch once.

### 1.1 Session defaults

The scanner reuses the same session-default mechanism as manual entry (UX_FLOWS F2.1), so the
two flows behave identically and the concept is already proven before the scanner exists:

| Default | Example |
|---|---|
| Acquisition origin | `Pulled` |
| Opening | Surging Sparks Booster Box |
| Purchase | a specific receipt, when origin is `purchased` |
| Condition | NM |
| Language | English |
| Storage location | Binder 3 |
| Custom collection | 151 Master Set |
| Cost handling | per-card cost, session cost, or none for non-purchase origins |

Set once, shown as a persistent header, changeable mid-session. Per-card override happens in the
batch review at the end, not inline — interrupting a scan to correct one field defeats the point.

Nothing is written until the review step is confirmed.

---

## 2. The hard constraint: iOS camera lifecycle

WebKit does not persist camera permission across URL changes in a standalone PWA. Bug 215884
remains open. A session that navigates per card would prompt on every card, which destroys the
workflow.

**This is settled architecture, not an open question** (see [DECISIONS.md](DECISIONS.md) D-006):

- One route owns the session.
- One `MediaStream`, acquired on entry, released on exit.
- Confirmation is an overlay inside that route. No navigation, no hash change, no URL mutation
  while the camera is live.
- Session state is component state. This route is the documented exception to the app-wide
  convention that filter state lives in the URL.

Deciding this now costs nothing. Discovering it after building the scanner would mean rewriting
its routing.

---

## 3. Approach: on-device recognition

Preferred, subject to re-validation:

- **No recurring API cost.** A hosted recognition service would be the main ongoing expense in a
  project targeting zero recurring cost.
- **No images leave the device.** A camera pointed at a private collection is a privacy surface
  worth keeping local.
- **Works on a poor connection**, once the model and index are cached.

Cost: a one-time model and index download in the tens of megabytes, and an offline pipeline to
build the index.

### 3.1 Reference implementation (August 2026)

One credible published implementation runs entirely client-side:

| Stage | Approach | Reported cost |
|---|---|---|
| Detection | YOLO11n, ~5 MB | ~10 ms desktop |
| Recognition | MobileCLIP-S2, FP16 | 50–80 ms desktop; a few hundred ms mobile |
| Runtime | WebGPU, with WebGL/WASM fallback | |
| Index | Embeddings over ~20 000 TCGdex card images | |

Source: https://ankush.one/blogs/pokemon-scanner/ — no accuracy figures published, and the
author noted that OpenCV rectangle detection failed on video streams, which is why a learned
detector was used.

**Treat this as an existence proof, not a design.** It demonstrates that the latency budget
works on a phone. The specific models are the part most likely to be obsolete by M15.

### 3.2 Alternatives to re-evaluate

| Approach | Note |
|---|---|
| Perceptual hashing (pHash/dHash/wHash) | Simpler, no ML runtime. Fragile against glare, sleeves, angle and lighting — the exact conditions of real scanning. Possible as a fast pre-filter. |
| OCR of card name and collector number | Robust where text is legible; collector number plus set symbol is a strong disambiguator. Poor on full-art cards where text is stylised or overlaid. |
| Hybrid: embedding match, OCR to disambiguate | Likely strongest. Embeddings narrow to a handful; OCR of the collector number picks among them. |
| Hosted recognition API | Fastest to build, recurring cost, images leave the device. Rejected unless on-device proves unworkable. |

---

## 4. Index construction

The catalog is ~23 400 English cards (verified via TCGdex, 2026-08-16). Building the index is an
offline job, run when the catalog changes, not on a user's device:

1. Fetch card images from `assets.tcgdex.net`.
2. Generate embeddings with the chosen model.
3. Quantise and pack into a compact artefact.
4. Ship as a static asset with a version hash; cache in the service worker.

Open questions for M15: artefact size at acceptable accuracy; whether to ship a per-set
index so a user scanning one set downloads a fraction of the whole; whether Japanese cards get
their own index or share one.

**Do not commit card images to the repository.** The pipeline downloads them at build time; the
artefact is the only thing distributed, and whether the artefact itself can be distributed
depends on the image-rights question in [API_SOURCES.md](API_SOURCES.md) — which must be
answered before the artefact is published anywhere public.

---

## 5. Accuracy and correction

Recognition will be imperfect. The interface, not the model, is what makes that acceptable.

- Above the confidence threshold: propose one identity, one tap to accept.
- Below it: show up to three candidates with their set symbols and collector numbers.
- Always available: manual search fallback without leaving the session.
- Bias toward recently scanned sets — a user opening a box is scanning one set repeatedly.
- Corrections happen in the batch review at the end, not as a modal that interrupts scanning.
- Never silently accept a low-confidence match. A wrong card in the collection is worse than a
  card that took an extra tap.

Variant ambiguity is a separate problem from card identity: normal, reverse holo and holo
printings of the same card are often visually distinguishable only by the finish, which is hard
to see through a camera at an angle. Expect to resolve variant by session default plus review
rather than by recognition.

---

## 6. Known unknowns

| # | Question | Resolve by |
|---|---|---|
| S1 | Accuracy through sleeves, under glare, at angle | Testing on a real, sleeved collection |
| S2 | Real WebGPU availability across target iPhones | Device testing |
| S3 | Acceptable index size versus accuracy | Spike during M15 |
| S4 | Whether holo and reverse can be distinguished at all from a camera frame | Spike |
| S5 | Japanese card coverage and image quality in TCGdex | Probe at build time |
| S6 | Whether camera permission truly survives an in-route session on current iOS | Real device, early — this gates the whole approach |
| S7 | Whether Basic Energy printings are distinguishable at all by image | Spike. Energies are visually near-identical across sets; the collector number and set symbol may be the only signal, and both are small. |

S6 is the one that could invalidate the plan. Test it with a throwaway page **before** M15
begins, not after the scanner is built.

S7 matters more than it looks: all-card tracking means energies are exactly the cards a user most
wants to bulk-scan, and they may be the hardest to identify. If image recognition cannot separate
them, the fallback is a fast manual "add N of this printing" path rather than a scanner that
guesses.

---

## 7. Integration addendum (M15, 2026-08-26 — P68)

What integration changed against the research above:

- **Engine versions as shipped (D-094):** tesseract.js 7.0.0 + tesseract.js-core **7.0.0** +
  @tesseract.js-data/eng 1.0.0. The researched core pin (6.1.2) was wrong in one respect: npm
  reality shows tesseract.js v7 declares 	esseract.js-core: ^7.0.0 and its worker selects a
  relaxed-SIMD LSTM core that only exists in core 7. Pinned exact; assets copied from the npm
  tarballs at build time by scripts/prepare-scanner-assets.mjs into public/scanner-assets/v7/
  (worker.min.js, three LSTM cores with their .wasm files, eng.traineddata.gz best_int).
- **Real smoke, this machine:** the pinned engine read the synthetic fixture
  ("TESTASAURUS" / "049/102") at confidence 93, full-image recognize ≈106 ms warm after a
  ~393 ms worker start, traineddata loaded from the staged copy. Not an iPhone claim.
- **Unknowns status:** S2 resolved by shipping choice (WASM SIMD family; plain-LSTM fallback
  included). S6 remains the standing owner-device gate (one prompt per cold start on installed
  PWA is now documented WebKit behaviour, not a blocker). S7 dissolved for OCR purposes: energies
  carry ordinary name+number strips, so they are first-class text-recognition targets; artwork
  similarity stays M15c-conditional and the visualSimilarity seam remains unused.
- **Build interaction:** staging >2 MB assets under public/ breaks Workbox's precache ceiling;
  P68 carries the minimal globIgnores exclusion so pnpm build works, while the scanner-asset
  caching POLICY (runtime CacheFirst) belongs to the pending P69 security PR.

---

## 7b. Visual recognition addendum (M15b, 2026-08-26 — P76, D-097)

The real-device gate this note's §6 flagged as the open question (S1: "accuracy through sleeves,
under glare, at angle") came due: the OCR-only path P68/P74/P75 shipped returned "Couldn't
identify this card" on real physical cards. This section records what P76 found and built to fix
it — read D-097 in DECISIONS.md for the decision itself; this is the underlying research.

### Model candidates evaluated

| Model | License | Verdict |
|---|---|---|
| MobileCLIP-S0/S2 (§3.1's existence proof) | Apple ML Research Model License — "Research Purposes" explicitly excludes "commercial exploitation, product development or use in any commercial product or service" (read directly from `apple/ml-mobileclip`'s `LICENSE_MODELS`) | **Disqualified.** Cannot ship converted weights. |
| OpenAI CLIP variants (via Transformers.js) | MIT | Not pursued once DINOv2 answered the need — pairs a text encoder this app has no use for, and CLIP's embedding space is tuned for semantic/category similarity, not exact-instance retrieval. |
| **DINOv2-small** (`Xenova/dinov2-small`, converted from `facebook/dinov2-small`) | **Apache-2.0**, unambiguous | **Selected.** Vision-only, 384-dim, self-supervised training objective suited to instance-level retrieval. |

### Fresh research sources (2026-08-26, this session)

- `apple/ml-mobileclip` GitHub repo: `LICENSE` (MIT, code only) points explicitly to
  `LICENSE_MODELS` and `LICENSE_DATA` for "The ML-MobileCLIP model weights and data copyright and
  license terms" — read `LICENSE_MODELS` directly (not inferred from a Hugging Face tag).
- `facebook/dinov2-small` Hugging Face model card: `"license":"apache-2.0"`, `hidden_size: 384`.
- `Xenova/dinov2-small` Hugging Face repo (revision `c2bb04a51fab207c420665f1946016107bffc701`):
  ONNX file sizes measured directly via `resolve` URL `content-length` headers — fp32 88.5 MB,
  fp16 44.4 MB, dynamic-INT8 (`model_quantized.onnx`) 24.5 MB, uint8 22.4 MB, q4 15.0 MB, bnb4
  13.7 MB, q4f16 12.9 MB. `q8`/dynamic-INT8 chosen (matches Transformers.js's own WASM default
  dtype).
- `@huggingface/transformers` npm registry: stable `latest` dist-tag is **4.2.0** (not the older
  3.x line an initial pass assumed) — verified via `npm view`, not memory.
- `node_modules/@huggingface/transformers/dist/transformers.js` (the ACTUAL bundled runtime code,
  read directly): confirms `env.backends.onnx.wasm.wasmPaths` defaults to
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/...` unless already set, and that
  the package does NOT re-export its internal `apis` (Safari/WebGPU detection) object at the
  package root in this version — both facts drove real implementation decisions (explicit
  same-origin `wasmPaths` override; a locally-reproduced Safari/WebGPU detector), not memory of
  the library's older public API surface.
- ORT-Web/iOS WASM: current, real caveats exist (`microsoft/onnxruntime#26827`: Safari/WebKit 26
  WebGPU JSEP-mode CPU/memory blowup; historical iOS WASM-SIMD issues in `#15644`/`#22086`) —
  reason WASM stays the REQUIRED baseline and WebGPU is opportunistic-only, verified by actually
  requesting a `GPUAdapter`, never assumed from `navigator.gpu`'s mere presence.

### Benchmark methodology (`scripts/scanner-visual-benchmark/`)

Real, reproducible, run this session (not fabricated):

- **Reference corpus:** 240 real card images from 6 live TCGdex sets (base1 Base Set, base2
  Jungle, neo1 Neo Genesis, swsh1 Sword & Shield, swsh7 Evolving Skies, sv01 Scarlet & Violet) —
  vintage and modern layouts, holo and non-holo, spanning three visually distinct card border
  eras. A 7th set, `cel25cc` (Celebrations Classic Collection — deliberate vintage-artwork
  reprints, e.g. `cel25cc-CC002` Charizard reprinting `base1-4`'s art), was added specifically to
  stress "same/near-identical art, different printing" but TCGdex does not serve CDN images for
  this set (`card.image` absent from both the set-list and single-card API responses) — a real,
  disclosed gap, not silently dropped.
- **Synthetic camera-capture augmentations** (`lib/augment.mjs`, `sharp`, seeded per-card so
  re-runs are reproducible): clean-resize, perspective-rotate (±6°), brightness-contrast,
  blur-jpeg (variable blur + JPEG quality 55), glare-overlay (radial-gradient screen blend),
  shadow-color-shift (linear-gradient multiply blend + hue shift). 6 profiles × 240 references =
  **1,440 augmented queries**.
- **OCR-first baseline:** the REAL pinned `tesseract.js` 7.0.0 (same assets the browser build
  stages), run headless in Node against each augmented image's full frame, parsed through the
  SAME `splitFullFrameCardText`/`cleanSignal` production code the browser fallback path uses, and
  scored by the REAL `src/domain/scanner/engine.ts` matcher — not a reimplementation.
- **Perceptual baseline:** `computeDHash`/`hammingDistance` (`src/domain/scanner/perceptual-hash.ts`),
  a 9×8 grayscale-grid difference hash, ranked by Hamming distance alone.
- **Visual baseline:** DINOv2 cosine similarity (dot product of L2-normalized vectors) against the
  240-card reference set, ranked directly.
- **Hybrid:** visual top-30 shortlist → OCR text scored by the SAME domain matcher, now with the
  visual-evidence channel wired in (`visualScores` parameter, D-097).

### Results (n = 1,440 augmented queries; see `scripts/scanner-visual-benchmark/reports/benchmark-report.json`)

| Method | TOP1 | TOP3 | TOP5 |
|---|---|---|---|
| OCR-first | 30.5% | 39.7% | 42.1% |
| Perceptual (dHash) | 86.7% | 93.0% | 95.0% |
| Visual (DINOv2) | 99.7% | 100% | 100% |
| Hybrid | 95.8% | 99.9% | 100% |

Per-set OCR TOP1 ranged from 11.3% (swsh1) to 65.0% (base1) — modern layouts with smaller/stylised
text read far worse than vintage ones, another point of agreement with the real device failure
(modern cards are exactly what a 2026 collector scans most). Visual TOP1 stayed 99.6–100% across
every set including modern ones, which is the core evidence for why a visual channel — not a
better OCR tuning — was the right fix.

**Performance (DESKTOP, Node `onnxruntime-node` CPU execution provider — NOT a browser/WASM/iPhone
measurement):** model cold load 225–3,371 ms across repeated runs (first-run HF cache miss vs.
warm cache); average per-card embedding 40–46 ms; average pure index-search time over 240 rows
1.1–1.2 ms; INT8-vs-FP32 top-1 agreement 100% across all 1,440 queries (quantization costs nothing
measurable at this scale). Real iPhone WASM numbers remain the owner's device-test job.

### Quantitative index-architecture decision

384-dim × INT8 = 384 bytes/card. Full canonical catalog (~23,400 English cards) ≈ **8.6 MB**;
this session's 240-card demonstration index is **89.6 KB**. Both comfortably clear the ≤20–25 MB
local-index budget (§17 of the prompt) — LOCAL INDEX wins outright, no pgvector migration
required. See D-097 for the full architecture writeup and the coverage caveat (this session's
committed index is LOCAL-database-derived and does not resolve against the hosted catalog until
the owner runs the generator once against hosted credentials).

## 7c. Exact-card matching, adaptive OCR ROI and photometric normalization (M15, 2026-08-28 — P80)

Runtime/crop/rectification were ruled IN as working by P78/P79 (real-iPhone diagnostics: model
ready, real embedding, full 19,501-card index searched, real candidates returned). Two concrete
real-device misses remained: Mega Chandelure ex (correct card absent from the top-20 visual
candidates entirely) and Shieldon (correct card present at raw visual rank 6, never shown because
the UI capped at 5). The owner's debug image preview additionally showed the fixed OCR ROIs
landing on the wrong region of a modern card.

### Why the fixed ROI fractions were wrong (not a defect in the P67 research — a different layout)

`NAME_ROI_FRACTIONS`/`NUMBER_ROI_FRACTIONS` (`roi.ts`) encode ONE real, still-valid Pokémon card
layout: vintage WOTC/e-series English cards print the name in a narrow top-left band and the
collector number bottom-RIGHT (e.g. Base Set's "4/102"). Modern SM/SWSH/SV-era English cards —
exactly what a 2026 collector scans most, and exactly what Mega Chandelure ex is — print the name
across most of the top edge and moved the collector number bottom-LEFT beside the set symbol (e.g.
"049/197"). The old single-ROI pipeline had no way to notice it was reading the wrong region; on a
modern card the name ROI's top-left-only band lands partly on artwork/holo header, and the number
ROI's bottom-right band lands on the illustrator credit / copyright line instead of the id — which
matches the owner's screenshot description exactly.

**Fix:** `analyze.ts` now tries a small, bounded set of named layout candidates per field
(`NAME_ROI_CANDIDATES`/`NUMBER_ROI_CANDIDATES`), scoring each OCR result (name: confidence +
letter-ratio; collector number: confidence + whether the text actually PARSES as a short printed
id — the strongest possible signal) and keeping the winner. An early-exit predicate
(`isNameRoiConfident`/`isNumberRoiConfident`) stops trying further candidates once one is already
confident, so the common, already-correctly-laid-out scan costs the SAME one-recognition-call
total the original pipeline had; a weak or wrong-layout first read falls through to the next
candidate instead of silently failing. Real bug found while building the parseability scorer:
P67's `parseCollectorNumber` is deliberately permissive (folds short OCR noise), and a long garbage
string containing a stray digit run can still structurally match its `prefix+digits+suffix`
pattern (e.g. "TESTASAURUS 58/102 junk" parses as prefix="TESTASAURUS", numeric="58") — a length
guard (`looksLikeCollectorNumberText`, ≤12 chars) keeps this from ever winning the number field.

### Candidate rescue: retrieval depth vs. display depth are now decoupled

`SCORING_TIERS.maxReturnedCandidates` (engine.ts) was 5 — the SAME number the UI displayed, so a
correct card at raw rank 6 (Shieldon) was invisible by construction: the engine itself discarded it
before the UI ever got a chance to show it. Raised to 10 (retention depth only — `top`/`runnerUp`
for tier/margin math are always the true best two regardless of this bound). The UI's own display
limit (`SCANNER_UI_CANDIDATE_LIMIT`, controller.ts) stays 5 in the normal case; a new
`resolveVisibleCandidateCount` widens it to `SCANNER_UI_EXPANDED_CANDIDATE_LIMIT` (8) only when the
score at the normal cutoff rank is still within the engine's OWN ambiguity margin
(`SCORING_TIERS.highMinMargin`) of the top score — i.e. only when the ranking near the cutoff is
genuinely flat/undifferentiated, never merely because confidence is LOW. A HIGH-tier match never
expands: by construction it already has a ≥15-point margin over its runner-up, so the ranking is
never flat at rank 5.

### Photometric normalization — implemented, tested, evidence gathered, NOT wired into the default pipeline

`src/domain/scanner/photometric.ts` (`normalizePhotometricRgba`): a luma-driven contrast stretch
(same percentile method as `roi.ts`'s OCR normalization, applied identically to R/G/B so hue is
preserved) plus a small, bounded (15%) blend of each pixel toward its own greyscale value —
investigated because the Chandelure miss's symptom (top neighbours were unrelated foil/full-art
cards) is consistent with DINOv2 weighting a card's overall color/foil texture more than its
structural identity for highly reflective modern printings.

**A real, bounded experiment was run** (`pnpm scanner:visual:benchmark:photometric`, new script,
reuses the SAME cached 240-card corpus, the SAME real `rectify.ts`/`embed.mjs` pipeline the P79
hard benchmark uses), comparing rectified-plain vs. rectified-then-photometric-normalized on the
`tilted-offcenter` profile (geometry-only distortion, already near-ceiling — the correct bar here
is "does not regress," not "improves"):

| Method | TOP1 | TOP3 | TOP5 | n |
|---|---|---|---|---|
| Rectified (plain) | 93.3% | 98.3% | 98.8% | 240 |
| Rectified + photometric-normalized | 94.6% | 97.5% | 98.3% | 240 |

Result: a wash — +1.3pp TOP1, −0.8pp TOP3, −0.5pp TOP5, all well inside single-flip noise at
n=240 (each point ≈0.4%). Non-regression is confirmed; no meaningful uplift signal exists on this
corpus.

**This experiment cannot test the actual hypothesis it was built to investigate**, and that
limitation matters more than the numbers above: the P79/P80 benchmark corpus is keyed by
TCGdex-style ids ("base1-1"), not the real catalog's Supabase UUIDs the hosted 19,501-card index
uses, so there is no ground truth to measure whether photometric normalization reduces confusion
among many visually-similar foil/full-art cards AT REAL INDEX SCALE — the actual failure mode the
Chandelure miss represents. A 240-card corpus spanning six eras essentially cannot reproduce
"which of several hundred rainbow-foil EX cards is this," because it does not contain several
hundred rainbow-foil EX cards. **Decision: the tested, non-regressive utility function ships on
this branch as available tooling; it is NOT wired into `visual-worker.ts`'s default embedding path
without evidence that actually targets the failure mode.** A future session with Supabase catalog
read access could build a real id-mapped diagnostic (map a handful of cached corpus TCGdex ids to
their real catalog UUIDs, then search a real captured/augmented query against the REAL committed
19,501-embedding index and inspect true rank) — this is the concrete follow-up, not a repeat of
this session's geometry-only non-regression check.

### Auxiliary visual signal (second/inner-art embedding) — REJECTED, same conclusion as P79 for a corrected reason

P79 already declined to build a second embedding signal, reasoning from the geometry-only hard
benchmark (93–99% across methods) that single-embedding brittleness was not evidenced. That
reasoning was RIGHT about geometry robustness but measures the wrong axis for the Chandelure
question: TOP1/TOP3/TOP5 against a 240-card pool tests whether a distorted query still resembles
ITS OWN clean reference more than 239 others (robustness to capture noise), not whether it gets
confused with a DIFFERENT, visually-similar card among thousands (discriminative power at scale) —
the failure class an inner-art auxiliary signal exists to address. This session could not build a
scale-appropriate corpus to test that axis either (same id-mapping gap as the photometric
experiment above), so the auxiliary-signal question remains genuinely untested, not disproven.

Given that, the decision to NOT build it this session rests on cost/risk, not on evidence it
wouldn't help: a second visual signal requires re-embedding all 19,501 catalog cards against a
DIFFERENT crop (a multi-hour, irreversible regeneration of committed index assets), doubling the
worker's per-scan inference cost, and a new merge/rerank contract in `engine.ts` — all before any
evidence exists that it fixes the actual problem. Building it now, ungated by evidence, is exactly
the "blindly ship a complicated ensemble" the prompt warns against. The concrete prerequisite for
revisiting this is the same real-index diagnostic described above — if it shows discriminative
power degrading meaningfully as pool size grows toward 19,501 for foil/full-art cards specifically,
an auxiliary signal becomes an evidence-justified next step, not before.

## 7d. iPhone cold-start / visual runtime performance (M15, 2026-08-30 — P81, D-098)

Recognition quality (§7c above) was superseded as the primary blocker by real-device evidence that
cold visual-channel initialization took 106–388 seconds across repeated real-iPhone attempts, and
one scan produced no usable result after 6–7 minutes. This section documents what was actually
measured and where the time provably does NOT go, complementing §7c rather than replacing it —
neither Chandelure nor Shieldon were retested this session per the prompt's own scope discipline.

**Real-browser measurement, not assumption.** `pnpm scanner:visual:benchmark:cold-start` (new
script) drives Chromium and WebKit (Playwright) against the actual production `visual-worker-*.js`
chunk served by a local `vite preview` instance — no mocks, no Node-side ONNX runtime substitute.
Measured on this machine (localhost network, effectively zero latency):

| Engine | Cold total | Cold modelColdLoadMs | Cold compile+session-create | Warm total |
|---|---|---|---|---|
| Chromium | 2137ms | 1477ms | 715ms | 1374ms |
| WebKit | 2056ms | 1971ms | 1052ms | 899ms |

These are DESKTOP numbers over a local network — not a claim about real iPhone-cellular
performance, and explicitly not presented as one. What they DO establish: the part of the pipeline
architecture/model choice controls (ONNX compile, WASM instantiate, InferenceSession.create) costs
hundreds of milliseconds to ~1.6s even from a cold cache, nowhere near enough to explain a
106–388-second real-device figure on its own. The dominant real-device cost is therefore most
plausibly network transfer of the ~45MB payload (24.5MB ONNX model, up to 23.5MB ORT WASM, 7.5MB
embeddings index) over the actual device's real connection, compounded by the two configuration
gaps below — not "the runtime is inherently slow" and not "the model is too big."

**Confirmed configuration gaps, not measured this benchmark can't reach:**

- `curl`-verified live headers showed every scanner asset served `Cache-Control: public,
  max-age=0, must-revalidate` — Cloudflare Pages' own default for a non-content-hashed filename —
  despite living under version-pinned paths (`v7`, `visual-v1`) the visual worker separately
  verifies by exact model revision (`EXPECTED_MODEL_REVISION`) before trusting anything loaded.
  Fixed: explicit `Cache-Control: public, max-age=31536000, immutable` for `/scanner-assets/*`.
- The visual channel was never warmed before a capture existed — `ensureReady()` was only ever
  reached from inside `analyzeCapture`. Fixed with route-entry prewarm (D-098).

**Instrumentation methodology note (a real finding from building it):** an initial `self.fetch`
monkey-patch inside the worker correctly timed the worker's OWN direct fetches (index manifest/ids/
embeddings) but reported 0ms/null-bytes for every fetch transformers.js/onnxruntime-web issue
internally (processor/model config, ONNX weights, ORT WASM/glue) — evidence those libraries hold
their own `fetch` reference, captured at their module's own top-level evaluation, before the
worker's `init()` (and therefore the patch) ever runs. Fixed by reading the Resource Timing API
(`performance.getEntriesByType('resource')`) instead, populated by the browser's network stack
regardless of which JS reference initiated a request — this is now the primary timing source
(`src/features/scanner/visual/phase-timing.ts`), with the fetch-probe log retained only as a
fallback for an environment without Resource Timing support.

**WASM threading:** current official onnxruntime-web behaviour (re-verified this session) enables
real multi-threading only when `self.crossOriginIsolated` is true (requires COOP AND COEP; this app
sends COOP only). Without it, the existing "threaded" WASM binary still loads and runs correctly,
single-threaded, via the library's own internal auto-detection — `numThreads` is now set explicitly
to 1 in that condition rather than left implicit, for the same reason `wasmPaths` is set explicitly
elsewhere in this file: an explicit, disclosed, version-independent choice instead of a dependency
on internal library behaviour holding across upgrades. Enabling COEP (and therefore real threading)
was investigated but not implemented — it requires every cross-origin resource on the page (notably
the TCGdex card-image CDN, loaded via plain `<img>` tags throughout the app) to either carry CORP
headers or be loaded with `crossorigin`, a cross-cutting change with real risk to unrelated features
that was not justified by this session's evidence (compile time is not the bottleneck — see above).

**Model replacement — researched, rejected, evidence-gated (D-098).** DINOv3-ViT-S/16 was
considered and is actually LARGER than the current DINOv2-small (~41MB fp16 vs. 24.5MB quantized
INT8 ONNX). MobileNet/EfficientNet-class extractors are smaller but risk regressing §7c's
still-open discriminative-power gap, with no benchmarked evidence either way. Given this session's
own measurement that compile/session-create is not the dominant real-device cost, a smaller model
would not address the problem that was actually diagnosed, and would force an irreversible
multi-hour re-embedding of the 19,501-card index to find out. Not undertaken.

## 7e. Live worker-progress instrumentation, lightweight perceptual-hash retrieval, FAST-baseline reprioritization (M15, 2026-08-30 — P82, D-099)

P81's fixes did not close the gap: the owner's real-iPhone retest showed `VISUAL_MODEL_STATE=
loading` persisting over a minute with every `VISUAL_PHASE_TIMINGS` field reading "—" (P81 only
reports per-phase timings inside the TERMINAL ready/unavailable message — a stall in progress was
unobservable), and a Shieldon scan that OCR also failed to identify despite the debug screenshot
showing the printed name clearly legible.

**Live progress instrumentation** (full account in D-099): the worker now posts a `progress`
message at every phase boundary, starting with `worker-module-evaluated` the INSTANT module
evaluation reaches application code — before transformers.js/onnxruntime-web are touched at all.
`VisualRecognitionClient` keeps a live snapshot (current phase, elapsed time in that phase, worker
boot status/timing) readable at any point, not only at a terminal message. Implemented by wrapping
the non-pure dependencies `visual-worker.ts`'s `init()` passes to
`domain/scanner/visual-backend-selection.ts` — that module's own pure signature and its 14 tests
are untouched.

**Lightweight perceptual-hash retrieval — measured on REALISTIC capture noise, REJECTED.** §7b's
dHash figure (86.7% TOP1) came from EASY resize/rotate-in-place distortions of an already-tight
reference image — never a captured frame needing real cropping/rectification. Re-run this session
(`pnpm scanner:visual:benchmark:hash`, new) against the SAME hard, realistic corpus §7c/P79's
rectification benchmark uses (tilt + off-center placement, the REAL `rectify.ts` pipeline), also
adding a newly-implemented DCT-based pHash (`computePHash`):

| Method | TOP1 | TOP3 | TOP5 | (tilted-offcenter, n=240) |
|---|---|---|---|---|
| dHash | 5.0% | 10.0% | 12.1% | |
| pHash | 23.3% | 30.8% | 36.3% | |
| combined (average) | 18.8% | 27.9% | 32.9% | |

Both collapse to 0-2% on the combined glare/shadow/blur profiles, same as DINO's own worst case.
Decisively: the combined-hash SAME-card vs. DIFFERENT-card similarity distributions overlap almost
completely across all 720 hard queries (same-card median 0.500, p10-p90 0.422-0.625; different-card
median 0.492, p10-p90 0.422-0.563) — no threshold separates a correct match from a wrong one
reliably at this noise level, versus DINO's 93.3% TOP1 on the identical profile (P79). **Decision:
perceptual-hash similarity is NOT wired into `engine.ts`'s scoring** — it would inject
near-random noise into ranking under exactly the conditions a real scan produces. The hash functions
(`computePHash`/`packHashRow`/`unpackHashRow`/`combinedHashSimilarity`) ship as tested, available
domain tooling (photometric.ts's own precedent); no hash index, generator, or browser client was
built — ungated by evidence, that would be exactly the "blindly ship a complicated pipeline" this
project's discipline exists to prevent.

**FAST baseline reprioritized: OCR + text search ahead of DINO.** With hashing rejected, the only
real fast (no ~45MB DINO cold start) signal is OCR + P67's text matcher — already shipped since
P68. Route-entry prewarm now starts OCR immediately and stages DINO
`ENHANCED_VISUAL_PREWARM_STAGGER_MS` (1500ms) behind it — the reverse of P81's own ordering. The
intro screen's loading copy now gates on `ScannerOcrEngine.getState()`
(`getFastScannerState()`, new) instead of the DINO channel's own readiness, so it clears once OCR is
ready rather than waiting for a still-cold DINO load. Debug diagnostics distinguish
`FAST_SCANNER_STATE`/`OCR_RUNTIME_STATE` from `ENHANCED_VISUAL_STATE` explicitly. Not benchmarked
against a real device this session (no iPhone available) — disclosed as reasoned, not measured,
same posture P81's own staggering used.

**OCR preprocessing: Otsu binarization added as a bounded fallback.** `roi.ts` gains
`otsuThreshold`/`binarizeGrayscale` (self-calibrating per-image threshold, oriented dark-text-on-
light). `analyze.ts` tries the existing `contrast` pass first (unchanged call cost from P78-P81); a
`binarize` retry over the same ROI candidates runs ONLY when `contrast` found nothing usable at all
for that field, so an already-working scan never pays for it. Not benchmarked against a real device
or a representative real-photo OCR corpus this session — a bounded, motivated but unverified
addition, disclosed as such.

## 7f. Embedding-contract parity gate, similarity calibration and real-index-scale diagnostic tooling (M15, 2026-09-02 — P84)

The owner's latest real-device scan reported TOP1 similarity of only 0.1816 — far below the
0.65-0.75 band earlier scans showed — with OCR name empty and final reranked candidates empty.
Rather than tune recognition blind, this session built the REQUIRED parity gate (prompt §2): prove
or disprove that the offline INDEX-GENERATOR embedding path (`embed.mjs`, used to build the
committed 19,501-card index) and the BROWSER RUNTIME embedding path (`visual-worker.ts`) actually
compute the same thing.

### The generator/browser embedding contract IS compatible — proven, not assumed

The two paths differ in exactly one structural way (confirmed by reading both files directly): the
generator decodes an image FILE (`RawImage.fromBlob`, Node/sharp-backed) while the browser
constructs a `RawImage` directly from raw RGBA pixel bytes it already drew to an `OffscreenCanvas`
(`bitmapToRgba`), skipping `fromBlob`'s own decode. Reassuring prior fact confirmed by reading the
INSTALLED `@huggingface/transformers` source directly: in a real browser, `RawImage.fromBlob` ALSO
does exactly `canvas.getContext('2d').drawImage(...); ctx.getImageData(...)` — i.e. the two
production code paths are structurally the same operation, just triggered from different entry
points.

New script `pnpm tsx scripts/scanner-visual-benchmark/run-parity-gate.ts` embeds all 240 real cached
corpus images (P76-era TCGdex downloads — the closest real-image stand-in available without hosted
DB credentials; same disclosed id-mapping gap every session since P77 has recorded for the REAL
19,501-card index specifically) through BOTH paths and compares:

- **`GENERATOR_BROWSER_EMBEDDING_COSINE = 1.000000` for all 240/240 images** (mean/median/min/max
  all exactly 1.0) — the RawImage-construction path and the file-decode path are embedding-
  IDENTICAL for the same visual content. The contract is compatible.
- **DINO output semantics confirmed empirically, not just read from a comment**:
  `last_hidden_state.dims = [1, 257, 384]` — 1 CLS token + 256 patch tokens (16x16 patches, 224px
  input, 14px patch size), confirming `data.slice(0, 384)` genuinely extracts the CLS token at
  sequence position 0, exactly as both code paths assume.
- **Pristine self-retrieval: 100%.** Both the generator path alone (a reference embeds and
  retrieves itself against a 240-card generator-built index) and the browser-simulated path
  searched against that same index reach 100% TOP1/TOP3/TOP5 — the REQUIRED gate (prompt §2)
  passes cleanly.
- **INT8 vs. FP32: 100% TOP1 rank agreement**, mean cosine delta from quantization ≈ 0.00099 (240
  corpus embeddings, re-proven against the CURRENT generator/runtime contract, not just P76's
  original claim).
- **Real committed 19,501-card index self-consistency: 100%** across a 501-row stratified sample
  (every ~39th row) — each row's OWN stored vector retrieves itself as rank 1 when searched against
  the full real index. This exercises `decodeVisualIndex`/`searchVisualIndex` against the ACTUAL
  committed `embeddings.bin`/`card-ids.json`/`manifest.json` directly — the index itself is not
  corrupted, duplicated, or misaligned.

**Conclusion: this is NOT a foundational embedding-contract bug.** The 0.18 anomaly has a different
explanation — see below.

### Similarity calibration: the 0.18 anomaly is the already-known combined-photometric-defect domain gap, now quantified for the first time

No prior M15 session recorded the ACTUAL cosine-similarity VALUE distributions same-card vs.
different-card produce — only TOP1/TOP3/TOP5 rank percentages. New script
`pnpm tsx scripts/scanner-visual-benchmark/run-similarity-calibration.ts` reuses the real
production pipeline (P79's `rectify.ts`, the real `embedImageBuffer`/`quantizeEmbedding` INT8
round trip) over the SAME 3 hard-augment profiles P79-P82 already used, recording similarity to the
TRUE reference (same-card) and to the best-scoring WRONG reference (nearest different-card) for
every query, against the full 240-card pool:

| Profile | same-card similarity (mean / median / p90) | nearest-wrong similarity (mean / median) | TOP1 |
|---|---|---|---|
| tilted-offcenter (geometry only) | 0.8122 / 0.8284 / 0.8996 | 0.6743 / 0.6841 | 92.9% |
| tilted-glare-shadow-blur | 0.1010 / 0.0990 / 0.1861 | 0.2817 / 0.2810 | 0.8% |
| skewed-partial-shadow-noisy | 0.1074 / 0.1032 / 0.1972 | 0.3260 / 0.3241 | 0.4% |

This is decisive. Under the two profiles combining glare+shadow+blur or partial-shadow+noise+skew
— exactly the class of real-device failure P79/P80 already found and left unsolved — the SAME-CARD
similarity (mean ≈0.10, p90 ≈0.19) is a close, direct match for the owner's reported 0.1816, and
critically the WRONG-card similarity is systematically HIGHER (mean 0.28-0.33) than the true card's
own similarity. This is not "weak signal," it is signal INVERSION: under severe combined capture
defects, DINOv2 ranks unrelated cards ABOVE the true card more often than not. The clean-geometry
profile (mean 0.81 same-card / 0.67 nearest-wrong) is consistent with the historically-reported
0.65-0.75 "moderate" band from earlier scans. **The owner's 0.1816 scan is very likely a genuine
instance of the already-disclosed, still-unsolved combined-photometric-defect domain gap — not a
new or different bug.** Do not call 0.18 "moderate" — calibrated against this pipeline's own real
distortion profiles, it sits inside the CATASTROPHIC-failure regime, not the borderline one.

### Query-only multi-view evaluation (prompt §8)

New script `pnpm tsx scripts/scanner-visual-benchmark/run-query-variants.ts` builds 5 query
representations per hard-augmented capture — rectified full card (production baseline), a raw guide
crop (pre-P79 behavior, no perspective correction), rectified+5%/10% border inset, and rectified+
photometric normalization — searched independently against the same 240-card reference pool, plus
3 score-fusion strategies (max similarity, average similarity, rank average) over the rectified/
inset5/inset10/photometric set (n=40 corpus cards x 3 hard profiles):

| Profile | rectified | rawCrop | inset5 | inset10 | photometric | fusionMax | fusionAvg | fusionRank |
|---|---|---|---|---|---|---|---|---|
| tilted-offcenter (TOP1) | 92.5% | 97.5% | 97.5% | 97.5% | 97.5% | 100% | 100% | 97.5% |
| tilted-glare-shadow-blur (TOP1) | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| skewed-partial-shadow-noisy (TOP1) | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |

**No query-side representation trick, alone or fused, rescues the combined-defect profiles — every
single variant and every fusion strategy scores EXACTLY 0% TOP1/TOP3/TOP5 on both.** This is a
clean, decisive negative result directly consistent with the calibration finding above: under
severe glare/shadow/blur/noise, the captured PIXELS themselves carry essentially no recoverable
signal about the true card's identity, regardless of how the query crop is framed, inset, or
photometrically adjusted — this is a genuinely different problem from "which crop is best," and no
evidence from this session supports that any bounded query-side transform closes it. On the
geometry-only profile, all variants already sit at or near ceiling (92.5-100%) with n=40 — too
small a sample for the small differences between variants to be meaningful (each point ≈2.5%); the
one apparent standout (`rectified` TOP1=92.5% vs. others ≈97.5%) is well within single-flip noise
at this n and should not be read as "raw crop beats rectification" without a larger re-run.
**BEST_QUERY_VARIANT: none shows a real uplift over the shipped `rectified` baseline** once sample
noise and the geometry-only ceiling are accounted for; fusion strategies did not underperform
either, but their apparent 100% vs. the baseline's 92.5% is not distinguishable from noise at
n=40. Not re-run at a larger n this session given the decisive (and much more consequential) 0%
result on both defect profiles.

### Auxiliary reference representation, local-feature rerank, reference-image rerank — reasoned rejection, not built

Per the parity/calibration findings above, the dominant real failure mode is a DOMAIN-GAP problem
(severe glare/shadow/blur/noise defeating the query embedding itself), not a near-duplicate-art
discrimination problem the P79/P80 sessions originally hypothesized. This materially changes what
these three prompt items (§9-§11) would even need to fix:

- **A second reference representation (border-trimmed/art-crop/structural)** would only help if the
  QUERY embedding still resembled the TRUE card reasonably well but got confused with a visually
  similar DIFFERENT card — the P80 Chandelure hypothesis. Under this session's calibration data,
  the dominant failure (same-card similarity below the mean WRONG-card similarity) is not "close
  but confused with a lookalike," it is "the query barely resembles its own true reference at all."
  A second reference crop embedded from the SAME degraded query image would suffer the identical
  defect. Not built — same evidence-gated discipline P79/P80 used, now with a sharper reason.
- **Local-feature (ORB/AKAZE-style keypoint) reranking over DINO's top-K shortlist** requires the
  true card to already be IN that shortlist for reranking to have anything to work with. Under the
  combined-defect profiles, the true card's similarity sits below the mean wrong-card similarity —
  strong evidence it is frequently outside any practical top-30/50/100 shortlist under those
  conditions, not merely mis-ranked within one. Separately, classical local-feature descriptors are,
  if anything, LESS robust to blur/glare/low-contrast than a global CNN embedding (well-established
  in the CV literature — corner/gradient detectors depend on exactly the sharp local contrast severe
  blur/glare destroys) — the opposite of what this failure mode needs. Not built: no evidence
  supports it helping the dominant failure, a real risk it would help nothing while adding a new
  dependency, and P82's own precedent (perceptual hashing) already showed a geometrically-cheaper
  local/global hybrid idea can look promising on paper and fail decisively once measured on the
  right corpus.
- **Reference-thumbnail image rerank** (fetch candidate images, compare pixel-level against the
  query) inherits the SAME structural problem — reranking only helps once the true card is already
  a candidate — plus adds real per-scan network traffic to fetch reference thumbnails, a cost this
  project's privacy/zero-image-upload discipline (this document §3, COST_POLICY.md) treats as a
  cost worth avoiding without compelling evidence it fixes the actual failure. Not built.

None of these were benchmarked this session (unlike the parity/calibration/query-variant work
above, which used real measurements) — this is REASONED rejection from the calibration evidence,
disclosed as such, not a claimed experimental result.

### Real-index-scale diagnostic tooling shipped (prompt §12/§13)

Two small, debug-mode-only additions to the shipped scanner code (not benchmark scripts — real,
tested, integration-ready):

1. **`getExpectedCardRank(cardId)`** (`visual-client.ts`/`visual-worker.ts`/`controller.ts`): the
   worker now caches the last scan's L2-normalized query vector (384 floats, never an image) and
   can re-rank it against the FULL decoded index on demand — cheap, since `searchVisualIndex` is
   already one O(cardCount) brute-force pass regardless of how much of the sorted result is kept
   (real-device evidence: `INDEX_SEARCH_MS=16` at 19,501 cards for a topK of 30). Debug-mode-gated
   (`isScannerDebugEnabled()`), never auto-adds, never persists the expected-card id anywhere, never
   triggers a new embedding or network request — a same-tab Worker round trip only.
2. **Debug shortlist depth raised** (`VISUAL_DEBUG_SHORTLIST_SIZE` 50→200,
   `DEBUG_EXTENDED_CANDIDATE_LIMIT` 20→100) — production's own `VISUAL_SHORTLIST_SIZE` (30) is
   untouched; this only changes what a debug session can see.

Both are covered by real `pnpm test` unit tests (`tests/ui/scanner-visual-client.test.ts`,
`tests/ui/scanner-controller.test.ts`) — see docs/DECISIONS.md D-101 for the full account.
