# P179 — Dark-first native UI finish-gate review

Independent review of P178's dark-first native UI on a real Android 16 device (own worktree,
AVD, backend stack — `test/p179-dark-ui-finish-gate`, base `084c7478` = P178's own `FINAL_SHA`).
Screenshot gallery: [gallery.html](p179-review/gallery.html). Raw screenshots:
`docs/mobile/p179-review/screens/`.

This is a finish-gate pass, not a redesign. Three concrete defects were found and fixed; the rest
of the design system held up under real device stress (large money, absent-vs-zero, font scale
2.0, both themes).

## What changed

1. **White flash on every cold launch, fixed.** P178 claimed "dark from the first pixel," verified
   by a screenshot taken *after* the system splash had already transitioned. Screenshotting the
   true first frame (repeatable, both on P178's own build and this session's pre-fix P179 build)
   showed a full-screen white "Starting Window" with the generic Android icon placeholder —
   Android 12+'s mandatory SplashScreen API, which the app had never actually opted into
   (`app.json` never installed `expo-splash-screen`; the generated `Theme.App.SplashScreen` only
   set the legacy `android:windowBackground`, which that API ignores for the true first frame).
   Fixed with a small config plugin (`plugins/with-dark-splash-background.js`, mirroring the
   project's existing `with-navigation-bar-follows-theme.js` pattern — no new dependency, no new
   asset, no icon decision) that adds `android:windowSplashScreenBackground` pointing at the same
   `activityBackground` color the rest of the theme already uses. Verified on-device, both before
   (full-screen white) and after (dark background; only the undecided default-icon's own circular
   white badge remains, which is an icon-asset question explicitly out of this session's scope,
   not a flash).
