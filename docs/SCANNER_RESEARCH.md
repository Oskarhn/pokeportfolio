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
