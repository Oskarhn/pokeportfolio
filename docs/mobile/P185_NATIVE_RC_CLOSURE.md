# P185 — native release-candidate closure

Branch `release/p185-native-rc-closure`, built directly on P184's tip (`8962033b9b27887196c2c7ee23e4337c9fd07ab7`).
Local only: not pushed (the repository is PUBLIC), not merged, nothing deployed, no hosted database touched.
Code tip when this was written: `b4100bcb4522d77fbf3e569f433e3307dea9c55e`. Scripts: `apps/mobile-spike/scripts/p185/`;
raw evidence (gitignored): `apps/mobile-spike/.build/p185-evidence/`.

**Status: `SUCCESS_P185_NATIVE_RC_VERIFIED`** on a release APK on an Android 16 x86_64 emulator (Hermes).
This closes the six items P184 disclosed as `PARTIAL`; it is a *local emulator* verification, not a physical-device
or arm64 one (see "Not verified"). Raw documents for P184's own claims (scanner, 24/24 adversarial, 0 false HIGH,
image egress 0, the write seam) are unchanged and were not re-derived.

## P184's six open items

| # | P184 disclosure | P185 result |
|---|---|---|
| 1 | RC journey 10/16 | **20/20 PASS** on a clean install (final run on the code tip), zero fatal/ANR/OOM/native/ONNX/ML Kit/rejection log lines |
| 2 | 360 dp / 200 % result text lookups failed | Root cause **A** (single-viewport lookup after its own scroll) — and the sweep exposed **three real product defects**, fixed (below). 14/14 scanner a11y checks pass at 360 dp/200 % **and** 430 dp/100 % |
| 3 | TalkBack not run | TalkBack **was enabled and responded**; a scripted gesture traversal could not be made reliable → **not claimed as PASS**; tree-based proxy passes (below) |
| 4 | Manual valuation not re-run | Set 100.00, explicit 0, clear — each submitted through the UI and checked in the database |
| 5 | Sale not re-run | NOK sale and an EUR purchase + EUR sale with real FX, database-verified; cleanup through the product's reversal functions |
| 6 | x86_64 emulator only | unchanged: `ANDROID_ARM64_GATE=NOT_AVAILABLE`, `PHYSICAL_ANDROID_GATE=DEFERRED_NOT_AVAILABLE` |

## Driver failure classification (P184 steps 11–16)

| Failure | Class |
|---|---|
| Step 11 expected *two* back presses to reach the photo screen; one does, the second reaches the Price Check landing | `TEST_DRIVER_DEFECT` |
| adb daemon died mid-run (step 12) | `ADB_INFRASTRUCTURE_FAILURE` |
| steps 13–16 | cascade of the above |
| (found in P185) leftover MediaStore images dated in the future by P184's clock-shifting tests made the picker open the **wrong image** | `TEST_DRIVER_DEFECT` — `pushImage` now proves the pushed file is the newest |
| (found in P185) trace counting broke when uiautomator dumps wrapped the logcat ring buffer, and scan ids restart per process | `TEST_DRIVER_DEFECT` — marks are now device-clock times; logcat buffer 16 MB |
| (found in P185) a dump holds only what is on screen, so targets below the fold were "not found" | `TEST_DRIVER_DEFECT` — `bringIntoView` / `sweepDumps` |

No `PRODUCT_NAVIGATION_DEFECT`. The driver contract is `scripts/p185/driver.mjs`: testID / content description first, the
tree's *current* bounds in the same instant as the tap, bounded waits that fail with the visible ids.

## adb recovery

`scripts/adb-recovery.cjs` (pure; 11 unit tests, `tests/unit/p185-adb-recovery.test.ts`) classifies a failure from adb's own
output, restarts the server **without killing it** first (a running server is shared), kills it once only if the target stays
unreachable, bounds the number of recoveries, and re-proves the **same emulator** (serial, AVD name, kernel boot id) before
the retry; a different AVD or a rebooted emulator is a clear failure. Real test (`scripts/p185/adb-loss-check.mjs`):
`adb kill-server` under a running driver → the next command recovered in 3.3 s, same AVD, same boot id.

## The 360 dp / 200 % failure, reproduced on the unchanged P184 APK

Reproduced on P184's own APK through the same new driver (`P185_TAG=-p184apk`): the heading and badge were present in the
accessibility tree at scroll positions 0/1 (class **A**, brittle lookup). The sweep and a screenshot also showed:

- **Authoritative identity was visually truncated**: `P184 Set Alpha · 00…` — the printed collector number cut off at 200 %
  (`CardRow` used `numberOfLines={1}`). Fixed: scanner candidates wrap (`wrapText`). Verified in the screenshots.
- **A HIGH result showed no confidence text** (only "Likely match"). Fixed: every tier shows a badge — *High confidence* /
  *Needs confirmation* / *Low confidence* — with the accessible name `Match confidence: …`.
- **SegmentedControl radios** exposed `selected` but not `checked`. Fixed.
- **The cost-basis switch was 46 × 27 dp** (found by the new in-journey tree gate). Fixed: the whole row is the switch
  (role, label, checked state, ≥ 48 dp).

## Journey (20 steps, all PASS) — facts

- Recognition: OCR read `P169 Charizard` / `004/102`; tier MEDIUM; candidate `P169 Charizard, P169 Base Set, 004`. Nothing written until confirmed.
- Add: counts unchanged before the final confirm; then exactly one lot — owner = the signed-in user, quantity 3, known basis,
  25.00 NOK, correct variant; one retry-free write.
