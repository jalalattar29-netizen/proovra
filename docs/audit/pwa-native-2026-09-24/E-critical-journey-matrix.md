# E — CRITICAL JOURNEY MATRIX

**Audited SHA:** `f822de79ad9397928cb59d1760e42bd63e583457`

## E.0 How to read a verdict

| Verdict | Means |
|---|---|
| **CODE_PRESENT** | The implementation exists and its handlers resolve to real effects in source. Says nothing about a device. |
| **CODE_GAP** | A step of the journey has no native implementation. |
| **BROKEN_IN_PROD** | Verified against production infrastructure. The journey cannot complete today. |
| **UNVERIFIED** | Cannot be decided without a device or an authenticated environment. |

Every row is additionally **device-UNVERIFIED** (0 simulator runs, 0 device runs) —
that column is stated once here rather than repeated 18 times.

---

## E.1 The boot chain (precondition for every authenticated journey)

Verified in source, native side:

| Step | Native authority | Verdict |
|---|---|---|
| token acquired + persisted | `src/auth/auth-api.ts` (13 endpoint sites), `src/bootstrap/bootstrap-machine.ts` | CODE_PRESENT |
| `GET /v1/auth/me` validates the session | `bootstrap-machine.ts:17` — state `"authenticated" // session validated (GET /v1/auth/me ok)` | CODE_PRESENT |
| `GET /v1/platform/context` | `src/product/platform-context.ts:2` — *"the ONE reader of GET /v1/platform/context"* | CODE_PRESENT |
| `activeSpace` → id / type / plan | `platform-context.ts:9–11`, `:68–76` | CODE_PRESENT |
| at most one context fetch | `platform-context.ts:16` | CODE_PRESENT |
| workspace-scoped requests carry the active space | — | **UNVERIFIED** — needs a request trace |

The chain the brief names is implemented, single-sourced, and matches the web
(`GET /v1/platform/context` is attributed to all 64 applicable web routes via
`PlatformContextProvider`). **Cross-workspace isolation, success/partial/total failure,
empty, retry, refresh and switching are UNVERIFIED** — each needs a live authenticated
session, which this audit did not create (production credentials, see A §7).

Note: `GET /v1/users/me` is called by `apps/web/app/providers.tsx:93` on every web route
and has **no** native caller. Native uses `/v1/auth/me`. Whether the two projections
differ is unresolved and is item **H-6** in the backlog.

---

## E.2 Journey matrix

