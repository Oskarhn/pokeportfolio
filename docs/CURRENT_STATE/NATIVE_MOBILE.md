# Native mobile — current state

Authority: this file for current status; `HANDOVER.md` §9 for the one-paragraph summary;
`docs/PROJECT_STATE.json` → `local_candidates.native_integrated` /
`local_candidates.native_financial_writes` for machine-readable pointers.

## What exists

A React Native/Expo native app track, built up across a long, mostly-linear chain of local
prompts. **Nothing in this track has ever been merged, pushed, or released.** It lives entirely
in local worktrees under `C:\Users\Oskar\Documents\Pokemonapp-worktrees\`.

| Branch (worktree) | Prompt | What it added |
|---|---|---|
| `spike/p158-native-collection-pricecheck` | P158 | Initial native spike — source-built, Hermes-compiled. No Hermes/Android execution performed (per P158's own report). |
| `spike/p166-native-runtime-stitch` | P166 | First runtime spike reported running on an Android 16 emulator/Hermes; SDK installed this session. |
| `fix/p167-native-android-runtime-hardening` | P167 | Android runtime hardening; per-worktree stack/`ANDROID_SERIAL` isolation; F1 patch backport. Mobile-only diff (verified `git diff` touches nothing outside `apps/mobile-spike` and `docs/mobile`). |
| `feat/p169-native-catalog-price-check` | P169 | Native catalog + Price Check. Graded pricing is `PARTIAL_NO_AUTHORIZED_PROVIDER` — no paid grading source is authorized. |
| `feat/p170-integrated-native-android` | P170 | Attempted integration. **No `output_170.txt` exists anywhere** — a later session (P172) explicitly found no evidence this prompt completed successfully, and did not guess its SHA. |
| `feat/p173-native-integration-recovered` | P173 | Recovers the missing P170 handoff; the current **native-integrated candidate**. SHA `0600361f71ee2dd5591fbbbfb2fe260ab68ba7a2`, 105 local migrations (104 released + 1: `20260926120000_p173_search_cards_stable_paging.sql`). Its own report claims no blockers for its scope. |
| `feat/p175-native-financial-write-flows` | P175 | Native financial write layer built **on top of P173** (confirmed ancestor via `git merge-base --is-ancestor`). SHA `a193a8bab2d742edd504ec578253f99c18f6d9d1`, 107 local migrations (105 + 2 copied verbatim from the P144 worktree). **Its own report states the native build was NOT run this session** — this candidate has not been exercised on any runtime. |

## What is NOT verified

- **No fresh-session confirmation that P173 or P175 has ever run on a real device.** P166/P167
  report emulator runs of earlier, less-integrated states. Do not assume the current P173/P175
  tip has been exercised the same way without re-running it.
- **No iOS simulator capability** — the toolchain audit (P159) confirms the host is Windows 11;
  iOS work needs a macOS host with Xcode, which no session here has had.
- **P170's actual completion status is unknown** — P173 exists specifically to route around that
  gap, but nothing retroactively proves P170 itself succeeded.
- **Graded-card pricing is intentionally incomplete** (no authorized provider, `docs/COST_POLICY.md`).

## Before doing more native work

1. Verify the Android toolchain (SDK, emulator or device, `ANDROID_SERIAL`) is actually present in
   your session — P159 found it entirely absent in a clean session; P166/P167 had to install it.
2. Re-run P173+P175 on a real emulator/device before adding features on top — don't compound an
   unverified base.
3. Check `docs/handover/STATE_RECONCILIATION.md` for the divergent local migration counts before
   assuming any one branch's count is authoritative for "the" local database state.