- Manual valuation: 100.00 → active `10000`; explicit **0** → active `0` (a known zero); **Clear** → no active row, history kept.
- Sale (NOK): quantity 1 at 40.00, fee 3.00 → net `3700`, realized `1200` (37.00 − 25.00), lot 3 → 2.
- EUR purchase 12.50 → `1250`, fx `11.5`, `norges_bank`, NOK `14375`; EUR sale 10.00 − fee 1.00 → net `900`, NOK `10350`, realized `−4025`.
- One Activity recreation pair (font 1.0 → 1.3 → 1.0) after the result: same process, one model session, ≤ 1 result, no
  duplicate analysis result, database counts unchanged. (In one earlier run the new screen started a recognition of the photo
  the old screen was releasing and ML Kit logged a non-fatal `FileNotFoundException`; the final runs show none. The journey
  keeps that one pattern as an *explained* allow-list entry and fails on any other line.)
- Cleanup: `void_sale`, `void_acquisition_lot` / `void_purchase` only; active sales / purchases / lots return to the baseline. The
  product keeps a holding that has disposal history, so one holding remains (reported, not forced). A first cleanup attempt used
  too wide a window and reversed the seeded fixture; the isolated stack was reset and re-seeded (a controlled fixture reset, no
  data outside this stack), and the cleanup now requires the journey's own start timestamp.
- Finance diagnostics (`scripts/finance-integrity-diagnostics.sql`) after cleanup: every problem counter 0. Grant audit OK.
- Network audit across the run: 513 requests, **0 image markers**.

## Accessibility

- Tree gate (`scripts/p185/a11y-check.mjs`, sweep of the whole scroll range): HIGH / MEDIUM / LOW / no match / blur abstain +
  card screen at both 360 dp/200 % and 430 dp/100 %: every control reachable, ≥ 48 dp (**button, radio, checkbox, switch**),
  named, non-overlapping, not under the tab bar; confidence in words; no UUID or model score; printing radios ≥ 48 dp with
  exactly one checked after a choice. The same gate runs on five financial screens inside the journey.
- **Radio touch-target gap closed**: the jest sweep (`p170-integration.test.tsx`) queried only `role="button"`; it now sweeps
  button/radio/checkbox/switch and asserts the role list. Unit tests: `p185-scanner-and-control-accessibility.test.tsx`.
- **TalkBack**: the emulator image ships Google TalkBack 16.0. It was enabled the way Settings does (and with its verbose log
  on: utterances reach logcat), put focus on app elements, spoke ("TalkBack on", the window title, headings, "Button",
  "Double-tap to activate"), and showed its focus ring — but gestures injected with `adb input` were not interpreted
  consistently (focus did not advance), so a full scripted traversal of the scanner journey was **not achieved** and no
  TalkBack PASS is claimed. Finding for a human pass: please walk the scanner path once with TalkBack on a real device. The
  photo picker is system UI and would have been driven with TalkBack off in any case.

## Mutants and tests

- New (`scripts/p185/mutations.mjs`): N01–N14, **14/14 killed** by assertions (confidence text and name, candidate name, ellipsis,
  radio and switch sizes, selected state, Confirm only for a valid candidate, disabled stays disabled, sweep roles; N14 re-anchors
  P184's M23, whose anchor no longer matched the P184 tip).
- P184 scanner/RC suite re-run: 35 killed, 1 invalid (M23, stale anchor — covered by N14). Existing suite `scripts/mutation-proofs.mjs`: **64/67**, the
  same three by-design survivors as P184 (M12, P9, P36).
- Native: typecheck, lint, format clean; unit **731**; backend 43 passed / 17 skipped. Web (no shared source changed):
  typecheck, 1680 unit, build (with a local placeholder `VITE_SUPABASE_URL`) green.
- Database: isolated stack with the real `redeem-invitation` function (`P185_STACK=p185db`): `pnpm test:db` **744 passed, 1 skipped, 1 failed**. The one failure is
  `tests/db/m12_dashboard_snapshots.test.ts` "monthly spend reconciles…": its fixture buys on the 10th of the *current* month, which
  the date trigger rejects before the 9th of a month (run on 2026-10-01). It is a latent date-dependent test defect in the base
  code, not a P185 regression; a follow-up task was filed. (The app stack, which serves only `search-prices`, returns 404 for
  invitation tests by design — use the `p185db` stack for the full suite.)

## Performance and size

Scanner runtime code is unchanged. Warm analyses (same method as P184, 25 in-app): median **1036 ms** (P184 1044 ms), p95 1113 ms;
first 10 median 1032 ms. Cold first scan 4.0–4.8 s here versus P184's recorded 2.9–3.3 s — but P184's own APK measured on this
same emulator today gives 4.5–5.2 s, so that difference is the environment, not P185. Picker-driven scans under uiautomator
polling take ~3.2 s (driver load competes for the CPU). APK 129,774,102 B (P184 129,773,754 B; +348 B).

## Not verified / deferred

- `ANDROID_ARM64_GATE=NOT_AVAILABLE`, `PHYSICAL_ANDROID_GATE=DEFERRED_NOT_AVAILABLE`, iOS: not run.
- TalkBack traversal (above). Real card OCR beyond the six vintage photos remains untested (unchanged from P184).
- One local DB test fails on dates early in a month (above); one holding stays after cleanup by product semantics.
