# iOS build and device runbook (for a real Mac)

For the first Mac session after P187. **Nothing below has been executed**: P187 ran on Windows. Every step that
fails is a finding to record, not a step to work around silently. Background, risks R1–R7 and the dependency matrix:
[P187_IOS_READINESS.md](P187_IOS_READINESS.md). Synthetic data only; no secrets in any file or log you keep.

## 0. What needs which account

| Goal | Needs | Notes |
|---|---|---|
| iOS Simulator | macOS + Xcode, **no paid account** | no camera in the simulator; library picker works |
| Your own iPhone via Xcode | Xcode + an Apple ID (a free "Personal Team" works) | free signing profiles expire after 7 days and cap the number of apps; the bundle id must be unique to you |
| TestFlight / App Store | Apple Developer Program (paid) + App Store Connect | **out of scope; do not enrol or pay without the owner's explicit approval** (COST_POLICY) |

Do not create certificates, profiles or App IDs on developer.apple.com. Xcode's automatic signing with a personal team
creates a local profile; that is enough.

## 1. Prerequisites

- macOS with **Xcode ≥ 16.1** (React Native 0.86's minimum), the command-line tools (`xcode-select --install`),
  an iOS simulator runtime, and **CocoaPods** (`pod --version`; install per cocoapods.org, e.g. `brew install cocoapods`).
- Node **24.19+** (`.nvmrc`), pnpm **10.15** (`corepack enable`), Git, and network access (Skia's postinstall downloads its
  xcframeworks; `pod install` downloads `onnxruntime-c` and ML Kit).
- Minimum deployment target: **iOS 16.4** (test devices must run 16.4 or newer).

## 2. Checkout and install

```bash
git clone <repo> pokeportfolio && cd pokeportfolio
git worktree add ../p187 feat/p187-ios-readiness     # or: git checkout feat/p187-ios-readiness
cd ../p187 && git rev-parse HEAD                      # record it
pnpm install --frozen-lockfile                        # repository root
cd apps/mobile-spike && pnpm install --frozen-lockfile
ls node_modules/@shopify/react-native-skia/libs/ios   # eight *.xcframework folders must exist
```

## 3. Scanner assets (the same pinned model and index as Android)

```bash
pnpm assets:scanner     # stages the pinned model + the committed index generation, verifies SHA-256
shasum -a 256 assets/scanner/visual-v1/model/onnx/model_quantized.onnx assets/scanner/visual-v1/index/embeddings.bin
```

Expected: model `3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917`, index
`eaec748d2713cd2b2a1f4a900b7bdeeb06435b8d15d28869a9dbd163f9a5540e`, generation `f25fc05d569b7cca`
(`scripts/scanner-visual-index/generated/visual-v1/current.json`). A mismatch stops the session.

## 4. Backend configuration

The app only talks to a **local development backend** (`src/config/backend-config.ts`). Two public values are embedded at
build time in `apps/mobile-spike/.env.local` (gitignored):

```bash
# Simulator: shares the Mac's loopback.
printf 'EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:<api-port>\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key>\n' > .env.local
# Physical iPhone: use the Mac's LAN address, e.g. http://192.168.1.20:<api-port> (private ranges are accepted, public hosts are not).
```

Start the isolated local stack the way P186 did (`node scripts/p185/backend.mjs start|seed|write-env` with
`P185_STACK`/`P186_INSTANCE` set for your own instance; Docker required; see P186 §13) and read the publishable key
from `.local-backend/<stack>/public-env.json`. For a physical phone the API port must be reachable from the phone's
network: check `curl http://<mac-lan-ip>:<api-port>/auth/v1/health` **from the phone's Safari** before the first launch.
Never put a service-role or secret key in `.env.local`.

## 5. Expo config and prebuild

```bash
npx expo config --type introspect --json | head -80   # compare with P187_IOS_READINESS.md §5
CI=1 npx expo prebuild --platform ios --clean --no-install
cd ios && pod install
```

Check, in order: `Podfile` contains `pod 'onnxruntime-c', '1.24.3'`; `Podfile.lock` resolves `onnxruntime-c (1.24.3)`,
`GoogleMLKit/TextRecognition (8.0.0)`; `Info.plist` has the two usage strings, `UIUserInterfaceStyle = Dark`,
`NSAllowsLocalNetworking`; `SplashScreen.storyboard` background is `#0F0F11`. Record `pod install` warnings verbatim.
Then run **Xcode's privacy report** (Product → Archive → Distribute → Generate Privacy Report, or inspect each pod's
`PrivacyInfo.xcprivacy`) and attach the list for ML Kit, ONNX Runtime and Skia.

## 6. Build and run

```bash
open PokePortfolioSpike.xcworkspace       # always the .xcworkspace, never the .xcodeproj
```

- **Simulator:** pick an iPhone simulator (a 16.4+ runtime), scheme `PokePortfolioSpike`, configuration **Release** for
  anything you measure (Product → Scheme → Edit Scheme → Run → Build Configuration → Release; Debug adds Metro and
  slows the scanner). If ML Kit fails to link for an arm64 simulator (R4), record it and continue on a device.