2. **Price Check's typography/radius drifted from the design system, fixed.** The mission's own
   named visual priority screen (`CardPriceScreen.tsx`) mixes P178's new component vocabulary
   (`RadioRow`, `SegmentedControl`, `FilterChip`, `InlineNotice`) with an older, feature-local kit
   (`src/features/ui/kit.tsx`) that predates P178 and was explicitly marked "the owner-approved
   designs replace the presentation later." That kit's `Section` used a hand-picked 12px corner
   radius (the design system's own `Surface` uses `RADIUS.md` = 10px) and its `ActionButton`/
   `Label`/`LiveStatus` used raw `fontSize`/`fontWeight` values that didn't match any of the
   system's named `TYPE` roles — most visibly, Price Check's own buttons rendered at font-weight
   600 while every other button in the app (Purchase, Sale, Manual valuation, Card detail's own
   two-action row) renders at 700. Fixed by pointing those four components at the same `RADIUS`/
   `TYPE` tokens the rest of the app already uses; no visual behavior other than the weight/radius
   correction changed, and the fix stayed inside the file that already owned this presentation
   debt.
3. **Fixture tooling silently discards the richer test account — disclosed, not fixed (out of
   this phase's scope).** `backend.mjs seed` runs two seed scripts back to back; the second
   (`p169/seed.mts`) overwrites `fixture.json` with its own freshly-created users, discarding the
   first script's own 40-holding/280-card "user B" (including the stress-value holdings this
   review needed: the 2^53+1 case, the ~2.9×10^17 case, a deliberate manual zero, an unpriced
   card, two same-provider-price cards). A session that logs in with `fixture.json`'s own
   credentials — exactly what the documented driver scripts do — gets a near-empty account
   instead. This is why P178's own screenshots don't match what its own scripts would produce
   today: they must have used different credentials than their own tooling would generate. Worked
   around this session by resetting the two synthetic users' passwords directly through the local
   Supabase admin API (no new account created, no data touched). Not fixed at the script level —
   fixing it means deciding whether the two seed steps should merge their fixture files or run
   against disjoint user pools, a product-adjacent tooling decision, not a UI one.

## Screen-by-screen

| Screen | Verdict | Notes |
|---|---|---|
| Login | PASS | Field positions verified via `uiautomator dump`, not guessed; keyboard-avoidance (`KeyboardAvoidingView behavior="padding"`) shifts content ~410px on focus — confirmed *not* a regression: it's P166's own documented fix for Android 15+ edge-to-edge breaking `adjustResize`, and every field/button stays reachable and unobstructed after the shift. |
| Collection | PASS | Hero value, honest "40 without a value" count, `InlineNotice` callout, unpriced rows all correct. Rich-fixture screenshot only obtainable after the fixture-tooling workaround above. |
| Card detail | PASS | Large-money stress and absent-price stress both verified — see below. |
| Search | PASS | "1 of 1 matching cards. Nothing is selected until you choose one." — honest, no premature price. |
| Printing chooser | PASS | Owned-variant path (pre-resolved, other printings as `FilterChip`s) verified live. The `choice_required` path (nothing pre-selected, from an ambiguous search) was not re-driven fresh this session — unchanged code, already screenshotted by P178. |
| Price Check (confirmed) | FIXED_IN_P179 | Functionally correct already; typography/radius drift fixed (see above). |
| Record purchase | PASS | Raw card-variant UUID shown in the body text (`Card variant 05ff092b-...· 0072d8bd-...`) is a real, visible polish gap — pre-existing from P175, not introduced by P178/P179. Flagged, not fixed (out of this phase's scope; the label needs the card's display name threaded through, a data-plumbing change). |
| Record sale | PASS | Not device-verified by P178 (disclosed there); verified live this session — form, currency selector and layout all correct. |
| Record opening | PASS | Confirm button always renders, disabled ("No sealed lots left to open in this holding.") instead of disappearing — matches P178's claim, verified live. |
| Manual valuation | PASS | Verified live end-to-end: submitted a real value, "Saved." appeared, and the write landed in the database (confirmed by direct query). |
| Profile | PASS | Dark/Light/System switch verified live in both directions; status bar icon color follows. |
| Empty / error states | PASS | A real server-unreachable state (backend momentarily down) rendered as the honest, non-technical `FailureView` message with dark background throughout — no white flash, no raw error text. |

## Money and honesty checks (mission §6/§8)

Verified against the P158 synthetic fixture's own purpose-built stress holdings (owned by the
seed's "user A", not "user B" — see the fixture-tooling note above):

- **"P158 Above Safe Integer"** (2^53 + 1 minor units): Card detail shows `90 071 992 547 409,93 kr`
  on one line, `size="large"`, no truncation, no ellipsis — the mission's own named stress value,
  reproduced exactly.
- **"P158 Astronomical"** (288230376151711745 minor units): Collection list renders
  `8 646 911 284 551 352,35 kr` on one line via the shrink-to-fit path; Card detail renders the same
  amount wrapped cleanly across two lines, breaking between a digit group and "kr" — never
  mid-group, never an ellipsis. Re-verified at **font scale 2.0**: still wraps correctly, no digit
  dropped, and every button below it (including "Manual valuation") stays reachable by scrolling,
  with no overlap against the bottom tab bar.
- **"P158 Manual Zero"**: renders `0,00 kr`, tinted the same manual-value color as the other manual
  entries — a real zero, never confused with absence.
- **"P158 No Prices"**: renders `—` with the caption "No value available" — never `0,00 kr`.
  Absent and zero are visually and textually distinct at every place they appear (list row and
  detail).
- **Negative amounts**: `formatMoney` always prefixes a real minus glyph (`−`) on a negative
  amount; the color layer (`moneyColor()`) never applies a negative-specific tint at all, so the
  sign is carried by text, not color — satisfies "must not rely only on color" by construction.
  No UI surface in this build currently displays a genuinely negative signed amount (net
  investment / P&L is explicitly not built yet, per P178's own disclosure), so this was verified at
  the formatter level, not against a live negative screen.

## Accessibility and device matrix

- **Touch targets**: unit-level 48dp sweep (`tests/unit/p170-integration.test.tsx`) passes clean;
  not independently re-measured pixel-by-pixel on the physical screenshots.
- **Font scale**: 1.0 and 2.0 both driven live on-device (see above); 1.3 not run.
- **Width matrix**: 360/390/430dp not driven — only the AVD's own default width (~411dp) was used,
  same limitation P178 disclosed.
- **TalkBack**: not exercised this session (time budget).
- **Native `Switch`** (used by `SwitchRow`): React Native's own `Switch` component sets its
  accessibility role and on/off state automatically; no gap found here.

## Performance

Not measured with tooling this session (no frame-metrics capture, no PSS). Qualitatively: every
screen transition, form submission and theme switch driven above felt immediate on the emulator,
with no visible jank.

## Regression

`pnpm run typecheck` / `pnpm run lint` / `pnpm run test`: clean, 546/546 passing (543 baseline +3
from the new plugin's own test). A real manual-valuation write was submitted through the release
build against the real local database and confirmed by direct query — the write seam is intact.
Login, Collection, Search, Price Check, Record sale, Record opening and Profile's theme switch
were all driven live this session; Record purchase and Record opening were driven far enough to
reach their forms but not submitted (the JPY currency-selector flow itself was P178's own
flagship device proof and was not re-driven from scratch here, since nothing in this phase's
diff touches that code path).

## Screenshots

See [gallery.html](p179-review/gallery.html) for the baseline / Stitch / native comparison, and
`docs/mobile/p179-review/screens/` for every raw capture referenced above.
