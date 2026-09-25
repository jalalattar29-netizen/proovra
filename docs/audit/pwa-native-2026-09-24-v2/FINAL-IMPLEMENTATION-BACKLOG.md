# D — FINAL IMPLEMENTATION BACKLOG

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5`
**This is a specification. No product code was changed and none should be until these are scheduled.**

Each task: exact source target · expected behaviour · acceptance criteria · dependencies.
Shared root causes appear **once**; affected screens are listed under them.

---

## W0 — Configuration (no code; blocks everything downstream)

### T-01 · Allow-list the native OAuth audiences  ·  RC-01
**Target:** deployed API environment (not the repository)
**Do:** set `GOOGLE_CLIENT_IDS` to include the iOS + Android client ids from `apps/mobile/eas.json:14-16`; set `APPLE_CLIENT_IDS` to include the bundle id `com.jalalattar29.proovra`.
**Expected:** `assertAudience` (`auth.service.ts:157,252`) accepts native tokens.
**Acceptance:** a device completes Google sign-in and Apple sign-in; `POST /v1/auth/google` and `/v1/auth/apple` return 200.
**Dependency:** none. **Blocks:** every authenticated acceptance test.
**Note:** `EXTERNAL_CONFIG.md:27,39` already specifies this. Do **not** weaken the allow-list.

### T-02 · Replace the placeholder Apple Team ID  ·  RC-02
**Target:** `apps/web/public/.well-known/apple-app-site-association:6` — `<APPLE_TEAM_ID>` → the real 10-character Team ID. Then deploy.
**Also:** `apps/web/__tests__/universal-link-parity.test.ts:143` currently **passes** on the placeholder — tighten it once the real ID lands, or CI will never catch a regression.
**Acceptance:** an emailed `https://www.proovra.com/verify/<token>` opens the app, not Safari, on a device with the app installed. Repeat for one `/intake/*` and one `/portal/*`.
**Affects 14 routes:** intake ×2, portal ×4, legal, verify ×2, invite, org-invites, reset-password, verify-email, mfa-recovery.

### T-03 · Fix the local mobile `.env`  ·  RC-03
**Target:** `apps/mobile/.env` — replace `EXPO_PUBLIC_GOOGLE_CLIENT_ID` with `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` / `_ANDROID_` / `_WEB_` (values already in `eas.json`).
**Acceptance:** a locally-bundled build shows an enabled Google button instead of `OAUTH_GOOGLE_UNCONFIGURED`.

---

## W1 — Global visual foundation (one fix, every screen)

### T-04 · Load the application fonts  ·  RC-04  ·  **highest blast radius in the audit**
**Targets:** `apps/mobile/package.json` (add `expo-font`), `apps/mobile/app/_layout.tsx` (load before first paint), `apps/mobile/assets/fonts/` (add the files), `apps/mobile/src/locale-context.tsx:111-112` (use the loaded family names).
**Do:** ship **Plus Jakarta Sans** (400/500/600/700/800) to match `apps/web/app/fonts.google.ts`, and **Noto Sans Arabic** for `ar`. Decide explicitly whether headers use **Inter Tight** as the web does.
**Expected:** native text renders in the product typeface instead of San Francisco / Roboto.
**Acceptance:** `useFonts` resolves before render; a device screenshot of `/home` shows Jakarta, not the system face; Arabic renders Noto Sans Arabic.
**Affects:** all 64 routes. **Note:** `"Inter"` in the current code is neither the web's body face nor loaded.

### T-05 · Ship the background artwork  ·  RC-05
**Targets:** `apps/mobile/assets/` — add `sidebar.png`, `app-shell-bg.png`, `register-logo...png` (sources in `apps/web/public/assets/`). Render via `ImageBackground` (currently **zero occurrences** in the native tree) in `src/ui/shell.tsx` (rail) and the auth screens.
**Expected:** sidebar shows the branded artwork (`app-shell-v2.css:175`: `no-repeat`/`center`/`cover`, **no overlay** — the CSS comment is explicit); login/register show the full-bleed hero with `object-cover object-center`.
**Acceptance:** device screenshots of the rail, `/login` and `/register` show the artwork.
**Dependency:** none. **Blocks:** T-06.

### T-06 · Use the nav palette that already exists  ·  RC-06
**Target:** `apps/mobile/src/ui/shell.tsx` — replace `ink.primary`/`ink.muted`/`border.*`/`surface.card` with `theme.color.nav.{inkStrong,ink,inkMuted,iconIdle,hoverBg,activeBg,divider}`. All 7 tokens already exist with values byte-identical to the web's `--nav-*`.
**Expected:** light ink on the dark artwork, matching the web.
**Acceptance:** resolved values equal `--nav-*`; rail is legible.
**Dependency: T-05 must land first** — light ink on today's white surface is unreadable.

