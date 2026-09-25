# Native photo feasibility (bounded)

Scope: prove the **API and ownership contract** for acquiring a card photo on a phone, previewing it,
releasing it, and handing a typed reference to a future scanner. No recognition, no model, no OCR,
no P151 code. **Nothing is uploaded**, and no server-side OCR exists (that needs a separate privacy
review).

## What exists

| Piece | File | Notes |
|---|---|---|
| Ownership store | `src/photo/photo-store.ts` | at most one image; `acquire(camera \| library)`, `release()`, `reset()` |
| Typed reference | `LocalImageRef` → `toScannerInput` | `{ uri, width, height }`: a **reference**, never bytes and never a URL to send to |
| Adapter | `src/photo/expo-photo-port.ts` | `expo-image-picker` (camera + system photo picker), `expo-file-system` `File.delete()` |
| Screen | `PhotoSpikeScreen` (Price Check stack) | opt-in buttons, honest permission/error states, preview |

## Contract, and how each rule is enforced

| Rule | Enforcement | Verified by |
|---|---|---|
| Camera use is opt-in, per action; the permission is requested when the person taps "Take photo" | `requestCameraPermissionsAsync` inside `acquire('camera')` only | unit (fake) |
| A denied permission is a **state** with copy (`canAskAgain` preserved), not a crash | `PhotoOutcome.permission_denied` | unit |
| A missing camera or a throwing native module is `unavailable`, not an unhandled rejection | `try/catch` around the launcher | unit |
| Library picking asks for no broad permission | the system photo picker (Android photo picker / iOS PHPicker) is used | source review only |
| No location metadata, no pixel data in JS memory | `exif: false`, `base64: false` | static test on the adapter source |
| The picked file is **owned** and deleted on release | `release()` → `deleteFile` | unit |
| Release on route exit | `useFocusEffect` cleanup in the screen | navigation is exercised; the cleanup call itself is unit-tested on the store |
| Release on identity change | store registered with the identity boundary | unit + integration |
| An image that arrives **after** the person left or the identity changed is deleted immediately | token + lease check in `acquire` | unit (two tests) |
| Only files under the app cache are deleted, never a user's original library file | `uri.startsWith(Paths.cache.uri)` | static test |
| A deletion that fails is **recorded** (`leaked`), not swallowed | `PhotoState.leaked` | unit |
| No network use | the photo modules import no `fetch`, Supabase client or upload API | static test |

## Not verified

The permission dialogs, the camera UI, the picker UI, that `expo-image-picker` copies the choice into
the cache directory on both platforms, that `File.exists`/`delete()` behave as expected on a real
file, and memory behaviour for a full-resolution photo were unverified in P158. **P166 exercised the
Android part on an emulator** (picker, cancel, permission dialog and denial, system camera, cache copy
deleted on exit) and found one defect: the picker fails after a configuration change
([P166 review](P166_RUNTIME_AND_STITCH_REVIEW.md) §4 F1). iOS and memory remain unverified.

## How the scanner will attach later

`ScannerImageInput { uri, width, height }` is the seam. A future `ScannerPort` receives it and returns
P151's read-only identification result (`ScannerMatch { tier, candidates[], signals }`,
`ScannerConfidenceTier = 'high' | 'medium' | 'low' | 'none'`, `src/domain/scanner/types.ts`).

1. **P151 identification.** Native capture → decode to an RGBA buffer (a native image module) →
   the existing pure matcher (`src/domain/scanner/*`, reusable) with a native OCR (Apple Vision
   `VNRecognizeTextRequest`, ML Kit Text Recognition v2) behind `OcrEnginePort`. P154's
   [NATIVE_SCANNER_PORTABILITY](../design/p154/NATIVE_SCANNER_PORTABILITY.md) has the parity gates
   (top-1/top-5 against the web baseline, embedding cosine ≈ 1, 50-scan thermal run); none is started
   here. Ask the P151 integrator whether `OcrEnginePort.recognize` still takes a canvas (P154 §7).
2. **P153 variant confirmation.** A scan identifies a **printing**, never a finish, foil or condition.
   The result feeds `PriceCheckStore.openCard(cardId)` **without** a variant, so the existing
   `choice_required` step asks the person, exactly as P153's scan session does. `HIGH` only
   **preselects**; the person confirms.
3. Price Check stays read-only; the photo never becomes an upload or a holding.

## Camera portability observations (no runtime evidence)

- Capture-then-analyse (P154's finding: the web scanner analyses a still, not live video) fits
  `expo-image-picker`'s `launchCameraAsync`; no per-frame ML access is needed for V1.
- `react-native-vision-camera` (frame processors) is only needed if live analysis is wanted; it needs
  a native rebuild and was not evaluated here.
- Expo Go includes `expo-image-picker` and `expo-camera`; whether the SDK-57 Expo Go can run this
  bundle end to end was **not tested**.
- Windows: an Android emulator's camera is a synthetic scene or a webcam pass-through; the library
  picker with a fixture image is the practical emulator path. **Not tried.**
