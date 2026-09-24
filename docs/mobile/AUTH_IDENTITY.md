# Auth, storage and identity

## Session storage: decision and evidence

| Option | Verdict |
|---|---|
| **Chunked `expo-secure-store`** (implemented, `src/auth/chunked-session-storage.ts`) | The session JSON is split into ≤ 1 500-byte chunks; every byte stays in the Keychain / Keystore-backed store. A manifest (chunk count, length, checksum) is written **last**. No crypto code of our own |
| Supabase's own guide: AsyncStorage | Plaintext tokens on disk. Not chosen |
| Supabase guide "LargeSecureStore" (AES-256 key in SecureStore, ciphertext in AsyncStorage) | Needs a crypto dependency and a random source; the guide's AES-CTR gives confidentiality but no integrity. Not chosen; remains the fallback if chunking proves slow on a device |
| Biometric unlock | later; not part of the spike |

Measured on the real stack: a supabase-js session for a minimal synthetic user is **2 039 bytes**
(2 chunks). The documented iOS figure is "roughly 2048 bytes", "Expo does not enforce a limit". The
storage test uses a fake store that **rejects any value above 2 048 bytes**, so the claim "every
stored value stays under the limit" is enforced, not asserted. Real hosted sessions are larger.

Torn writes: the app killed between chunk writes leaves a manifest/checksum mismatch, which reads as
**absent** (the person signs in again). A partial session is never returned. Cost: one extra
Keychain round trip per chunk. **Not measured on a device.**

`WHEN_UNLOCKED_THIS_DEVICE_ONLY` is used for the store options: readable only while unlocked, never
migrated by backup. The app refreshes tokens in the foreground only. **Provisional; a security review
owns the final accessibility class.**

## Lifecycle (verified against real GoTrue)

| Behaviour | Test |
|---|---|
| Sign in, stored through the chunk adapter | `auth-session.test.ts` |
| App restart restores the same session **without** a network sign-in | same |
| Expired access token is refreshed on restore, `TOKEN_REFRESHED`, storage updated, same user | same |
| A refresh the server rejects ends in a clean `signed_out` and an empty store | same |
| Sign-out uses `scope: 'local'`, removes the stored session **and** the server refuses the old refresh token | same |
| Wrong credentials and an unreachable backend are distinct results | same |
| Foreground-only refresh (`AppState` → `startAutoRefresh` / `stopAutoRefresh`) | `auth-identity.test.ts` (scripted `AppState`) |
| Cold start offline with a stored session shows **"try again", not the login screen** | `auth-identity.test.ts`, `native-app.test.tsx` |

**Not verified:** a refresh that fails because the network is down for the full 25 s auth-js retry
window (covered for the web by P149's fake-clock suite); background/foreground on a device; deep-link
URL handling (`detectSessionInUrl` is `false`, so password-reset and invitation links are not handled).

## Identity boundary

```
                 supabase.auth  (single source of truth about the session)
                        │  onAuthStateChange(event, session)
                        ▼
              ┌──────────────────────┐
              │   AuthController     │  INITIAL_SESSION null? → getSession() error? → "try again"
              └──────────┬───────────┘
        observe(userId)  │
                        ▼
              ┌──────────────────────┐   epoch++ only on a REAL change
              │  IdentityAuthority   │   (A→B, A→signed-out, signed-out→A);
              └──────────┬───────────┘   TOKEN_REFRESHED / USER_UPDATED: no change
     real change?        │
        ┌────────────────┴───────────────────────────┐
        ▼ yes, synchronously                          ▼ every async load
 ScopedRegistry.resetAll()                     runUnderIdentity(lease)
   collection · holding-detail ·                 lease = begin(current user)
   price-check drafts · photo (deletes file)     result discarded if !lease.isCurrent()
        │
        ▼
 React: <Fragment key="user:<id>:<epoch>"> remounts the whole navigator
```

Two independent mechanisms, each with its own mutation proof: the **reset** (state of A is gone the
instant B is observed, not after a fetch) and the **lease** (a response or failure for A that arrives
after B signed in is dropped). Removing either is caught ([TEST_EVIDENCE](TEST_EVIDENCE.md), M1, M7a, M7b).

| Guarantee | Test (unit, real composition root) | Test (real backend) |
|---|---|---|
| A → B: nothing of A after the switch, synchronously | `identity-isolation.test.ts` | `identity.test.ts` |
| A late response **or failure** for A is discarded after B signed in | same | same (held request) |
| A → B → A: the second A session starts empty; a lease from the first A session is dead | same | same |
| Same-user refresh keeps rows, the typed query and the chosen variant | same | same (real `refreshSession`) |
| Sign-out clears every store, drafts and the owned photo file | same | |
| RLS still refuses B access to an A holding by id | | `identity.test.ts` |
| Whole navigation tree remounts on an identity change | `native-app.test.tsx` | |

## Adopting P149 later (no second source of truth)

`IdentityAuthority` (`src/auth/identity-authority.ts`) deliberately reuses **P149's names and
semantics** (`observe`, `retire`, `begin`, `IdentityLease`, `AuthIdentityChangedError`; branch
`fix/p149-auth-refresh-failure-recovery`, unreleased at `7fb83c2`). It only **records** what
supabase-js reports; it never holds a copy of the session. After P149 releases:

1. Delete `identity-authority.ts`; import `IdentityAuthority` from the released
   `src/auth/identity-lease.ts` through `@shared`.
2. Replace `createNativeClient` with P149's `createAppSupabaseClient` (adds the exact-money transport
   guard, which **quotes** unsafe integers instead of refusing them), keeping the native `storage`
   option. Delete `net/exact-transport-guard.ts` and `money/wire.ts`.
3. Any write added later must use a **leased** client (`createLeasedDb`, `accessToken` provider) so a
   mutation begun under A cannot complete under B. The spike has no write, so this is not yet exercised.
4. `AuthController` collapses into a thin native adapter around P149's `AuthProvider` behaviour;
   `session_check_failed` maps to P149's `AuthCredentialsUnavailableError` path.
5. Re-run the same test names against the released code; the contract tests are written to be pointed
   at it.

`SPIKE_ONLY` is marked in the header of every file that is a temporary stand-in.
