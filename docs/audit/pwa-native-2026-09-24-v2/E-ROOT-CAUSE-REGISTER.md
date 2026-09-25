# E — GLOBAL ROOT-CAUSE REGISTER (v2)

**Frozen revision:** `71e148f34410c7c231f8930d1387d8924b10b4e5`

Confidence vocabulary, used strictly:

* **A / CONFIRMED-BY-SOURCE** — decidable from committed source alone.
* **B / SOURCE-SUPPORTED HYPOTHESIS** — source makes it the leading explanation; one named runtime fact would settle it.
* **C / REQUIRES RUNTIME EVIDENCE** — source cannot decide it.

The user reported five classes of failure on a physical iPad. Each is traced below to source **independently of the report**.

---

## V2-001 — Native OAuth token audiences are not in the API allow-list

**Category:** DATA MISMATCH / configuration · **Confidence: B (high)**
**User-visible impact:** Google **and** Apple sign-in both fail on device.

### Mechanism

`apps/mobile/src/auth/use-oauth.ts:85-90` requests an `IdToken` from Google using the **platform** client id:

```
Google.useAuthRequest({ iosClientId, androidClientId, webClientId,
                        responseType: AuthSession.ResponseType.IdToken, ... })
```

On iOS the issued `id_token` therefore carries `aud = EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`
(`548168595768-uhugauso4ep7n9auc4rh8jbihmv971tm.apps.googleusercontent.com`, `apps/mobile/eas.json:14`).

Apple: `AppleAuthentication.signInAsync` (`use-oauth.ts:143`) issues an identity token whose `aud` is the **bundle id** `com.jalalattar29.proovra` (`apps/mobile/app.json:41`).

The server accepts neither by default. `services/api/src/services/auth.service.ts`:

```
157:  assertAudience(payload.aud, allowedAudiences("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_IDS"));
252:  assertAudience(payload.aud, allowedAudiences("APPLE_CLIENT_ID", "APPLE_CLIENT_IDS"));
```

`allowedAudiences` (`auth.service.ts:121-131`) is the union of the primary var and a comma-separated list var, and **throws when both are empty**.

### Evidence that the list vars are not set

`GOOGLE_CLIENT_IDS` and `APPLE_CLIENT_IDS` appear **nowhere in the repository except those two call sites** — not in `services/api/.env.example`, not in `services/api/src/env.ts`, not in `infra/`, not in any deployment template.

The only repository record of production values is `services/api/.env.production-backup-1789524624714` (untracked and gitignored — verified with `git ls-files` and `git check-ignore`):

```
GOOGLE_CLIENT_ID=548168595768-8uddhhcmdgl9108juth8fke4boncenut.apps.googleusercontent.com   <- the WEB client id
APPLE_CLIENT_ID=com.proovra.web                                                              <- the WEB Services ID
```

Neither the iOS client id nor the bundle id is present, and no `*_CLIENT_IDS` line exists. Under that configuration `assertAudience` rejects **every** native Google and Apple sign-in.

### Already documented, already flagged

* `apps/mobile/docs/EXTERNAL_CONFIG.md:27` — *"Backend audience allowlist: the API must accept the iOS/Android/Web client [ids]"*; `:39` — *"Backend audience: must accept the bundle id `com.jalalattar29.proovra`."*
* `docs/uc6-release-acceptance.md:424` — *"Confirm the deployed API's `GOOGLE_CLIENT_IDS` includes them, and `APPLE_CLIENT_IDS` includes the bundle id ... a mismatch fails sign-in for a configuration reason that looks like a code defect."*

The prior audit recorded this as `CODE_PRESENT / UNVERIFIED` (`E-critical-journey-matrix.md:52`). This audit **upgrades it to the leading explanation of an observed production failure**, on the strength of the recovered production env values.

### Minimal evidence to close

One command on the API host: `printenv GOOGLE_CLIENT_ID GOOGLE_CLIENT_IDS APPLE_CLIENT_ID APPLE_CLIENT_IDS` — **or** the response body of one failing `POST /v1/auth/apple` from the device.

### Ruled out by source (NOT the cause)

* The iOS reversed-client-id URL scheme **is** correctly registered (`app.json:64` = `com.googleusercontent.apps.548168595768-uhugauso4ep7n9auc4rh8jbihmv971tm`, matching `eas.json:14`).
* `usesAppleSignIn: true` **is** set (`app.json:44`).
* `eas.json` carries real client ids on **all four** build profiles.