| # | Journey | Native entry | Verdict | Evidence / what is missing |
|---|---|---|---|---|
| J-01 | **Email auth** (sign in, register, verify, forgot/reset) | `(stack)/auth.tsx`, `register.tsx`, `verify-email.tsx`, `forgot-password.tsx`, `reset-password.tsx` | CODE_PRESENT | 5 screens, handlers resolve to `API_CALL`. Reset/verify arrive **by link** → see J-02. |
| J-02 | **Deep-link arrival** (reset-password, verify-email, mfa-recovery) | `src/deep-link.ts`, `DeepLinkGate.tsx` | **BROKEN_IN_PROD** | Parsers exist and are tested (`deep-link-families`, `deep-link.contract`). The **link cannot reach the app**: AASA/assetlinks carry placeholders (A §3.1). |
| J-03 | **OAuth — Google** | `(stack)/auth.tsx:123` (`oauth.promptGoogle`) | CODE_PRESENT / UNVERIFIED | `eas.json` carries the client ids. Runtime depends on API `GOOGLE_CLIENT_IDS` — pre-flight 0.1 in `physical-acceptance.md`. |
| J-04 | **OAuth — Apple** (iOS only) | `(stack)/auth.tsx:130` (`oauth.signInApple`) | CODE_PRESENT / UNVERIFIED | `usesAppleSignIn: true`. A 401 on `aud` = API env, not code. |
| J-05 | **MFA challenge + recovery** | `(stack)/mfa.tsx`, `mfa-recovery-verify.tsx`, `src/product/mfa-recovery.ts` | CODE_PRESENT | 7 endpoint sites. 2 page-scoped endpoints on `/auth/mfa-challenge` uncalled. Recovery **arrives by link** → J-02. |
| J-06 | **Workspace / space switching** | `(stack)/spaces.tsx`, `platform-context.ts` | CODE_PRESENT | Uses toast feedback. Isolation on switch **UNVERIFIED**. |
| J-07 | **Dashboard / Home** | `(tabs)/index.tsx` | CODE_PRESENT with **CODE_GAP** | Overview + health/records/activity ported as sections. The web's `/v1/ops/*` cluster (18 endpoints: workflows, causality chains, bulk-actions, assign/escalate/resolve/suppress/retry) is **not called anywhere natively**. |
| J-08 | **Capture — photo / video / audio / file** | `(stack)/capture.tsx` | CODE_PRESENT | Largest control surface in the app. Feedback via `addToast`. |
| J-09 | **Capture — Android screen (UC-2)** | `(stack)/screen-capture.tsx` + `modules/proovra-screen-capture` | CODE_PRESENT | `MediaProjection` via `ScreenCaptureService.kt`. Gated `Platform.OS === "android"`. |
| J-10 | **Capture — Android continuous (UC-3)** | `(stack)/continuous-capture.tsx` + `ContinuousScreenCaptureService.kt` | CODE_PRESENT | Segmented ORIGINAL parts + continuity manifest. |
| J-11 | **Capture — iOS ReplayKit (UC-5)** | `modules/.../ios/ProovraBroadcastShared.swift`, `plugins/withProovraIosScreenBroadcast.cjs` | CODE_PRESENT / **device-blocking** | Broadcast Extension target compiles and packages on EAS. `crypto.subtle` sealing and signing are **real-device-only** proof. |
| J-12 | **Staging → explicit finalize** | `src/direct-capture.ts` (10 endpoint sites), `src/capture/capture-draft.ts` | CODE_PRESENT | One UC-0 spine; `acquisitionMode` is the origin authority. Finalize is the single direct-capture session path for all five UCs. |
| J-13 | **Evidence library** | `(tabs)/evidence.tsx` | CODE_PRESENT | **Zero page-scoped endpoint gaps.** 17 map-recorded call sites. |
| J-14 | **Evidence detail** | `(stack)/evidence/[id].tsx` | CODE_PRESENT with **CODE_GAP** | 24 of 110 page-scoped endpoints called. Lifecycle (lock/unlock/archive/unarchive) **is** wired and server-gated. Absent: certifications attest/request/revoke, governance publish/unpublish, review-operations claim/decision, media-intelligence, derived assets, AI categorisation, comparison, provenance. |
| J-15 | **Review (reviewer workflow on a record)** | `src/ui/reviewer-workflow-panel.tsx` at `evidence/[id].tsx:1101` | CODE_PRESENT | The *record-level* reviewer workflow is ported. The `/review/*` and `/reviewer-ops/*` **consoles** are ENTERPRISE_ONLY and correctly out of scope (B.2). |
| J-16 | **Cases** | `(tabs)/cases.tsx`, `(stack)/case/[id].tsx` | CODE_PRESENT, scope-narrowed | Native renders the **5-tab personal branch**, not the 12-tab enterprise `MatterWorkspace` — argued in the ledger. Export uses `GET /v1/cases/:id/export` where web uses `POST /v1/cases/:id/siu-export`: **same capability, different endpoint** (H-4). |
| J-17 | **Reports** | `(stack)/reports.tsx` | CODE_PRESENT | Regeneration reads the typed OUTCOME, not the boolean; only regeneration confirms first. |
| J-18 | **Verify (public)** | `app/verify.tsx`, `(stack)` token route | CODE_PRESENT | **Zero endpoint gaps.** Token arrival by link → J-02. |
| J-19 | **Notifications / inbox** | `(tabs)/notifications.tsx` | CODE_PRESENT | 7 call sites. `GET /v1/me/inbox/summary` + dismiss are web **shell** (NotificationBell) and uncalled natively — the native tab is the equivalent surface (H-5). |
| J-20 | **Settings** | `(tabs)/settings.tsx` + 5 sub-screens | CODE_PRESENT with **CODE_GAP** | 19 of 47 page-scoped endpoints uncalled. TOTP enrolment present (`src/ui/totp-enrolment.tsx`). |
| J-21 | **Intake (external contributor)** | `(stack)/intake/[token].tsx`, `intake/capture.tsx`, `intake-links.tsx` | **BROKEN_IN_PROD** | Screens, parsers and capture exist. The intake link is https and **cannot open the app** (A §3.1). |
| J-22 | **Portal (external reviewer)** | `(stack)/portal/*` (4 screens) | **BROKEN_IN_PROD** | Same cause. `portal/index.tsx` — the manual token-entry fallback — exists *precisely* "for the case where the link did not open the app". That fallback is currently the **only** way in. |
| J-23 | **Invites — collaboration + org** | `(stack)/invite/[token].tsx`, `org-invite/[token].tsx` | **BROKEN_IN_PROD** | Same cause. |
| J-24 | **Billing** | `(stack)/billing.tsx` | CODE_PRESENT, deliberately narrowed | 11 page-scoped endpoints uncalled. **No in-app purchase** — app-store rules; argued, correct. |
| J-25 | **Operations (personal scope)** | **none** | **CODE_GAP** | `/operations` and `/operations/health` have no native screen, no ledger row, no test (A §3.2). 19 + 2 page-scoped endpoints uncalled. |

## E.3 Journey verdict roll-up

| Verdict | Journeys |
|---|---:|
| CODE_PRESENT (no known gap) | 13 |
| CODE_PRESENT with a named CODE_GAP | 5 |
| CODE_GAP (nothing native) | 1 |
| **BROKEN_IN_PROD** | **4** |
| Device-UNVERIFIED | **25 of 25** |

**Four of twenty-five critical journeys cannot complete in production today**, and all
four fail for the same single cause: two placeholder strings in the association files
(A §3.1). That is the most concentrated repair in this audit — one fix restores J-02,
J-21, J-22 and J-23, and removes the link-arrival caveat from J-01 and J-05.
