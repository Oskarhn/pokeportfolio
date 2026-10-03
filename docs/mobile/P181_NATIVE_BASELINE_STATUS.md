# P181 Native Baseline Status (proposed)

This is a proposed status update from P181's own session. It does not modify P176's documentation
branch directly — a later docs-sync should fold whatever of this is still current into the
canonical mobile docs.

## Current SHA

- Base: P180 `FINAL_SHA` `ecdb120863f0d8478ed69216cb64272b734de2a7`
- Branch: `feat/p181-native-device-accessibility-performance-gate`
- P181 commits: own stack/build scripts + 8 new regression mutants (P37-P44), then the tab-label
  fix. See `ai_outputs/Claude_outputs/output_181.txt` for the exact final SHA.

## Device coverage this session (representative, not exhaustive)

Real release APK, Pixel 7 profile, API 36 emulator, own AVD `p181_api36`, own backend stack
(API 55721). Verified on-device:

- Cold launch: clean dark Sign-in screen, no white flash, Hermes proof 61/61.
- Sign-in (session B, 40 holdings, 133-card synthetic catalog) -> Collection -> Card detail ->
  Manual valuation, at 360dp/100%, 360dp/200%, 390dp/light, 430dp/100%.
- Money stress: the mission's largest specified amount (90 071 992 547 409.93) entered, saved, and
  rendered exactly ("90 071 992 547 409,93 kr" and the x7 total "630 503 947 831 869,51 kr") at
  360dp width and 200% font scale — no truncation, no ellipsis, correct grouping.
- Record sale's keyboard flow at 360dp: focused field stays visible above the keyboard
  (`KeyboardAvoidingView` in `TaskScreen` confirmed working).
- Activity recreation via two font-scale changes: same process PID before/after, no crash, no ANR.
- Light theme smoke pass: app stays dark regardless of system theme (`userInterfaceStyle: "dark"`
  in app.json — a deliberate P178 decision, not a bug; no light theme is reachable from system
  settings).
- One performance snapshot on Collection after scrolling: p50/p90/p95/p99 = 17/18/18/18ms,
  6.98% janky frames (typical for an x86_64 emulator), zero missed-vsync frames >100ms.
- One memory snapshot: TOTAL PSS ~117MB after scrolling (Native Heap + Dalvik Heap breakdown in
  `output_181.txt`).
- Full logcat sweep for the session: zero ANRs, zero FATAL EXCEPTIONs, zero native crashes.

NOT covered this session (disclosed gaps, not silently skipped): the full 6-combo x 16-screen
matrix, TalkBack (real or accessibility-tree proxy) beyond the existing unit-level source-scan
guards, a full keyboard pass on Login/Purchase/Acquisition (only Sale and Manual valuation were
device-driven), the multi-stage PSS/memory-leak sweep (launch -> scroll -> 20 nav cycles -> Price
Check -> 20 form cycles -> recreation -> leaving screens), and Docker cleanup verification beyond
this session's own stack.

## Design status

Foil identity (graphite background, brass/gold accent, compact native layouts, no generic white
cards) holds up across every combo captured this session, including at 200% font scale and both
360dp and 430dp widths. No erosion found. See `docs/mobile/p181-review/gallery.html`.

## Real defect found and fixed this session

`MainNavigator.tsx`'s `TabLabel` used `numberOfLines={2}`, which forced a single-word label
("Collection", "Profile") to break mid-word ("Collectio"/"n") at 200% font scale instead of
wrapping at a space (there is no space to wrap at). Fixed by switching to `numberOfLines={1}` +
`adjustsFontSizeToFit` + a `0.6` minimum font scale — the same shrink-to-fit pattern `MoneyText`
already uses elsewhere in this codebase. Before/after screenshots in the gallery. Regression test:
`tests/unit/p167-dark-theme.test.tsx` (updated selector) plus the existing full-app touch-target
sweep in `tests/unit/p170-integration.test.tsx`.

## Known remaining gaps for whoever picks this up next

1. The Oslo-midnight clock-manipulation scenario (P180's own disclosed gap) is still not run.
2. TalkBack itself (not just the accessibility-tree proxy) was not attempted this session.
3. Login, Purchase and Acquisition's keyboard flows were not individually device-driven (Sale and
   Manual valuation were); their `TaskScreen` composition is shared and source-guarded
   (`tests/unit/p181-device-accessibility-contracts.test.tsx` mutant P43), but that is a proxy, not
   a device observation of those three specific screens.
4. No screenshot was taken at 390dp/1.3/dark or 430dp/200%/dark specifically (360dp/200%, 430dp/
   100%, and 390dp/light were the combos actually driven).
5. The full memory-leak sweep (PSS at each of the mission's 7 checkpoints) was not run — one
   snapshot only.
