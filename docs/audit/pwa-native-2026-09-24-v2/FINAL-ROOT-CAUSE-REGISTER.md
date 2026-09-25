# B — FINAL ROOT-CAUSE REGISTER

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · SOURCE-ONLY · nothing rendered

Deduplicated. Each root cause appears **once**, with every affected route listed.
Confidence: **A** = decidable from committed source · **B** = source makes it the
leading explanation, one named runtime fact settles it · **C** = source cannot decide.

---

## P0 — blocks sign-in or link-following entirely

### RC-01 · Native OAuth token audiences are not in the API allow-list
**A/B: B (high)** · **Category:** configuration · **Affects:** every native user, both providers

Native iOS Google `id_token` carries `aud` = the **iOS client id** (`eas.json:14`);
Apple's identity token carries `aud` = the **bundle id** `com.jalalattar29.proovra`
(`app.json:41`). The server allow-lists only `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_IDS`
and `APPLE_CLIENT_ID`/`APPLE_CLIENT_IDS` (`services/api/src/services/auth.service.ts:157,252`);
`allowedAudiences` (`:121-131`) throws when both are empty.

`*_CLIENT_IDS` exists **nowhere in the repository** but those two call sites. The only
record of production values (`services/api/.env.production-backup-1789524624714`,
untracked + gitignored) shows the **web** client id and `APPLE_CLIENT_ID=com.proovra.web`.

Required by `apps/mobile/docs/EXTERNAL_CONFIG.md:27,39` and predicted by
`docs/uc6-release-acceptance.md:424`.
**Ruled out:** reversed-client-id scheme is correct (`app.json:64`), `usesAppleSignIn: true` (`:44`), `eas.json` carries real ids on all 4 profiles.
**Closes with:** RV-01.

### RC-02 · Every iOS Universal Link is dead — placeholder Team ID in the committed file
**A** · **Affects:** 14 of 63 applicable routes

`apps/web/public/.well-known/apple-app-site-association:6` reads
`"<APPLE_TEAM_ID>.com.jalalattar29.proovra"`. iOS cannot match the appID, declines the
association, and every `https://www.proovra.com/...` link opens Safari.

10 declared components → `/intake/[token]`, `/intake/[token]/capture`, `/portal`,
`/portal/[token]`, `/portal/[token]/work/[workflowId]`, `/portal/accept/[grantId]`,
`/legal/[slug]`, `/verify`, `/verify/[token]`, `/invite/[token]`,
`/org-invites/[token]/accept`, `/reset-password`, `/auth/verify-email`,
`/auth/mfa-recovery/verify`.

**CI cannot tell you:** `apps/web/__tests__/universal-link-parity.test.ts:143` is written
to **pass** on the placeholder. Android is fixed (real SHA-256 fingerprint).

### RC-03 · A locally-bundled build cannot offer Google sign-in at all
**A** · `apps/mobile/.env` carries only the retired `EXPO_PUBLIC_GOOGLE_CLIENT_ID`; the code reads only `EXPO_PUBLIC_GOOGLE_{IOS,ANDROID,WEB}_CLIENT_ID` (`use-oauth.ts:45-47`) → `promptGoogle` refuses with `OAUTH_GOOGLE_UNCONFIGURED` (`:128-136`). Distinct symptom from RC-01.

---

## P1 — global visual root causes (every screen)

### RC-04 · Native loads no fonts; every text element renders the system face
**A** · **Affects: all 64 routes**

| Check | Result |
|---|---|
| `expo-font` in `apps/mobile/package.json` / installed | **absent / absent** |
| `useFonts` / `Font.loadAsync` anywhere | **none** |
| `.ttf` / `.otf` in `apps/mobile` | **none** |
| What the code asks for | `fontFamily = isRTL ? "Noto Sans Arabic" : "Inter"` (`src/locale-context.tsx:111-112`) |

RN falls back to San Francisco / Roboto. Separately `"Inter"` is not the web's family:
`apps/web/app/fonts.google.ts` uses **Plus Jakarta Sans** (body), Inter Tight (headers),
Noto Sans Arabic. **Invisible to a token comparison** — the typeface is a runtime string.

### RC-05 · No background artwork exists in the native bundle
**A** · **Affects:** sidebar, app shell, `/login`, `/register`

