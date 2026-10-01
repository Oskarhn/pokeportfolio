# P184 — native release-candidate hardening (scanner)

Branch `release/p184-native-rc`, built directly on P182 (`615475209a33…`). Local only: not pushed (the
repository is PUBLIC), not merged, nothing deployed. Code tip when this was written:
`953aa017d2f950e77d1319dd238dcd35d83b5ded`. Scripts: `apps/mobile-spike/scripts/p184/`; raw evidence
(gitignored): `apps/mobile-spike/.build/p184-evidence/`.

> **Superseded for the open items by [P185](P185_NATIVE_RC_CLOSURE.md)** (`SUCCESS_P185_NATIVE_RC_VERIFIED`): the full journey, the
> 360 dp text checks, manual valuation and sale are closed there. This document stays the record of the scanner hardening.

**Status: `PARTIAL_P184_NATIVE_RC_HARDENING`.** The scanner and its safety properties are verified on a
release APK; the full release-candidate journey and the accessibility sweep are not fully green (see
"Not verified").

## What P182 proved, what P184 changed

P182 proved the core: real release APK, real on-device ML Kit OCR, real on-device ONNX/DINO inference
over the shared index (`f25fc05d569b7cca`), a real selected image → a real catalog candidate. It did
not run its reliability scope. P184 ran it and found and fixed real defects:

| Finding | Fix |
|---|---|
| Image safety ran **after** Skia decode; a compressed pixel bomb reached the decoder | Container header (JPEG/PNG/WebP) sniffed and bounded before any decode/OCR; unsupported containers refused |
| Cancellation only at the very end of a scan | Checkpoint after every await; cancelled on background, on leaving the screen, and on the identity boundary (`reset()` registered in the scoped registry) |
| No severe-blur handling (web abstains the visual channel) | Shared `capture-quality` gate: visual skipped, text still works; nothing readable → honest "too blurry" abstention |
| `NO_MATCH` could still list the first weak-visual candidate | `NO_MATCH` shows no candidate (manual-search fallback) |
| Collector-number heuristic read HP/damage numbers (`30`, `60`, `100 HP6`, `I00`): **0/6** correct on real vintage cards | Printed `N/M` token in the lower card first, mid-card bare numbers ignored: **6/6** |
| OCR received the downscaled decode height; ML Kit frames are in the full oriented image | OCR gets the oriented full-size height (matters for camera photos > 1600 px) |
| A transient model/asset load failure was cached for the process lifetime | Only an integrity failure stays sticky; nothing falls back to an unverified asset |
| Two mounted photo screens cancelled each other's analysis in an endless loop (found on device) | Only the focused screen analyses; only a background cancellation is re-run |
| Result below the fold under a full-width preview | Preview 46 % wide |

Decision logic is dependency-injected (`RecognitionPipelineDeps`) and tested with the real fusion
engine. 36 scanner/RC mutants (`scripts/p184/mutations.mjs`) are killed by assertions; the existing
suite kills 64/67 (3 survive by their documented design). Mobile unit tests: 707 (was 609).

## Confidence policy (shared engine, unchanged)

Observed and pinned: weak visual-only (< 0.68) is never HIGH; a strong visual-only match (≥ ~0.85)
**is** HIGH by the shared policy (same as web — an owner-visible property). HIGH only pre-highlights:
the outcome carries card identity only (no printing, finish, condition, grade, price), Price Check is
read-only, the printing is chosen explicitly, nothing is written before the final confirm.

## Device results (Android 16 x86_64 emulator, release APK, proof build)

- **Adversarial suite** (18 synthetic fixtures + 6 local-only real-artwork photos, never committed): 24/24
  policy checks, **0 false HIGH**, 2 controlled positives reach HIGH for the right card (one synthetic,
  one real artwork). Severe blur → abstain; unknown / non-card → no match; OCR-vs-visual,
  visual-vs-number, same-art siblings, duplicate number across sets → never HIGH.
- **Image safety** (13 pathological files): pixel-bomb PNG, 12000² JPEG, extreme aspect, tiny → refused in
  < 50 ms before any decode; lying headers, text, PDF, SVG, empty files are refused by the system picker;
  a truncated JPEG and a 22 MB noise JPEG are analysed without a crash.
- **Lifecycle**: latest-capture-wins (held scan A + photo B: only B shown, 0 flashes; burst of 8 → 1 analysed /
  7 cancelled), navigation away (cancelled, no leak), background (cancelled, no ONNX, 1 CPU tick, exactly one
  re-analysis on return), sign-out and A → B → A (old scan never appears), same-user token refresh
  mid-scan (scan preserved — the explicit contract), font/density/locale recreation (one JS runtime, one
  model session; the photo and result are released on recreation, the existing P167 ownership contract).
- **Privacy**: every request audited for image bytes, base64 prefixes, file/content URIs, picker names, EXIF:
  **0** markers; largest request body 148 bytes.
- **Parity with the web logic** (same 24 images, same catalog): top-1 agrees 14/24, visual top-1 19/24,
  collector-number interpretation 19/24. 2 flagged "native HIGH while web NO_MATCH" (perspective, moderate
  blur) were investigated: same top-1 card; the web harness can only use its full-frame OCR fallback
  (its ROI path needs a live capture guide) and read no number. Native was more conservative on siblings.
