# P182 — Native Card Recognition: Portability Audit

Base: `45ebfefa9a5038e20dd1999644eb96c1ae6352ef` (P181, `feat/p181-native-device-accessibility-performance-gate`).
Verified ancestry: P181 → P180 → P179 → P178 → P177 → P175 → P173 → … → `d8682e0` (released main).

This audit classifies every module the web scanner (`src/domain/scanner/`, `src/data/scanner/`,
`src/features/scanner/`) depends on, per the P182 mission's own six categories, before any native
recognition code was written. Read before implementation, not after.

## Key finding: this base already exposes the scanner domain to the native app for free

`apps/mobile-spike/metro.config.js` already aliases `@shared/*` → `<repo>/src/*` and adds `src/` as a
Metro watch folder (built for `@shared/domain/money` etc.). `src/domain/scanner/*` and
`src/data/scanner/visual-index.ts` are part of the **released** scanner feature (merged into `main`
long before the P166 native track branched), so — unlike P169's price-check domain, which had to be
byte-identically vendored because P165 was an unmerged branch not present in this base's history —
the scanner's pure domain code is *already on this base* and can be imported natively via the exact
same `@shared/domain/scanner/...` / `@shared/data/scanner/visual-index` aliases, live from the single
source of truth. No fork, no copy, no provenance pinning needed. (`tsconfig.json`'s `include` list
needs two additions for `tsc` to see the extra paths — Metro's runtime resolution is unaffected.)

## Classification

| Module | Category | Notes |
|---|---|---|
| `src/domain/scanner/engine.ts` | PURE_TYPESCRIPT_REUSABLE | Candidate fusion + confidence tiers (HIGH/MEDIUM/LOW/NO_MATCH via `rankScannerCandidates`). Zero DOM refs (grepped for `document.`/`window.`/`OffscreenCanvas`/`createImageBitmap`/`fetch(`/`localStorage`/`indexedDB`/`navigator.` — none). Reused verbatim via `@shared/domain/scanner/engine`. |
| `src/domain/scanner/collector-number.ts`, `collector-compare.ts`, `collector-parse.ts` | PURE_TYPESCRIPT_REUSABLE | Collector-number parsing/comparison the OCR text feeds into. No DOM. |
| `src/domain/scanner/name-similarity.ts`, `name-lexicon.ts`, `edit-distance.ts`, `normalize.ts`, `set-hint.ts` | PURE_TYPESCRIPT_REUSABLE | Text-evidence scoring inputs to `engine.ts`. No DOM. |
| `src/domain/scanner/visual-evidence.ts` | PURE_TYPESCRIPT_REUSABLE | The visual-similarity → points curve `engine.ts` calls. No DOM. |
| `src/domain/scanner/dino-preprocess.ts` | PURE_TYPESCRIPT_REUSABLE | `preprocessRgbaForDino`: canvas-free RGBA→CHW-float32-tensor pipeline, **already written for a non-OffscreenCanvas fallback path** (WebKit) — plain typed arrays in, plain typed arrays out. This is the exact function a native RGBA buffer needs; no adaptation required. |
| `src/domain/scanner/rectify.ts` | PURE_TYPESCRIPT_REUSABLE | `RgbaImage`/`Quadrilateral` types, Sobel-based `detectCardQuadrilateral`, `warpPerspective`. No DOM. Optional for P182 v1 (see §8 below); reused as-is if used. |
| `src/domain/scanner/photometric.ts`, `capture-quality.ts`, `perceptual-hash.ts` | PURE_TYPESCRIPT_REUSABLE | Blur/quality checks and the P97 prototype-augmentation recipe. No DOM. |
| `src/domain/scanner/index-content-id.ts`, `index-coverage.ts`, `index-pagination.ts`, `types.ts`, `checkpoint-identity.ts` | PURE_TYPESCRIPT_REUSABLE | Index bookkeeping types/helpers. No DOM. |
| `src/data/scanner/visual-index.ts` | PURE_TYPESCRIPT_REUSABLE | `decodeVisualIndex`/`searchVisualIndex`/`l2Normalize`/`quantizeEmbedding` — documented in its own header as "operates on plain ArrayBuffers/TypedArrays only — no DOM, no fetch, no Supabase." Reused verbatim. |
| `src/features/scanner/camera-session.ts`, `camera-acquisition-guard.ts`, `capture.ts`, `canvas-compat.ts` | BROWSER_ONLY | `getUserMedia`/`<video>`/`OffscreenCanvas`/`createImageBitmap`. Not portable. Native equivalent: the app already has one — `apps/mobile-spike/src/photo/{photo-store.ts, expo-photo-port.ts}` (P167), which owns the camera/picker lifecycle, permission states, orphan cleanup and identity-scoped release. P182 reuses `PhotoStore` unchanged rather than porting the web camera module. |
| `src/features/scanner/image-header.ts` | IMAGE_DECODE_SPECIFIC | Pre-decode dimension sniffing straight from file bytes (PNG/JPEG/GIF/WebP/BMP headers), no `createImageBitmap` call — the byte-parsing logic itself has no DOM dependency, but its caller (`capture.ts`) is browser-only. P182 reimplements the *policy* (reject before allocating a full decode) against `expo-image-manipulator`'s native decode+resize, which does not expose a header-only peek — see §7. |
| `src/features/scanner/ocr-engine.ts` | OCR_RUNTIME_SPECIFIC | Tesseract.js Worker wrapper. Not portable. Native replacement: `@react-native-ml-kit/text-recognition` (Google ML Kit, on-device) — see §4. |
| `src/features/scanner/visual/visual-client.ts`, `visual-worker.ts`, `worker-asset-cache-through.ts`, `phase-timing.ts`, `safari-detection.ts` | VISUAL_MODEL_RUNTIME_SPECIFIC / WORKER_SPECIFIC | `transformers.js` (`AutoModel`/`AutoProcessor`) + Web Worker `postMessage` orchestration + Cache Storage asset staging. Not portable. **The math inside (`preprocessRgbaForDino`, `searchVisualIndex`) already lives in the pure `domain`/`data` layer above and is reused directly** — only the *runtime* (model loading, tensor execution, worker lifecycle) is rebuilt natively, against `onnxruntime-react-native` running the identical pinned `.onnx` file (§5). |
| `src/features/scanner/controller.ts`, `state.ts`, `session-store.ts`, `analyze.ts`, `ScannerPage.tsx`, `unsaved-work.ts`, `debug-flag.ts`, `diagnostics-format.ts`, `errors.ts`, `guide-geometry.ts`, `roi.ts`, `rectify-capture.ts` | BROWSER_ONLY / NATIVE_ADAPTER_REQUIRED | React-DOM screen, cancellation/generation-counter orchestration built around the browser worker pair. **Not ported as files** — P182 writes a new native orchestration module (`apps/mobile-spike/src/features/scanner-native/recognition-pipeline.ts`) that reproduces the same *policy* (latest-capture-wins, cancellation checkpoints, no result after supersede) using the native app's own `IdentityAuthority` lease pattern (already used by `PhotoStore`), not a line-for-line port of `controller.ts`'s DOM-coupled state machine. |
| `src/features/scanner/scanner-identification.ts` | ABSENT FROM THIS BASE | Introduced in the P151 scanner-hardening branch, which was never merged into the native track's base (`d8682e0` → P166…P181 is a separate lineage from P151/P153/P161/P164/P165's own unmerged branches). Not available to reuse here. P182's `recognize()` implementation is written directly against `engine.ts`'s `matchScannerObservation`/`rankScannerCandidates`, not against this absent port. |