PWA ships **56** image assets; `apps/mobile/assets/` has **5**, all launcher/splash icons
plus `brand-mark.png`. No `ImageBackground` anywhere in `apps/mobile`.

| Missing artwork | Declared at |
|---|---|
| `cards/sidebar.png` | `app-shell-v2.css:175` (single rule, **no competitor** — certain) |
| `backgrounds/app-shell-bg.png` | `app-shell-v2.css:71` (5 competing rules → see U-4) |
| `hero/register-logo...png` | `login/page.tsx:677`, `register/page.tsx:845` |

### RC-06 · The nav palette exists in Native and `shell.tsx` uses none of it
**A** · **Affects:** every authenticated screen

All **7** `theme.color.nav.*` tokens carry values byte-identical to the web's `--nav-*`
(`nav.ink = rgba(226,232,240,0.82)`, `nav.activeBg`, `nav.divider`, …).
`apps/mobile/src/ui/shell.tsx` references **zero** of them — it uses `ink.primary`,
`ink.muted`, `border.*`, `surface.card`. Web = dark artwork + light ink; native = white +
dark ink. **Coupled with RC-05:** light `nav.*` ink without the artwork is unreadable, so
they must close together.

### RC-07 · Component-variant styling diverges on shape, not just colour
**A** · **Affects:** every screen

| Primitive | PWA | Native |
|---|---|---|
| Primary button | `linear-gradient(135deg,#7…)`, radius **8px**, `0 14px`, weight 650 | flat `#7C3AED`, radius **999 (pill)**, `12/20`, minHeight 44 |
| Auth/social button | 52px tall, radius **16px**, 0.96rem | 44 tall, radius **999**, 12px |
| Card | `rgba(255,255,255,0.74)`, radius **28px**, shadow **0.10** | `#FFFFFF`, radius **14**, shadow **0.04** |
| Input | radius **6px** | radius **8** |

### RC-08 · The web bypasses its own design tokens
**A** · **PWA-side** · 295 distinct hex outside `tokens.css` (1,752 occurrences); 1,600 PWA-only colour uses across applicable routes; native token set is 46 and native source carries only **6** hardcoded hex. The token pipeline is sound; the web does not use it.

### RC-09 · ~115 custom CSS classes have no rule anywhere — the `cc-*` rename
**A** · **PWA-side** · **6 applicable routes**

Components use **551 distinct `cc-*` class names**; only `.cc-page` and `.cc-title` have
rules. `command-center.css` declares **213 `.ec-*`** rules — the stylesheet was renamed
`cc-` → `ec-` and components were not updated. On applicable routes: **22 classes / 196
uses**. Largest consumers: `cases-experience/*`, `workspace-admin/*`, `billing/page.tsx`.
Also unstyled: `ui-empty-state`, `ui-filterbar`, `legal-list`, `opsw-drawer__section`,
`proovra-upload-operations*`, `ilk-*`, `set-nav`, `matter-workspace`.

---

## P2 — missing structure and controls

### RC-10 · Native has no app header, so global search does not exist
**A** · **Affects:** every authenticated screen

Web `AppShellV2` (2,757 lines / 6 components) vs native `src/ui/shell.tsx` (**175 lines**).
Absent from native: header, command palette (`AppAccountToolbar.tsx:328`), workspace
switcher (`:402`), account menu (`:583`), notification bell (`NotificationBell.tsx`, 722
lines), language selector (`:373`), system status (`:365`), skip link
(`AppShellV2.tsx:195`), recovery panels (`:241,:243`), "All Tools" (`AppSidebarV2.tsx:710`),
support link (`:741`), brand area (`:667`), group titles (`:379`), storage widget.

`/search` has exactly **one** entry point in the whole app: `app/(tabs)/index.tsx:280`.
`/v1/platform/context/switch-workspace` is reachable on **33 web routes** and **one**
native screen. Nav is a hardcoded 7-item array with no icons and no capability gating.

### RC-11 · Native registration offers no Google or Apple sign-up
**A** · `apps/mobile/app/(stack)/register.tsx` never imports `useOAuth`; `(stack)/auth.tsx` does. The PWA register subtitle promises *"using Google, Apple, or email"*. Not a platform limitation.

### RC-12 · `/operations` and `/operations/health` have no native screen
**A** · Both are tier **CORE / allow** (`lib/surface/tiers.ts`), 91 + 8 web handlers, 15 + 3 endpoints. Native ships the PROFESSIONAL sub-surfaces (`batch-analysis`, `quotas`) but not the CORE parent.

