# CURRENT ROUTE IMPLEMENTATION MATRIX

Generated 2026-09-25T03:21:42.987Z from the CURRENT tree by `19-route-matrix.mjs` → `20-render-matrix.mjs`. One entry per applicable PWA route (62 NATIVE_REQUIRED + the 2 declared aliases the frozen inventory carried = 64). The other 144 web routes are source-classified in `reclass.json`: 16 PUBLIC_INFORMATIONAL_ONLY, 36 ADMIN_ONLY, 94 ENTERPRISE_ONLY — no web route was added or removed since the freeze (checked against `apps/web/app/**/page.tsx`, 208 pages).

**How each column is decided (no column is asserted by hand):**
- **Native** — the serving file(s), verified to exist; `(n)` = number of OTHER native files that navigate to it.
- **Deep link** — iOS: the route matches a component of `apps/web/public/.well-known/apple-app-site-association`; Android: an `app.json` intent-filter pathPrefix covers it; scheme: a `proovra://` canonical family in `src/deep-link.ts`.
- **F / D / C** — Functional / Data / Content: `PARTIAL` while any ledger row for the route is UNRESOLVED on that axis (UNREACHABLE+CONTROL+HANDLER+FUNCTIONAL / ENDPOINT / CONTENT); otherwise `AUTOMATED-TESTED` when a test loads the native screen, else `SOURCE-IMPLEMENTED`.
- **V** — Visual: `PARTIAL` while a shared visual foundation the screen consumes is unmet or a CSS/VISUAL row is open. Per-screen pixel comparison is NOT automated, so no row is VISUAL-DONE; **DEVICE-ACCEPTED is false for every route** until the physical-device gate runs.
- **L10n** — the web localizes only /login and /register — the only web screens that call `t()` (/verify/[token] mounts useLocale but renders English; Settings › Preferences is a language picker, which native also has). Everywhere else the PWA is English-only, so English-only native is parity, and the language CHOICE still reaches the shell (navigation/header read the dictionary on both).

## Shared foundations (verified in source)

| Foundation | Consumed |
|---|---|
| Fonts loaded at the root (`useAppFonts` in app/_layout.tsx) | yes |
| Sidebar/rail artwork (`sidebar-bg.png` via ImageBackground) | yes |
| App-shell background artwork (`app-shell-bg.png`) behind header + content | yes |
| Auth hero artwork (`auth-hero.png`) on login/register/reset/verify-email | yes |

## Ledger reconciliation (1071 child ids; was 1,044 before this pass)

| Class | Rows |
|---|---:|
| ACTUAL_FIX | 392 |
| UNRESOLVED | 235 |
| VERIFIED_EQUIVALENT | 195 |
| VALID_EXCLUSION | 135 |
| PRODUCT_DECISION | 30 |
| AUDIT_CORRECTION | 30 |
| CONSUMED_BY_NATIVE | 29 |
| ROOT_CAUSE_CLOSED | 13 |
| DEVICE_GATE | 6 |
| BLOCKED_ON_APPROVAL | 3 |
| PARTIAL | 2 |
| EXTERNALLY_BLOCKED | 1 |

UNRESOLVED by axis: ROUTE 60 · CONTENT 117 · CSS 49 · ROOT_CAUSE 7 · FUNCTIONAL 2. The 60 ROUTE rows are per-route aggregates — this matrix replaces them as the per-route truth.

Every CLOSED row was re-checked: cited native files must exist today, and a fixed control's label must still be in native source (a SELECT/LINK whose accessible name became a chip/picker label counts only when its cited test exists). Recheck failures: **0**.

## Matrix