### T-07 · Align the primitive shape tokens  ·  RC-07
**Target:** `apps/mobile/src/ui/index.tsx` — button `borderRadius: theme.radius.pill (999)` vs web **8px**; card `radius.card (14)` vs web **28px**; card elevation opacity **0.04** vs web **0.10**; input radius **8** vs web **6px**; primary button flat `#7C3AED` vs a 4-stop gradient.
**Decide per primitive** whether the web or the native value is the product intent; this task is to make them agree, not to copy blindly.
**Acceptance:** a documented decision per primitive, and the two resolved values match.

### T-08 · Repair the `cc-*` stylesheet rename  ·  RC-09  ·  **PWA-side**
**Target:** components using `cc-*`; `command-center.css` declares **213 `.ec-*`** rules while components reference **551 distinct `cc-*`** names of which only 2 have rules.
**Do:** for each, either rename the class to its `.ec-*` counterpart or add the rule. On applicable routes this is **22 classes / 196 uses / 6 routes**; the full surface is 551.
**Also unstyled:** `ui-empty-state`, `ui-filterbar`, `legal-list`, `opsw-drawer__section`, `proovra-upload-operations*`, `ilk-*`, `set-nav`, `matter-workspace`.
**Acceptance:** every `className` token on an applicable route resolves to a rule, a Tailwind form, or a TSX `<style>` block. Re-run `13-css-closure.mjs`: `NO_RULE_ANYWHERE` custom classes → 0.
**Note:** this is a **defect in the PWA reference**, not a native gap. Fix it before treating those surfaces as a parity target.

---

## W2 — Structure and controls

### T-09 · Build the native app header  ·  RC-10  ·  **largest structural gap**
**Target:** `apps/mobile/src/ui/shell.tsx` (175 lines today) against `apps/web/components/app-shell-v2/` (2,757).
Independently shippable sub-tasks:

| # | Element | Web reference |
|---|---|---|
| T-09a | **global search / command palette on every screen** | `AppAccountToolbar.tsx:328`, `AppShellV2.tsx:252` |
| T-09b | workspace switcher in the header | `:402` (`switch-workspace` is on 33 web routes, 1 native screen) |
| T-09c | account menu + avatar | `:583`, `:708` |
| T-09d | notification bell with count | `NotificationBell.tsx` |
| T-09e | degraded-workspace recovery panel | `AppShellV2.tsx:241,:243` |
| T-09f | nav icons + capability gating + groups | `AppSidebarV2.tsx:19-46`, `lib/navigation/routeIcons.ts` |
| T-09g | brand area, group titles, separators, rail scrolling, footer | `:667`, `:379`, `:680` |
| T-09h | skip link / landmark | `AppShellV2.tsx:195` |

**T-09a alone closes the reported "missing search"**: `/search` has exactly one entry point today (`app/(tabs)/index.tsx:280`).
**Acceptance:** search reachable from all 7 primary destinations; workspace switch without entering Settings.

### T-10 · Add Google/Apple sign-up to native registration  ·  RC-11
**Target:** `apps/mobile/app/(stack)/register.tsx` — import and wire `useOAuth` exactly as `(stack)/auth.tsx` does.
**Acceptance:** both buttons present and a device completes account creation with each. **Dependency: T-01.**

### T-11 · Build the Operations surface  ·  RC-12
**Target:** new native screens for `/operations` (91 web handlers, 15 endpoints) and `/operations/health` (8, 3). Both are tier **CORE / allow**.
**Acceptance:** both reachable; the 17 `/v1/ops` endpoints are consumed.

### T-12 · Add the 35 confirmed absent controls  ·  RC-13
Grouped by screen — `/cases/[id]` Priority + Assignee + Team · `/cases` Risk level + Bulk action · `/collaboration-teams` 5 filters · `/collaboration-teams/[teamId]` Assignee + Priority · `/evidence` Target case · `/evidence/[id]` Select case + Assigned reviewer · `/evidence-requests/[id]` Assign reviewer + Choose a member · `/home` Activity period · `/organizations/[id]` New owner · `/intake-links` request type + expiry (with T-16).
**Note:** native already has picker patterns (`ProovraSheet`, `ProovraFilterChips`) — no new primitive needed.
**Acceptance:** each control present and its effect matches the web's.

---

## W3 — Content, navigation and data

### T-13 · Make the 457 present-but-unreachable strings reachable  ·  RC-15  ·  **do this before T-14**
**Why first:** these already exist in Native. The fix is **navigation**, not new copy, and it will shrink T-14.
**Target:** `q9-rechecks.json → presentElsewhere.unreachableSample` — each row carries the route that needs it and the native file that has it.
**Acceptance:** re-run `15-q9-rechecks.mjs`; `unreachable` falls toward 0.

