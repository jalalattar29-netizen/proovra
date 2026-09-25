# I — PRIORITIZED DEFECT BACKLOG (v2)

**Frozen revision:** `71e148f34410c7c231f8930d1387d8924b10b4e5`
**This is a DIAGNOSIS artifact. No product code was changed by this audit.**

Grouped by shared root cause. Unverified hypotheses are **not** promoted to
confirmed defects — the confidence column is load-bearing.

---

## P0 — blocks a user from signing in or following a link at all

| ID | Root cause | Confidence | Fix lives in | Affected |
|---|---|---|---|---|
| **V2-001** | Deployed API's OAuth audience allow-list contains only the **web** Google client id and `com.proovra.web`. Native tokens carry the iOS client id / bundle id as `aud`. | **B (high)** — needs one `printenv` to close | **Deployment config**, not code: `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS` | Google **and** Apple sign-in, every native user |
| **J.4** | `apps/web/public/.well-known/apple-app-site-association:6` still contains the literal `<APPLE_TEAM_ID>`. | **A** | that file + deploy | **All iOS Universal Links** — 14 of 63 applicable routes (intake, portal, legal, verify, invite, org-invites, reset-password, verify-email, mfa-recovery) |
| **V2-002** | `apps/mobile/.env` carries only the retired `EXPO_PUBLIC_GOOGLE_CLIENT_ID`; current code reads only the platform-specific names. | **A** | `apps/mobile/.env` (local), already correct in `eas.json` | Google sign-in in any locally-bundled build |

**Acceptance for P0:** a device signs in with Google and with Apple; an emailed
`https://www.proovra.com/verify/<token>` opens the app rather than Safari.

**Note:** `apps/web/__tests__/universal-link-parity.test.ts:143` is written to
**pass** while the Team ID is a placeholder. CI cannot tell you this is broken.

---

## P1 — the user cannot find or trust core functionality

| ID | Root cause | Confidence | Affected |
|---|---|---|---|
| **V2-005** | Native has **no app header**. The entire global chrome is `src/ui/shell.tsx` (175 lines) against the web's `app-shell-v2` (2,757 lines). | **A** | Every authenticated screen |
| **V2-003** | Two controls named **"Finish & Sign"**; the continuous-capture one stages while its copy claims it seals. | **A** | UC-3, UC-5 — the whole iPad screen-capture experience |
| **V2-006** | Native `/search` goes silently `idle` when `activeTeamId` is null — no error, no explanation. | **A** | `/search` |

### V2-005 decomposes into independently shippable items

| | Missing from native chrome | Web source |
|---|---|---|
| a | global search / command palette **on every screen** | `AppAccountToolbar.tsx:328`, `AppShellV2.tsx:252` |
| b | workspace switcher in the header | `AppAccountToolbar.tsx:402` |
| c | account menu + avatar | `:583`, `:708` |
| d | notification bell with count | `NotificationBell.tsx` |
| e | degraded-workspace recovery panel | `AppShellV2.tsx:241`, `:243` |
| f | nav icons + capability gating + grouping | `AppSidebarV2.tsx:19-46`, `lib/navigation/routeIcons.ts` |
| g | skip link / landmark | `AppShellV2.tsx:195` |

(a) alone resolves the reported "missing search functionality": today `/search`
has exactly **one** entry point in the whole app, `app/(tabs)/index.tsx:280`.

---

## P2 — missing applicable surfaces and modules

| ID | Gap | Confidence |
|---|---|---|
| **V2-007** | `/operations` (91 web handlers) and `/operations/health` (8) have **no native screen**. Both are tier CORE / `allow`. | **A** |
| **D.3** | `/home` is missing 6 of 16 modules: hero action, Getting Started checklist, verification health, trust state, report production, intake pipeline, team work. | **A** |
| **V2-004** | iOS has no `/screen-capture`; the "Screen capture" label routes to a different flow per platform with no in-product explanation. | **A** |

---

## P3 — visual divergence

| ID | Root cause | Confidence |
|---|---|---|
| **C.2** | The **web** renders from ~**295 distinct hex colours that exist in no token**, on top of the ~53 that do. Native renders the 46-colour token palette faithfully (only 6 hardcoded hex in all native source). | **A** |

The token pipeline (`tokens.css` → `generate-tokens.mjs` →
`proovra.generated.ts` → `theme.ts`) is **sound and well guarded**. The guard's
scope simply cannot reach this: nothing asserts that a web component *uses* a
token. Closing P3 means de-hardcoding the web, not re-skinning native — the
concentration is `capture-v2.css` (776), `capture-workspace.css` (243),
`globals.css` (123), `settings.css` (112).

**No rendered comparison was performed. This priority is a source finding.**

---

## P4 — instrument and record defects (fix so the next audit is cheaper)

| ID | Defect | Evidence |
|---|---|---|
| **P4-1** | `native-destinations.mjs` claims **`CODE_PARITY` for all 62** rows, contradicted by the same repo's own element and handler data (`/home` 13%, `/search` 21%, `/evidence/[id]` 24%). | `F-COVERAGE-LEDGER.md` §3 |
| **P4-2** | `derive-product-manifest.mjs` mis-classifies 3 routes: `/operations` + `/operations/health` excluded (they are CORE), `/workspaces` included (it is Enterprise-gated). Its `ENTERPRISE_DOMAINS` heuristic reads the registry **domain** where the runtime gate is `lib/surface/tiers.ts`. | `00-BASELINE.md` §3c |
| **P4-3** | The ledger's 62-row denominator inherits both P4-2 errors, so `/operations` can never be reported as missing. | `J-RE-ADJUDICATION.md` J.1 |
| **P4-4** | `universal-link-parity.test.ts` is deliberately written to pass on the placeholder Team ID, so CI is green while every iOS deep link is dead. | `J-RE-ADJUDICATION.md` J.4 |
| **P4-5** | `uc-disposition.md` records UC-5 (and UC-3) CODE as COMPLETE; V2-003 and V2-004 are CODE defects resolvable in this repository. | `G-UC-MATRIX.md` |
| **P4-6** | The prior findings register attributes 51 enterprise-only `CommandCenter` elements to `/home`, and 5 prop-name extractor artifacts to 13 routes. | `J-RE-ADJUDICATION.md` J.3 |

---

## What is NOT in this backlog, and why

* **800 of 1,271 unpaired elements remain UNRESOLVED** (584 copy-or-structure,
  183 runtime-expression labels, 33 manual). They are **not** listed as defects
  because source cannot yet tell a missing control from a differently worded one.
  Resolving them needs the module-tier reading demonstrated on `/home`.
* **Nothing was rendered.** No item here is a rendered-parity claim.
* **No test was executed** by this audit.
