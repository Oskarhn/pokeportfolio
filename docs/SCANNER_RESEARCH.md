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
