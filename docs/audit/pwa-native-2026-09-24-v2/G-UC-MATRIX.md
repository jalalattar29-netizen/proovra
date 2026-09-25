# G — UC-1 … UC-6 REQUIREMENT MATRIX (v2)

**Frozen revision:** `71e148f34410c7c231f8930d1387d8924b10b4e5`

## Specifications located

| UC | Specification | Found |
|---|---|---|
| UC-1 … UC-5 | `apps/mobile/docs/uc-disposition.md` | yes |
| UC-6 | `docs/uc6-release-acceptance.md` | yes |
| Acceptance script | `apps/mobile/docs/physical-acceptance.md` | yes |
| Mode authority | `packages/shared/src/evidence-acquisition.ts` (`EVIDENCE_ACQUISITION_MODES`) | yes |

No use case was invented. The four-axis model (CODE / EXTERNAL / PHYSICAL /
ENVIRONMENT) is the document's own and is preserved.

---

## The matrix, with this audit's adjudication

| UC | Spec claim | Native implementation | v2 adjudication |
|---|---|---|---|
| **UC-1** Direct Web Capture (browser extension) | CODE **complete**; EXTERNAL pending (store listing) | `apps/extension` (MV3), writes `DIRECT_WEB_CAPTURE_EXTENSION` | **UPHELD.** Not exercised by this audit — the extension is outside the PWA↔Native comparison. |
| **UC-2** Android Screen Capture (MediaProjection) | CODE **complete**; PHYSICAL pending (Android device) | `modules/proovra-screen-capture/android/**` + `app/(stack)/screen-capture.tsx` | **UPHELD for Android.** Note `screen-capture.tsx:57` gates the JS screen to `Platform.OS === "android"`, which is consistent with this UC's scope. |
| **UC-3** Android continuous capture | CODE **complete**; PHYSICAL pending (Android device) | `ContinuousScreenCaptureService.kt`, `src/continuous-capture.ts`, `app/(stack)/continuous-capture.tsx` | **CONTRADICTED on CODE.** The shared finalize handler carries V2-003 (label/behaviour contradiction) and V2-004. See below. |
| **UC-4** Derived intelligence on a captured record | CODE **complete**; nothing pending | on the UC-0 spine | **UPHELD.** Not independently re-verified. |
| **UC-5** iOS screen capture (ReplayKit) | CODE **complete**; EXTERNAL pending (signing identity); PHYSICAL pending (broadcast picker, `crypto.subtle`) | `modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift`, `ProovraBroadcastShared.swift`; JS entry via `/continuous-capture` | **CONTRADICTED on CODE.** See below. |
| **UC-6** Release acceptance / controlled launch | Android physical acceptance **NOT_TESTED**; §0 pre-flight requires confirming the deployed API's `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS` | `docs/uc6-release-acceptance.md:76`, `:424` | **UPHELD, and its §0 pre-flight is now the highest-priority item** — V2-001 is exactly the failure it predicted. |

---

## UC-5 — why "CODE: COMPLETE" does not hold

The disposition places every UC-5 remainder on EXTERNAL (signing) and PHYSICAL
(device). This audit finds **two CODE defects on the only iOS screen-capture
path a user can reach**:

1. **V2-004 — there is no iOS `/screen-capture`.**
   `app/(stack)/screen-capture.tsx:57` is `Platform.OS === "android" && …`;
   `:188` renders an unsupported state otherwise. The iOS native module exists
   but this screen never calls it. `capture.tsx:1395-1417` therefore routes the
   iOS **"Screen capture"** button to `/continuous-capture`. The same label
   leads to two different flows depending on platform, with nothing in-product
   saying so.

2. **V2-003 — the iOS finalize control misstates what it does.**
   `continuous-capture.tsx:417` renders a button labelled **"Finish & Sign"** —
   the same name as the canonical sealing action at `capture.tsx:1547` — and the
   copy above it at `:415` states it *"seals these segments into one evidence
   record."* The handler (`:263-344`) **stages** and navigates away;
   `src/continuous-capture.ts:13` says plainly **"IT DOES NOT SEAL."**

Neither is EXTERNAL and neither is PHYSICAL. Both are resolvable in this
repository, which is the disposition document's own test for a CODE item.

**UC-5 CODE status should read PARTIAL, not COMPLETE.** UC-3 inherits V2-003
because it shares the same screen and handler.

### On the `crypto.subtle` note
UC-5 lists `crypto.subtle` as a device-only unknown. The **JavaScript** upload
path no longer uses it: `src/upload-utils.ts:11-25` records that it was replaced
with `expo-crypto` `Crypto.digest` (`:193`), because React Native has no
WebCrypto. If the remaining concern is the **Swift** Broadcast Extension's own
hashing, that is genuinely device-only and the note stands — but it should name
the extension rather than the JS path, which is closed.

---

## What each UC still needs, by axis

| UC | CODE (resolvable here) | EXTERNAL | PHYSICAL |
|---|---|---|---|
| UC-1 | — | publish the extension; point the web install CTA at it | — |
| UC-2 | — | — | Android device |
| UC-3 | **V2-003** (label/copy vs behaviour) | — | Android device |
| UC-4 | — | — | — |
| UC-5 | **V2-003, V2-004** | Broadcast Extension signing identity + provisioning profile | iOS device: ReplayKit picker; extension-side hashing |
| UC-6 | — | **V2-001** — set `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS` on the deployed API; **J.4** — replace `<APPLE_TEAM_ID>` in the AASA | Android + iOS device acceptance |

---

## Tests vs acceptance

`native-destinations.mjs` records `physicallyAccepted: false` for **all 62**
surfaces. The repository is explicit that this flag may never be set from CI
(`native-destinations.mjs:36-44`), and this audit did not set it, did not run
any test, and produced no device evidence.

**A green test suite is not acceptance of any UC.** The prior audit's
"942/942 passing" is carried as its claim and was not re-executed here.