---

## V2-002 — A locally-bundled build cannot offer Google sign-in at all

**Category:** BEHAVIORAL / configuration · **Confidence: A (confirmed by source)**

`apps/mobile/.env` (present on disk, dated Feb 2026) declares only:

```
EXPO_PUBLIC_API_BASE, EXPO_PUBLIC_WEB_BASE,
EXPO_PUBLIC_GOOGLE_CLIENT_ID     <- the OLD generic name
EXPO_PUBLIC_APPLE_CLIENT_ID
```

The current code reads **only** `EXPO_PUBLIC_GOOGLE_{IOS,ANDROID,WEB}_CLIENT_ID` (`use-oauth.ts:45-47`). `EXPO_PUBLIC_GOOGLE_CLIENT_ID` is read by nothing in the repository.

Therefore in any bundle built from this `.env` (local `expo run:ios`, dev client, Metro), `platformClientId` is `undefined` → `googleConfigured === false` → `promptGoogle` refuses immediately with `OAUTH_GOOGLE_UNCONFIGURED` (503) (`use-oauth.ts:128-136`), and `googleReady` is false.

**Distinct from V2-001** and produces a *different* symptom — the button refuses before any network call, rather than the server rejecting a token. Which one the user hit depends on how the installed build was produced: an EAS build hits V2-001, a locally-bundled build hits V2-002.

The comment at `use-oauth.ts:60-70` records that an earlier form of this **crashed the sign-in screen during render**, measured on a physical iPad on 2026-09-24. That crash is fixed at the frozen revision (the provider is now fed a placeholder). The *refusal* remains.

---

## V2-003 — "Finish & Sign" on continuous capture does not sign, and says it does

**Category:** CONTENT MISMATCH + BEHAVIORAL MISMATCH · **Confidence: A**
**User-visible impact:** screen-capture finalization appears to fail.

Two different controls in the native app carry the **same label**:

| Control | Source | What it actually does |
|---|---|---|
| Canonical completion | `app/(stack)/capture.tsx:1547` — `Finish & Sign (n)` | calls `completeAcquisition` (`:1251`) → **seals**, produces signed Evidence |
| Continuous capture | `app/(stack)/continuous-capture.tsx:417` — `Finish & Sign` | calls `finalize` (`:263-344`) → **stages only**, then `router.replace("/capture")` with the toast *"Recording staged — review and finish in Capture"* |

The body copy directly above the second button (`continuous-capture.tsx:415`) states:

> "Finish & Sign **seals these segments into one evidence record.**"

That sentence is false for that button, and the module's own header says so explicitly — `src/continuous-capture.ts:13`: **"IT DOES NOT SEAL. Completion is the canonical Finish & Sign in Capture (F-08)."**

A user who presses it is told the evidence is sealed, is moved to a different screen, and has no signed record. On iOS this is the **only** screen-capture path available (see V2-004), so it is the entire iPad screen-capture experience.

### Aggravating factors in the same handler

* Every failure in a five-step chain (`drainUploads` → `stageContinuousCapture` → `sealDirectCapture` → `openCaptureDraft` → `saveCaptureSession`) collapses to one opaque string, *"Could not finalize the evidence."* (`:343`).
* That failure is **terminal**: `sessionRef.current = null`, and the screen deliberately offers no retry (`:340-342`).
* `toScreenDraftItem({ ..., sizeBytes: 0 })` (`:308`) hardcodes a zero byte count into the draft item.

---

## V2-004 — iOS has no `/screen-capture`; the Android-only gate is silent

**Category:** STRUCTURAL / platform divergence · **Confidence: A**

`app/(stack)/screen-capture.tsx:57`:

```
const supported = Platform.OS === "android" && isScreenCaptureSupported();
```

`:188` renders an unsupported state for everything else. The iOS native module **exists** (`modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift`, `ProovraBroadcastShared.swift`) but this screen never uses it.

`capture.tsx:1395-1417` accordingly routes the iOS **"Screen capture"** button to `/continuous-capture` instead. So the label "Screen capture" leads to the *continuous* flow on iOS and to the *frame* flow on Android, and Android additionally gets a second button, "Continuous screen capture", that iOS does not.