### RC-13 · 35 confirmed absent controls
**A** · From 101 `ROLE_ABSENT_ON_SCREEN` occurrences → 63 distinct → **35 genuinely absent** after reading (4 of 39 SELECTs proved valid native adaptations; the 33-route `TABLE "Actions"` is one documented `ProovraDataList` adaptation). Includes case Priority/Assignee/Team, `/cases` Risk level + Bulk action, collaboration Assignee/Priority filters, `/evidence` Target case, `/evidence/[id]` Select case + Assigned reviewer, `/home` Activity period, `/organizations/[id]` New owner.

---

## P3 — content and data

### RC-14 · 2,732 web strings have no native equivalent (62.7% of correspondences)
**A** · **191 owning files** · after promoting the 457 present-but-unreachable

Largest shared causes:

| Web source | Applicable routes |
|---|---:|
| `app/verify/[token]/page.tsx` | 114 occ |
| `components/cases-experience/MatterWorkspace.tsx` | 70 |
| `components/feedback/ProovraSupportReference.tsx` | **33 routes** |
| `app/support/page.tsx` | 57 |
| `components/navigation/PageRouteGate.tsx:98` ("This page is not available") | **25 routes** |
| `components/legal/LegalDocumentShell.tsx` | 6 routes |

### RC-15 · 457 strings exist in Native but not reachable from the screen that needs them
**A** · **NEW from the mandated §4 re-check.** Presence somewhere is not parity. These are promoted into RC-14's backlog with their actual native location recorded, because the fix is **navigation**, not new copy.

### RC-16 · 111 `/v1` endpoints are called by the PWA and by no native file
**A** · Families: `/v1/ops` 17 (→ RC-12), `/v1/search` 9, `/v1/billing` 8, `/v1/identity-security` 7, `/v1/identity` 6, `/v1/trust` 4, `/v1/workflow` 4. Plus **parameter gaps on shared endpoints** — `library-summary` receives **12 params** from web, **1** from native.

### RC-17 · Four of seven advertised locales are untranslated placeholders
**A** · **both platforms** (shared dictionary) · `fr`, `es`, `tr`, `ru` return English for all 42 keys. Dictionary covers 42 keys against 6,101 labelled web elements; native uses 11 keys / 18 call sites. No interpolation, no plurals. Native's RTL handling is **better than the web's**.

---

## P4 — capture lifecycle

### RC-18 · "Finish & Sign" on continuous capture does not sign, and its copy says it does
**A** · **UC-3 + UC-5** · Two controls share the label: `capture.tsx:1547` seals via `completeAcquisition`; `continuous-capture.tsx:417` only **stages**, then navigates away. The copy at `:415` claims it *"seals these segments into one evidence record"* while `src/continuous-capture.ts:13` states **"IT DOES NOT SEAL."** Failure is terminal (`:340-342`), message opaque (`:343`), `sizeBytes: 0` hardcoded (`:308`).

### RC-19 · iOS has no `/screen-capture`; the platform gate is silent
**A** · `screen-capture.tsx:57` gates to Android; `capture.tsx:1395-1417` routes iOS "Screen capture" to `/continuous-capture`. Same label, two flows, nothing in-product says so.

### RC-20 · Native intake-links cannot create a link
**A** · `intake-links.tsx:339` discloses it in product copy. The stated reason (raw token not persisted) is sound for **resend**, not for **creation**. Partially-justified functional gap.

---

## Instrument/record defects (fix so the next audit is cheaper)

| ID | Defect |
|---|---|
| RC-21 | `native-destinations.mjs` claims **CODE_PARITY on all 62**; the repo's own data gives 45% handler coverage, `/home` 13%. 0/62 physically accepted |
| RC-22 | `derive-product-manifest.mjs` mis-classifies 3 routes (reads registry **domain**, not `lib/surface/tiers.ts`) |
| RC-23 | `universal-link-parity.test.ts:143` is written to PASS on the placeholder Team ID |
| RC-24 | `uc-disposition.md` records UC-3/UC-5 CODE COMPLETE; RC-18/RC-19 are CODE defects |
| RC-25 | Prior audits attributed enterprise-only `CommandCenter` elements to `/home` and whole multi-export files to any importing route |
