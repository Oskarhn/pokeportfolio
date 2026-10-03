# P173 — Integrated native Android candidate (recovery of the unfinished P170)

Branch `feat/p173-native-integration-recovered` (worktree `Pokemonapp-worktrees\p173`), continued from the
observed P170 head `24bc001`. Local only: not pushed, no PR, nothing hosted changed. This document
replaces the missing P170 report. Status: **one integrated native app (P167 hardening + P169 catalog
search / read-only Price Check) verified on an Android 16 emulator, release build, Hermes**, with the
limits in §9.

## 1. What P170 had actually done (recovered from the tree, the history and its gitignored evidence)

P170 never wrote its report. Its state was rebuilt from `git`, the tree and `.build/keep/` (report of
27 PASS / 1 NOT_RUN on its own driver, 20 screenshots, Hermes logs). It had integrated the two tracks into
one shell and run the Search / Price Check journey on a device. It had **not**: run the P167 photo /
recreation driver against the integrated app to the end, exercised an account switch with a lookup in
flight, forced a token refresh, fixed either P169 finding (F1 paging, F9 test command), or written the
`docs/mobile/P170_*.md` that `README.md` linked to.

### Graph proof (checked, not assumed)

| Question | Result |
|---|---|
| Is P167 `4ea0eb6` an ancestor of the P170 head? | yes (`git merge-base --is-ancestor`, exit 0) |
| Are P169's two commits present exactly once? | yes: `b06d11b`/`e2e382e` were cherry-picked as `2b8e7c9`/`44e1b20`; `git patch-id --stable` is identical for each pair |
| Is the P166 base duplicated? | no: linear history, 0 merge commits, 19 first-parent commits over `41dea0e` |
| Foreign branches (P156/P163/P168/P171)? | none; nothing outside `apps/mobile-spike/` and `docs/mobile/` changed since `41dea0e` |
| A second copy of the vendored Price Check domain? | no: one `src/features/price-check/p165-domain/` (blob-pinned, checked by a test) |
| Verdict | structurally clean, source salvageable: **continued**, not reconstructed. The old branch was left untouched; P173 branches from its head. |

### Reconciliation