Defensible as a platform adaptation, but **undocumented in-product**: nothing tells the iOS user the two are different, and it routes them into the flow that carries V2-003.

---

## V2-005 — The native app has no global chrome, so global search does not exist

**Category:** STRUCTURAL MISMATCH · **Confidence: A**
**User-visible impact:** "missing search functionality"; also the likely reason the wrong workspace's data is seen with no obvious way to correct it.

### PWA

`app/(app)/layout.tsx` wraps every authenticated surface in `AppShellV2` (`components/app-shell-v2/`, **2,757 lines across 6 components + a stylesheet**). `AppShellV2.tsx` renders, on **every** authenticated page:

| Element | Source |
|---|---|
| skip link `#app-main-content` | `AppShellV2.tsx:195` |
| sidebar (`AppSidebarV2`, 772 lines) | `:212-213` |
| header toolbar (`AppAccountToolbar`, 784 lines) | `:216-217` |
| **"Open command palette (search)"** | `AppAccountToolbar.tsx:328` |
| system status | `:365` |
| language selector | `:373` |
| **workspace switcher** — *"Active workspace: ... Open workspace switcher."* + unsaved-work warning | `:402`, `:427`, `:442-445` |
| user avatar + account menu | `:583`, `:708` |
| notification bell (`NotificationBell`, 722 lines) | via toolbar |
| `CommandPalette` | `AppShellV2.tsx:252` |
| `WorkspaceRecoveryPanel` / `PersonalSpaceUnavailablePanel` | `:241`, `:243` |
| mobile drawer sidebar | `:276` |

The sidebar is **derived**, not hardcoded: `ROUTE_REGISTRY` → `resolveRouteAccess` → `resolveNavigationExposure` → `resolveNavigationDisclosure` → `resolveNavigationGroups`, with per-route icons (`lib/navigation/routeIcons.ts`), groups, disclosure tiers and degradation chips (`AppSidebarV2.tsx:19-46`).

### Native

`src/ui/shell.tsx` — **175 lines**, the entire global chrome. It renders a nav only: a phone bottom bar or a tablet rail (`ProovraShell:110`), from a **hardcoded 7-item array** (`useNavItems():24-33`):

> Home · Capture · Cases · Evidence · Reports · Alerts · Settings

Each item is a text label plus a two-colour indicator bar (`NavButton:40-70`). There are **no icons**.

**There is no header.** No logo, no search, no command palette, no workspace switcher, no account menu, no notification bell, no language selector, no skip link, no breadcrumbs, no recovery panel. `app/(tabs)/_layout.tsx` explicitly hides the expo-router tab bar and defers to `ProovraShell`.

### Consequences established from source

1. **Global search does not exist.** `/search` is reachable from exactly **one** place in the entire app — a card at the top of Home, `app/(tabs)/index.tsx:280`. Verified by exhaustive scan of every `router.push` / `router.replace` / `href` in `apps/mobile/app` and `apps/mobile/src`. A user on Evidence, Cases, Reports, Alerts or Settings has no search at all.
2. **No workspace switcher in the chrome.** `/spaces` is reachable only from a row inside the Settings tab (`app/(tabs)/settings.tsx:174`). The PWA offers it in the header on every page.
3. **Nav breadth.** 7 hardcoded destinations with no capability gating, vs a registry-derived, capability-gated, grouped sidebar over the applicable route set.
4. **`app/(tabs)/teams.tsx` is not in the nav** despite being a tab screen; it is reachable only via `settings.tsx:259` and an invite deep link.

### The Settings tab is doing the sidebar's job

Exhaustive destination→source mapping shows `app/(tabs)/settings.tsx` is the sole in-app entry point for **14+** surfaces: billing, batch-analysis, quotas, organizations, AI settings, notification settings, privacy, reviewer-criteria, security, spaces, support, trust-center, evidence-requests, intake-links, legal, teams, verify, workspace-people.

---

## V2-006 — Native `/search` fails silently when the workspace id is unresolved

**Category:** BEHAVIORAL MISMATCH · **Confidence: A**

`app/(stack)/search.tsx:57` takes `teamId = context?.activeTeamId ?? null`. `src/product/search.ts:110` — `buildSearchPath` returns `null` when `teamId` is falsy. The screen then takes the `if (!path)` branch (`search.tsx:95-100`): `setPhase("idle"); setRows([]); setCursor(null)` — **no error, no explanation**. The box accepts typing and never searches.