### T-14 · Close the content gap  ·  RC-14 · **2,732 strings / 191 owning files**
Work by owning file, largest first — `verify/[token]/page.tsx` (114), `MatterWorkspace.tsx` (70), `ProovraSupportReference.tsx` (**33 routes**), `support/page.tsx` (57), `PageRouteGate.tsx:98` (**25 routes**), `organizations/[id]` (45), `collaboration-teams` (43), `evidence/[id]` (42), `HomeSections.tsx` (41).
**Two shared components pay for themselves first:** `ProovraSupportReference` (33 routes) and `PageRouteGate`'s denial state (25 routes).
**Acceptance:** per file, each string is implemented, deliberately reworded, or recorded as a product decision not to carry it.

### T-15 · Close the data gap  ·  RC-16
**111 endpoints absent from the app** — `/v1/ops` 17 (→ T-11), `/v1/search` 9, `/v1/billing` 8 (incl. checkout), `/v1/identity-security` 7, `/v1/identity` 6, `/v1/trust` 4, `/v1/workflow` 4.
**Plus parameter gaps on shared endpoints:** `/v1/evidence/library-summary` gets **12 params** from web, **1** from native — 11 filter dimensions with no native control.
**Acceptance:** each endpoint either consumed or recorded as out of scope with a reason; `library-summary` accepts the same filter set.

### T-16 · Native intake-link creation  ·  RC-20
**Target:** `apps/mobile/app/(stack)/intake-links.tsx:339` — the disclosure covers **resend** (raw token not persisted), not **creation**. Either implement creation or correct the copy to say only resend is web-only.

### T-17 · Translate or withdraw four locales  ·  RC-17 · **both platforms**
**Target:** `packages/shared/src/i18n.ts` — `fr`, `es`, `tr`, `ru` return English for all 42 keys while `supportedLocales` advertises them. Either translate them or remove them from `supportedLocales`.
**Larger question:** 42 keys against 6,101 labelled web elements; native uses 11 keys / 18 call sites. Locale selection currently leaves the product in English. No interpolation, no plurals.

---

## W4 — Capture lifecycle

### T-18 · Stop "Finish & Sign" claiming to sign  ·  RC-18 · **UC-3 + UC-5**
**Target:** `apps/mobile/app/(stack)/continuous-capture.tsx:415,417`.
**Do:** either make the control seal (call `completeAcquisition`), or rename it and correct the copy — `src/continuous-capture.ts:13` says **"IT DOES NOT SEAL."** Two controls must not share the name of the canonical sealing action (`capture.tsx:1547`).
**Also:** replace the opaque `"Could not finalize the evidence."` (`:343`) with per-stage messages across the five-step chain; reconsider the terminal no-retry (`:340-342`); fix `sizeBytes: 0` (`:308`).
**Acceptance:** the label matches the effect; a device run produces a signed Evidence record or a stage-specific error with a retry path.

### T-19 · Make the iOS capture route explicit  ·  RC-19
**Target:** `screen-capture.tsx:57`, `capture.tsx:1395-1417`. Either implement iOS `/screen-capture` on the existing `ProovraScreenCaptureModule.swift`, or label the iOS control for the flow it actually opens.
**Acceptance:** an iOS user is never sent to a differently-behaving flow under the same label.

---

## W5 — Instruments and records

| Task | Target |
|---|---|
| **T-20** · Correct `native-destinations.mjs` — it claims `CODE_PARITY` on all 62 while the repo's own data shows 45% handler coverage, `/home` 13% (RC-21) | `apps/mobile/src/product/native-destinations.mjs` |
| **T-21** · Fix `derive-product-manifest.mjs` — read `lib/surface/tiers.ts`, not the registry domain; 3 routes mis-classified (RC-22) | `apps/mobile/tools/derive-product-manifest.mjs` |
| **T-22** · Tighten `universal-link-parity.test.ts:143` after T-02 (RC-23) | `apps/web/__tests__/` |
| **T-23** · Correct `uc-disposition.md` — UC-3/UC-5 CODE is not complete (RC-24) | `apps/mobile/docs/uc-disposition.md` |

---

## Dependency order

```
T-01 T-02 T-03          (config; unblock everything)
  └─ T-10 (needs T-01)
T-05 ──► T-06           (artwork before light nav ink)
T-04, T-07, T-08        (independent)
T-09a ──► closes "missing search"
T-11, T-12              (independent)
T-13 ──► T-14           (navigation first shrinks the content backlog)
T-15, T-16, T-17
T-18, T-19              (capture)
T-02 ──► T-22
```

**Not in this backlog:** the 28 `HOOK_RETURNED_CALLABLE` handlers (U-1) and every runtime item — those are audit work and validation, not implementation. See `FINAL-RUNTIME-VALIDATION-PLAN.md`.
