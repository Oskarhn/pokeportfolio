# P177 documentation corrections (for a later P178 documentation-sync pass)

This file records facts a later documentation-sync task should apply to `HANDOVER.md` and
`docs/CURRENT_STATE/NATIVE_MOBILE.md`. It does **not** edit those files itself — P176 owns their
compact format, and P177's own mission explicitly says not to modify the P176 branch directly.

## 1. Correct a P176 status error

P176's `HANDOVER.md` and `output_176.txt` label the P173 native-integrated candidate:

> `NATIVE_INTEGRATED_CANDIDATE=P173, ... LOCAL_ONLY_NOT_DEVICE_VERIFIED`

This is wrong. P173's own report (`output_173.txt`) states, and this session independently
re-read and confirms:

> `ANDROID_STEPS=P173 driver 35 PASS / 0 FAIL (final APK, second full run) + P167 driver 19 PASS / 0 FAIL.`

P173 **was** built as a release APK (Hermes, embedded bundle) and driven on a real Android 16
x86_64 emulator (AVD `p173_api36`), twice, with 35/35 and 19/19 passing driver runs against its
own tip (`0600361f71ee2dd5591fbbbfb2fe260ab68ba7a2`). "Local-only" (never merged/pushed) is
correct; "not device-verified" is not — those are two different facts and P176 conflated them.

`docs/CURRENT_STATE/NATIVE_MOBILE.md`'s own hedge ("No fresh-session confirmation that P173 or
P175 has ever run on a real device... do not assume the current P173/P175 tip has been exercised
the same way without re-running it") is more carefully worded and is **not** the error — it
correctly says a *later* tip needs re-verification, not that P173 was never run. The error is
specifically the `LOCAL_ONLY_NOT_DEVICE_VERIFIED` string in `HANDOVER.md` and
`output_176.txt`'s `NATIVE_INTEGRATED_CANDIDATE` line.

## 2. P175 before P177 was correctly NOT device-verified

P176's label for P175 (`LOCAL_ONLY_NOT_DEVICE_VERIFIED`) was accurate as of P176 — P175's own
report disclosed this explicitly (`ANDROID_STEPS=NOT_RUN`, `HERMES_EXACT_MONEY=PARTIAL`, no APK
built). Nothing to correct there.

## 3. P177's result determines the new correct status

As of this session's `FINAL_SHA` (`3f6759542b18910dc0ea7a51651ff41e6d4dc0b3`, branch
`test/p177-native-financial-runtime`, based on P175's `a193a8bab2d742edd504ec578253f99c18f6d9d1`):

- The P175 write seam (add-acquisition, purchase, sale, opening, manual valuation) is now
  **device-verified**: a release APK was built, installed on a fresh AVD (`p177_api36`), and
  driven through all six flows via the app's real navigation (Price Check → Add to Collection →
  Add acquisition / Record purchase; Collection → Card → Record sale / Record opening / Manual
  valuation), with every write independently checked against the live database. 28/28 driver
  steps passed on the final run.
- Two real defects were found by this device run and fixed (both are small, disclosed, in-scope
  fixes per the mission's own allowance — not a redesign):
  1. `RecordPurchaseScreen` never sent a `condition` for its card line; `create_purchase` requires
     one for a raw card, so every purchase submitted through the real app was rejected
     server-side. Fixed: defaults to `'NM'`, matching `AddAcquisitionScreen`'s own default.
  2. `CardDetailScreen` only reloaded `holdingDetail` when `holdingId` changed, so returning from
     Record sale / Record opening / Manual valuation (same holding) kept showing the pre-write
     value/price-state. Fixed: switched to `useFocusEffect`.
  Both fixes have new regression-guarding unit tests and mutation-proof mutants (P19-P21).
- The write-side money boundary (`write/money-input.ts`, `write/money-wire.ts`,
  `write/idempotency-key.ts`) was executed on an actual Hermes VM for the first time:
  `P166_PROOF RESULT pass=52 fail=0 engine=hermes 250829098.0.17`.
- Opening has **no UI path to create its own precondition** — Price Check only searches cards, so
  a sealed holding cannot be created through any screen. `add_card_acquisition` itself supports
  `sealedProductId`/`sealedIntent` (proven via the real RPC, same mechanism
  `tests/backend/write-seam.test.ts` already used), so this session used that RPC directly (not
  raw SQL) to seed one synthetic sealed holding, then drove Record Opening against it through the
  real UI. This is a genuine, disclosed scope gap in P175's screens, not a defect in the write
  layer itself.
- `create_purchase` has no way to record a JPY receipt through the UI: `RecordPurchaseScreen`
  hardcodes `currency: 'NOK'` on its draft with no currency selector. JPY money-boundary
  correctness is proven at the unit/Hermes level (P175/P177) but not reachable as a device
  journey without a UI change.
- Full root DB suite (`pnpm test:db`), run against an isolated P177 stack with **Edge Runtime
  enabled** (opt-in addition to `scripts/local-backend.mjs`, off by default for every other
  worktree): **745 passed, 1 skipped, 0 failed** — the 13 invite/authorization failures every
  prior mobile-spike stack accepted as a known gap (P162, P175) do not occur once the real
  `redeem-invitation` function is actually served. This closes that open question for the current
  107-migration tree; a future session should keep enabling Edge Runtime for this same reason
  rather than reintroducing the 13-failure baseline as "expected."
- Mutation campaign: P9 ("opening creates a second spend"), previously SURVIVED for a disclosed,
  legitimate reason (no Docker in that runner), is now **genuinely KILLED** — a real,
  reversed-after-use SQL mutant of `create_opening` (adding a bogus second purchase/purchase-line
  and repointing the lot's `purchase_line_id`) made `tests/backend/write-seam.test.ts`'s
  `create_opening` test fail exactly as expected, against the real database. 43/44 total mutants
  killed (P9 remains formally SURVIVED in the no-Docker source runner by design, exactly as
  P175's own report explained, but is independently proven KILLED by the DB-backed witness above).

## 4. Local migration count (unchanged by this session)

Still 107 on the P175/P177 track (104 released + P144's 2 + P173's 1), verified by a fresh
`supabase db reset` this session. `docs/handover/STATE_RECONCILIATION.md`'s note about divergent
local migration counts across branches is still accurate and still needs an integrator's attention
before more than one local candidate is merged.

## 5. Not verified by this session (disclosed scope, not silent gaps)

- Font-scale / dark-mode / touch-target device matrix for the new financial screens.
- Process-death-after-commit and app-backgrounding-during-submit device scenarios (P175's own
  disclosed gap; still open — see `output_177.txt` for the reasoning on why this needs dedicated
  time, not a rushed pass).
- A literal in-app account-switch mid-write on device (this app has no multi-account switcher;
  the adversarial identity behaviour is proven at the unit/backend level per P175, and this
  session's device pass covered the single-account financial journeys, not the identity-switch
  device scenarios).
- Production smoke testing (not attempted; out of scope per the mission's own "Local release-APK
  runtime proof is the required gate").