**Ruled out as the cause of a null id:** native's read is correct. The server populates `activeSpace.id` from `workspace.id` or `personalSpace.id` and only emits `null` when bootstrap genuinely failed (`services/api/src/services/platform-context/platform-context.service.ts:1137-1167`), and native's `projectPlatformContext` reads exactly that field (`src/product/platform-context.ts:70-78`). This matches the web's **canonical** `useActiveWorkspaceId`, and is in fact *better* than the deprecated `useWorkspaceId()` that the web's own `/search` page still uses (`app/(app)/search/page.tsx:547`, `lib/platform-context/useTeamWorkspaceGate.ts:102-107`).

The defect is the **silent presentation**, not the resolution. The PWA renders a `WorkspaceRecoveryPanel` for the degraded-id case (`AppShellV2.tsx:241`); native renders an idle search box.

---

## V2-007 — `/operations` and `/operations/health` are applicable and absent

**Category:** MISSING IN NATIVE · **Confidence: A**

Established in `00-BASELINE.md` §3c: both are tier **CORE**, `directAccessPolicy: "allow"`, deliberately moved out of INTERNAL so that "a tenant admin looking at a failed report" can reach their workspace's unresolved work. There is no native screen for either.

Native ships `(stack)/operations/batch-analysis.tsx` and `(stack)/operations/quotas.tsx` — the **PROFESSIONAL** sub-surfaces — but not the CORE parent Operations surface itself.

This confirms the prior audit's instinct to hand-add these two rows, and corrects the manifest that excluded them.

---

## V2-008 — Native `/search` is a 287-line screen against a 3,683-line PWA surface

**Category:** STRUCTURAL + BEHAVIORAL MISMATCH · **Confidence: A (scale); per-feature adjudication in `D-PER-PAGE.md`**

| | PWA | Native |
|---|---:|---:|
| `app/(app)/search/page.tsx` | **3,683 lines** | — |
| `app/(stack)/search.tsx` | — | **287 lines** |

The PWA surface carries a workspace readiness/health envelope with four declared index states (`healthy | partial_index | empty_index | empty_workspace`, `page.tsx:251`), a search-activity log, restricted-result handling, and reviewer-scope guards documented at `:507-544`. Native carries query, filter chips, mode, recency, cursor paging and a result count.

This is recorded as a scale finding here; the element-level disposition is in the per-page register.

---

# V4 ADDITIONS — 2026-09-24. Nothing above retracted.

## V4-001 — Native loads no fonts; every text element is the system face
**Category:** VISUAL / MISSING ASSET + INCORRECT VALUE · **Confidence: A** · **Blast radius: every text element, all 64 routes**

`apps/mobile/src/locale-context.tsx:111-112` sets
`fontFamily = isRTL ? "Noto Sans Arabic" : "Inter"`.

| Check | Result |
|---|---|
| `expo-font` in `apps/mobile/package.json` | **absent** |
| `expo-font` under `apps/mobile/node_modules` | **absent** |
| `useFonts` / `Font.loadAsync` anywhere in `apps/mobile` | **none** |
| `.ttf` / `.otf` in `apps/mobile` (excl. `node_modules`) | **none** |

React Native falls back to the platform system face for an unregistered family,
so native renders **San Francisco / Roboto**, not Inter and not Noto Sans Arabic.

Separately, `"Inter"` is not the web's family either. `apps/web/app/fonts.google.ts`:
body **Plus Jakarta Sans**, headers **Inter Tight**, Arabic **Noto Sans Arabic**.

Invisible to a token comparison — the typeface is a runtime string, not a token.
Full detail: `N-VISUAL-PARITY.md` §N.0.

## V4-002 — No background artwork exists in the native bundle
**Category:** MISSING ASSET · **Confidence: A**

PWA ships **56** image assets; native ships **5**, all launcher/splash icons plus
`brand-mark.png`. No `ImageBackground` appears anywhere in `apps/mobile`.

Directly causes the three reported surfaces:
* sidebar — `url("/assets/cards/sidebar.png")` (`app-shell-v2.css:175`)
* app shell — `url("/assets/backgrounds/app-shell-bg.png")` (`:71`)
* login **and** register — `<img src="/assets/hero/register-logo...png">`
  (`login/page.tsx:677`, `register/page.tsx:845`)