- **Physical iPhone:** target → Signing & Capabilities → tick "Automatically manage signing", choose your Personal Team,
  set a **unique** bundle identifier (e.g. `dev.<yourname>.pokeportfolio`); trust the developer profile on the phone
  (Settings → General → VPN & Device Management); on iOS 16+ enable Developer Mode (Settings → Privacy & Security).
  Allow the "local network" prompt when asked.
- Command line alternative: `npx expo run:ios --configuration Release [--device]`.

## 7. Synthetic scanner fixture

Use the same synthetic card images as the P184/P186 adversarial suite (`.p184-scratch/` and
`apps/mobile-spike/scripts/p186/device-specs/`; the six real-artwork photos are local-only and are not in the repo).
Copy a few images to the simulator/phone Photos (drag onto the simulator; AirDrop/Files on a device). Do not photograph
real cards that belong to anyone else's collection data you are not allowed to use.

## 8. Runtime test sequence (each is a gate; record PASS/FAIL with evidence, never infer)

| Gate | Check | Pass evidence |
|---|---|---|
| G1 | **Cold dark launch**: kill the app, launch from the home screen | screen recording; first frame `#0F0F11` (no white or black flash); status bar legible |
| G2 | **Login** against the local stack | session established; ATS did not block `http://<LAN-ip>` (R7) |
| G3 | **Collection** list, Card Detail, pull to refresh | seeded rows render; Dynamic Island / home indicator not overlapped |
| G4 | **Library picker → local OCR → local ONNX → candidate** (the R1 gate) | a candidate for a synthetic card; Console: no `Onnxruntime install failed`/`undefined is not a function`; if the model cannot load, stop and report |
| G5 | **Camera** (physical device only) | capture → same pipeline; denial path shows the unavailable state, no crash |
| G6 | **Confirmation → printing selection → Price Check → Add**, then **purchase**, **sale**, **non-NOK (EUR/JPY) FX**, **manual valuation** | each write checked against the database, as in P185 (rows, idempotency key, NOK reference) |
| G7 | **Layout**: iPhone SE (320/375 pt), a 390 and a 430 pt device; Larger Text at default, +3 steps and the accessibility maximum; keyboard open on Purchase/Sale/Login | footers clear the home indicator; the keyboard never covers the focused field or the primary button (R: `keyboardVerticalOffset`) |
| G8 | **Pending-write recovery**: submit a sale, force-quit mid-flight (airplane mode + kill), relaunch | one row at most; journal reconciles (P180 semantics) |
| G9 | **Identity change and Keychain**: sign in as A, delete the app, reinstall, launch | record whether A's session is still present (R3); sign in as B → B sees none of A's data or journal |
| G10 | **Background / resume**: scanner open → Home → 5 min → return; also a memory warning (Simulator → Debug → Simulate Memory Warning) | no crash; scanner usable |
| G11 | **VoiceOver** (device): Collection → Card Detail → Scanner → candidate → a write form | every control labelled, focus order logical, no unlabeled image buttons |
| G12 | **Network privacy**: see §9 | zero requests carrying image bytes |

## 9. Network privacy capture (image egress must be 0)

Set the iPhone/simulator Wi-Fi proxy to a capture proxy on the Mac (mitmproxy/Proxyman, or
`node scripts/p185/capture-proxy.mjs` as P186 did), run G4–G6, then count requests whose body is image-like
(JPEG/PNG magic, `multipart`, base64 image). **Expected: 0**; also no request to any host other than the local backend.
Disable the proxy afterwards. Record the request count and the largest body.

## 10. Memory and performance (measure; nothing from Android applies)

P186's Android figures (~110 MB prewarm) are context, **not** iOS evidence. Use a **Release** build on a **physical**
device (simulator numbers are not representative). In Xcode: Debug → Debug Navigator → Memory gauge, or Instruments
(Allocations + VM Tracker), reading **Physical footprint**:

1. baseline: app launched, Collection shown;
2. scanner entered (prewarm done: wait 5 s);
3. model loaded (first result shown);
4. after 1 scan; 5. after 25 scans (note growth); 6. after leaving the scanner; 7. after a memory warning.

Latency: use the proof build (`EXPO_PUBLIC_RUNTIME_PROOF=1`, shows the trace panel) and record cold and warm
photo→result for ≥ 10 runs each; report median and p95. Record the installed app size (Xcode Organizer or Settings →
General → iPhone Storage) and the ML Kit size risk R2.

## 11. Cleanup

Delete the app from the simulator/phone, `xcrun simctl shutdown all`, revoke the free-profile trust if desired, stop the
local Supabase stack (`node scripts/p185/backend.mjs stop`; verify with `docker ps` that no container of your project
remains), reset the Wi-Fi proxy, delete `ios/` (generated, gitignored) and `.env.local`. Commit nothing from the Mac
session except documentation of results; never commit `ios/`, `.env.local`, keys, profiles or provisioning files.

## 12. Reporting

State each gate as `PASS`, `FAIL` or `NOT_RUN` with its evidence path, the Xcode/iOS/device versions, the commit SHA
and the `pod install` log. `IOS_RUNTIME_VERIFIED` becomes `yes` only when G1–G10 and G12 pass on a physical iPhone and
G11 has been run by a person with VoiceOver.