- **Flows**: scanner → confirm → explicit printing → raw Price Check: 0 writes; → Add to Collection: 0 writes
  before the final confirm, then exactly one acquisition lot; → EUR purchase: exact `EUR 20.00`
  (2 × 10.00), FX 11.5 Norges Bank, NOK 230.00 in the database.
- **Write reliability**: lost response (server commits, answer dropped → uncertain notice, retry creates no
  second purchase), process death after commit (no duplicate), background during submit (one purchase).
- **Oslo midnight**: device 00:30 and 01:30 `Europe/Oslo` while UTC is the previous day → default date and
  stored `purchased_on` are the local calendar date.
- **Performance** (3 cold starts, 100 warm analyses, 0 failures): cold first scan 2.9–3.3 s (OCR ≈ 1.0 s,
  model + index load ≈ 0.55 s); warm total median 1044 ms, p90 1222, p95 1257, p99 2075. Per stage (median):
  decode 82, blur 10, OCR 345, preprocess 189, ONNX 49, index search 304, retrieval 56, fusion 0.2 ms.
  The index search and preprocess run in JS on Hermes and are the next optimisation targets.
- **Memory** (PSS): baseline 148 MB, scanner open 148 MB, after first scan (model loaded) 373 MB, 25 / 50 /
  75 / 100 scans 384 / 407 / 355 / 356 MB, after leaving 356 MB, after 60 s 356 MB. A stable plateau
  (the model session is deliberately cached), no monotonic climb; threads 84 → 78.
- **APK size** (x86_64 only): P181 30.65 MB → P184 129.77 MB. Compressed: ONNX Runtime 39.4 MB, model 19.7,
  Skia 11.8, ML Kit OCR 11.6 + 3.7 models, index 9.7, JS +1.0, dex +1.7. A multi-ABI release is larger.
- **Build reproducibility**: clean `pnpm install --frozen-lockfile` → `expo prebuild --clean` → release build:
  one Gradle pass, 4 min 39 s, no junction, no `subst` drive; 707 unit tests green on that tree.
- **Backend / DB**: 107 migrations; fresh reset + full `pnpm test:db` with Edge Runtime **745 passed, 1
  skipped, 0 failed**; grant audit OK; read-only finance diagnostics run; native backend 43 passed (17
  skipped). Web: typecheck, lint, format, 1680 unit tests, build, 58 scanner/browser specs green.

## Build workarounds (P182 → reviewed by P184)

| # | Workaround | Class | P184 finding |
|---|---|---|---|
| 1 | `patches/onnxruntime-react-native.patch` (Gradle 9 `VersionNumber`) | `UPSTREAM_BUG` + `REQUIRED_STABLE_WORKAROUND` | Applied by pnpm on every install; drop when upstream is Gradle-9-clean |
| 2 | `plugins/with-short-cxx-build-path.js` | `TEMPORARY_BUILD_MACHINE_WORKAROUND` (Windows) | Was one shared `~/.p182-cxx-build` for every checkout; now a per-project hashed directory under `os.homedir()`; unit-tested |
| 3 | `node_modules` junction | `LOCAL_MACHINE_ONLY` + `SHOULD_BE_REMOVED` | Never committed; not needed with Windows long paths |
| 4 | `install-skia-android-libs.mjs` postinstall | `SHOULD_BE_REMOVED` — **removed** | Skia's own `install-libs.js` completes on a clean install |
| 5 | Skia deep imports in `image-decode.ts` | `UPSTREAM_BUG` + `REQUIRED_STABLE_WORKAROUND` | Skia pinned exactly (`2.6.2`); the build fails loudly if a path moves |
| 6 | `plugins/with-onnxruntime-package.js` (manual `ReactPackage`) | `UPSTREAM_BUG` (cause not proven) + `REQUIRED_STABLE_WORKAROUND` | Likely the package's legacy `unimodule.json`; now a pure, idempotent, tested transform |

Licences: ML Kit text-recognition wrapper, onnxruntime-react-native, Skia, expo-asset/crypto/image-manipulator
are MIT (the bundled Google ML Kit runtime has its own terms).

## Not verified / disclosed

- **Full RC journey**: 10 of 16 steps passed (cold dark launch, sign-in, Collection, scanner, recognition,
  candidate review, confirmation, printing, Price Check, Profile, sign-out, restart); the steps after the
  Price Check "return" failed on driver navigation and an adb daemon crash, not on an observed app fault.
  Add acquisition and EUR purchase are proven separately in the flow driver; manual valuation and sale were
  not re-run in P184 (proven in P177/P180).
- **Accessibility**: at 430 dp / 100 % every scanner-path screen passes (touch targets, labels, confidence in
  words, printing stated in words, dark surface). At 360 dp / 200 % the idle and card screens pass; the
  result and review checks only fail the heading/badge text lookup after scrolling (touch targets pass).
  **TalkBack itself was not driven.**
- Strong-visual disagreement scenarios need real artwork; covered at pipeline level with the real engine.
  Real artwork used for evidence is a local cache from an earlier phase, never committed.
- x86_64 emulator only; no arm64 device, iOS or physical phone. The proof build contains a proof panel and
  trace (`EXPO_PUBLIC_RUNTIME_PROOF=1`); a normal build contains neither.
- Real card OCR quality beyond 6 vintage Base Set photos is untested; modern layouts rely on the same
  `N/M` token rule.