Detail: `SIDEBAR-PARITY.md` §A, `AUTH-LOGIN-PARITY.md` §1, `N-VISUAL-PARITY.md` §N.1.

## V4-003 — The nav palette exists in native and the shell does not use it
**Category:** INCORRECT TOKEN MAPPING · **Confidence: A**

All **7** `theme.color.nav.*` tokens are emitted with values byte-identical to the
web's `--nav-*` custom properties (`nav.ink = rgba(226,232,240,0.82)`, etc).
`apps/mobile/src/ui/shell.tsx` references **none** of them — it uses `ink.primary`,
`ink.muted`, `border.*`, `surface.card`.

Result: the web's dark-artwork-with-light-ink sidebar renders in native as a white
surface with dark ink. Coupled with V4-002: applying the light `nav.*` ink without
the artwork would make the rail unreadable, so both must close together.

Detail: `SIDEBAR-PARITY.md` §C.

## V4-004 — Native registration offers no Google or Apple sign-up
**Category:** MISSING CONTROL · **Confidence: A**

`apps/mobile/app/(stack)/register.tsx` does not import `useOAuth` and renders
neither `"Continue with Google"` nor `"Continue with Apple"`. The PWA register
page offers both and its own subtitle says *"Create your account using Google,
Apple, or email"*. `(stack)/auth.tsx` wires the same hook successfully, so this is
not a platform limitation.

Distinct from V2-001/V2-002, which concern whether OAuth buttons *work* where they
exist. Detail: `AUTH-REGISTER-PARITY.md` §2.

## V4-005 — Roughly half the PWA's user-visible copy has no native equivalent
**Category:** CONTENT MISMATCH · **Confidence: A** · **2,275 of 4,360 element correspondences (52.2%)**

After export-scoped trees, 4-pass semantic pairing and an individual reading of
all 177 near-miss locations, **2,275** web strings across **1,879 distinct source
locations** are `CONTENT_ABSENT`: the literal appears nowhere in the native app,
on a route whose native counterpart does carry elements of that role.

Largest shared causes:

| Web source | Applicable routes |
|---|---:|
| `components/feedback/ProovraSupportReference.tsx` ("Support reference", "Copy support reference") | **33** |
| `components/navigation/PageRouteGate.tsx:98` ("This page is not available") | **25** |
| `components/legal/LegalDocumentShell.tsx` (related documents, Trust Center link) | 6 |
| `components/contextual-help/ContextualHelp.tsx` | 5 |
| `components/external-portal/PortalMfaCodeStep.tsx` | 4 |

Detail: `element-final.json`, `routes-v4/*.adjudicated.json`.

## V4-006 — Four of seven advertised locales are untranslated placeholders
**Category:** CONTENT MISMATCH (affects BOTH platforms) · **Confidence: A**

`packages/shared/src/i18n.ts` advertises 7 locales. `fr`, `es`, `tr` and `ru`
return the **English** string for **all 42 keys**. `ar` (41/42) and `de` (38/42)
are genuinely translated.

Compounding: the dictionary holds 42 keys against **6,101** labelled PWA elements,
and native uses **11 keys at 18 call sites**. Locale selection leaves the product
in English on both platforms.

Native's RTL handling (direction flip, text alignment, Arabic family selection) is
**more thorough than the web's**, which shows no `dir` wiring in its root layout —
though the Arabic face it selects is never loaded (V4-001).

Detail: `O-LOCALE-PARITY.md`.

## V4-007 — Component-variant styling diverges on shape, not just colour
**Category:** DIFFERENT THEME VALUE · **Confidence: A**

| Primitive | PWA | Native |
|---|---|---|
| Primary button radius | `8px` | `999` (**pill**) |
| Primary button background | `linear-gradient(135deg, #7…)` | flat `#7C3AED` |
| Auth/social button | `52px` tall, radius `16px`, `0.96rem` | `44` tall, radius `999`, `12px` |
| Auth card | `rgba(255,255,255,0.74)`, radius `28px`, shadow `0.10` | `#FFFFFF`, radius `14`, shadow **`0.04`** |
| Input radius | `6px` | `8` |

Only **16 of 111** matched pairs carry literal per-element styles on both sides —
both codebases style through variants, so this is the level at which the
comparison is expressible. Detail: `N-VISUAL-PARITY.md` §N.3–§N.4.
