# F — iOS / ANDROID DEVICE CAPABILITY MATRIX

**Audited SHA:** `f822de79ad9397928cb59d1760e42bd63e583457`

This matrix records **what each platform is configured and coded to do**, and separates
that from **what has been proven on hardware**. It does not replace
`apps/mobile/docs/physical-acceptance.md`, which is the existing step-by-step script for
a human with devices and remains the correct execution vehicle. This is the
capability/《state》 view that sits above it.

## F.0 The four axes (retained from `docs/uc-disposition.md`, because they are right)

| Axis | Meaning | Who resolves it |
|---|---|---|
| **CODE** | The implementation in this repository | engineers here |
| **EXTERNAL** | Store listing, signing identity, published domain association | release/infra |
| **PHYSICAL** | Acceptance on real hardware | a human with devices |
| **ENVIRONMENT** | A local prerequisite (DB, daemon, SDK) | the machine |

Collapsing these into one "blocked" is how a finished implementation gets described as
unbuilt. **No row below is blocked on CODE.**

---

## F.1 Platform configuration, as declared

| Capability | iOS | Android | Source |
|---|---|---|---|
| Bundle / package | `com.jalalattar29.proovra` | `com.jalalattar29.proovra` | `app.json` |
| Expo SDK | 52.0.0 | 52.0.0 | `app.json` |
| Tablet | **`supportsTablet: true`** | (n/a) | `app.json` |
| URL scheme | `proovra://` + Google reversed-client-id | `proovra://` | `app.json` |
| Universal / App Links **declared** | `applinks:www.proovra.com`, `applinks:proovra.com` | 10 `pathPrefix` filters × 2 hosts, `autoVerify: true` | `app.json` |
| Universal / App Links **working** | **NO** — A §3.1 | **NO** — A §3.1 | live probe |
| Apple Sign-In | `usesAppleSignIn: true` | n/a | `app.json` |
| App group (broadcast IPC) | `group.com.jalalattar29.proovra` | n/a | `app.json` entitlements |
| Broadcast extension | `ProovraBroadcast` (`com.jalalattar29.proovra.broadcast`) | n/a | `app.json` `extra.eas.build.experimental` |
| Orientation lock | **none declared** | **none declared** | `app.json` |
| UI style | **`dark`** (contradicts the light palette — C.1.1) | **`dark`** | `app.json` |

## F.2 Permissions declared

| Permission | iOS purpose string | Android |
|---|---|---|
| Camera | `NSCameraUsageDescription` ✓ | via module manifest |
| Microphone | `NSMicrophoneUsageDescription` ✓ | via module manifest |
| Photo library | `NSPhotoLibraryUsageDescription` ✓ | via module manifest |
| Location (capture-time, consented) | `NSLocationWhenInUseUsageDescription` ✓ | via module manifest |
| Screen capture | ReplayKit broadcast (user-initiated) | `MediaProjection` (system consent dialog) |
| Encryption declaration | `ITSAppUsesNonExemptEncryption: false` | n/a |

All four purpose strings are specific and consent-scoped ("only when you…"), which is
what App Review looks for.

## F.3 Native capture modules

| Module file | Platform | Role |
|---|---|---|
| `modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift` | iOS | ReplayKit bridge |
| `modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift` | iOS | app-group IPC with the extension |
| `modules/proovra-screen-capture/ios/ProovraScreenCapture.podspec` | iOS | pod integration |
| `plugins/withProovraIosScreenBroadcast.cjs` | iOS | config plugin embedding the `.appex` |
| `plugins/broadcast-extension/ProovraBroadcast.entitlements` | iOS | extension entitlements |
| `.../android/.../ProovraScreenCaptureModule.kt` | Android | MediaProjection bridge |
| `.../android/.../ScreenCaptureService.kt` | Android | single-shot foreground service |
| `.../android/.../ContinuousScreenCaptureService.kt` | Android | UC-3 continuous segmented capture |