| Requirement | In the tree at `24bc001`? | Tested before P173 | Runtime-tested before P173 | P173 |
|---|---|---|---|---|
| P167 expo-modules-core Activity-result patch | yes | unit (pins version, hash) | partial (P170 driver stopped early) | full P167 driver 19/19 on the integrated build |
| Picker after font / density / locale recreation | yes | unit (recreation) | no | 3/3 PASS |
| Orphan / process-restart cleanup, A photo never under B | yes | unit | no | PASS |
| Identity-scoped navigation memory, Back, recreation | yes | unit | Search tab only | PASS (finished lookup, lookup in flight) |
| Dark chrome, 48 dp, 200 % text, keyboard, tab labels | yes | unit | P167 only | PASS on the integrated build |
| One runtime per JS runtime | code yes, **no test of `App.tsx`** | none | no | new `app-entry` test + device log line + mutant |
| P169 stores in the shell's registry, one authority | yes | unit (`p170-integration`) | A→B / A→B→A, no in-flight | in-flight A→B and A→B→A with the wire recorded |
| Explicit card and printing choice, no price before it | yes | unit | device | PASS |
| Candidate `observations[]`, released headline-only | yes | backend suite | device (candidate) | backend 17/17 |
| Stored snapshot, freshness, exact strings, NULL≠0 | yes | unit | device | PASS |
| Fail-closed unsafe number, no derived graded, read-only | yes | unit, backend hash | device | PASS, ledger hashes unchanged at the end |
| Add to Collection is an intent | yes | unit | device | PASS (no write path exists, see §9) |
| Search paging determinism (P169 F1) | **no** | none | none | migration + DB test, mutant |
| Test command runs every project (P169 F9) | **no** (ran 25 of 40 suites) | none | none | fixed + regression test, mutant |
| Own AVD / application id / stack / drive | no (P170's) | — | — | P173's own |

## 2. One app, one identity system

`App.tsx` is the only entry. It calls `createRuntime(...)` (which composes the P169 feature through
`createP169Feature` into the runtime's own `ScopedRegistry` and `IdentityAuthority`) and renders
`AppRoot`. There is no second app root: the P169 harness entry does not exist in this tree.

| Property | Enforced by |
|---|---|
| One auth/session source, one `IdentityAuthority`, one `ScopedRegistry` | `createRuntime`; `p170-integration` (5 shell + 3 feature stores in one registry); mutants A, P |
| One Supabase client | `seam/supabase-client.ts` is the only `createNativeClient` call; `navigation-structure` test |
| One navigation tree | one `<NavigationContainer>` (`AppRoot.tsx`); feature routes come from one `P169_SCREENS.map`; `navigation-structure` test |
| One runtime per JS runtime | `getAppRuntime()`; `app-entry` test (3 recreations, `createRuntime` called once); mutant U; device log `P173_RUNTIME created count=1` in every process |

## 3. Device evidence (final release APK)

APK SHA-256 `646eabc9129c8c82915de122f15195f473942ba1528fcfe2d3a35160b2ca3a6e`, built from a clean
`expo prebuild --clean` at commit `e1dd3ee` (clean tree), Hermes bytecode (magic `c61fbc03`), x86_64,
own application id `invalid.pokeportfolio.spike.p173`, AVD `p173_api36` (`emulator-5580`). A scan of the
bundle finds no `service_role` or `VITE_SUPABASE`; `sb_secret_` occurs once (the refusal pattern) and
`add_card_acquisition` once (the shared `collection.ts`, never called and refused by the wire policy).

| Driver | Result |
|---|---|
| `scripts/p173/android-check.mjs` (35 steps) | **35 PASS / 0 FAIL** (second full run; the first full run on this APK hit an ANR dialog, §9) |
| `scripts/android-p167-check.mjs` (19 steps) | **19 PASS / 0 FAIL** |
| Hermes in-app proofs | P166 36/36, P169 25/25, `engine=hermes 250829098.0.17` |

New in P173, all on the integrated build: **in-flight account switches** (a lookup is held at the proxy,
A→B or A→B→A happens, the answer is then released: never rendered, B's first request is made as B with
zero cache hits, checked from the request's JWT `sub`); **same-user token refresh** (emulator clock moved
59.5 min, a `grant_type=refresh_token` request observed, screen, printing and price kept, nothing
requested again); **recreation with a finished lookup** (font 1.3, density 480, nb-NO: zero provider
requests, one runtime) and **with a lookup in flight** (one request, printing kept, answer shown once);
**exact price through the real screen** (EUR 987654321098765 minor × the stored 11.5 rate, computed
independently with `BigInt` in the driver, equals the rendered `113 580 246 926 357,98 kr`, above 2^53);
**photo on the wire** (a picked photo produces no request at all; the owned copy is deleted on leaving);
**language filter**. The device timings in the report (search ≈ 10 s) are driver overhead (typing and
uiautomator dumps); the app's own `search_request` events are 70–115 ms.

## 4. Fixes made in P173

1. **`pnpm test` skipped projects** (P169 F9). The script selected `shared`; the projects are
   `shared-node` and `shared-rn`. Jest ignored the unknown name: 25 of 40 suites ran. Now `unit shared-node
   shared-rn` (40 suites, 429 tests). `tests/unit/test-command.test.ts` reads the declared command and
   fails if a configured non-backend project is not selected or a selected name does not exist, and lists
   the tests the command would run.
2. **`search_cards` paging** (P169 F1). `ORDER BY … c.name, c.local_id` is not unique; the same name and
   collector number in two sets tie completely. Reproduced on the P173 stack: a walk over 30 tied rows,
   7 per page, returned **29** distinct ids. Migration `20260926120000_p173_search_cards_stable_paging.sql`
   adds `c.id asc` as the last key: additive `CREATE OR REPLACE`, same signature, `stable`, invoker rights,
   `search_path = ''`, grants untouched (so RLS and the privilege baseline are unchanged). The client-side
   de-duplication was **not** relied on. Deployment order: migration first, then any client (backward
   compatible, no coordinated release). The hosted database (104 migrations) has not been changed.
3. Tooling under P173's own identities; `README.md` no longer links to a document that did not exist.

## 5. Tests

| Gate | Result |
|---|---|
| Native typecheck / lint / prettier | clean |
| Native `pnpm test` (unit + shared-node + shared-rn) | **42 suites / 435 tests** pass (was 25 / 337 through the broken command) |
| Native backend (real stack, 6 files) | 6+8+4+3+17+7 = **45 / 45** |
| DB paging test (`tests/db/search_cards_paging.test.ts`) | 4 / 4; **fails 4 / 4 against the pre-fix definition** |
| Mutations | **22 / 22 killed** on the final tree (§6) |
| Web (root) typecheck / lint / prettier | clean |
| Web unit | 1636 passed, 1 skipped when run under UTC. Under this machine's local time between 00:00 and 02:00 (UTC+2) two tests in `tests/ui/opening-draft.test.ts` fail because they compare a local date with a UTC date; unrelated to P173 (no web source changed) and reproducible with `TZ=UTC` passing 58/58 |
| Web build | passes (with local placeholder `VITE_SUPABASE_*`; the existing prebuild step fetches its pinned model files) |

## 6. Mutation campaign (assertion failures only; source restored, tree clean afterwards)

A registry (P169 stores not registered) · B first printing auto-selected · C NULL→0 (shell) · D unsafe JSON
number accepted · E graded = raw × 3 · F write RPC exposed · G expo-modules-core patch unregistered · H
navigation not restored · I late A answer published · J A→B→A lease resurrected · K target below 48 dp ·
L `Number(bigint)` · M card reload repeats the request · N leaving the card keeps request/printing · O
photo not deleted on leaving · P private registry · Q transient tab instruction restored · **S photo store
not reset by identity** · **T price requested before a printing is chosen** · **U second runtime per mount**
· **W `pnpm test` names a missing project** · **V** (database) `search_cards` without `c.id`, killed by the
DB test with the fixed definition restored and re-verified. Two runner defects were found and fixed on the
way: a kill was demanded to match an `expect(` pattern (D was killed but reported as surviving), and a
`BigInt` in a failure message crashed the parallel Jest worker (E), so the runner now runs in-band.

## 7. Resources and isolation

Stack `pokeportfolio-p173` (API 55421, mock provider 55411, proxy 55401, own AVD, subst `N:`), stopped at
the end; the recording proxy, the mock and the emulator are stopped too. No other session's stack,
emulator, drive or process was addressed.

## 8. Reproduce

See `apps/mobile-spike/README.md`, section "P173".

## 9. Limits and open items

- **ANR, not explained.** On the first full run of the final APK, an Android "isn't responding" dialog
  (input dispatch, 5 s, on a key event) appeared around step 17 and broke steps 17–24; a restart cleared
  it. Two later full runs on the same APK and the P167 driver's 19 steps showed none, and `am_anr` was
  empty. The host was busy (it had just finished a Gradle build and runs an RGB/overlay stack). Cause
  not established; a physical device is the right place to look.
- **No native write path.** There is no "Add to collection" confirmation and no acquisition write in the
  native app (the wire policy refuses every write). The intent screen says nothing was saved; the
  ledger tables are hash-identical after the whole journey. "One confirmation → one write → exact values"
  is therefore **not testable and not claimed**; it belongs to a later milestone.
- **Production.** Not used except one read-only aggregate over the catalog tables, run after the owner's
  "Try again": 32 690 cards, 1 232 same-name-same-number groups (so the tie is real in Production data), 104
  migrations. No account was created and the app was not pointed at Production (it refuses a Production URL
  by design). No hosted change of any kind.
- Emulator only (Android 16, x86_64, host GPU); no physical device, no iOS; TalkBack, reduced motion and
  contrast ratios not tested; no card recognition; final Stitch design not adopted; account deletion not
  merged.
- The expo-modules-core patch stays until an Expo release contains expo/expo#49634.
