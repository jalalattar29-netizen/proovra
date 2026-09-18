# PROOVRA — UNIVERSAL CAPTURE PRODUCT-SURFACE & ANDROID RUNTIME CLOSURE

**Document type:** Implementation closure record for the corrective work that followed
`UNIVERSAL_CAPTURE_PRODUCT_SURFACE_PLATFORM_ROUTING_AUDIT.md`.
**Date:** 2026-09-18
**Feature branch:** `fix/universal-capture-product-runtime-closure` (isolated git worktree `D:\pv-capture-closure`).
**Baseline:** branched from `origin/main` `fefb014e`.
**Integration:** the branch is pushed for review; **main is intentionally NOT merged** in this session (a concurrent session is also converging on main; merge is deferred to a coordinated step).

> **Status vocabulary** (used precisely below): **IMPLEMENTED** (code written), **TESTED** (automated
> test proves it), **BUILT** (the package's own build ran), **LINKED** (native module autolink-proven),
> **PACKAGED** (compiled into an installable native binary — requires Android SDK/EAS), **RUNTIME_ACCEPTED**
> (verified on a real device), **DEFERRED** (could not be executed in this environment), **UNPUBLISHED**,
> **NOT DEPLOYED**.

---

## VERDICT

### UNIVERSAL CAPTURE ANDROID PRODUCT/RUNTIME CODE CLOSURE NOT COMPLETE · UC-5 MUST NOT BEGIN

Every **code/architecture** finding is closed and test-guarded on the branch:
- **P0: 0.** No acquisition-mode corruption, no ORIGINAL mutation, no auth/commercial bypass, no
  DERIVED-as-ORIGINAL. (Confirmed: no `services/api` or `services/worker` source was touched.)
- **Code/architecture P1 (F1–F7): IMPLEMENTED + TESTED.**
- **P2/P3 (F8, F9, F11, F12): IMPLEMENTED + TESTED / BUILT.**
- **F10 (native packaging): PARTIAL.** The native module is now **LINKED** (autolinking-proven) and its
  AndroidManifest is correct, but a native **compile/PACKAGE** into an APK/AAB **could not be executed**
  (no Java/Android SDK and no authorized EAS build in this environment), so BUILDABLE/PACKAGED remain
  unproven.

Per the audit's own UC-5 gate: because the Android native app's **compile/package is not proven** and
**physical device acceptance did not run**, the honest verdict is **NOT COMPLETE** and **UC-5 must not
begin**. The remaining work is not more code — it is a native build on a machine with the Android
toolchain (or EAS) plus on-device acceptance, and the main integration + final-HEAD CI.

---

## COMMITS (feature branch)

| SHA | Scope |
|---|---|
| `2545bfc2` | F7 — canonical cross-platform capture-capability authority + 15 matrix tests |
| `7c30508a` | F4/F5/F6 — native Android boot + UC-2/UC-3 native contract + 3 guard suites |
| `280d0347` | F1/F2/F3/F9/F11 — truthful web Direct Web Capture + disclosure page + guards |
| `b5ffc927` | F8/F12 — truthful extension denial copy + real store icons |
| (this doc) | closure record |

---

## FINDING-BY-FINDING RESOLUTION

### F7 (P1) — canonical capture-capability authority — **IMPLEMENTED + TESTED**
- **New:** `packages/shared/src/capture-capability.ts` (exported from `packages/shared/src/index.ts`).
  THE one resolver: `resolveCaptureCapabilities` / `resolveWebCaptureCapabilities`, plus
  `resolveExtensionDistribution`, `classifyWebPlatform`, `classifyWebBrowserSupport`.
- Answers a **product/platform** question only; decides **no** authorization or commercial eligibility
  (those stay with their canonical authorities). Pure/isomorphic (no DOM/env/IO). Dimensions:
  platform (`WEB_DESKTOP|WEB_MOBILE|ANDROID_NATIVE|IOS_NATIVE|UNKNOWN`), browser family, extension
  distribution (`PUBLISHED|UNPUBLISHED`), native probes → availability states
  (`AVAILABLE|COMING_SOON|UNSUPPORTED_PLATFORM|UNSUPPORTED_BROWSER|UNAVAILABLE`).
- **Tests:** `packages/shared/tests/capture-capability.test.mjs` (15). Full shared suite **986/986**.

### F1 (P1) — dead 404 install path — **IMPLEMENTED + TESTED**
- `resolveExtensionDistribution` accepts **only** a genuine external store URL (Chrome Web Store / Edge
  Add-ons, https). A relative/internal path (e.g. `/settings/legal/direct-web-capture`) can never resolve
  to `PUBLISHED` — the dead-fallback class is impossible at the source.
- The card (`apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx`) no longer coalesces the env
  var to an internal path.
- **Tests:** route-integrity guard + shared distribution tests + render test (internal fallback → no install).

### F2 (P1) — false extension availability — **IMPLEMENTED + TESTED**
- The install control renders **only** when `canInstall` (supported desktop browser **and** a validated
  external store URL). While unpublished the card shows a truthful **COMING_SOON** state — no install control.
- **Tests:** shared matrix (`PUBLISHED` vs `UNPUBLISHED`) + render test (unset env → COMING_SOON, no link).

### F3 (P1) — wrong-platform extension CTA — **IMPLEMENTED + TESTED**
- The card consumes F7 via `useCaptureCapabilities` (reads navigator/Client-Hints). Mobile web →
  `UNSUPPORTED_PLATFORM` (points to desktop), non-Chromium desktop → `UNSUPPORTED_BROWSER`, never an install
  control. The native app never renders this surface at all (guarded — see F4 boot guard).
- **Tests:** shared matrix (mobile/iOS never installable) + jsdom render test across UAs.

### F4 (P1) — native app cannot boot — **IMPLEMENTED + TESTED (functional boot = device-DEFERRED)**
- `apps/mobile/app/_layout.tsx` rebuilt as the ONE root: `ErrorBoundary > LocaleProvider > AuthProvider >
  ToastProvider > Stack`, hosting the `(tabs)`/`(stack)` groups. Providers are now mounted, so
  `app/index.tsx`'s `useAuth()` resolves instead of throwing. No parallel nav tree; the real tab set stays
  in `app/(tabs)/_layout.tsx`.
- **Tests:** `mobile-boot-contract` (root mounts all providers + a navigator; native capture entries are
  Android-gated; the web DWC surface never leaks into native). Mobile typecheck clean.
- **DEFERRED:** a *functional* boot render (native runtime) is part of device acceptance (§ below).

### F5 (P1) — UC-2 JS↔Kotlin name mismatch — **IMPLEMENTED + TESTED**
- Kotlin `AsyncFunction("stop")` → `AsyncFunction("stopCapture")` (aligned to the JS public API; no alias).
  File: `…/ProovraScreenCaptureModule.kt`.
- **Tests:** `native-module-contract` — every native method the JS binding invokes exists in Kotlin, and
  the stale `stop` name is gone.

### F6 (P1) — UC-3 service undeclared — **IMPLEMENTED + TESTED**
- `ContinuousScreenCaptureService` declared in the module AndroidManifest (`exported=false`,
  `foregroundServiceType="mediaProjection"`).
- **Tests:** `android-manifest-contract` — every Kotlin `*Service` class must be declared with the
  mediaProjection type; fails if the continuous service is removed.

### F8 (P2) — extension mislabels quota denial as a capture plan — **IMPLEMENTED + TESTED**
- New `apps/extension/src/lib/denial-copy.ts` maps real evidence-creation/quota/entitlement denial codes to
  truthful copy (mirrors the web `toSafeUserError`); `popup.ts` no longer claims a Direct-Web-Capture plan
  restriction. Capture stays plan-blind. **Tests:** 8 new (extension suite 21/21).

### F9 (P2) — missing disclosure page — **IMPLEMENTED + TESTED**
- `apps/web/content/legal/en/direct-web-capture.md` authored (what DWC records, integrity after ingestion,
  user-initiated/no hidden surveillance, permissions at a high level, the trust boundary reusing the
  canonical acquisition qualifier + UC-1 limitation texts, one `[Counsel review required]` marker on
  admissibility). Slug + hero registered (`legal-content.tsx`, `legal-hero-meta.ts`). One canonical content
  source serves both the authenticated and public routes. It is a "learn how it works" page, **not** the
  install target. **Tests:** repo legal suites 40/40; route-integrity asserts the slug exists.

### F11 (P2) — no truthful unsupported/mobile state — **IMPLEMENTED + TESTED**
- Covered by the F3 availability states; the card always shows a truthful availability line + a learn-more
  link on every platform.

### F12 (P3) — missing store icons — **IMPLEMENTED + BUILT**
- Real 16/48/128 PNG icons produced from the canonical PROOVRA app mark (`apps/mobile/assets/icon.png`; no
  second identity). Verified exact dimensions + PNG signature; manifest references resolve; extension build
  emits `dist/icons/*`.

### F10 (P1) — native packaging path — **PARTIAL: LINKED + config-correct; PACKAGED = DEFERRED**
- **Proven (LINKED):** `expo-modules-autolinking search --platform android` discovers
  `proovra-screen-capture` → `com.proovra.screencapture.ProovraScreenCaptureModule`. The module is
  autolink-eligible and would be compiled into a native build; combined with F6 it is no longer
  "SOURCE_PRESENT_ONLY".
- **DEFERRED (PACKAGED/RUNTIME):** a Kotlin→APK/AAB compile could not run — no Java, no `ANDROID_HOME`/SDK,
  and no authorized EAS build in this environment. `eas.json` profiles exist (development/preview/production,
  `EXPO_USE_WORKSPACE_ROOT=1`; `submit.production` still an empty stub). See "Native build" below.

---

## CANONICAL CAPABILITY AUTHORITY (Law of One)

One new authority added: `capture-capability.ts`. No duplication introduced — the acquisition-mode
vocabulary (`evidence-acquisition.ts`), CaptureSession/ingest, authorization, commercial and storage
authorities are unchanged. Platform capability and authorization/commercial remain **separate** dimensions
(the resolver never reads plan/quota). The web card and (guarded) mobile Home both defer to platform truth;
mobile screen capture continues to gate on `Platform.OS==="android"` + the native support probe.

---

## PLATFORM ROUTING — CURRENT BEHAVIOUR AFTER THE FIX

| Surface | Direct Web Capture | Install CTA | Native screen capture |
|---|---|---|---|
| Web desktop Chromium, extension published | AVAILABLE | external store link | n/a (web) |
| Web desktop Chromium, unpublished | COMING_SOON | **none** | n/a |
| Web desktop non-Chromium | UNSUPPORTED_BROWSER | **none** | n/a |
| Web mobile | UNSUPPORTED_PLATFORM (use desktop) | **none** | n/a |
| Android native app | not shown (native surface only) | **none** | UC-2 + UC-3, Android-gated |
| iOS native app (UC-5 not built) | not shown | **none** | none (truthful absence) |

Proven by: shared matrix tests (15), web render test (5), mobile boot guard, and the "web DWC never in
native" guard.

---

## ACQUISITION-MODE + ORIGINAL/DERIVED REGRESSION

No change to `packages/shared/src/evidence-acquisition.ts`, the completion routes, or the worker. UC-2
seals ONE Evidence with N ORIGINAL `screen_frame` parts; UC-3 ONE Evidence with N ORIGINAL `screen_segment`
parts; UC-4 produces DERIVED assets. Modes `DIRECT_SCREEN_CAPTURE_ANDROID` /
`…_CONTINUOUS` are untouched and immutable. Shared suite (986) includes the acquisition + ORIGINAL/DERIVED
contracts and is green.

## UC-4 / DOWNSTREAM LIFECYCLE

No `services/worker` or `services/api` source changed on this branch, so UC-4 Derived Review, Library,
Detail/Inspector, Cases, Search, Reports, Packages, Verify, storage accounting, retention, legal hold and
destruction are unaffected by design. Their suites run in CI against the DB (not runnable locally here — see
below). UC-4 continues to consume UC-2 `screen_frame` / UC-3 `screen_segment` evidence structurally.

## AUTH / COMMERCIAL

No plan gate introduced. Capture remains plan-blind and Personal-Space-visible (unchanged server authority).
The only commercial-adjacent change is the extension F8 copy, which now states the true evidence-creation
/quota reason instead of a fictional capture plan.

---

## PERMANENT GUARDS ADDED (root causes, not just symptoms)

| Guard | File | Catches |
|---|---|---|
| A/B route + install integrity | `apps/web/__tests__/capture-direct-web-route-integrity.test.ts` | F1 (dead link), F2 (unconditional install) |
| C platform matrix | `packages/shared/tests/capture-capability.test.mjs` | F3 (wrong-platform), install truthfulness |
| C (render) | `apps/web/__tests__/render/capture-direct-web-card.render.test.tsx` | per-platform DOM |
| D mobile boot | `apps/mobile/test/mobile-boot-contract.test.mjs` | F4 (providerless root), web surface leaking into native |
| E JS↔Kotlin contract | `apps/mobile/test/native-module-contract.test.mjs` | F5 (missing native method / event) |
| F service↔manifest | `apps/mobile/test/android-manifest-contract.test.mjs` | F6 (undeclared foreground service) |

Acquisition-mode + ORIGINAL/DERIVED regressions (guards G/H) are already enforced by the existing shared
`evidence-acquisition` suite (unchanged, green).

---

## BUILD / TEST EVIDENCE (this environment)

| Gate | Result |
|---|---|
| shared build (`tsc -p tsconfig.build.json`) | OK |
| shared tests (`node --test tests/*.test.mjs`) | **986/986** |
| web typecheck (`tsc --noEmit`, incl. build:deps) | **clean** |
| web route-integrity (`run-tests capture-direct-web-route-integrity`) | **4/4** |
| web render (`vitest test:render capture-direct-web-card`) | **5/5** |
| web existing capture contracts (target-surfaces, mobile-no-personal-capture) | 13/13, 7/7 |
| web production build (`next build`) | **OK (exit 0)** — full route table compiled |
| mobile typecheck (`tsc --noEmit`) | **clean** |
| mobile tests (`node --test`) | **39/39** (incl. 3 new guards + UC-2/UC-3 flow) |
| extension typecheck / tests / lint / build | clean / **21/21** / MV3 lint OK / dist 9 files incl. icons |
| eslint (changed web/shared/mobile files) | clean |
| native module autolinking (android) | `proovra-screen-capture` **LINKED** |

### Web build
`pnpm build` (`next build`) completed **exit 0** in this environment, compiling the full route table
(including `/capture`, `/verify/[token]`, and the `/settings/legal/[slug]` reader). This is the production
build proof for the web changes, alongside the clean typecheck and the render/route-integrity suites.

### Native build (Android) — DEFERRED with exact blockers
- Attempted probes: `java -version` → **not found**; `ANDROID_HOME`/`ANDROID_SDK_ROOT` → **empty**;
  `expo-modules-autolinking search --platform android` → **module linked** (proven).
- Blocker class: **environment/toolchain** (no JDK, no Android SDK) and **no authorized EAS build** (remote
  EAS would consume external build/release infra and is out of scope without explicit authorization).
- What is proven at source/config: JS↔Kotlin contract correct (F5 + guard E), both foreground services
  declared (F6 + guard F), module autolinks (F10 LINKED), Expo config resolves (`plugins:["expo-asset"]`,
  `android.package=com.jalalattar29.proovra`), EAS profiles present.
- What remains runtime-unproven: Kotlin compilation, manifest merge in a real build, APK/AAB packaging, app
  install and boot on hardware.

### Not runnable locally (by policy) — run in CI
- `services/api` / `services/worker` integration suites need Postgres/Redis; the local API `.env` carries
  live production credentials, so these were **not** run locally (prod-safety). No backend source changed on
  this branch, so these are expected unchanged; CI must run them against its own DB.
- clean-db/raw-schema reproducibility: DB-backed; no migration was created (none required), so no schema
  drift to reconcile.

---

## MIGRATION / BUILD / DEPLOY / PUBLICATION STATE

- **Migration required:** **NO.** No schema change; acquisition modes and part kinds already exist.
- **Android rebuild required:** **YES** — F4/F5/F6 are native; a new custom EAS build (not Expo Go) is
  required, then device acceptance. No OTA can deliver them.
- **Extension publication:** still **UNPUBLISHED** (no store URL; version/name unchanged). F8/F12 are
  readiness fixes only. The web install CTA stays hidden until a real store URL is configured.
- **Web redeploy required:** **YES** for the truthful card + disclosure page (web-only; no migration).
- **Production:** **NOT DEPLOYED / NOT MUTATED.** No deploy, no DB write, no external publication performed.

---

## PHYSICAL / RUNTIME ACCEPTANCE — DEFERRED

- **UC-2 / UC-3 on-device acceptance:** **DEFERRED — no Android device/emulator and no packaged binary in
  this environment.** The full UC-2 (frame → MediaProjection consent → foreground notification → Capture
  Frame → Stop & Review → Finalize → ONE Evidence, N ORIGINAL `screen_frame`) and UC-3 (segments → Stop →
  Finalize → ONE Evidence, N ORIGINAL `screen_segment`) sequences must be run on hardware.
- **UC-1 browser acceptance:** unchanged (still DEFERRED); the extension stays unpublished.
- **Functional mobile boot:** the boot fix is proven by source contract; a device/emulator render is part of
  the deferred acceptance.

---

## FILES CHANGED / CREATED
- `packages/shared/src/capture-capability.ts` (new), `packages/shared/src/index.ts`,
  `packages/shared/tests/capture-capability.test.mjs` (new)
- `apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx`,
  `apps/web/app/(app)/capture/_lib/useCaptureCapabilities.ts` (new),
  `apps/web/components/capture-v2/capture-workspace.css`,
  `apps/web/app/legal/legal-content.tsx`, `apps/web/app/legal/legal-hero-meta.ts`,
  `apps/web/content/legal/en/direct-web-capture.md` (new),
  `apps/web/__tests__/capture-direct-web-route-integrity.test.ts` (new),
  `apps/web/__tests__/render/capture-direct-web-card.render.test.tsx` (new)
- `apps/mobile/app/_layout.tsx`,
  `…/proovra-screen-capture/android/…/ProovraScreenCaptureModule.kt`,
  `…/proovra-screen-capture/android/src/main/AndroidManifest.xml`,
  `apps/mobile/test/{native-module-contract,android-manifest-contract,mobile-boot-contract}.test.mjs` (new)
- `apps/extension/src/lib/denial-copy.ts` (new), `apps/extension/src/popup.ts`,
  `apps/extension/build-test.mjs`, `apps/extension/test/denial-copy.test.mjs` (new),
  `apps/extension/public/icons/icon-{16,48,128}.png` (new)

## FILES DELIBERATELY NOT DUPLICATED / NOT TOUCHED
`packages/shared/src/evidence-acquisition.ts`, `services/api/**`, `services/worker/**`, the
CaptureSession/ingest services, commercial/storage/retention/hold/destruction authorities, and the
`settings/legal/[slug]` reader mechanism — all extended-by-reference or untouched.

---

## WHAT MUST HAPPEN BEFORE UC-5 (in order)
1. Native Android build on a machine with the Android toolchain (or an authorized EAS `preview`/`production`
   build) — prove Kotlin compiles, both services survive manifest merge, and an APK/AAB installs and boots.
2. On-device UC-2 + UC-3 acceptance to sealed Evidence (modes + ORIGINAL part kinds verified downstream).
3. Web redeploy of the truthful card + disclosure page.
4. Merge the branch to main (coordinated with the concurrent main work) and confirm the **final main HEAD**'s
   required CI (including the DB-backed API/worker suites) is green.

Only when 1–2 are green (compile/package proven + device acceptance, or explicitly accepted deferral with a
proven compile) may a closure record state **UC-5 MAY BEGIN**. Today it does not.

---

## PRODUCTION SAFETY STATEMENT
No production deploy, no production DB mutation, no migration, no extension publication, no Play Store
submission, no iOS work, no customer-evidence access, and no destructive jobs were performed. All work is on
the isolated feature branch/worktree; main was not merged or pushed by this session.