## Model & index asset identity (verified, not assumed)

- Pin source: `scripts/scanner-visual-index/lib/model-pin.mjs` — `Xenova/dinov2-small` @
  `c2bb04a51fab207c420665f1946016107bffc701`, dtype `q8`/int8, 384-dim.
- Downloaded fresh from `huggingface.co/Xenova/dinov2-small` at that exact revision and hashed:
  - `onnx/model_quantized.onnx` — SHA-256 `3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917`, 24,451,943 bytes — **matches the pin exactly**.
  - `config.json` — SHA-256 `471007e1c59df520030a2690998f4e0ba5d810bc4f959d1984f630d198faa07e` — **matches**.
  - `preprocessor_config.json` — SHA-256 `14e780d86fa1861f8751f868d7f45425b5feb55c38ca26f152ca5097ab30f828` — **matches**.
- Index generation `f25fc05d569b7cca` (the content id P182's own prompt named as expected) exists locally
  at `scripts/scanner-visual-index/generated/visual-v1/generations/f25fc05d569b7cca/` in the main
  checkout: `manifest.json` (schema v2, multi-prototype-v2, 19,500 cards, 39,000 rows),
  `card-ids.json`, `embeddings.bin` (14,976,000 bytes = 39,000 rows × 384 dims × 1 byte, exact).
  `embeddings.bin`'s SHA-256 (`eaec748d2713cd2b2a1f4a900b7bdeeb06435b8d15d28869a9dbd163f9a5540e`)
  matches the manifest's own pinned `embeddingsSha256`.
- **Conclusion: the exact web model and the exact web index (content id `f25fc05d569b7cca`) are
  reused byte-for-byte, verified by hash, not rebuilt.** This closes the mission's §10 requirement
  ("if the exact web ONNX model runs natively, prove fixture parity; do not silently rebuild a
  different embedding/index") at the asset-identity level; runtime parity (does
  `onnxruntime-react-native` actually reproduce the same embeddings from the same tensor) is proven
  separately, on-device, in the fixture-parity pass (§25 of the mission).

## Native package choices (verified against the real registry, not memory)

- **OCR**: `@react-native-ml-kit/text-recognition` — npm `dist-tags.latest` = `2.0.0`, published
  2025-09-01, license MIT, repo `github.com/a7med-mahmoud/react-native-ml-kit`. Wraps Google ML Kit
  Text Recognition v2 (on-device, Android + iOS). No image leaves the device — ML Kit's on-device
  text recognizer does not call a network API.
- **Visual model runtime**: `onnxruntime-react-native` — npm `dist-tags.latest` = `1.24.3`, MIT,
  published by Microsoft (`git+https://github.com/Microsoft/onnxruntime.git`, maintainer
  `onnxruntime@microsoft.com`). `InferenceSession.create(modelPath: string, options?)` — a *local
  file path* only (confirmed against the package's own README: "Model loading using ArrayBuffer is
  not currently supported"). Both packages require `expo prebuild`/a custom dev client (no Expo Go) —
  consistent with how every native phase since P166 has already built this app (release APK via
  `expo prebuild --clean` + Gradle, never Expo Go).
- **Asset bundling**: Metro's default asset pipeline (`resolver.assetExts.push('onnx')`) +
  `expo-asset`'s `Asset.fromModule(require(...)).downloadAsync()` to materialize a real `file://`
  path from the bundled `.onnx`/`.bin` assets, `expo-file-system`'s `File.bytes()` (SDK 57, returns
  `Promise<Uint8Array<ArrayBuffer>>` directly — no base64 round-trip) to read `embeddings.bin` into
  the `ArrayBuffer` `decodeVisualIndex` expects, and `expo-crypto`'s `Crypto.digest(algorithm,
  Uint8Array)` for the on-device SHA-256 asset-integrity check before every session load. `manifest.json`
  and `card-ids.json` are small enough (899 B / ~743 KB) to import directly as JS modules (Metro/TS
  already parse `.json` imports) rather than routed through the binary-asset path.
- No paid cloud API, no third-party OCR/vision SaaS considered or used.

## What P182 builds new (the actual native-specific surface)

1. `apps/mobile-spike/src/features/scanner-native/image-safety.ts` — pre-inference bounds (file size,
   width/height, decoded-pixel ceiling, aspect ratio) against `expo-image-manipulator`'s manipulate
   result, mirroring `image-header.ts`'s *policy* (values pinned in `docs/SCANNER_RESEARCH.md` 12c)
   since there is no native header-only peek equivalent to avoid a full decode on an oversized file —
   disclosed, not silently different.
2. `.../ocr-adapter.ts` — `@react-native-ml-kit/text-recognition` wrapper producing the same
   `rawNameText`/`rawCollectorNumberText`/`rawSetText`/`nameOcrConfidence`/`collectorOcrConfidence`
   shape `parseScannerSignals` (`engine.ts`) already consumes.
3. `.../visual-adapter.ts` — `onnxruntime-react-native` session wrapper: load the pinned `.onnx` via
   `InferenceSession.create`, run `preprocessRgbaForDino`'s tensor through it, L2-normalize
   (`visual-index.ts`'s own `l2Normalize`), search (`searchVisualIndex`) against the bundled index.
4. `.../recognition-pipeline.ts` — orchestration implementing the existing
   `CardRecognitionPort` interface (`apps/mobile-spike/src/features/price-check/recognition.ts`,
   currently `NATIVE_RECOGNITION_UNAVAILABLE`): image safety → OCR → visual embed/search →
   `matchScannerObservation` (engine.ts, unchanged) → confidence-state mapping (adds
   `ABSTAIN_QUALITY`/`ERROR`/`CANCELLED` around engine.ts's four tiers, which the mission's states
   list needs and `engine.ts` itself has no reason to know about) → identity lease / latest-capture-wins
   (same pattern as `PhotoStore`).
5. Result/confirmation UI extending `PhotoEntryScreen.tsx`, using P181's existing dark
   `Utility × Foil` component system (`src/ui/components.tsx`) — no new visual language.

## Integration points reused unchanged (not rebuilt)

- `apps/mobile-spike/src/photo/photo-store.ts` (P167) — camera/picker acquisition, ownership,
  identity-scoped release/orphan purge. P182 does not touch its lifecycle contract.
- `apps/mobile-spike/src/features/price-check/recognition.ts` — the `CardRecognitionPort` seam and
  `toRecognitionOutcome`/`interpretScan` (P165 domain, vendored in P169) — P182 implements the port,
  does not change the seam's shape.
- `apps/mobile-spike/src/features/price-check/PhotoEntryScreen.tsx` — extended, not replaced.
- Price Check's own flow (P169/P173/P177/P180/P181) and the financial write seam (P175/P177/P180) —
  reached only after explicit confirmation, exactly as already built; P182 adds no second write path.
