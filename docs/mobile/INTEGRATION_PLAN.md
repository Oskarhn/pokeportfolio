# Replacing the SPIKE_ONLY adapters

Every temporary stand-in is marked `SPIKE_ONLY` in its file header. None is a Production security
boundary: RLS and the database remain the authority. This plan removes each one **after** the thing it
stands in for is released; nothing here needs a change to the spike's screens.

| Phase | Trigger | Replace | With | Gate |
|---|---|---|---|---|
| 0 | Owner reviews [DECISION_RECORD](DECISION_RECORD.md) | nothing | decision on React Native vs alternatives, navigation, visual direction, icon, spending | written answer; D-027 revisited if a store account is wanted |
| 1 | An Android SDK + JDK 17 + emulator (or a phone) is available (**done on an emulator in P166**; a phone is still open) | `ANDROID_RUNTIME_UNVERIFIED` → emulator-verified | run `pnpm hermes:proof` output on Hermes; smoke the app; measure cold start | the numbers in [TEST_EVIDENCE](TEST_EVIDENCE.md) reproduced **on the device** |
| 2 | P149 released | `auth/identity-authority.ts`, `net/exact-transport-guard.ts`, `money/wire.ts`, `createNativeClient` | P149's `IdentityAuthority`, `createAppSupabaseClient` (quotes unsafe integers), leased client for any write | same test names green against the released code; the cursor hazard (F3) closed by exact-string params |
| 3 | P153 released | `price-check/fixture-adapter.ts`, `observation-wire.ts`, `released-adapter.ts`, `resolve-variant.ts`, identity types | a port over P153's data layer; type re-export of its identity | [PRICE_CHECK_CONTRACT](PRICE_CHECK_CONTRACT.md) rules still hold; `search-prices` added to the request allow-list after review |
| 4 | P154 Option B accepted | the Metro/Jest/tsconfig seam | a `setSupabaseClient` factory in `src/data` (reviewed PR to `main`) or a `packages/api` extraction | web build and both test runners still green |
| 5 | P151 released and a scanner spike passed its parity gates | `PhotoPort` → `ScannerPort` | native capture + platform OCR + model runtime | P154 NATIVE_SCANNER_PORTABILITY §5 gates |
| 6 | Owner approves writes | the read-only request policy | a leased client, idempotency keys per intent, the P138/P140 semantics | on-device double-tap / background / airplane-mode tests create exactly one row (P154 G5) |
| 7 | Store distribution approved | `loadBackendConfig` (local-only) | a reviewed release configuration, privacy/deletion flow (P152), `minimum-supported-version` handling | P154 APP_STORE_READINESS |

## Order constraints worth stating

- Phase 2 before Phase 6: no financial write may be added on the SPIKE_ONLY identity code.
- Phase 3 does not depend on Phase 2.
- The session-storage decision (chunked SecureStore) survives every phase unless a device measurement
  says otherwise.
- Backend changes are **additive** from the first native build onward (P154 §4): an installed app does
  not update itself.