### F.3.1 A platform asymmetry worth naming

`app/(stack)/screen-capture.tsx:57`:

```ts
const supported = Platform.OS === "android" && isScreenCaptureSupported();
```

The **single-shot screen-capture screen is Android-only by construction.** iOS reaches
screen capture through the ReplayKit broadcast/continuous path instead
(`src/continuous-capture.ts:153` selects `DIRECT_SCREEN_CAPTURE_IOS` vs
`DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS`).

That is a defensible platform split — ReplayKit has no single-frame equivalent. **What is
UNVERIFIED is what an iOS user sees if they reach this screen**: whether they get a clear
"use continuous capture instead" explanation or an inert unsupported state. This is
capture-surface item **H-9**.

## F.4 Capability × platform × proof

Legend — **C** code, **E** external, **P** physical.

| Capability | iOS C | iOS E | iOS P | Android C | Android E | Android P |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Email auth | ✓ | ✓ | ☐ | ✓ | ✓ | ☐ |
| Google OAuth | ✓ | ⚠ API env | ☐ | ✓ | ⚠ API env | ☐ |
| Apple OAuth | ✓ | ⚠ API env | ☐ | n/a | n/a | n/a |
| Deep link `proovra://` | ✓ | ✓ | ☐ | ✓ | ✓ | ☐ |
| **Universal / App Link (https)** | ✓ | **✗ placeholder** | ☐ | ✓ | **✗ placeholder** | ☐ |
| Apex-domain link | ✓ | **✗ 301 redirect** | ☐ | ✓ | ⚠ redirect | ☐ |
| Photo / video / audio / file capture | ✓ | ✓ | ☐ | ✓ | ✓ | ☐ |
| Screen capture — single shot | **n/a by design** | — | — | ✓ | ✓ | ☐ |
| Screen capture — continuous | ✓ ReplayKit | ✓ | ☐ | ✓ MediaProjection | ✓ | ☐ |
| Broadcast extension packaging | ✓ | ⚠ signing | ☐ | n/a | n/a | n/a |
| `crypto.subtle` sealing | ✓ | — | **☐ device-only** | ✓ | — | **☐ device-only** |
| Share-sheet export | ✓ | ✓ | ☐ | ✓ | ✓ | ☐ |
| Tablet layout | ⚠ declared, no layout code found | — | ☐ | n/a | — | — |
| RTL (Arabic) | ⚠ text only (C.1.2) | — | ☐ | ⚠ text only | — | ☐ |

**Every `P` column is ☐.** `physicallyAccepted` is `false` on all 62 ledger rows and
this audit ran 0 simulator and 0 device sessions.

## F.5 What must be proven on hardware and cannot be proven anywhere else

1. **`crypto.subtle` on a real device** — sealing and signing. Simulator behaviour is
   not evidence.
2. **ReplayKit broadcast end-to-end with real signing** — the `.appex` compiles and
   packages on EAS; that a broadcast starts, streams through the app group and seals is
   device-only.
3. **MediaProjection consent + foreground service under Doze** — including what happens
   when the service is killed mid-capture (UC-3 continuity manifest).
4. **That bytes reached storage** — no test in this repository can establish it.
5. **C.1.1 status-bar / splash contradiction** — one look at any screen settles it.
6. **iPad portrait *and* landscape** (`supportsTablet: true`, no orientation lock).
7. **Arabic layout** — C.1.2 predicts mixed-direction rows.

## F.6 Environment blockers recorded at this SHA

| Blocker | Effect |
|---|---|
| Audit host is `win32` | iOS simulator impossible. |
| No Android SDK / AVD on host | Android emulator not run. |
| `services/api/.env` holds live production credentials | Local API boot reaches production. **Deliberately not attempted.** No authenticated render or integration run was performed. |
| `@proovra/shared` resolves via gitignored `dist/` | `node --test` fails until `pnpm run build:deps` runs. Ran it; suite then passed 942/942. |
