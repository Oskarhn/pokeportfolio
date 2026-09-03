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

## 7f. Content-addressed index publishing, runtime integrity and cache coherence (M15, 2026-09-02 — P87, D-101)

P86's independent adversarial audit (F-01, CRITICAL/P0) found the visual reference INDEX served
`Cache-Control: immutable, max-age=1y` at a fixed literal path whose DATA had already been
rebuilt at least three times (P76/P77/P79) — a device that already ran the scanner could keep
using a stale or incomplete index for up to a year with no diagnostic signal. Full mechanism,
design and every touched surface: D-101. Summary for a future session:

- The index is now content-addressed (`.../visual-v1/index/generations/<contentId>/`, a SHA-256
  over semantic manifest fields + card-ids + embeddings bytes, `src/domain/scanner/
  index-content-id.ts`), with a tiny always-revalidating pointer (`current.json`) as the one
  thing a client fetches first. Model/engine binaries (content-stable per model revision) keep
  their existing path, untouched.
- `verify-index.ts`'s checks are now build-load-bearing (`stage-index-assets.mjs` calls them
  directly before staging anything into `public/`), publishing is atomic (temp-write, verify,
  rename — `atomic-publish.ts`), and `drainAllCardPages` uses keyset (not OFFSET) pagination with
  a before/after exact-count reconciliation around the full drain.
- The runtime worker gates a loaded index's declared source project against THIS deployment's
  own configured Supabase project (never gated in local/CI-placeholder builds), and independently
  re-hashes the fetched embeddings via WebCrypto rather than trusting the manifest's own checksum
  field alone.
- The already-valid, already-hosted-sourced 19,501-card committed index was repackaged under its
  correct content id by a one-time local script — zero re-embedding, zero database access.
- P84's debug-only `getExpectedCardRank` tooling (a sibling, unmerged branch off the same base)
  was ported by hand, unchanged in behavior.

Not addressed here, and still open for a future session per P86's other findings: F-02 (the
visual-evidence score ceiling structurally below coincidental text-match convergence — the
CRITICAL/P0 companion finding to F-01, a matcher-scoring defect, out of this session's scope),
F-03 (the discriminative-power-at-scale benchmark gap), and the remaining HIGH/MEDIUM findings
this session was not asked to fix (F-05 through F-41 except where explicitly listed in D-101).

## 7g. OCR engine forensics and a real, evidence-backed collector-number recovery pass (M15, 2026-09-02 — P85, D-102)

§7e's `binarize` fallback was shipped unbenchmarked against any real OCR corpus (disclosed
directly above). This session built one — the first real, ground-truthed OCR accuracy corpus this
project has had — and used it to actually forensically test Tesseract.js 7's configuration space
rather than continue reasoning from single anecdotal real-device screenshots (Shieldon, Mega
Chandelure ex) the way P78-P83 all had to.

### Corpus and methodology

`scripts/scanner-ocr-benchmark/` reuses the EXISTING real TCGdex reference-image fetcher
(`scripts/scanner-visual-benchmark/lib/fetch-references.mjs`, unchanged — no second corpus-fetch
implementation) for ground truth (real printed `name`/`localId` across 7 real sets spanning
vintage WOTC/e-series through Scarlet & Violet), then applies BOTH existing augmentation modules
this project already had for the P76/P79 visual benchmarks — `augment.mjs`'s 6 profiles (resize,
perspective-rotate, brightness-contrast, blur-jpeg, glare-overlay, shadow-color-shift) and
`hard-augment.mjs`'s 3 profiles (tilt + off-center placement composed onto a larger background,
optionally with combined glare/shadow/blur/noise, run through the REAL `rectify.ts` detect+warp
pipeline) — for 9 realistic perturbation profiles per card, covering every distortion class P85
asked for (perspective, skew, brightness, shadow, glare, blur, compression, small text,
vintage/modern layout) without a third reimplementation of any of it.

