# P186 — Android packaging, scanner latency and release quality

Branch `perf/p186-native-packaging-scanner`, built directly on P185's tip
(`a68546dddb0f833adb6e651f97b3c7c267fc1de2`). Local only: not pushed (the repository is PUBLIC), not merged,
nothing deployed, no hosted database touched. Scripts: `apps/mobile-spike/scripts/p186/`; raw evidence
(gitignored): `apps/mobile-spike/.build/p186-evidence/` and `.build/p186-artifacts/`.

**Status: `SUCCESS_P186_ANDROID_RELEASE_OPTIMIZED`** on an Android 16 x86_64 emulator (Hermes). No scanner
policy, threshold, model, index or product semantic changed; this phase is packaging, one prewarm and one
test fixture. arm64 packaging is proven **statically only** (`ARM64_PACKAGE_PRESENT`); no arm64 runtime
exists on this machine.

## Result in one table

| | P185 / baseline (rebuilt today) | P186 |
|---|---|---|
| Proof APK, x86_64 (comparable to P185's 129,774,102 B) | 129,774,086 B | **121,113,601 B** (−8,660,485 B, −6.7 %) |
| Android App Bundle (arm64-v8a + x86_64) | 150,800,532 B (R8 off, with the same ABIs) | **145,701,566 B** (−5.1 MB; 47.85 MB of the file is Play-only symbol tables, not delivered) |
| Delivered to an arm64 phone (bundletool, compressed) | 72,257,219 B | **63,863,402 B** (−11.6 %) |
| Delivered to an x86_64 device | 74,658,413 B | **66,264,576 B** (−11.2 %) |
| Cold photo → result (10 cold process starts, median / p95) | 3,598 / 4,624 ms | **2,347 / 2,858 ms** (−35 % / −38 %) |
| …of which waiting for the model session (median) | 713 ms | **0.2 ms** |
| Warm photo → result (100 analyses, two interleaved runs each, median / p95) | 1,066 · 1,004 / 1,264 · 1,234 ms | 1,026 · 1,009 / 1,305 · 1,227 ms (no change beyond run-to-run noise) |
| Adversarial suite / false HIGH / image egress | (P184/P185) 24/24, 0, 0 | **24/24, 0, 0** |
| `tests/db` | 744 passed, 1 skipped, **1 failed** (P185) | **771 passed, 1 skipped, 0 failed** |

The 129.8 MB emulator APK is **not** what a Play user downloads. The same code as an App Bundle delivers
about 72 MB to an arm64 phone (see "AAB versus APK").

## 1. Baseline reproduction (before any change)

P185 unchanged, from a clean generated-native state (`pnpm install --frozen-lockfile` for the root and the app,
scanner assets staged from the verified local copy and re-checked against the pinned hashes, `expo prebuild
--clean`, one Gradle pass from the real path):

- proof APK x86_64: **129,774,086 B** (P185: 129,774,102 B, −16 B), 306 s, **no `subst` drive, no junction**;
- cold first scan, 10 cold process starts: median **3,598 ms**, p95 4,624 ms (P185 recorded 4.0–4.8 s for its
  first scan; the same band);
- warm, 100 in-app analyses: median **1,002 ms**, p95 1,098 ms (P185: 1,036 / 1,113);
- PSS: app 130 MB → scanner open 131 → result shown 352 → left 290 → +60 s 290.

The environment differs from P185 only by day-to-day emulator state; the figures agree with P185's, so none of
the change below is attributed to variance.

## 2. AAB versus APK

`bundleRelease` (R8 off, P185 code plus the CMake-path fix of §5 without which arm64 does not build on this machine, arm64-v8a + x86_64): **150,800,532 B**. What it contains is not what a
device receives:

| Artifact | Bytes |
|---|---|
| AAB file (baseline) | 150,800,532 |
| …of which Play-only native symbol tables (`BUNDLE-METADATA/…debugsymbols`, 24 files) | 47.85 MB compressed / 142.4 MB raw |
| Universal APK from that AAB (every ABI) | 203,163,795 |
| Delivered to arm64-v8a (bundletool `get-size total`, compressed) | 72,257,219 |
| Delivered to x86_64 | 74,658,413 |
| Split APKs installed on an arm64 phone, raw | 138,328,652 (master 64.8 MB + arm64 libs 73.3 MB + config splits) |

Why 129.8 → ~72: (1) one ABI instead of all; (2) densities and languages are config splits (Android resources
10.3 MB compressed in the APK → 0.6 MB in the AAB); (3) native libraries are **stored uncompressed** in an APK
(page-aligned, `extractNativeLibs=false`) but travel compressed, so ONNX Runtime is 33 MB raw → 12.5 MB sent.
The native symbol tables are for crash symbolication in Play and are never delivered; they are kept (they cost no
user bytes and make native ONNX/Skia/ML Kit crashes readable) — `ndk.debugSymbolLevel` would remove 48 MB of the
file if upload size ever mattered.

Tooling: official bundletool 1.18.1 (`bundletool-all-1.18.1.jar` from the `google/bundletool` GitHub release,
SHA-256 `675786493983787ffa11550bdb7c0715679a44e1643f3ff980a529e9c822595c`; not committed; point
`BUNDLETOOL_JAR` at it). `scripts/p186/aab-analysis.mjs` produces the table; `scripts/p186/package-inventory.mjs`
reads any APK/AAB (pure Node).

## 3. Size table (arm64-v8a delivery, baseline AAB)

| Component | Compressed | Raw | Required | ABI-specific | Opportunity |
|---|---:|---:|---|---|---|
| Scanner model (DINOv2 small, int8 ONNX) | 19.68 MB | 24.45 MB | yes (pinned, quantized) | no | none: do not swap or shrink |
| ONNX Runtime (`libonnxruntime.so` + JSI) | 12.52 MB | 33.35 MB | yes | yes | a reduced-operator build (future, see below) |
| DEX | 9.75 MB | 27.0 MB | yes | no | **R8: → 3.8 MB (done)** |
| Visual index (embeddings, 19,500 cards) | 9.73 MB | 14.98 MB | yes | no | none |
| Skia (`librnskia.so`) | 4.65 MB | 11.31 MB | yes (decode, resize) | yes | — |
| ML Kit OCR native pipeline | 4.41 MB | 11.06 MB | yes | yes | — |
| React Native core (7 libs) | 3.49 MB | 11.09 MB | yes | yes | — |
| ML Kit models/assets | 3.46 MB | 5.40 MB | Latin only | no | **−2.4 MB: four unused script packages (done)** |
| JS bundle (Hermes bytecode) | 1.56 MB | 3.37 MB | yes | no | — |
| Other native / Hermes / resources / manifest | ≈ 3.7 MB | | yes | partly | — |
| **Total delivered** | **72.90 MB** | | | | |

**After P186** (final AAB, arm64-v8a): our inventory 64.55 MB compressed, bundletool's estimate **63.86 MB**
(was 72.90 / 72.26 MB). The two changes: DEX 9.75 → 3.83 MB (R8), ML Kit assets 3.46 → 1.05 MB (four unused
script packages); everything else is byte-identical (the model, index and every native library). Split APKs on an
arm64 phone, raw: 118,233,897 B (was 138,328,652); universal APK 194,550,640 B (was 203,163,795).

Sizes of the shipped pieces (bytes): model `24,451,943`, index `14,976,000` (+ `760,501` card ids, 899 manifest);
ONNX Runtime `.so` arm64 `32,990,472` / x86_64 `39,348,480`; ML Kit pipeline `.so` arm64 `11,064,544`; Skia
`.so` arm64 `11,305,168`.

## 4. Inventory — duplicates and waste

Searched the baseline AAB and APK for each item the brief named. Findings:

| Item | Result |
|---|---|
| duplicated ONNX model / embeddings | **none**: one `.onnx` and one `.bin` in `res/raw` (the APK renames them `res/dU.onnx`, `res/pk.bin`) |
| stale scanner generation / second model | none (one generation `f25fc05d569b7cca`) |
| packaged test fixtures, P182/P184 evidence | none (no `tests/`, no screenshots, no `.p184-scratch`) |
| source maps | none in the bundle or the APK (the sourcemap stays in Gradle intermediates) |
| debug symbols | **yes, Play-only** native symbol tables in `BUNDLE-METADATA` (kept, see §2) |
| ABI duplication | the template builds armeabi-v7a + x86 too; **now excluded** (§5) |
| unused Skia libraries | one `librnskia.so` per ABI; nothing else |
| unused ML Kit script recognizers | **Chinese, Devanagari, Japanese, Korean**: the wrapper packages all five; the only call is `TextRecognition.recognize(path, LATIN)` (a test scans the sources and pins this) → excluded |

Nothing was removed on size alone. Proven unused, then removed: two ABIs, four OCR script packages. The model,
index and every runtime library are required.

## 5. ABI strategy

`plugins/with-release-packaging.js` sets `reactNativeArchitectures=arm64-v8a,x86_64`. The proof/emulator builds
still override it on the command line (`-PreactNativeArchitectures=x86_64`). Release bundle ABIs
(`scripts/p186/package-inventory.mjs --check-abis arm64-v8a,x86_64`):

- `AAB_ARM64_PRESENT = yes` — 21 native libraries for every scanner dependency (ONNX Runtime, Skia, ML Kit,
  Hermes, React Native). **`ARM64_PACKAGE_PRESENT`: a static proof of what is packaged, not a runtime claim.**
- `AAB_X86_64_PRESENT = yes` (emulator / development).
- armeabi-v7a and x86 are absent on purpose: the scanner holds a ~300 MB model session, which a 32-bit-only phone
  cannot carry, and each extra ABI adds ~25–30 MB compressed to the bundle.
- Nothing is hard-coded to x86_64.

**Found on the way (`WINDOWS_PATH_WORKAROUNDS` matters for arm64):** the first arm64-v8a build failed in
`onnxruntime-react-native`'s own CMake target (`ninja: error: mkdir(CMakeFiles/onnxruntimejsi.dir/C_/Users/…/node_modules):
No such file or directory`): the object path exceeded Windows' 260 characters. x86_64 passes only because
`x86_64` is three characters shorter than `arm64-v8a`. `with-short-cxx-build-path.js` already redirected the **app**
module's `.cxx` directory; it now also gives every Android library module that declares a CMake build its own
short staging directory under the same per-project hash. Verified: the arm64 bundle builds in one Gradle pass
from the real path.

## 6. Model and index packaging

Measured, not assumed (final proof build, 10 cold starts):

| | Value |
|---|---|
| model in the package | deflated, 24.45 MB → 19.68 MB |
| index in the package | deflated, 14.98 MB → 9.73 MB |
| materialised copy on first run (`expo-asset` → app cache) | 24,451,943 + 14,976,000 B = **39.4 MB of cache** (the "temporary duplicate": the package copy plus this) |
| `loadScannerAssets` (copy + SHA-256 of both files + manifest) | 271–530 ms, i.e. 60 % of the 450–765 ms session creation |
| integrity | both files are hashed against the manifest's pinned SHA-256 on every process start; a mismatch refuses to start the scanner and nothing falls back |

Options evaluated (A and B measured on x86_64 proof builds, 8 cold starts each, same emulator, back to back):

| | A: bundled, **un**compressed (`noCompress 'onnx','bin'`) | B: bundled, compressed (shipped) | C: first-run extraction |
|---|---:|---:|---|
| x86_64 APK | 131,141,853 B | **121,113,601 B** | (already how B and A reach the app: `expo-asset` copies the bundled file into the cache once) |
| delta | +10,028,252 B (+8.3 %) | — | + 39.4 MB cache either way |
| `loadScannerAssets` median | 273 ms | 368 ms | — |
| session creation median | 488 ms | 546 ms | — |
| prewarm duration median | 666 ms | 741 ms | — |
| photo → result median | 2,447 ms | 2,354 ms | — |

A saves ~95 ms of inflate work, which already happens **inside the prewarm window** (before the photo), so the
post-photo wait does not move (2,447 vs 2,354 ms: noise), while the package grows by 10 MB and the install
footprint by the same (the APK stays on the device; Play compresses the transfer either way). A is rejected.
C is not a separate choice here: the package always has to be read into a file for ONNX Runtime (which takes a
path), and the integrity check hashes that file on every process start.

Decision: **keep the model and index bundled and compressed (`B`), materialised once into the cache by the
existing path (`C`).** Remote delivery is **not** implemented (it would give up the offline, pinned,
hash-verified design; the compelling future option is documented under "Not implemented").

## 7. R8 and resource shrinking

| | Before | After |
|---|---|---|
| `minifyEnabled` (R8) | **off** (Expo template default) | on |
| `shrinkResources` | off | on |
| DEX | 3 files, 27.0 MB raw / 9.75 MB compressed | 2 files, 9.5 MB raw / 3.83 MB compressed |
| x86_64 proof APK | 129,774,086 B | 123,541,748 B (R8 alone), then 121,113,601 B with the ML Kit exclusion |

Keep rules (`plugins/with-release-packaging.js`): `ai.onnxruntime.**`, `com.microsoft.onnxruntime.**` (JNI/React
Native binding), `com.shopify.reactnative.skia.**`, `com.rnmlkit.**`, `com.google.mlkit.vision.text.**`; plus
`-dontwarn` for the four excluded script packages the wrapper still names. **"The build passed" proved nothing:**
the release build was then driven on the device — real on-device OCR, ONNX inference and Skia decode through the
whole adversarial suite and the release smoke — with no `NoClassDefFoundError`, no ONNX/ML Kit error and no
fatal/ANR in logcat (§12).

## 8. Perceived cold-scan latency — the prewarm

Cold photo → result was 3.2–4.6 s (median 3.6 s). Per-stage, cold versus warm:

| Stage | Cold (baseline) | Warm |
|---|---:|---:|
| model session (asset load + ONNX create) | 550–750 ms | 0 |
| OCR (first ML Kit call in the process) | 860–1,120 ms | ~345 ms |
| decode (first Skia decode) | 400–810 ms | ~82 ms |
| retrieval (first catalog query, cold connection) | 640–1,040 ms | ~56 ms |

The person spends seconds choosing or taking a photo (20 s in the device driver). **When the photo screen
becomes the screen being looked at**, the port starts, in parallel, the model session and the OCR engine (a
recognition of a synthetic 64 × 64 white PNG, 98 bytes, no card data) and then decodes the same blank. Never at
app launch (the only trigger is the screen's focus; a test pins it), never a second model session (the prewarm
and a scan share the adapter's one pending promise; a photo chosen before it finishes awaits the same one).
Network retrieval is **not** prewarmed (it would be a request at screen entry; left alone).

| Photo → result, 10 cold starts | Baseline | P186 |
|---|---:|---:|
| median | 3,598 ms | **2,347 ms** |
| p95 | 4,624 ms | **2,858 ms** |
| min / max | 3,193 / 4,624 | 2,253 / 2,858 |
| model-session wait (median / max) | 713 / 1,518 ms | **0.2 / 0.9 ms** |
| OCR stage (median) | ~1,060 ms | ~580 ms |
| decode stage (median) | ~580 ms | ~245 ms |
| prewarm duration (screen entry → ready) | n/a | 644–964 ms |

What remains cold is the network retrieval (730–1,070 ms) and the first JS index search (~410 ms).

Warm analyses are unaffected by design (same code after the first scan), and that was checked rather than
assumed: the baseline and the P186 APK were installed alternately on the same emulator (A B A B), each running
the proof panel's 100 back-to-back analyses of one photo.

| 100 warm analyses | median | p90 | p95 | max | PSS after |
|---|---:|---:|---:|---:|---:|
| baseline, run 1 | 1,066 ms | 1,199 | 1,264 | 1,821 | 344 MB |
| P186, run 1 | 1,026 ms | 1,180 | 1,305 | 2,050 | 372 MB |
| baseline, run 2 | 1,004 ms | 1,126 | 1,234 | 1,867 | 360 MB |
| P186, run 2 | 1,009 ms | 1,125 | 1,227 | 2,023 | 352 MB |

Mean of the two medians 1,035 → 1,017 ms (−1.7 %), of the p95s 1,249 → 1,266 ms (+1.4 %); the spread between two
runs of the *same* APK (62 ms in the median) is larger than the difference. P184 recorded 1,044 ms and P185
1,036 ms. No regression.

## 9. Model session cache and memory

`≤ 1` active ONNX session is now observable: every session trace event carries `active`, and a unit test runs the
real adapter over a fake runtime (concurrent prewarm + scan callers → exactly one creation; a failed creation is
not cached; dispose is idempotent and the active count never goes negative).

**Memory attribution** (PSS, MB, scanner screen entered, no photo, 12 s settle; experiment builds that each start
one prewarm component, `scripts/p186/mem-attribution.mjs`):

| Starts | Total PSS | Native heap | Δ vs. nothing |
|---|---:|---:|---:|
| nothing (screen entered) | 126 | 30 | — |
| assets only (verified model + index in memory) | 178 | 68 | **+52** |
| model session (assets + ONNX) | 225 | 104 | **+99** (+47 over assets) |
| OCR engine (ML Kit) | 157 | 47 | **+31** |
| image decoder | 134 | 36 | **+8** |

Phases of the final build (PSS MB; two reads a few seconds apart can differ by ~25 MB with garbage-collection
timing, so ranges are given): app baseline 119–122 → scanner entered, prewarm done 242–269 → first result shown
299–302 → left immediately 299–300 → +60 s 299 → after 100 warm analyses 352–372 (P184's recorded plateau 356,
band 355–407; baseline in the same A B A B runs 344–360). The baseline build went 130 → 131 → 352 → 290 → 290: the
prewarm moves the load to the moment the screen opens, and the first result peaks lower (≈300 vs 352).

**Idle unload: measured and not shipped.** A first version of this phase released the session 180 s after the
scanner screen was left (with a deferral while a scan ran, and re-creation on re-entry). On the device it
reclaimed **19 of 277 MB (7 %)**: the retained memory is the verified assets (52 MB of JS-side buffers), the OCR
engine (31 MB) and allocator retention, not the ONNX working set. That is too little for the machinery, the
reload and the thrash risk, so the code was removed; the model stays cached for the process lifetime exactly as
in P185, and the port has no unload path (a test pins it). The honest cost of the prewarm is that a person who
opens the scanner and leaves now carries ~110 MB more than before until the app is closed; a person who scans
carries the same plateau as P185.

## 10. Accuracy and privacy regression (release build with R8, prewarm on)

`scripts/p186/scenario-eval.mjs` (P184's policy, thresholds untouched; 18 synthetic fixtures + 6 local-only
real-artwork photos, never committed): **24/24** policy checks pass, **0 false HIGH**, both controlled positives
HIGH for the right card (`f01-clean`, `real-base1-1`; also HIGH and correct: `real-base1-4` Charizard,
`real-base1-58` Pikachu), the unknown-card, severe-blur, non-card, same-art-reprint, duplicate-number and
OCR-versus-visual fixtures never HIGH. **`IMAGE_EGRESS = 0`**: 46 requests audited by the capture proxy, 0 image
markers, largest body 109 bytes.

## 11. The date-dependent database test

`tests/db/m12_dashboard_snapshots.test.ts` "monthly spend reconciles GPO = CS + HS" built its purchases on **the
10th of the current month**. The purchase-date trigger rejects a business date after today + 1 day, so the test
fails on days 1–8 of every month (reproduced today, 2026-10-01: `purchases.purchased_on 2026-10-10 is outside the
supported range 1996-10-20 to 2026-10-02`). A test defect, not a product defect; no policy or formula changed.

Fix: `tests/db/lib/fixture-dates.ts` `monthlyFixtureDate(now, monthsAgo)` builds the date from year/month
arithmetic (`Date.UTC`, so a negative month rolls the year and no day overflows: "31 March minus one month" is
10 February, not 3 March) — day **1** for the current month (always ≤ today), day **10** for earlier months. The
real database trigger runs unmodified. 26 pure regression tests (`fixture-dates.test.ts`, also in the default
`pnpm test`) cover days 1, 2, 10, month end, 31 March/31 May, a leap day, and the year boundary; two mutants
(always-day-10; `setUTCMonth` then `setUTCDate`) are killed by them.

The previously failing test passes against the real stack; the full suite on a freshly started isolated stack
with the real `redeem-invitation` function: **53 files passed | 1 skipped; 771 passed | 1 skipped | 0 failed**
(P185: 744 + 1 skipped + 1 failed; the 26 new tests account for the rest). The suite needs `DB_URL` as well as
the API keys (`scripts/p186/run-db-suite.mjs` supplies them without printing) and a fresh database (its fixtures
use fixed local ids).

## 12. Release smoke (release build, R8, no proof panel)

Release APK (`final-release-apk.apk`, 194,433,569 B, arm64-v8a + x86_64, R8 on, **no proof panel and no trace**:
every check is the UI tree, the database or the screen), fresh app data, seeded synthetic user, emulator picks
x86_64. `node scripts/p186/smoke.mjs --install <apk>`:

| # | Step | Result |
|---|---|---|
| 1 | dark cold launch | PASS: first frame luminance 0.079, login 0.079 (dark), `am start` 430 ms |
| 2 | sign in | PASS: first page visible in 3.7 s |
| 3 | scanner entry | PASS: both photo buttons present |
| 4 | real synthetic image → on-device recognition (system picker, real OCR + ONNX + Skia) | PASS: a result with "Needs confirmation" |
| 5 | candidate | PASS: `P169 Charizard, P169 Base Set, 004`; confirming it wrote nothing |
| 6 | Price Check | PASS: raw price + NOK reference shown, ledger unchanged |
| 7 | Add to Collection | PASS: form opens, 25.00 × 3 typed, **0 rows written** |
| 8 | cancel before the write | PASS: left the flow, ledger still unchanged |
| 9 | Collection | PASS: list shown |

Logcat over the run: fatal 0, ANR 0, OutOfMemory 0, native crash 0, `NoClassDefFoundError`/`ClassNotFound`/
`NoSuchMethod` 0, ONNX/ML Kit error lines 0, crash buffer empty (two adb transport recoveries happened and were
handled by the P185 recovery layer; the same emulator was re-proved each time). The full 20-step financial
journey was not repeated: no shared write code changed.

## 12a. AAB validation (`final-release.aab`, built with the declared application id)

| Check | Result |
|---|---|
| package | `invalid.pokeportfolio.spike` — the id declared in `app.json` (the `.p186` suffix exists only so the emulator build installs beside the proof build) |
| `versionCode` / `versionName` | 1 / 0.0.0 — unchanged; no store publication; not changed because nothing needed it |
| `minSdk` / `targetSdk` | 24 / 36; `debuggable=false` |
| ABIs | arm64-v8a **and** x86_64, 21 native libraries each (`ARM64_STATIC_PACKAGE_GATE`: the bundle config splits by ABI; a device receives `base-arm64_v8a.apk`) |
| secrets | none: the exact local secret key, service-role key and JWT secret are absent from every text-bearing entry (`scripts/p186/secret-scan.mjs --stack p186`); the one match is the **publishable** key of the local stack, public by design |
| debug content | no JS source map; R8's `proguard.map` (for Play's de-obfuscation) and the native symbol tables are in `BUNDLE-METADATA` |

**Not a Play candidate, and not meant to be:** placeholder application id, a loopback cleartext network-security
config (`with-local-cleartext.js`, SPIKE_ONLY), the local backend URL baked into the bundle, signed with the
debug keystore. Found while reading the manifest and **not changed** (outside this phase): the merged manifest
declares `RECORD_AUDIO` (from `expo-image-picker`'s video capture), `SYSTEM_ALERT_WINDOW`, `USE_BIOMETRIC`/
`USE_FINGERPRINT` (from `expo-secure-store`) and `VIBRATE`; a card scanner needs none of them. The fix is one
line (`"microphonePermission": false` in the `expo-image-picker` plugin options, and `android.blockedPermissions`
for the rest) and belongs with the store-readiness phase.

## 13. Reproducible build

From a clean checkout, Windows 11 PowerShell/Git Bash, JDK 17+ (tested with 18), Android SDK + NDK, Node 24, pnpm 10:

```bash
pnpm install --frozen-lockfile                      # repository root
cd apps/mobile-spike && pnpm install --frozen-lockfile
pnpm assets:scanner                                  # stages + verifies the pinned model and the committed index
node scripts/p186/build.mjs --variant release --task both --abis arm64-v8a,x86_64    # AAB + APK, R8 on
node scripts/p186/build.mjs --variant proof   --task apk  --abis x86_64                # the emulator driver build
```

`build.mjs` writes `.env.local` (gitignored), runs `expo prebuild --clean`, sets the application id, and runs one
Gradle pass from the real path (a `subst` drive is only a fallback and is reported if used). No machine-specific
path is committed: the JDK is `P186_JAVA_HOME`/`JAVA_HOME`, the SDK `ANDROID_HOME` or the default location, the
CMake staging directory is `os.homedir()` plus a per-project hash.

| Workaround | Needed today? | Why / exact failure without it | Upstream | Removal condition |
|---|---|---|---|---|
| `node_modules` junction | **no** — removed from all notes | the builds above ran without it, from the real path | — | — |
| `subst` drive fallback | **no** (not used in any P186 build); kept as a reported fallback | CMake `CMAKE_OBJECT_PATH_MAX` on a deeper checkout | — | drop once no build needs it for a release |
| `plugins/with-short-cxx-build-path.js` | **yes** (now more than before) | arm64-v8a: `ninja: error: mkdir(…/node_modules): No such file or directory` in `onnxruntime-react-native` (path > 260 chars); app module: P182 | CMake/Ninja on Windows | checkout path short enough, or Ninja long-path support |
| `patches/onnxruntime-react-native.patch` | yes | Gradle 9 removed `org.gradle.util.VersionNumber`; the package's `android/build.gradle` calls it ("unable to resolve class") | `onnxruntime-react-native` 1.24.3 is still the latest on npm | an upstream release that is Gradle-9-clean |
| `plugins/with-onnxruntime-package.js` | yes | the package is not autolinked by the template (legacy `unimodule.json`); without registering it `InferenceSession.create` has no native module | same package | upstream autolinking works with this Expo/RN pair |
| Skia Android install script | **removed in P184** | Skia's own `install-libs.js` completes on a clean install | `@shopify/react-native-skia` pinned 2.6.2 (latest 2.14.0) | — |
| `patches/expo-modules-core@57.0.18.patch` | yes | image picker "Attempting to launch an unregistered ActivityResultLauncher" after Activity recreation (P167) | `expo-modules-core` 57.0.18 | an upstream release that re-registers launchers |

## 14. Tests, mutants and disclosures

| Gate | Result |
|---|---|
| native typecheck / lint / format | clean |
| native unit | **776 tests, 80 suites** (P185: 731 / 74): +45 tests — prewarm, session invariant, OCR/decoder warm-up, the warm-up PNG, screen hook, both packaging plugins |
| native backend (isolated stack) | 43 passed, 17 skipped (as P185) |
| `tests/db` (isolated stack, real `redeem-invitation`) | **771 passed, 1 skipped, 0 failed** |
| web: typecheck, lint, `pnpm test`, build | typecheck and lint clean (0 errors), build green; `pnpm test`: 1704 passed, **2 failed** — see below; no web source file changed |
| P186 mutants (`scripts/p186/mutations.mjs`) | **18 / 18 killed**: prewarm at launch, never entered, no session, cache bypassed, dispose not dropping / not idempotent, failed creation cached, OCR / decoder warm-up not once, corrupted warm-up PNG, non-Latin script requested, arm64 dropped, Latin recognizer excluded, ONNX keep rule removed, library staging removed, date fixture day 10, date fixture overflow. **P01 first survived** (the test waited microtasks only, so a `setTimeout(0)` start at construction slipped through); the test now also waits a real timer tick |
| P184 scanner/RC mutants (unchanged) | 35 killed, 1 invalid (M23, stale anchor at the P184 tip; covered by P185's N14) — identical to P185 |
| P185 accessibility mutants | 14 / 14 killed |
| `scripts/mutation-proofs.mjs` | 64 / 67 — the same three by-design survivors as P185 (M12, P9, P36) |

**The two web failures are not P186's.** `tests/ui/opening-draft.test.ts` "defaults to today" and "a future date is
refused" compare the product's *local* calendar date with a *UTC* date, so they fail between local midnight and
the UTC offset (00:00–02:00 in Oslo in summer). They were first seen at 01:38 local on 2026-10-02 and fail
identically on the unchanged P185 tree. A follow-up task was filed; nothing was changed here.

Other things to know:

- The first full database-suite run was started without `DB_URL` (the P132 lock tests need it) and then
  re-run on a database that already held the first run's rows (fixed local ids collide); the reported run is on a
  freshly started stack with all four variables.
- `adb root` was run once during an adversarial-suite run to look at the app cache; the driver's adb recovery
  re-proved the same emulator and the run completed (24/24).
- `scripts/p184-parity-compare.mts` was formatted (whitespace only): it made the repository's own
  `pnpm format:check` fail.
- The proof builds (`EXPO_PUBLIC_RUNTIME_PROOF=1`) are what the latency, memory and adversarial drivers need;
  the smoke and the AAB are production-shaped.
- Nothing was pushed (the repository is PUBLIC), merged or deployed; no hosted database was touched.

## Not implemented (ideas, with their trade-offs)

- **Reduced-operator ONNX Runtime build** for the one DINOv2 graph: `libonnxruntime.so` is the largest library
  (12.5 MB compressed delivered, 33 MB raw). It needs a custom build and its own numerical parity proof; not
  attempted.
- **Remote, content-addressed model and index**: would cut the download by ~29 MB but gives up the offline,
  pinned, hash-verified design; only worth it if the store size limit forces it.
- **Streaming SHA-256 of the model**: today the 24 MB file is read into a JS buffer to be hashed (the largest
  single memory item, +52 MB with the index). `expo-crypto` has no incremental digest and `expo-file-system` no
  SHA-256; a small native module, or per-chunk hashes in the manifest, would remove it.
- **Retrieval prewarm** (the cold connection, 0.7–1.0 s): a request at screen entry; deliberately not done.
- A 64-bit-only `armeabi-v7a`-free policy is a choice, easily reversed (`reactNativeArchitectures`).
- Physical arm64 device, TalkBack walk-through and iOS remain open exactly as in P185.