| Route | Native (nav refs) | Nav | Deep link iOS/And/scheme | F | D | V | C | L10n | Tests | Open ids |
|---|---|---|---|---|---|---|---|---|---:|---|
| `/abuse-reporting` | `/legal/[slug]`(9) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/auth` | `/auth`(13) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/auth/callback/ui` | `/auth`(13) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/app/auth/callback/ui/page.tsx` |
| `/auth/mfa-challenge` | `/mfa`(1) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/app/auth/mfa-challenge/page.tsx`, `CONTENT_FILE:apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx` |
| `/auth/mfa-recovery/verify` | `/mfa-recovery-verify`(0) | link-only | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 1 | — |
| `/auth/verify-email` | `/verify-email`(0) | link-only | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/billing` | `/billing`(8) | yes | –/–/– | PARTIAL | PARTIAL | PARTIAL | PARTIAL | en=web | 1 | `UNREACHABLE:apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:416|/billing`, `UNREACHABLE:apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:434|/billing`, `UNREACHABLE:apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:468|/billing` … +18 |
| `/capture` | `/capture`(9) + `/screen-capture`(2) + `/continuous-capture`(2) | yes | –/–/– | AUTOMATED-TESTED | PARTIAL | PARTIAL | PARTIAL | en=web | 4 | `ENDPOINT:/v1/uploads/sessions`, `ENDPOINT:/v1/uploads/sessions/${…}`, `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx` … +15 |
| `/cases` | `/cases`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/cases-experience/CasesIndex.tsx` … +2 |
| `/cases/[id]` | `/case/[id]`(6) | yes | –/–/✓ | PARTIAL | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 4 | `NEW:ANDROID-SHARE-URL`, `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx` … +5 |
| `/collaboration-teams` | `/teams`(6) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` |
| `/collaboration-teams/[teamId]` | `/collaboration-team/[id]`(2) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 4 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` |
| `/collaboration-teams/[teamId]/collaboration` | `/collaboration-team/[id]`(2) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 4 | `CONTENT_FILE:apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` |
| `/collaboration-teams/invites/[token]/accept` | `/invite/[token]`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx` |
| `/data-retention` | `/legal/[slug]`(9) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/evidence` | `/evidence`(5) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx` … +4 |
| `/evidence-requests/[id]` | `/evidence-request/[id]`(1) + `/evidence-requests`(1) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence-requests/[id]/page.tsx` … +3 |
| `/evidence/[id]` | `/evidence/[id]`(14) | yes | –/–/✓ | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 13 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/page.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` … +21 |
| `/forgot-password` | `/forgot-password`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/home` | `/`(19) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 6 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/home-experience/HomeSections.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` … +5 |
| `/inbox` | `/notifications`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/inbox/page.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` |
| `/intake-links` | `/intake-links`(7) + `/intake-link-create`(2) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/intake-links/_components/States.tsx` … +5 |
| `/intake/[token]` | `/intake/[token]`(3) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/app/intake/[token]/page.tsx`, `CONTENT_FILE:apps/web/components/intake/IntakeReReviewBanner.tsx` |
| `/intake/[token]/capture` | `/intake/capture`(1) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/app/intake/[token]/capture/page.tsx` |
| `/invite/[token]` | `/invite/[token]`(3) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx` |
| `/legal/[slug]` | `/legal/[slug]`(9) + `/legal`(2) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/app/legal/[slug]/page.tsx` |
| `/login` | `/auth`(13) + `/legal-acceptance`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | dict | 3 | `CONTENT_FILE:apps/web/app/login/page.tsx` |
| `/notifications` | `/notifications`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/inbox/page.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` |
| `/operations` | `/operations`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | AUTOMATED-TESTED | en=web | 1 | — |
| `/operations/batch-analysis` | `/operations/batch-analysis`(2) | yes | –/–/– | PARTIAL | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `NEW:ANDROID-SHARE-URL`, `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` … +1 |
| `/operations/health` | `/operations/health`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 1 | — |
| `/operations/quotas` | `/operations/quotas`(2) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/operations/quotas/page.tsx` |
| `/org-invites/[token]/accept` | `/org-invite/[token]`(1) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/org-invites/[token]/accept/page.tsx` |
| `/organizations` | `/organizations`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/organizations/page.tsx` |
| `/organizations/[id]` | `/organizations/[id]`(2) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/organizations/[id]/page.tsx`, `CONTENT_FILE:apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx` … +1 |
| `/people` | `/workspace-people`(6) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 4 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` |
| `/portal` | `/portal`(2) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/page.tsx` |
| `/portal/[token]` | `/portal/[token]`(5) | yes | ✓/✓/– | PARTIAL | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 2 | `NEW:PORTAL-TOKEN-IN-PARAMS`, `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/[token]/page.tsx` |
| `/portal/[token]/work/[workflowId]` | `/portal/work/[workflowId]`(1) | yes | ✓/✓/– | PARTIAL | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `UNREACHABLE:apps/web/app/portal/[token]/work/[workflowId]/page.tsx:361|/portal/[token]/wor`, `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/[token]/work/[workflowId]/page.tsx` |
| `/portal/accept/[grantId]` | `/portal/accept/[grantId]`(3) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/accept/[grantId]/page.tsx` |
| `/pricing` | `/billing`(8) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/app/pricing/page.tsx` |
| `/privacy` | `/legal/[slug]`(9) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/register` | `/register`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | dict | 3 | `CONTENT_FILE:apps/web/app/register/page.tsx` |
| `/reports` | `/reports`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/contextual-help/ContextualHelp.tsx`, `CONTENT_FILE:apps/web/components/reports-experience/ReportsIndex.tsx` |
| `/reset-password` | `/reset-password`(1) | yes | ✓/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/app/reset-password/page.tsx` |
| `/search` | `/search`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 4 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/search/page.tsx`, `CONTENT_FILE:apps/web/app/(app)/search/components/SearchStates.tsx` … +2 |
| `/settings` | `/settings`(5) + `/settings/security`(1) + `/settings/privacy`(1) + `/settings/ai`(1) + `/settings/notifications`(2) + `/legal-acceptance`(3) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 9 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/AiSection.tsx` … +9 |
| `/settings/legal/[slug]` | `/legal/[slug]`(9) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 2 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx` |
| `/settings/reviewer-criteria` | `/settings/reviewer-criteria`(2) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/reviewer-criteria/page.tsx` |
| `/share/[id]` | `/evidence/[id]`(14) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 13 | `CONTENT_FILE:apps/web/app/share/[id]/page.tsx` |
| `/subprocessors` | `/legal/[slug]`(9) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/support` | `/support`(7) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 1 | — |
| `/teams/[id]` | `/workspace-people`(6) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 4 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`, `CONTENT_FILE:apps/web/app/(app)/teams/[id]/page.tsx` … +5 |
| `/terms` | `/legal/[slug]`(9) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 2 | — |
| `/trust` | `/trust-center`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/app/trust/page.tsx` |
| `/trust-center` | `/trust-center`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 3 | — |
| `/trust-center/ai-disclosure` | `/trust-center`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx` … +2 |
| `/trust-center/methodology` | `/trust-center`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_section-list.tsx` … +2 |
| `/trust-center/security` | `/trust-center`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_section-list.tsx` … +1 |
| `/trust-center/status` | `/trust-center`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx` |
| `/trust-center/subprocessors` | `/trust-center`(4) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 3 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_version-history.tsx` |
| `/verify` | `/verify`(2) | yes | –/✓/– | AUTOMATED-TESTED | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 3 | — |
| `/verify/[token]` | `/verify`(2) | yes | ✓/✓/– | PARTIAL | AUTOMATED-TESTED | SOURCE-IMPLEMENTED | AUTOMATED-TESTED | en=web | 3 | `NEW:VERIFY-CAPTURE-CONTEXT` |
| `/workspaces` | `/spaces`(5) | yes | –/–/– | AUTOMATED-TESTED | AUTOMATED-TESTED | PARTIAL | PARTIAL | en=web | 1 | `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/contextual-help/ContextualHelp.tsx` … +1 |

## Per-route detail

### `/abuse-reporting`
- **Web entry:** `apps/web/app/abuse-reporting/page.tsx` · **Native:** `apps/mobile/app/(stack)/legal/[slug].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/legal/index.tsx, apps/mobile/app/(stack)/register.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/legal.render.test.mjs`, `test/support.render.test.mjs`
- **Ledger:** 1 rows (UNRESOLVED 1) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/auth`
- **Web entry:** `apps/web/app/auth/page.tsx` · **Native:** `apps/mobile/app/(stack)/auth.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/forgot-password.tsx, apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/mfa-recovery-verify.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/sign-in-heading.render.test.mjs`
- **Ledger:** 1 rows (UNRESOLVED 1) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/auth/callback/ui`
- **Web entry:** `apps/web/app/auth/callback/ui/page.tsx` · **Native:** `apps/mobile/app/(stack)/auth.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/forgot-password.tsx, apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/mfa-recovery-verify.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/auth/callback/ui/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/sign-in-heading.render.test.mjs`
- **Ledger:** 7 rows (UNRESOLVED 2, VALID_EXCLUSION 3, VERIFIED_EQUIVALENT 1, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/auth/mfa-challenge`
- **Web entry:** `apps/web/app/auth/mfa-challenge/page.tsx` · **Native:** `apps/mobile/app/(stack)/mfa.tsx`
- **Reachable:** navigation yes (apps/mobile/src/auth/use-auth-flow.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/auth/mfa-challenge/page.tsx`, `CONTENT_FILE:apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/auth-recovery-states.render.test.mjs`
- **Ledger:** 10 rows (UNRESOLVED 3, ACTUAL_FIX 6, VALID_EXCLUSION 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/auth/mfa-recovery/verify`
- **Web entry:** `apps/web/app/auth/mfa-recovery/verify/page.tsx` · **Native:** `apps/mobile/app/(stack)/mfa-recovery-verify.tsx`
- **Reachable:** navigation link/token only · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/mfa-recovery-verify.render.test.mjs`
- **Ledger:** 3 rows (UNRESOLVED 1, VERIFIED_EQUIVALENT 1, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/auth/verify-email`
- **Web entry:** `apps/web/app/auth/verify-email/page.tsx` · **Native:** `apps/mobile/app/(stack)/verify-email.tsx`
- **Reachable:** navigation link/token only · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/auth-recovery-states.render.test.mjs`, `test/branded-surfaces.render.test.mjs`
- **Ledger:** 11 rows (UNRESOLVED 1, VALID_EXCLUSION 3, ACTUAL_FIX 5, VERIFIED_EQUIVALENT 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/billing`
- **Web entry:** `apps/web/app/(app)/billing/page.tsx` · **Native:** `apps/mobile/app/(stack)/billing.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/collaboration-team/[id].tsx, apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/workspace-people.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** PARTIAL `UNREACHABLE:apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:416|/billing`, `UNREACHABLE:apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:434|/billing`, `UNREACHABLE:apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:468|/billing`, `UNREACHABLE:apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:180|/billing`, `UNREACHABLE:apps/web/app/(app)/billing/_sections/BillingDrawer.tsx:190|/billing`
- **Data:** PARTIAL `ENDPOINT:/v1/billing/subscription/plan`, `ENDPOINT:/v1/billing/credits/checkout/stripe`, `ENDPOINT:/v1/billing/credits/checkout/paypal`, `ENDPOINT:/v1/billing/storage-addons/checkout/stripe`, `ENDPOINT:/v1/billing/storage-addons/checkout/paypal`, `ENDPOINT:/v1/billing/checkout/stripe`, `ENDPOINT:/v1/billing/checkout/paypal`
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx`, `CONTENT_FILE:apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx`, `CONTENT_FILE:apps/web/app/(app)/billing/_sections/BillingOverview.tsx`, `CONTENT_FILE:apps/web/app/(app)/billing/page.tsx`, `CONTENT_FILE:apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx`, `CONTENT_FILE:apps/web/app/(app)/billing/_sections/PlanAndUsage.tsx`, `CONTENT_FILE:apps/web/app/(app)/billing/_sections/PaymentMethodChoice.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/billing-accounts.render.test.mjs`
- **Ledger:** 41 rows (UNRESOLVED 11, PRODUCT_DECISION 12, VALID_EXCLUSION 3, ACTUAL_FIX 9, VERIFIED_EQUIVALENT 6) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/capture`
- **Web entry:** `apps/web/app/(app)/capture/page.tsx` · **Native:** `apps/mobile/app/(stack)/capture.tsx`, `apps/mobile/app/(stack)/screen-capture.tsx`, `apps/mobile/app/(stack)/continuous-capture.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/continuous-capture.tsx, apps/mobile/app/(stack)/evidence-request/[id].tsx, apps/mobile/app/(stack)/screen-capture.tsx; apps/mobile/app/(stack)/capture.tsx, apps/mobile/src/capture/screen-acquisition.ts; apps/mobile/app/(stack)/capture.tsx, apps/mobile/src/capture/screen-acquisition.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** PARTIAL `ENDPOINT:/v1/uploads/sessions`, `ENDPOINT:/v1/uploads/sessions/${…}`
- **Visual:** PARTIAL — 16 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/page.tsx`, `CONTENT_FILE:apps/web/components/contextual-help/ContextualHelp.tsx`, `CONTENT_FILE:apps/web/components/capture-v2/CaptureSessionPanel.tsx`, `CONTENT_FILE:apps/web/components/uploads/UploadOperationsPanel.tsx`, `CONTENT_FILE:apps/web/components/capture-v2/CaptureRequirements.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/_lib/CaptureReadinessPanel.tsx`, `CONTENT_FILE:apps/web/components/capture-v2/CaptureDropzone.tsx`, `CONTENT_FILE:apps/web/components/capture-v2/CaptureCameraOverlay.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/_lib/CaptureDraftReattachNotice.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/_lib/CaptureOperationalSummary.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/_lib/CaptureIntakeRail.tsx`, `CONTENT_FILE:apps/web/app/(app)/capture/_lib/CaptureFinalReadiness.tsx`, `CONTENT_FILE:apps/web/components/capture-v2/CaptureBottomBar.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/capture-lifecycle.render.test.mjs`, `test/capture-session-status.render.test.mjs`, `test/error-presentation.test.mjs`, `test/mobile-boot-contract.test.mjs`
- **Ledger:** 70 rows (UNRESOLVED 18, PRODUCT_DECISION 17, VALID_EXCLUSION 6, ACTUAL_FIX 18, VERIFIED_EQUIVALENT 11) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/cases`
- **Web entry:** `apps/web/app/(app)/cases/page.tsx` · **Native:** `apps/mobile/app/(tabs)/cases.tsx`
- **Reachable:** navigation yes (apps/mobile/src/product/home-dashboard.ts, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/navigation.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 6 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/cases-experience/CasesIndex.tsx`, `CONTENT_FILE:apps/web/components/contextual-help/ContextualHelp.tsx`, `CONTENT_FILE:apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/cases-queue.render.test.mjs`, `test/request-id-and-small-gaps.render.test.mjs`
- **Ledger:** 46 rows (UNRESOLVED 12, ACTUAL_FIX 9, VALID_EXCLUSION 9, VERIFIED_EQUIVALENT 16) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/cases/[id]`
- **Web entry:** `apps/web/app/(app)/cases/[id]/page.tsx` · **Native:** `apps/mobile/app/(stack)/case/[id].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/cases.tsx, apps/mobile/src/product/ai-copilot.ts, apps/mobile/src/product/inbox.ts) · deep link iOS false / Android false / scheme true
- **Functional:** PARTIAL `NEW:ANDROID-SHARE-URL`
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 4 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/governance/GovernanceSummary.tsx`, `CONTENT_FILE:apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx`, `CONTENT_FILE:apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx`, `CONTENT_FILE:apps/web/components/governance/LifecycleStateBadge.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/case-copilot.render.test.mjs`, `test/case-overview.render.test.mjs`, `test/presence.render.test.mjs`, `test/team-responsibility.render.test.mjs`
- **Ledger:** 102 rows (UNRESOLVED 12, VALID_EXCLUSION 51, ACTUAL_FIX 27, VERIFIED_EQUIVALENT 10, AUDIT_CORRECTION 1, BLOCKED_ON_APPROVAL 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/collaboration-teams`
- **Web entry:** `apps/web/app/(app)/collaboration-teams/page.tsx` · **Native:** `apps/mobile/app/(tabs)/teams.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/org-invite/[token].tsx, apps/mobile/app/(tabs)/settings.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/collaboration-teams-list.render.test.mjs`, `test/collaboration-teams-rollup.render.test.mjs`
- **Ledger:** 25 rows (UNRESOLVED 4, VALID_EXCLUSION 1, ACTUAL_FIX 15, VERIFIED_EQUIVALENT 5) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/collaboration-teams/[teamId]`
- **Web entry:** `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` · **Native:** `apps/mobile/app/(stack)/collaboration-team/[id].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(tabs)/teams.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/collaboration-add-members.render.test.mjs`, `test/create-assignment.render.test.mjs`, `test/request-id-and-small-gaps.render.test.mjs`, `test/team-discussion.render.test.mjs`
- **Ledger:** 25 rows (UNRESOLVED 4, VALID_EXCLUSION 3, VERIFIED_EQUIVALENT 5, ACTUAL_FIX 13) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/collaboration-teams/[teamId]/collaboration`
- **Web entry:** `apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` · **Native:** `apps/mobile/app/(stack)/collaboration-team/[id].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(tabs)/teams.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/collaboration-add-members.render.test.mjs`, `test/create-assignment.render.test.mjs`, `test/request-id-and-small-gaps.render.test.mjs`, `test/team-discussion.render.test.mjs`
- **Ledger:** 4 rows (UNRESOLVED 3, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/collaboration-teams/invites/[token]/accept`
- **Web entry:** `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx` · **Native:** `apps/mobile/app/(stack)/invite/[token].tsx`
- **Reachable:** navigation yes (apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/workspace-invite.ts, apps/mobile/src/ui/workspace-invite.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/collab-invite-refusal.render.test.mjs`, `test/request-id-and-small-gaps.render.test.mjs`, `test/workspace-invite.render.test.mjs`
- **Ledger:** 10 rows (UNRESOLVED 4, VALID_EXCLUSION 1, ACTUAL_FIX 4, VERIFIED_EQUIVALENT 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/data-retention`
- **Web entry:** `apps/web/app/data-retention/page.tsx` · **Native:** `apps/mobile/app/(stack)/legal/[slug].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/legal/index.tsx, apps/mobile/app/(stack)/register.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/legal.render.test.mjs`, `test/support.render.test.mjs`
- **Ledger:** 1 rows (UNRESOLVED 1) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/evidence`
- **Web entry:** `apps/web/app/(app)/evidence/page.tsx` · **Native:** `apps/mobile/app/(tabs)/evidence.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/operations/index.tsx, apps/mobile/src/product/home-dashboard.ts, apps/mobile/src/product/native-destinations.mjs) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/components/EvidenceList.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/components/EvidenceFilters.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/evidence-retention.render.test.mjs`
- **Ledger:** 17 rows (UNRESOLVED 8, VALID_EXCLUSION 1, VERIFIED_EQUIVALENT 6, ACTUAL_FIX 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/evidence-requests/[id]`
- **Web entry:** `apps/web/app/(app)/evidence-requests/[id]/page.tsx` · **Native:** `apps/mobile/app/(stack)/evidence-request/[id].tsx`, `apps/mobile/app/(stack)/evidence-requests.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/evidence-requests.tsx; apps/mobile/app/(tabs)/settings.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence-requests/[id]/page.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignme`, `CONTENT_FILE:apps/web/components/navigation/OperationalBreadcrumb.tsx`, `CONTENT_FILE:apps/web/components/notifications/ContextualDeliveryStatus.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/evidence-request-assign.render.test.mjs`, `test/evidence-request-review.render.test.mjs`
- **Ledger:** 21 rows (UNRESOLVED 7, VALID_EXCLUSION 5, ACTUAL_FIX 7, VERIFIED_EQUIVALENT 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/evidence/[id]`
- **Web entry:** `apps/web/app/(app)/evidence/[id]/page.tsx` · **Native:** `apps/mobile/app/(stack)/evidence/[id].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/capture.tsx, apps/mobile/app/(stack)/evidence-request/[id].tsx, apps/mobile/app/(stack)/intake-links.tsx) · deep link iOS false / Android false / scheme true
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 6 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/page.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAp`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx`, `CONTENT_FILE:apps/web/components/governance/GovernanceSummary.tsx`, `CONTENT_FILE:apps/web/components/operational/RuntimeStatusBanner.tsx`, `CONTENT_FILE:apps/web/components/operational/OperationalEmptyState.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx`, `CONTENT_FILE:apps/web/components/operational/GovernanceSnapshotPanel.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx`, `CONTENT_FILE:apps/web/components/presence/CollisionWarning.tsx`, `CONTENT_FILE:apps/web/app/(app)/evidence/components/ReviewerCommentsPanel.tsx` … +4 · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-categorization.render.test.mjs`, `test/evidence-attention.render.test.mjs`, `test/evidence-case-assign.render.test.mjs`, `test/evidence-comparison.render.test.mjs`, `test/evidence-copilot.render.test.mjs`, `test/evidence-declarations.render.test.mjs`, `test/evidence-discussion.render.test.mjs`, `test/evidence-export.render.test.mjs`, `test/evidence-linked-requests.render.test.mjs`, `test/evidence-part-metadata.render.test.mjs`, `test/media-intelligence.render.test.mjs`, `test/provenance.render.test.mjs`, `test/review-actions.render.test.mjs`
- **Ledger:** 131 rows (UNRESOLVED 29, CONSUMED_BY_NATIVE 7, ACTUAL_FIX 61, VALID_EXCLUSION 14, VERIFIED_EQUIVALENT 15, BLOCKED_ON_APPROVAL 1, PARTIAL 1, AUDIT_CORRECTION 3) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/forgot-password`
- **Web entry:** `apps/web/app/forgot-password/page.tsx` · **Native:** `apps/mobile/app/(stack)/forgot-password.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/auth.tsx, apps/mobile/app/(stack)/register.tsx, apps/mobile/app/(stack)/reset-password.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/forgot-password.render.test.mjs`
- **Ledger:** 4 rows (UNRESOLVED 1, ACTUAL_FIX 3) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/home`
- **Web entry:** `apps/web/app/(app)/home/page.tsx` · **Native:** `apps/mobile/app/(tabs)/index.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/capture.tsx, apps/mobile/app/(stack)/intake/capture.tsx, apps/mobile/app/(stack)/intake/[token].tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/home-experience/HomeSections.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/contextual-help/ContextualHelp.tsx`, `CONTENT_FILE:apps/web/components/home-experience/HomeDashboardSections.tsx`, `CONTENT_FILE:apps/web/components/operational/RuntimeStatusBanner.tsx`, `CONTENT_FILE:apps/web/components/operational/OperationalEmptyState.tsx`, `CONTENT_FILE:apps/web/components/home-experience/SelfServeHomeDashboard.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/header-search.test.mjs`, `test/home-dashboard-states.render.test.mjs`, `test/home-intake.render.test.mjs`, `test/home-sections.render.test.mjs`, `test/home.render.test.mjs`, `test/mobile-boot-contract.test.mjs`
- **Ledger:** 50 rows (UNRESOLVED 10, CONSUMED_BY_NATIVE 4, ACTUAL_FIX 17, VALID_EXCLUSION 13, VERIFIED_EQUIVALENT 6) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/inbox`
- **Web entry:** `apps/web/app/(app)/inbox/page.tsx` · **Native:** `apps/mobile/app/(tabs)/notifications.tsx`
- **Reachable:** navigation yes (apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/navigation.ts, apps/mobile/src/ui/header.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/inbox/page.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/inbox-archive.render.test.mjs`, `test/notifications-filter-empty.render.test.mjs`
- **Ledger:** 16 rows (UNRESOLVED 4, VALID_EXCLUSION 2, ACTUAL_FIX 6, VERIFIED_EQUIVALENT 3, AUDIT_CORRECTION 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/intake-links`
- **Web entry:** `apps/web/app/(app)/intake-links/page.tsx` · **Native:** `apps/mobile/app/(stack)/intake-links.tsx`, `apps/mobile/app/(stack)/intake-link-create.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/intake-link-create.tsx, apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/home-dashboard.ts; apps/mobile/app/(stack)/intake-links.tsx, apps/mobile/src/ui/home-intake-pipeline.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/intake-links/_components/States.tsx`, `CONTENT_FILE:apps/web/app/(app)/intake-links/_components/RecordsSurface.tsx`, `CONTENT_FILE:apps/web/app/(app)/intake-links/page.tsx`, `CONTENT_FILE:apps/web/app/(app)/intake-links/_components/FilterToolbar.tsx`, `CONTENT_FILE:apps/web/app/(app)/intake-links/_components/SubmissionsDrawer.tsx`, `CONTENT_FILE:apps/web/app/(app)/intake-links/_components/Pagination.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/intake-links.render.test.mjs`, `test/intake-create.test.mjs`
- **Ledger:** 65 rows (UNRESOLVED 10, ACTUAL_FIX 32, CONSUMED_BY_NATIVE 2, VALID_EXCLUSION 5, VERIFIED_EQUIVALENT 15, AUDIT_CORRECTION 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/intake/[token]`
- **Web entry:** `apps/web/app/intake/[token]/page.tsx` · **Native:** `apps/mobile/app/(stack)/intake/[token].tsx`
- **Reachable:** navigation yes (apps/mobile/src/deep-link.ts, apps/mobile/src/product/external-intake.ts, apps/mobile/src/product/native-destinations.mjs) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/intake/[token]/page.tsx`, `CONTENT_FILE:apps/web/components/intake/IntakeReReviewBanner.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/intake-checklist.render.test.mjs`, `test/intake-consent.render.test.mjs`
- **Ledger:** 10 rows (UNRESOLVED 3, VERIFIED_EQUIVALENT 1, ACTUAL_FIX 6) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/intake/[token]/capture`
- **Web entry:** `apps/web/app/intake/[token]/capture/page.tsx` · **Native:** `apps/mobile/app/(stack)/intake/capture.tsx`
- **Reachable:** navigation yes (apps/mobile/src/product/external-intake.ts) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/intake/[token]/capture/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/intake-capture.render.test.mjs`
- **Ledger:** 5 rows (UNRESOLVED 2, ACTUAL_FIX 3) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/invite/[token]`
- **Web entry:** `apps/web/app/invite/[token]/page.tsx` · **Native:** `apps/mobile/app/(stack)/invite/[token].tsx`
- **Reachable:** navigation yes (apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/workspace-invite.ts, apps/mobile/src/ui/workspace-invite.tsx) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/collab-invite-refusal.render.test.mjs`, `test/request-id-and-small-gaps.render.test.mjs`, `test/workspace-invite.render.test.mjs`
- **Ledger:** 10 rows (UNRESOLVED 2, VALID_EXCLUSION 2, ACTUAL_FIX 6) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/legal/[slug]`
- **Web entry:** `apps/web/app/legal/[slug]/page.tsx` · **Native:** `apps/mobile/app/(stack)/legal/[slug].tsx`, `apps/mobile/app/(stack)/legal/index.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/legal/index.tsx, apps/mobile/app/(stack)/register.tsx; apps/mobile/app/(stack)/legal/[slug].tsx, apps/mobile/app/(tabs)/settings.tsx) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 3 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/legal/[slug]/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/legal.render.test.mjs`, `test/support.render.test.mjs`
- **Ledger:** 9 rows (UNRESOLVED 5, VALID_EXCLUSION 2, AUDIT_CORRECTION 1, VERIFIED_EQUIVALENT 1) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/login`
- **Web entry:** `apps/web/app/login/page.tsx` · **Native:** `apps/mobile/app/(stack)/auth.tsx`, `apps/mobile/app/(stack)/legal-acceptance.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/forgot-password.tsx, apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/mfa-recovery-verify.tsx; apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/auth/legal-gate.ts, apps/mobile/src/auth/use-auth-flow.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/login/page.tsx` · localization: DICTIONARY-BOUND
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/sign-in-heading.render.test.mjs`, `test/legal-acceptance-body.render.test.mjs`
- **Ledger:** 11 rows (UNRESOLVED 2, VALID_EXCLUSION 3, ACTUAL_FIX 3, VERIFIED_EQUIVALENT 3) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/notifications`
- **Web entry:** `apps/web/app/(app)/notifications/page.tsx` · **Native:** `apps/mobile/app/(tabs)/notifications.tsx`
- **Reachable:** navigation yes (apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/navigation.ts, apps/mobile/src/ui/header.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/inbox/page.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/inbox-archive.render.test.mjs`, `test/notifications-filter-empty.render.test.mjs`
- **Ledger:** 16 rows (UNRESOLVED 4, VALID_EXCLUSION 2, ACTUAL_FIX 6, VERIFIED_EQUIVALENT 3, AUDIT_CORRECTION 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/operations`
- **Web entry:** `apps/web/app/(app)/operations/page.tsx` · **Native:** `apps/mobile/app/(stack)/operations/index.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/operations/health.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/navigation.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 4 open CSS rows
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ops-console.test.mjs`
- **Ledger:** 20 rows (BLOCKED_ON_APPROVAL 1, CONSUMED_BY_NATIVE 13, UNRESOLVED 4, VERIFIED_EQUIVALENT 1, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/operations/batch-analysis`
- **Web entry:** `apps/web/app/(app)/operations/batch-analysis/page.tsx` · **Native:** `apps/mobile/app/(stack)/operations/batch-analysis.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs) · deep link iOS false / Android false / scheme false
- **Functional:** PARTIAL `NEW:ANDROID-SHARE-URL`
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/operations/batch-analysis/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/operations-batch-analysis.render.test.mjs`
- **Ledger:** 12 rows (UNRESOLVED 4, VALID_EXCLUSION 3, CONSUMED_BY_NATIVE 1, ACTUAL_FIX 3, BLOCKED_ON_APPROVAL 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/operations/health`
- **Web entry:** `apps/web/app/(app)/operations/health/page.tsx` · **Native:** `apps/mobile/app/(stack)/operations/health.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/operations/index.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/ops-health.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ops-console.test.mjs`
- **Ledger:** 3 rows (ACTUAL_FIX 2, VERIFIED_EQUIVALENT 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/operations/quotas`
- **Web entry:** `apps/web/app/(app)/operations/quotas/page.tsx` · **Native:** `apps/mobile/app/(stack)/operations/quotas.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/operations/quotas/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/operations-quotas.render.test.mjs`
- **Ledger:** 9 rows (UNRESOLVED 4, VALID_EXCLUSION 2, VERIFIED_EQUIVALENT 2, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/org-invites/[token]/accept`
- **Web entry:** `apps/web/app/(app)/org-invites/[token]/accept/page.tsx` · **Native:** `apps/mobile/app/(stack)/org-invite/[token].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/organizations/index.tsx) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/org-invites/[token]/accept/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/org-invite-open.render.test.mjs`
- **Ledger:** 9 rows (UNRESOLVED 4, VERIFIED_EQUIVALENT 3, ACTUAL_FIX 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/organizations`
- **Web entry:** `apps/web/app/(app)/organizations/page.tsx` · **Native:** `apps/mobile/app/(stack)/organizations/index.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/org-invite/[token].tsx, apps/mobile/app/(stack)/spaces.tsx, apps/mobile/app/(tabs)/settings.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/organizations/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/organizations-list.render.test.mjs`
- **Ledger:** 15 rows (UNRESOLVED 4, CONSUMED_BY_NATIVE 1, VALID_EXCLUSION 1, ACTUAL_FIX 3, VERIFIED_EQUIVALENT 6) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/organizations/[id]`
- **Web entry:** `apps/web/app/(app)/organizations/[id]/page.tsx` · **Native:** `apps/mobile/app/(stack)/organizations/[id].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/organizations/index.tsx, apps/mobile/src/product/native-destinations.mjs) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/organizations/[id]/page.tsx`, `CONTENT_FILE:apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/org-detail.render.test.mjs`
- **Ledger:** 39 rows (UNRESOLVED 5, VALID_EXCLUSION 2, ACTUAL_FIX 22, CONSUMED_BY_NATIVE 1, VERIFIED_EQUIVALENT 9) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/people`
- **Web entry:** `apps/web/app/(app)/people/page.tsx` · **Native:** `apps/mobile/app/(stack)/workspace-people.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/collaboration-team/[id].tsx, apps/mobile/app/(stack)/spaces.tsx, apps/mobile/app/(tabs)/settings.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/external-collaborators.render.test.mjs`, `test/member-removal.render.test.mjs`, `test/role-permissions.render.test.mjs`, `test/workspace-roster-filter.render.test.mjs`
- **Ledger:** 4 rows (UNRESOLVED 3, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/portal`
- **Web entry:** `apps/web/app/portal/page.tsx` · **Native:** `apps/mobile/app/(stack)/portal/index.tsx`
- **Reachable:** navigation yes (apps/mobile/src/deep-link.ts, apps/mobile/src/product/native-destinations.mjs) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/portal-entry.render.test.mjs`
- **Ledger:** 8 rows (UNRESOLVED 3, VALID_EXCLUSION 2, CONSUMED_BY_NATIVE 1, ACTUAL_FIX 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/portal/[token]`
- **Web entry:** `apps/web/app/portal/[token]/page.tsx` · **Native:** `apps/mobile/app/(stack)/portal/[token].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/portal/accept/[grantId].tsx, apps/mobile/app/(stack)/portal/index.tsx, apps/mobile/src/deep-link.ts) · deep link iOS true / Android true / scheme false
- **Functional:** PARTIAL `NEW:PORTAL-TOKEN-IN-PARAMS`
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/[token]/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/portal-entry.render.test.mjs`, `test/portal-mfa.render.test.mjs`
- **Ledger:** 10 rows (UNRESOLVED 4, VALID_EXCLUSION 2, VERIFIED_EQUIVALENT 2, ACTUAL_FIX 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/portal/[token]/work/[workflowId]`
- **Web entry:** `apps/web/app/portal/[token]/work/[workflowId]/page.tsx` · **Native:** `apps/mobile/app/(stack)/portal/work/[workflowId].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/portal/[token].tsx) · deep link iOS true / Android true / scheme false
- **Functional:** PARTIAL `UNREACHABLE:apps/web/app/portal/[token]/work/[workflowId]/page.tsx:361|/portal/[token]/wor`
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/[token]/work/[workflowId]/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/portal-work.render.test.mjs`
- **Ledger:** 10 rows (UNRESOLVED 3, VALID_EXCLUSION 2, PRODUCT_DECISION 1, VERIFIED_EQUIVALENT 2, ACTUAL_FIX 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/portal/accept/[grantId]`
- **Web entry:** `apps/web/app/portal/accept/[grantId]/page.tsx` · **Native:** `apps/mobile/app/(stack)/portal/accept/[grantId].tsx`
- **Reachable:** navigation yes (apps/mobile/src/deep-link.ts, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/portal.ts) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/external-portal/PortalMfaCodeStep.tsx`, `CONTENT_FILE:apps/web/app/portal/accept/[grantId]/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/portal-accept.render.test.mjs`
- **Ledger:** 6 rows (UNRESOLVED 3, VALID_EXCLUSION 2, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/pricing`
- **Web entry:** `apps/web/app/pricing/page.tsx` · **Native:** `apps/mobile/app/(stack)/billing.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/collaboration-team/[id].tsx, apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/workspace-people.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/pricing/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/billing-accounts.render.test.mjs`
- **Ledger:** 13 rows (UNRESOLVED 2, VALID_EXCLUSION 2, VERIFIED_EQUIVALENT 5, AUDIT_CORRECTION 4) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/privacy`
- **Web entry:** `apps/web/app/privacy/page.tsx` · **Native:** `apps/mobile/app/(stack)/legal/[slug].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/legal/index.tsx, apps/mobile/app/(stack)/register.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/legal.render.test.mjs`, `test/support.render.test.mjs`
- **Ledger:** 1 rows (UNRESOLVED 1) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/register`
- **Web entry:** `apps/web/app/register/page.tsx` · **Native:** `apps/mobile/app/(stack)/register.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/auth.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/ui/workspace-invite.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/register/page.tsx` · localization: DICTIONARY-BOUND
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/register-consent.render.test.mjs`, `test/register-oauth.render.test.mjs`
- **Ledger:** 16 rows (UNRESOLVED 2, VALID_EXCLUSION 3, CONSUMED_BY_NATIVE 1, ACTUAL_FIX 8, VERIFIED_EQUIVALENT 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/reports`
- **Web entry:** `apps/web/app/(app)/reports/page.tsx` · **Native:** `apps/mobile/app/(stack)/reports.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/billing.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/navigation.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/contextual-help/ContextualHelp.tsx`, `CONTENT_FILE:apps/web/components/reports-experience/ReportsIndex.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/reports-rows.render.test.mjs`
- **Ledger:** 21 rows (UNRESOLVED 5, ACTUAL_FIX 7, VALID_EXCLUSION 1, VERIFIED_EQUIVALENT 8) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/reset-password`
- **Web entry:** `apps/web/app/reset-password/page.tsx` · **Native:** `apps/mobile/app/(stack)/reset-password.tsx`
- **Reachable:** navigation yes (apps/mobile/src/product/native-destinations.mjs) · deep link iOS true / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/reset-password/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/reset-password.render.test.mjs`
- **Ledger:** 11 rows (UNRESOLVED 2, VALID_EXCLUSION 2, VERIFIED_EQUIVALENT 3, ACTUAL_FIX 4) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/search`
- **Web entry:** `apps/web/app/(app)/search/page.tsx` · **Native:** `apps/mobile/app/(stack)/search.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/index.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/navigation.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/search/page.tsx`, `CONTENT_FILE:apps/web/app/(app)/search/components/SearchStates.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/search/components/SearchGuidance.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/search-activity.render.test.mjs`, `test/search-filters.render.test.mjs`, `test/search-inspector.render.test.mjs`, `test/search-readiness.render.test.mjs`
- **Ledger:** 51 rows (UNRESOLVED 6, VALID_EXCLUSION 13, ACTUAL_FIX 25, VERIFIED_EQUIVALENT 7) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/settings`
- **Web entry:** `apps/web/app/(app)/settings/page.tsx` · **Native:** `apps/mobile/app/(tabs)/settings.tsx`, `apps/mobile/app/(stack)/settings/security.tsx`, `apps/mobile/app/(stack)/settings/privacy.tsx`, `apps/mobile/app/(stack)/settings/ai.tsx`, `apps/mobile/app/(stack)/settings/notifications.tsx`, `apps/mobile/app/(stack)/legal-acceptance.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/settings/ai.tsx, apps/mobile/src/product/ai-assistance.ts, apps/mobile/src/product/native-destinations.mjs; apps/mobile/app/(tabs)/settings.tsx; apps/mobile/app/(tabs)/settings.tsx; apps/mobile/app/(tabs)/settings.tsx; apps/mobile/app/(tabs)/notifications.tsx, apps/mobile/app/(tabs)/settings.tsx; apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/auth/legal-gate.ts, apps/mobile/src/auth/use-auth-flow.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 7 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/AiSection.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/notifications/NotificationPreferencesPanel.tsx`, `CONTENT_FILE:apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/RolesSection.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/SettingsOverview.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/AiReadOnlyView.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/PreferencesSection.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/OverviewSection.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/_sections/BillingSection.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/settings-language.render.test.mjs`, `test/contact-factors.render.test.mjs`, `test/identity-links.render.test.mjs`, `test/settings-security.render.test.mjs`, `test/settings-privacy.render.test.mjs`, `test/ai-policy-editor.render.test.mjs`, `test/messaging-contact.render.test.mjs`, `test/legal-acceptance-body.render.test.mjs`
- **Ledger:** 67 rows (UNRESOLVED 19, VALID_EXCLUSION 6, ACTUAL_FIX 32, CONSUMED_BY_NATIVE 3, VERIFIED_EQUIVALENT 6, PARTIAL 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/settings/legal/[slug]`
- **Web entry:** `apps/web/app/(app)/settings/legal/[slug]/page.tsx` · **Native:** `apps/mobile/app/(stack)/legal/[slug].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/legal/index.tsx, apps/mobile/app/(stack)/register.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 4 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/legal.render.test.mjs`, `test/support.render.test.mjs`
- **Ledger:** 14 rows (UNRESOLVED 8, ACTUAL_FIX 3, VALID_EXCLUSION 1, AUDIT_CORRECTION 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/settings/reviewer-criteria`
- **Web entry:** `apps/web/app/(app)/settings/reviewer-criteria/page.tsx` · **Native:** `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/settings/reviewer-criteria/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/criteria-version-history.render.test.mjs`
- **Ledger:** 13 rows (UNRESOLVED 4, ACTUAL_FIX 3, VERIFIED_EQUIVALENT 6) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/share/[id]`
- **Web entry:** `apps/web/app/share/[id]/page.tsx` · **Native:** `apps/mobile/app/(stack)/evidence/[id].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/capture.tsx, apps/mobile/app/(stack)/evidence-request/[id].tsx, apps/mobile/app/(stack)/intake-links.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/share/[id]/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-categorization.render.test.mjs`, `test/evidence-attention.render.test.mjs`, `test/evidence-case-assign.render.test.mjs`, `test/evidence-comparison.render.test.mjs`, `test/evidence-copilot.render.test.mjs`, `test/evidence-declarations.render.test.mjs`, `test/evidence-discussion.render.test.mjs`, `test/evidence-export.render.test.mjs`, `test/evidence-linked-requests.render.test.mjs`, `test/evidence-part-metadata.render.test.mjs`, `test/media-intelligence.render.test.mjs`, `test/provenance.render.test.mjs`, `test/review-actions.render.test.mjs`
- **Ledger:** 6 rows (UNRESOLVED 2, VALID_EXCLUSION 2, VERIFIED_EQUIVALENT 2) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/subprocessors`
- **Web entry:** `apps/web/app/subprocessors/page.tsx` · **Native:** `apps/mobile/app/(stack)/legal/[slug].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/legal/index.tsx, apps/mobile/app/(stack)/register.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/legal.render.test.mjs`, `test/support.render.test.mjs`
- **Ledger:** 1 rows (UNRESOLVED 1) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/support`
- **Web entry:** `apps/web/app/support/page.tsx` · **Native:** `apps/mobile/app/(stack)/support.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/support.render.test.mjs`
- **Ledger:** 12 rows (UNRESOLVED 1, VALID_EXCLUSION 2, VERIFIED_EQUIVALENT 5, ACTUAL_FIX 2, AUDIT_CORRECTION 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/teams/[id]`
- **Web entry:** `apps/web/app/(app)/teams/[id]/page.tsx` · **Native:** `apps/mobile/app/(stack)/workspace-people.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/collaboration-team/[id].tsx, apps/mobile/app/(stack)/spaces.tsx, apps/mobile/app/(tabs)/settings.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 2 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`, `CONTENT_FILE:apps/web/app/(app)/teams/[id]/page.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx`, `CONTENT_FILE:apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx`, `CONTENT_FILE:apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx`, `CONTENT_FILE:apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/external-collaborators.render.test.mjs`, `test/member-removal.render.test.mjs`, `test/role-permissions.render.test.mjs`, `test/workspace-roster-filter.render.test.mjs`
- **Ledger:** 42 rows (UNRESOLVED 11, VALID_EXCLUSION 2, ACTUAL_FIX 16, CONSUMED_BY_NATIVE 1, VERIFIED_EQUIVALENT 12) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/terms`
- **Web entry:** `apps/web/app/terms/page.tsx` · **Native:** `apps/mobile/app/(stack)/legal/[slug].tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/invite/[token].tsx, apps/mobile/app/(stack)/legal/index.tsx, apps/mobile/app/(stack)/register.tsx) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/legal.render.test.mjs`, `test/support.render.test.mjs`
- **Ledger:** 1 rows (UNRESOLVED 1) · SOURCE-FIXED false · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/trust`
- **Web entry:** `apps/web/app/trust/page.tsx` · **Native:** `apps/mobile/app/(stack)/trust-center.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/support.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** PARTIAL `CONTENT_FILE:apps/web/app/trust/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-capability-status.render.test.mjs`, `test/support.render.test.mjs`, `test/trust-live.render.test.mjs`
- **Ledger:** 8 rows (UNRESOLVED 2, VALID_EXCLUSION 2, ACTUAL_FIX 1, AUDIT_CORRECTION 3) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/trust-center`
- **Web entry:** `apps/web/app/(app)/trust-center/page.tsx` · **Native:** `apps/mobile/app/(stack)/trust-center.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/support.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-capability-status.render.test.mjs`, `test/support.render.test.mjs`, `test/trust-live.render.test.mjs`
- **Ledger:** 2 rows (UNRESOLVED 1, ACTUAL_FIX 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/trust-center/ai-disclosure`
- **Web entry:** `apps/web/app/(app)/trust-center/ai-disclosure/page.tsx` · **Native:** `apps/mobile/app/(stack)/trust-center.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/support.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_section-list.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_version-history.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-capability-status.render.test.mjs`, `test/support.render.test.mjs`, `test/trust-live.render.test.mjs`
- **Ledger:** 19 rows (UNRESOLVED 7, ACTUAL_FIX 7, VERIFIED_EQUIVALENT 3, VALID_EXCLUSION 1, AUDIT_CORRECTION 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/trust-center/methodology`
- **Web entry:** `apps/web/app/(app)/trust-center/methodology/page.tsx` · **Native:** `apps/mobile/app/(stack)/trust-center.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/support.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_section-list.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_version-history.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/methodology/page.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-capability-status.render.test.mjs`, `test/support.render.test.mjs`, `test/trust-live.render.test.mjs`
- **Ledger:** 15 rows (UNRESOLVED 7, ACTUAL_FIX 2, VERIFIED_EQUIVALENT 3, VALID_EXCLUSION 1, AUDIT_CORRECTION 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/trust-center/security`
- **Web entry:** `apps/web/app/(app)/trust-center/security/page.tsx` · **Native:** `apps/mobile/app/(stack)/trust-center.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/support.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_section-list.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_version-history.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-capability-status.render.test.mjs`, `test/support.render.test.mjs`, `test/trust-live.render.test.mjs`
- **Ledger:** 13 rows (UNRESOLVED 6, ACTUAL_FIX 2, VERIFIED_EQUIVALENT 3, VALID_EXCLUSION 1, AUDIT_CORRECTION 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/trust-center/status`
- **Web entry:** `apps/web/app/(app)/trust-center/status/page.tsx` · **Native:** `apps/mobile/app/(stack)/trust-center.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/support.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-capability-status.render.test.mjs`, `test/support.render.test.mjs`, `test/trust-live.render.test.mjs`
- **Ledger:** 20 rows (ACTUAL_FIX 13, VALID_EXCLUSION 3, UNRESOLVED 3, AUDIT_CORRECTION 1) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/trust-center/subprocessors`
- **Web entry:** `apps/web/app/(app)/trust-center/subprocessors/page.tsx` · **Native:** `apps/mobile/app/(stack)/trust-center.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs, apps/mobile/src/product/support.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 1 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/legal/LegalDocumentShell.tsx`, `CONTENT_FILE:apps/web/app/(app)/trust-center/_version-history.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/ai-capability-status.render.test.mjs`, `test/support.render.test.mjs`, `test/trust-live.render.test.mjs`
- **Ledger:** 19 rows (ACTUAL_FIX 8, VALID_EXCLUSION 4, VERIFIED_EQUIVALENT 1, UNRESOLVED 4, AUDIT_CORRECTION 2) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/verify`
- **Web entry:** `apps/web/app/verify/page.tsx` · **Native:** `apps/mobile/app/verify.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs) · deep link iOS false / Android true / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/public-verify-sections.render.test.mjs`, `test/public-verify.render.test.mjs`
- **Ledger:** 14 rows (UNRESOLVED 1, VALID_EXCLUSION 2, VERIFIED_EQUIVALENT 2, ACTUAL_FIX 6, AUDIT_CORRECTION 3) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/verify/[token]`
- **Web entry:** `apps/web/app/verify/[token]/page.tsx` · **Native:** `apps/mobile/app/verify.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/native-destinations.mjs) · deep link iOS true / Android true / scheme false
- **Functional:** PARTIAL `NEW:VERIFY-CAPTURE-CONTEXT`
- **Data:** AUTOMATED-TESTED —
- **Visual:** SOURCE-IMPLEMENTED
- **Content:** AUTOMATED-TESTED — · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/branded-surfaces.render.test.mjs`, `test/public-verify-sections.render.test.mjs`, `test/public-verify.render.test.mjs`
- **Ledger:** 27 rows (UNRESOLVED 2, VALID_EXCLUSION 3, ACTUAL_FIX 18, VERIFIED_EQUIVALENT 4) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

### `/workspaces`
- **Web entry:** `apps/web/app/(app)/workspaces/page.tsx` · **Native:** `apps/mobile/app/(stack)/spaces.tsx`
- **Reachable:** navigation yes (apps/mobile/app/(stack)/organizations/[id].tsx, apps/mobile/app/(tabs)/settings.tsx, apps/mobile/src/product/shell-gates.ts) · deep link iOS false / Android false / scheme false
- **Functional:** AUTOMATED-TESTED —
- **Data:** AUTOMATED-TESTED —
- **Visual:** PARTIAL — 19 open CSS rows
- **Content:** PARTIAL `CONTENT_FILE:apps/web/components/feedback/ProovraSupportReference.tsx`, `CONTENT_FILE:apps/web/components/navigation/PageRouteGate.tsx`, `CONTENT_FILE:apps/web/components/contextual-help/ContextualHelp.tsx`, `CONTENT_FILE:apps/web/components/navigation/OperationalBreadcrumb.tsx` · localization: EN-ONLY ON WEB (parity)
- **Tests:** `test/workspace-audit.render.test.mjs`
- **Ledger:** 33 rows (UNRESOLVED 24, VALID_EXCLUSION 3, CONSUMED_BY_NATIVE 1, ACTUAL_FIX 2, VERIFIED_EQUIVALENT 3) · SOURCE-FIXED true · AUTOMATED-TESTED true · DEVICE-ACCEPTED false