Two new benchmark entrypoints:
- `pnpm scanner:ocr:benchmark:psm-forensics` — a bounded PSM × preprocess grid search (5 page-
  segmentation modes × 2 preprocessing passes × both ROI candidates, on a representative 40-card/
  4-profile subset) to find which Tesseract configuration actually wins per field, rather than
  assuming one.
- `pnpm scanner:ocr:benchmark:recognition` — runs the REAL production pipeline functions (the
  exact exports `analyze.ts` itself calls: `NAME_ROI_CANDIDATES`/`NUMBER_ROI_CANDIDATES`,
  `scoreNameRoiCandidate`/`scoreNumberRoiCandidate`, `isNameRoiConfident`/`isNumberRoiConfident`,
  `extractCollectorNumberLine`) against a diverse, proportionally-sampled corpus (every real set
  represented, not just however `corpus.json` happens to be ordered — a real methodology bug this
  session found and fixed mid-session, see below) and reports BASELINE (P82/P83 behavior) vs. NEW
  (this session's addition) side by side.

**A real methodology bug, caught before it produced a false conclusion:** the first forensics run
sliced `corpus.json`'s first N rows unconditionally — which, because the corpus cache is built set
by set, meant "40 cards" was silently ALL Base Set (vintage) with zero modern SWSH/SV
representation. `diverseSample()` (new) samples proportionally across every real set instead.
Disclosed here because the wrong conclusion this bug could have produced (a PSM/preprocess winner
tuned only for one layout family) is exactly the kind of category error P80 already spent a whole
session fixing (§7c) — this project's benchmark tooling itself is not exempt from that lesson.

### PSM forensics result: the existing default was already correct for a genuinely single-line crop

Tested PSM 3 (auto), 6 (single uniform block), 7 (single line — the pre-existing default), 8
(single word), 11 (sparse text) against both `contrast` and `binarize` preprocessing, 40 cards ×
4 representative profiles (n=241-300 usable attempts per configuration after empty-text
exclusion). PSM 0/2/12 (any OSD-dependent mode) were excluded: `osd.traineddata` is not staged
(`scripts/prepare-scanner-assets.mjs` ships `eng.traineddata` only) — confirmed directly that
these modes do NOT throw, they silently degrade to `{text: '', confidence: 0}` every time with
stderr noise ("Tesseract couldn't load any languages!"), a worse failure mode than an exception.

**PSM 7 (single-line) wins decisively for BOTH fields when the candidate crop genuinely is one
line** — `contrast|7` and `binarize|7` are the top two configurations for the name field by a wide
margin (name-exact 7-8% / name-lexicon-fuzzy 39-44% vs. 0-3% for every other PSM); `binarize|7`
also leads the number-field grid, though every configuration in that grid scored near zero (see
below — this is the real finding, not a PSM problem). **The pre-existing default was already the
right choice; no PSM change was warranted for the single-line pass.** Full report:
`scripts/scanner-ocr-benchmark/reports/psm-forensics-report.json` (gitignored, regenerable).

### The real collector-number failure: a correctly-cropped strip routinely contains TWO lines, which PSM 7 cannot read at all

Direct visual inspection of the actual cropped/preprocessed ROI images (not just OCR output) on
two real cards — Base Set Alakazam (vintage `classic-bottom-right`) and Scarlet & Violet Pineco
(modern `modern-bottom-left`) — showed the crop containing perfectly legible printed text
("1/102 ★", "001/198") that `readOneCandidate`'s single-line recognition (PSM 7) nonetheless read
as EMPTY or as unrelated garbage. Root cause, confirmed by testing the identical crop at PSM 6
(uniform block): the crop structurally contains the id's line PLUS an adjacent illustrator-credit
or copyright line — a real, common template shape on both vintage AND modern layouts, not a rare
edge case — and PSM 7's single-line assumption mis-segments a genuinely two-line image into
nothing usable. PSM 6 reads the whole block, including both lines.

**Fix:** `analyze.ts`'s adaptive-ROI trial loop gains a bounded THIRD pass for the
collector-number field only (`readBestRoi`'s new `multiLineExtract` parameter, wired only at the
number call site): when the existing `contrast` AND `binarize` single-line passes BOTH find
nothing usable for EITHER number candidate, one more bounded attempt retries the SAME candidates
with `multi-line` segmentation (PSM 6) and extracts the id from whichever line/token actually
parses as one (`extractCollectorNumberLine`, new, exported and unit-tested). Never attempted
unless the field has already fully failed — an already-working scan pays zero extra cost, and the
worst case adds at most `NUMBER_ROI_CANDIDATES.length` (2) extra recognition calls, matching P85
§9's staged-budget requirement exactly.

**A real false positive found and closed before this shipped:** a bare structural
`looksLikeCollectorNumberText` check on a PSM 6 multi-line read let a vintage card's copyright
YEAR ("© 1995") win as a plausible "collector number" — a 4-digit, prefix-less token that
structurally parses but is not remotely a real printed id (this catalog's real local ids never
reach 4 digits without a total attached). `looksLikePlausibleMultiLineToken` (analyze.ts, used
ONLY by the multi-line fallback) additionally requires either a total (`X/Y` shape) or a
non-empty/known prefix or a numeric run of ≤3 digits — closing the exact false-positive shape
found, without touching the existing, already-tested `looksLikeCollectorNumberText` used
elsewhere. A second real shape — a misread set-symbol icon box sharing its line with the real id
(Scarlet & Violet: `"(BI 001/198 ®"`) — needed per-TOKEN extraction inside the line, not just a
per-line check, since the line as a whole never parses.

### Full-corpus recognition benchmark (BASELINE vs. NEW)

`pnpm scanner:ocr:benchmark:recognition`, sample=180 cards proportionally drawn from every real
set (base1/base2/neo1/swsh1/swsh7/sv01, 30 each — the 7th set, `cel25cc`, contributed fewer than
30 usable rows), 1,620 total perturbed queries (9 profiles/card):

| Metric | BASELINE (P82/P83) | NEW (P85) |
|---|---|---|
| Collector number EXACT | 0.0% | 0.4% |
| Collector number folded/numeric-only | 0.9% | 1.3% |
| Queries recovered ONLY by the multi-line pass (found SOMETHING baseline found nothing for) | n/a | 22/1620 (1.4%) |
| Avg. recognition calls/query (number field) | 2.25 | 2.36 |

Name field (unaffected by this session — measured once, n=1,620): EXACT 3.8%, lexicon-fuzzy
15.4%, lexicon-top-3 18.3%. By layout family: vintage EXACT 5.9%/fuzzy 23.1%/top-3 27.8% vs.
modern EXACT 1.7%/fuzzy 7.8%/top-3 8.9% — consistent with vintage's simpler, less busy name-plate
typography being easier for a general-purpose LSTM model than modern full-bleed name art.

**The fix is real, measured and non-zero — and honestly small at this benchmark's harsh scale.**
22 real queries out of 1,620 recovered SOME usable text ONLY because the multi-line pass ran;
collector-number EXACT moved from a flat 0.0% to 0.4%, and folded/numeric-partial evidence from
0.9% to 1.3% — a genuine, directly-attributable improvement with zero regression (BASELINE
numbers here are reproduced from the SAME pipeline code paths NEW uses minus the third pass, not
re-derived, so this is an apples-to-apples delta). It is also small in absolute terms: this
benchmark deliberately includes the harsh combined-defect profiles (blur, glare, shadow,
tilt+off-center composited with noise) that §7c/P79 already found collapse near-EVERY recognition
method to near-zero, and a card's collector number is printed in a much smaller, often more
stylized font than its name — the single hardest text on the card to recover once resolution/
contrast has already been degraded by a realistic capture. The individual-image confirmations
above (Alakazam, Pineco) show the mechanism genuinely working when the source is only lightly
degraded; the population-scale number here shows how much of this benchmark's corpus is NOT lightly
degraded. Disclosed as a real, still-open, hard sub-problem — not a claim that collector-number
OCR is solved.

**Honest limitation, disclosed rather than smoothed over:** the multi-line recovery is real and
directly confirmed on individual, lightly-degraded images (see above), but its measured recovery
rate across the FULL 9-profile perturbed corpus is small — most of this benchmark's perturbation
profiles (blur, glare, shadow, tilt+off-center) degrade the already-small, often stylized printed
collector-number font enough that no page-segmentation mode recovers it, consistent with §7c/P79's
own "combined photometric defects collapse every method to near-zero" finding for the VISUAL
channel. This is a genuine, still-open, hard sub-problem — not something ROI/PSM tuning alone can
fully close — rather than a claim that P85 solved collector-number OCR outright.

### Local name-lexicon fuzzy resolution — built, tested, NOT wired into production retrieval this session

`src/domain/scanner/name-lexicon.ts` (new): resolves a noisy OCR name reading against a small
local list of UNIQUE catalog names via bounded Damerau-Levenshtein similarity, requiring both a
minimum ratio (`LEXICON_MIN_RATIO`, 0.72) AND a real margin over the runner-up
(`LEXICON_MIN_MARGIN`, 0.08) before calling anything "confident" — the same
score-alone-proves-nothing discipline `engine.ts`'s own ambiguity-margin tiers use. Directly
confirmed to resolve a Shieldon-shaped one-letter OCR miss ("Shieidon" → "shieldon") with real
confidence while REJECTING genuine garbage ("3S oa |") outright — no manufactured confidence.

This is a separate, EARLIER-stage concern from `name-similarity.ts`'s existing `compareNames`
(which scores a candidate the catalog has ALREADY returned): a lexicon resolution would let a
badly garbled OCR string produce a sane search query before any catalog call, rather than one
guaranteed to return nothing. `scripts/scanner-name-lexicon/build-lexicon.ts` (new) generates the
lexicon for real, from either the real catalog (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) or,
absent credentials, this session's own OCR benchmark corpus as an honestly-labeled DEMO substitute
— run this session (no DB credentials available, the same standing gap every M15 session since
P75 has disclosed): 667 unique names from 988 raw rows (the full OCR benchmark corpus), 8,021
bytes — a real, measured confirmation of the
"far fewer unique names than printings" premise (32% reduction even at this small, low-duplication
demo scale; a real ~20,946-card catalog with many more reprints/re-releases would show a
materially starker ratio). **Not wired into `retrieveScannerCandidates`'s default retrieval path
this session** — the real production-scale lexicon does not exist yet (no DB access), and wiring
an unvalidated demo-scale substitute into the shipped retrieval path would be exactly the
"blindly ship a complicated ensemble" this project's discipline exists to prevent. Ships as
tested, available domain tooling (`photometric.ts`/`perceptual-hash.ts`'s own precedent) for a
future session with real catalog access to wire in once a real lexicon is generated and verified
at production scale.

### Structured collector-number parsing

`src/domain/scanner/collector-parse.ts` (new): wraps the existing `parseCollectorNumber` with a
canonical `normalized` form and a `PARSE_CONFIDENCE` band (`high`/`medium`/`low`/`none`) driven by
STRUCTURAL plausibility, independent of raw OCR confidence — a total (`X/Y`) is the strongest
signal (HIGH); a bare numeric id or a recognized multi-letter/known-single-letter prefix is the
ordinary real-catalog shape (MEDIUM); a generic single letter plus a stray digit or two with no
total ("Z7", "x2" — exactly the garbage shapes P85 §8 named) is LOW, never promoted further
without more evidence; text with no digits at all never parses (NONE). Diagnostics/scoring
tooling only — `engine.ts`'s own matching scores are untouched.

### OCR debugger

`?scannerDebug=1` now surfaces every considered ROI/preprocess/segmentation attempt this scan
(`ScannerDiagnostics.ocrTrials`, new — `analyze.ts`'s `readBestRoi` records one entry per attempt
when `debug` is true), each line showing field, ROI id, preprocessing variant, segmentation mode,
confidence, a plausibility score, and the actual recognized text, with the winning attempt flagged
`<-- WINNER`. Textual only, memory-only, never persisted — the exact same privacy floor the
existing `OCR_NAME_SIGNAL`/`OCR_COLLECTOR_SIGNAL` fields already established (P77); this is the
same information at finer grain, not a new boundary.

## 8. Matcher evidence-combination redesign (P88, D-103)

Responds to the independent adversarial audit's two P0/CRITICAL findings this session owned
(F-02) — full decision record in `docs/DECISIONS.md` D-103; this section carries only the
measured numbers.

### Re-run of the existing §7b/D-097 benchmark methodology with the NEW matcher

Same corpus (240 real TCGdex cards, 6 sets, 1,440 augmented queries), same real production
matcher/embeddings — only `engine.ts`/`visual-evidence.ts`'s scoring changed:

| Method | TOP1 | TOP3 | TOP5 |
|---|---|---|---|
| OCR-first | 30.2% | 39.3% | 41.6% |
| Perceptual (dHash) | 86.7% | 93% | 95% |
| Visual (DINOv2) alone | 99.7% | 100% | 100% |
| Hybrid — OLD (pre-P88, documented above) | 95.8% | 99.9% | 100% |
| **Hybrid — NEW (P88)** | **99.4%** | **100%** | **100%** |

The hybrid-vs-visual-alone gap shrank from -3.9 points (OLD) to -0.3 points (NEW) on the project's
own existing measurement. This does not by itself prove F-02 is closed at the real 19,501-card
catalog's discriminative scale (see F-03/§7 above — this 240-card corpus still cannot measure
confusability against 19,500 OTHER cards) — it proves the redesign does not regress the existing,
already-relied-upon benchmark, and the isolated adversarial unit suite
(`tests/domain/scanner/engine-visual-dominance.test.ts`) proves the specific coincidental-text-
convergence mechanism the audit found is now guarded against by construction, independent of
corpus scale.

### Full-corpus OCR recognition benchmark (P85's methodology, re-run with this session's F-16/F-12/§13 fixes)

210 of the 240-card corpus (a fresh random sample), 9 perturbation profiles, 1,890 queries:

| Field | Baseline | This session |
|---|---|---|
| Name exact | — | 3.3% (P85's own 180-card sample: 3.8% — within sampling noise, not a regression) |
| Name fuzzy/normalized | — | 14.8% |
| Collector-number exact | 0.1% | 0.4% |
| Collector-number fuzzy/normalized | 1.0% | 1.3% |

Consistent with P85's own numbers (small differences are sampling noise from a different random
210-of-240 draw, not a regression). F-16 (separator recovery) and F-12/§13 (confidence gating,
body-text penalty) target failure classes this synthetic corpus does not heavily represent
(stray-separator OCR noise, low-confidence-garbage ROI winners, attack/rules-text contamination)
— their effect is demonstrated by dedicated unit tests
(`tests/domain/scanner/collector-number.test.ts`, `tests/ui/scanner-analyze.test.ts`), not expected
to move this particular aggregate benchmark meaningfully.

### Not done this session (disclosed)

A scale-appropriate confusable-group benchmark against the real 19,501-card hosted catalog
(prompt §17/§18, F-03) — still blocked on hosted Supabase credentials, the same standing gap every
M15 session since P75 has disclosed. No card-name/set metadata for the real catalog exists locally
to construct deliberate confusable groups (same-Pokémon-different-printing, adjacent evolution
families, GX/V/VSTAR/ex families) without a live database connection.

## 9. Mega-integration: P87 + P88 + P89 combined, worker fallback, expected-card debug UI (M15, 2026-09-02/03 — P90, D-105)

Combines all three parallel M15 repair branches above onto one integration branch via real `git
merge` (never squash/cherry-pick — each branch's own commit history is preserved), then closes the
concrete gaps the combined result still left open. Full account: D-105.

Beyond the merge conflict resolution itself (§7f/§7g/§8 renumbering, the `analyze.ts`
OCR-pipeline/mutex reconstruction, `main.tsx`'s two independent fire-and-forget calls), this session:

- Implemented a REAL main-thread RGBA-conversion fallback for the one confirmed engine gap P89's
  real-worker smoke test found (`OffscreenCanvas` unavailable inside a Worker scope) — the worker
  reports `offscreenCanvasAvailableInWorker`, and the client converts on the main thread instead of
  degrading to a structured error, keeping visual recognition working end to end.
- Finished the expected-card debug UI P87 shipped plumbing for but never built (§7f/D-101's own
  disclosed gap) — a catalog search + rank lookup under `?scannerDebug=1`, extended with a real
  hybrid (text + visual) rank via a new `rankScannerCandidatesFull` that reuses production's exact
  scoring pipeline without the top-N truncation.
- Made the platform build verifier and the hosted missing-index policy mode-aware (LOCAL/CI
  PLACEHOLDER vs HOSTED), closing a false-failure P87 had disclosed (23/24 under the local
  placeholder origin) and a real gap (a hosted build could previously ship with no visual index at
  all, silently, with every other gate green).
- Added a plain-language "visual recognition unavailable" note to the scanner intro screen for a
  confirmed terminal failure — previously silent either way.
- Verified (not assumed) that index-update-during-an-open-session, the unsaved-work registry vs.
  index-freshness interaction, abort vs. visual-worker state, the OCR mutex vs. cancellation, F-02's
  guard, and test-fixture path consistency were ALL already coherent by construction post-merge, with
  no code change required — each investigated directly against the merged tree.

`SCANNER_SCHEMA_VERSION` bumped 1 → 2 — see `src/platform/build-info.ts`'s own comment.

## 10. Matcher correctness rewrite: continuous scoring, reliability-weighted evidence, severe-blur abstention (P93, D-106)

Responds to P92's cross-branch audit re-derivation, which found D-103's F-02 fix structurally
incomplete (N-01/N-04/N-05/N-09) — full decision record in `docs/DECISIONS.md` D-106; this section
carries the calibration derivation and the measured numbers.

### §10a — continuous visual-evidence curve derivation

The old curve was three piecewise-linear bands meeting at hard thresholds (a 17-point jump exactly
at similarity 0.82, N-04). The new curve is a single logistic function,
`points(s) = ceilingPoints / (1 + e^{-k(s - m)})`, with `ceilingPoints = 92` (unchanged asymptotic
ceiling) and `k`/`m` solved from two calibration anchors read directly off P84's own measured
distributions (D-101 §2):

- `points(moderateMin = 0.68) ≈ 25` — a plausible-but-unproven visual read, well below confident.
- `points(strongMin = 0.82) ≈ 60` — just above P84's own mean genuine-match similarity (0.812),
  genuinely competitive with (though not overwhelming) the maximum reachable coincidental TEXT-only
  score a wrong card can score in production (75 — id-exact 45 + name-exact 30, since `rawSetText`
  is never populated and language-match no longer scores per D-106).

Solving `logit(25/92) = k(0.68 - m)` and `logit(60/92) = k(0.82 - m)` simultaneously gives
`k ≈ 11.53`, `m ≈ 0.7655`. Selected points on the resulting curve:

| similarity | 0.0 | 0.2 | 0.4 | 0.55 | 0.6 | 0.68 | 0.75 | 0.79 | 0.80 | 0.81 | 0.812 | 0.82 | 0.83 | 0.88 | 0.90 | 0.95 | 1.0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| points | 0 | 0 | 1 | 7 | 12 | 25 | 42 | 52 | 55 | 58 | 58 | 60 | 62 | 73 | 76 | 82 | 86 |

No jump anywhere; every ±0.01 step near the old 0.82 cliff changes points by 2-3 at most (pinned by
`tests/domain/scanner/engine-p93-redesign.test.ts`'s M93-2 case, which asserts every ±0.001 step in
[0.8, 0.84) differs by at most 2 points).

### §10b — real benchmark evidence (all actually run this session)

**240-card/6-set benchmark** (`pnpm scanner:visual:benchmark`, same methodology as §8 above):

| Method | TOP1 | TOP3 | TOP5 |
|---|---|---|---|
| Visual (DINOv2) alone | 99.7% | 100% | 100% |
| Hybrid — P88 (D-103, documented above) | 99.4% | 100% | 100% |
| **Hybrid — P93 (D-106)** | **99.7%** | **100%** | **100%** |

The hybrid-vs-visual-alone gap is now ~0 points (was -3.9 pre-D-103, -0.3 at D-103).

**Real corpus-scale adversarial benchmark** (new, `scripts/scanner-recognition-lab/experiments/
08-p93-hybrid-false-confidence.ts`, reusing P91's cached ~4,300-card corpus/reference index rather
than re-downloading — see that script's own header for exactly how). For each of n=300 sampled
cards, a DIFFERENT corpus card is given the true card's own coincidental id+name text match while
the true card carries ZERO text evidence — the F-02 mechanism, at real scale, across three real
embedded conditions per card (900 trials total):

| Profile | mean true similarity | correct (TOP1) | false-HIGH rate |
|---|---|---|---|
| clean | 1.000 | 100% | 0% |
| tilted-offcenter (geometry-only) | 0.7999 (≈ P84's 0.812) | 60.7% | 1.33% |
| tilted-glare-shadow-blur (catastrophic) | 0.1195 | 0% | 0% |

The geometry-only row is the exact operating point P92's audit flagged as broken (P84's own MEAN
genuine similarity, previously below the 0.82 absolute activation threshold): the true card now
wins outright in 6 of 10 of this deliberately worst-case adversarial matchups (zero text evidence
of its own, competing against a coincidental exact id+name match), and even in the 4 of 10 it loses,
it almost never loses at HIGH confidence. The catastrophic row shows the true card losing HONESTLY
(the matcher correctly has no real evidence to work with there) rather than the wrong card ever
displaying false HIGH confidence — 0% false-HIGH across all 300 catastrophic-profile trials.

**Continuous blur-severity sweep** (new, `.../09-p93-continuous-blur-severity.ts`, n=80, isolated
Gaussian-blur-sigma dimension — glare/shadow are not swept, see the script's own header for why):

| sigma | mean blur score | TOP1 accuracy | below BLUR_ABSTAIN_THRESHOLD (378) |
|---|---|---|---|
| 0 | 10298.69 | 100% | no |
| 2 | 1194.21 | 98.8% | no |
| 3 | 335.78 | 96.3% | yes |
| 4 | 130.78 | 87.5% | yes |
| 6 | 39.93 | 88.8% | yes |
| 8 | 16.31 | 71.3% | yes |
| 10 | 9.92 | 36.3% | yes |
| 14 | 5.29 | 6.3% | yes |
| 20 | 3.78 | 3.8% | yes |

On pure, isolated blur, retrieval accuracy actually stays high (96%+) somewhat past where the
threshold already triggers abstention (sigma 3), and the real accuracy cliff sits later (sigma
8-10). The shipped threshold is therefore conservative relative to isolated blur severity alone —
expected and appropriate, since P91's own calibration derived it from hard-defect profiles that
bundle blur with co-occurring tilt/glare/shadow, which a real phone photo is more likely to exhibit
together than blur in total isolation. Not changed based on this evidence, per this session's own
instruction not to broaden the gate without evidence exceeding the measured range.

### §10c — not done this session (disclosed)

The real 19,501-card hosted-catalog confusable-group benchmark (F-03) remains open — unchanged
since every M15 session since P75. The dual-prototype reference-index recommendation (P91) was not
implemented. No new DINO model was evaluated (D-098 stands). Glare/shadow/perspective/noise
severity dimensions were not swept continuously — P91 already found its simple metrics for those
have ~zero discriminative power on this project's synthetic composites, and neither is wired into
production.
