# P — GLOBAL FINDINGS REGISTER (source comparison)

**Audited SHA:** `10668edbe4ac189ff965a09c7e8be17953d83f4a`
**Method:** static source comparison only. No rendering, no screenshots, no devices.

Each finding links to every page it affects. Shared root causes are grouped; the
individual discrepancies stay visible underneath the group.

## P.1 Headline counts

| | |
|---|---:|
| Applicable routes | 64 |
| Routes source-compared | 62 |
| Routes with no native screen | 2 |
| Distinct PWA files read (rendered trees) | **289** |
| Distinct Native files read (rendered trees) | **57** |
| PWA elements identified | **19788** |
| Native elements identified | **5455** |
| PWA elements in a pairable role | 3349 |
| — paired exactly | 75 |
| — paired, copy differs | 55 |
| — paired, role differs (possible wrong control) | 29 |
| — unpaired on its own route (distinct) | 1271 |
| —— of those, PRESENT on another native screen (placement difference) | 746 |
| —— of those, **found NOWHERE in native** | **525** |
| — unpaired (per-route occurrences) | 2559 |
| Extra in Native | 890 |
| Unlabelled (not pairable by label) | 566 |
| **SOURCE-UNRESOLVED labels** | **823** |
| PWA style properties resolved to literals | **26222** |
| PWA style items SOURCE-UNRESOLVED | 3764 |
| Native style properties resolved | 4990 |
| PWA interactive elements | 2703 |
| Native interactive elements | 1215 |
| PWA conditional branches | 9281 |
| Native conditional branches | 2802 |
| **Screenshots / simulator / device runs** | **0 / 0 / 0** |

## P.2 THE STYLE FINDING — a shared token file is not shared styling

This is the answer to "do not report a shared token as proof of parity", and it is
measured, not asserted.

| | Count |
|---|---:|
| CSS files indexed | 30 |
| CSS classes indexed | 2515 |
| CSS custom properties | 235 |
| Values in the shared native token set (`packages/ui/src/tokens/proovra.generated.ts`) | 136 |
| Distinct hex colours declared anywhere in web CSS | **238** |
| …that exist in the native token set | **28** |
| **Hex literals written DIRECTLY in component CSS, bypassing tokens** | **2079 occurrences, 222 distinct** |
| …that exist in the native token set | **25** |

Both platforms do import the same generated token module, and that fact proves
nothing: the web paints most of its surfaces from **222 colours hardcoded in
stylesheets**, of which only **25** have any native counterpart. Native has no
access to the other 197 because they exist only as literals inside `apps/web`.

### Where the hardcoding is concentrated

| Hex literals | File |
|---:|---|
| 776 | `apps/web/components/capture-v2/capture-v2.css` |
| 344 | `apps/web/components/command-center/command-center.css` |
| 243 | `apps/web/components/capture-v2/capture-workspace.css` |
| 123 | `apps/web/app/globals.css` |
| 112 | `apps/web/app/(app)/settings/settings.css` |
| 88 | `apps/web/components/app-primitives/app-primitives.css` |
| 87 | `apps/web/app/(app)/evidence/[id]/evidence-detail.css` |
| 73 | `apps/web/components/cases-experience/cases-experience.css` |
| 38 | `apps/web/components/home-experience/home.css` |
| 37 | `apps/web/components/app-shell-v2/app-shell-v2.css` |
| 35 | `apps/web/app/(app)/evidence/evidence-library.css` |
| 29 | `apps/web/app/(app)/intake-links/intake-links.css` |
| 28 | `apps/web/app/intake/[token]/intake.css` |
| 18 | `apps/web/app/(app)/search/search.css` |

`capture-v2.css` alone declares 776 colour literals, and `/capture` is a
NATIVE_REQUIRED route whose native screen paints from the 136-value token set.

**SOURCE-UNRESOLVED:** which of these declarations actually reaches a pixel depends on
cascade order and runtime class application. This audit resolves what is DECLARED and
does not claim which declaration wins.

## P.3 Root-cause groups — classified

### Support reference code cannot be copied natively

- **Verdict:** `REAL_GAP`
- **Owning PWA component:** `apps/web/components/feedback/ProovraSupportReference.tsx`
- **Blast radius:** 36 of 64 applicable routes, 1 distinct element(s)
- **Evidence:** Web renders a Copy button beside the support reference on every error and support surface. `grep -rn "Clipboard|copyToClipboard|Copy\b" apps/mobile/src/ui apps/mobile/app/(stack)/support.tsx` returns NOTHING — native has no clipboard affordance at all. A user reading a support code off a phone screen must transcribe it by hand.

Affected routes: [`/auth/mfa-challenge`](pages/auth-mfa-challenge.md), [`/billing`](pages/billing.md), [`/capture`](pages/capture.md), [`/cases`](pages/cases.md), [`/cases/[id]`](pages/cases-id.md), [`/collaboration-teams`](pages/collaboration-teams.md), [`/collaboration-teams/[teamId]`](pages/collaboration-teams-teamId.md), [`/collaboration-teams/invites/[token]/accept`](pages/collaboration-teams-invites-token-accept.md), [`/evidence`](pages/evidence.md), [`/evidence-requests/[id]`](pages/evidence-requests-id.md), [`/evidence/[id]`](pages/evidence-id.md), [`/home`](pages/home.md), [`/inbox`](pages/inbox.md), [`/intake-links`](pages/intake-links.md), [`/invite/[token]`](pages/invite-token.md), [`/notifications`](pages/notifications.md), [`/operations/batch-analysis`](pages/operations-batch-analysis.md), [`/operations/quotas`](pages/operations-quotas.md), [`/org-invites/[token]/accept`](pages/org-invites-token-accept.md), [`/organizations`](pages/organizations.md), [`/organizations/[id]`](pages/organizations-id.md), [`/people`](pages/people.md), [`/reports`](pages/reports.md), [`/search`](pages/search.md), [`/settings`](pages/settings.md), [`/settings/legal/[slug]`](pages/settings-legal-slug.md), [`/settings/reviewer-criteria`](pages/settings-reviewer-criteria.md), [`/share/[id]`](pages/share-id.md), [`/teams/[id]`](pages/teams-id.md), [`/trust-center/ai-disclosure`](pages/trust-center-ai-disclosure.md), [`/trust-center/methodology`](pages/trust-center-methodology.md), [`/trust-center/security`](pages/trust-center-security.md), [`/trust-center/status`](pages/trust-center-status.md), [`/trust-center/subprocessors`](pages/trust-center-subprocessors.md), [`/verify/[token]`](pages/verify-token.md), [`/workspaces`](pages/workspaces.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| BUTTON |  | `undefined` |

### Route-level denial/unavailable state

- **Verdict:** `PARTIAL`
- **Owning PWA component:** `apps/web/components/navigation/PageRouteGate.tsx`
- **Blast radius:** 32 of 64 applicable routes, 3 distinct element(s)
- **Evidence:** Web wraps pages in PageRouteGate, which renders 'This page is not available' and a headline for denial. Native has error/denial handling at the DATA layer (`src/errors/safe-error.ts` models 403 'forbidden'; `discussion-section.tsx:71` branches to a denied phase) but no route-level gate component. Whether every native screen refuses a disallowed route is SOURCE-UNRESOLVED per screen and is listed per page.

Affected routes: [`/billing`](pages/billing.md), [`/capture`](pages/capture.md), [`/cases`](pages/cases.md), [`/cases/[id]`](pages/cases-id.md), [`/collaboration-teams`](pages/collaboration-teams.md), [`/collaboration-teams/[teamId]`](pages/collaboration-teams-teamId.md), [`/collaboration-teams/invites/[token]/accept`](pages/collaboration-teams-invites-token-accept.md), [`/evidence`](pages/evidence.md), [`/evidence-requests/[id]`](pages/evidence-requests-id.md), [`/evidence/[id]`](pages/evidence-id.md), [`/home`](pages/home.md), [`/inbox`](pages/inbox.md), [`/intake-links`](pages/intake-links.md), [`/notifications`](pages/notifications.md), [`/operations/batch-analysis`](pages/operations-batch-analysis.md), [`/operations/quotas`](pages/operations-quotas.md), [`/org-invites/[token]/accept`](pages/org-invites-token-accept.md), [`/organizations`](pages/organizations.md), [`/organizations/[id]`](pages/organizations-id.md), [`/people`](pages/people.md), [`/reports`](pages/reports.md), [`/search`](pages/search.md), [`/settings`](pages/settings.md), [`/settings/legal/[slug]`](pages/settings-legal-slug.md), [`/settings/reviewer-criteria`](pages/settings-reviewer-criteria.md), [`/teams/[id]`](pages/teams-id.md), [`/trust-center/ai-disclosure`](pages/trust-center-ai-disclosure.md), [`/trust-center/methodology`](pages/trust-center-methodology.md), [`/trust-center/security`](pages/trust-center-security.md), [`/trust-center/status`](pages/trust-center-status.md), [`/trust-center/subprocessors`](pages/trust-center-subprocessors.md), [`/workspaces`](pages/workspaces.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| STATE_ERROR |  | `undefined` |
| STATE_ERROR |  | `undefined` |
| STATE_ERROR |  | `undefined` |

### Marketing site chrome (header, footer, language switcher)

- **Verdict:** `INTENTIONAL_PLATFORM_ADAPTATION`
- **Owning PWA component:** `apps/web/components/marketing/MarketingHeader.tsx`
- **Blast radius:** 19 of 64 applicable routes, 5 distinct element(s)
- **Evidence:** apps/web/middleware.ts splits the estate across an app host and a marketing host. These components render the marketing host's navigation. An installed app has no marketing site to navigate, and `docs/uc-disposition.md` records the same disposition. Native correctly renders none of them.

Affected routes: [`/abuse-reporting`](pages/abuse-reporting.md), [`/auth`](pages/auth.md), [`/auth/verify-email`](pages/auth-verify-email.md), [`/data-retention`](pages/data-retention.md), [`/forgot-password`](pages/forgot-password.md), [`/invite/[token]`](pages/invite-token.md), [`/legal/[slug]`](pages/legal-slug.md), [`/login`](pages/login.md), [`/pricing`](pages/pricing.md), [`/privacy`](pages/privacy.md), [`/register`](pages/register.md), [`/reset-password`](pages/reset-password.md), [`/share/[id]`](pages/share-id.md), [`/subprocessors`](pages/subprocessors.md), [`/support`](pages/support.md), [`/terms`](pages/terms.md), [`/trust`](pages/trust.md), [`/trust-center`](pages/trust-center.md), [`/verify`](pages/verify.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| LINK |  | `undefined` |

### Marketing site chrome (header, footer, language switcher)

- **Verdict:** `INTENTIONAL_PLATFORM_ADAPTATION`
- **Owning PWA component:** `apps/web/components/marketing/MarketingLanguageSwitcher.tsx`
- **Blast radius:** 19 of 64 applicable routes, 1 distinct element(s)
- **Evidence:** apps/web/middleware.ts splits the estate across an app host and a marketing host. These components render the marketing host's navigation. An installed app has no marketing site to navigate, and `docs/uc-disposition.md` records the same disposition. Native correctly renders none of them.

Affected routes: [`/abuse-reporting`](pages/abuse-reporting.md), [`/auth`](pages/auth.md), [`/auth/verify-email`](pages/auth-verify-email.md), [`/data-retention`](pages/data-retention.md), [`/forgot-password`](pages/forgot-password.md), [`/invite/[token]`](pages/invite-token.md), [`/legal/[slug]`](pages/legal-slug.md), [`/login`](pages/login.md), [`/pricing`](pages/pricing.md), [`/privacy`](pages/privacy.md), [`/register`](pages/register.md), [`/reset-password`](pages/reset-password.md), [`/share/[id]`](pages/share-id.md), [`/subprocessors`](pages/subprocessors.md), [`/support`](pages/support.md), [`/terms`](pages/terms.md), [`/trust`](pages/trust.md), [`/trust-center`](pages/trust-center.md), [`/verify`](pages/verify.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| BUTTON |  | `undefined` |

### No native equivalent of the accessible listbox primitive

- **Verdict:** `REAL_GAP`
- **Owning PWA component:** `apps/web/components/app-primitives/AppListbox.tsx`
- **Blast radius:** 13 of 64 applicable routes, 1 distinct element(s)
- **Evidence:** AppListbox is 'the single accessible custom listbox for every internal surface… Replaces native <select> everywhere in the authenticated product' (its own header). Native `src/ui/index.tsx` exports no Picker, Listbox, Dropdown or Select primitive. Any web surface offering a choice from a list has no native counterpart control.

Affected routes: [`/cases/[id]`](pages/cases-id.md), [`/collaboration-teams`](pages/collaboration-teams.md), [`/collaboration-teams/[teamId]`](pages/collaboration-teams-teamId.md), [`/evidence`](pages/evidence.md), [`/evidence-requests/[id]`](pages/evidence-requests-id.md), [`/evidence/[id]`](pages/evidence-id.md), [`/home`](pages/home.md), [`/inbox`](pages/inbox.md), [`/intake-links`](pages/intake-links.md), [`/notifications`](pages/notifications.md), [`/search`](pages/search.md), [`/settings`](pages/settings.md), [`/teams/[id]`](pages/teams-id.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| BUTTON |  | `undefined` |

### Marketing site chrome (header, footer, language switcher)

- **Verdict:** `INTENTIONAL_PLATFORM_ADAPTATION`
- **Owning PWA component:** `apps/web/components/marketing/EnterpriseFooter.tsx`
- **Blast radius:** 12 of 64 applicable routes, 5 distinct element(s)
- **Evidence:** apps/web/middleware.ts splits the estate across an app host and a marketing host. These components render the marketing host's navigation. An installed app has no marketing site to navigate, and `docs/uc-disposition.md` records the same disposition. Native correctly renders none of them.

Affected routes: [`/abuse-reporting`](pages/abuse-reporting.md), [`/data-retention`](pages/data-retention.md), [`/legal/[slug]`](pages/legal-slug.md), [`/pricing`](pages/pricing.md), [`/privacy`](pages/privacy.md), [`/share/[id]`](pages/share-id.md), [`/subprocessors`](pages/subprocessors.md), [`/support`](pages/support.md), [`/terms`](pages/terms.md), [`/trust`](pages/trust.md), [`/trust-center`](pages/trust-center.md), [`/verify`](pages/verify.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| LINK |  | `undefined` |

### Legacy primitive internal slots

- **Verdict:** `FALSE_POSITIVE_GENERIC_SLOT`
- **Owning PWA component:** `apps/web/components/ui-legacy.tsx`
- **Blast radius:** 9 of 64 applicable routes, 1 distinct element(s)
- **Evidence:** Same class as ui/Button — an internal error slot expression, not a distinct control.

Affected routes: [`/auth/mfa-challenge`](pages/auth-mfa-challenge.md), [`/billing`](pages/billing.md), [`/capture`](pages/capture.md), [`/operations/batch-analysis`](pages/operations-batch-analysis.md), [`/operations/quotas`](pages/operations-quotas.md), [`/settings`](pages/settings.md), [`/share/[id]`](pages/share-id.md), [`/teams/[id]`](pages/teams-id.md), [`/verify/[token]`](pages/verify-token.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| INPUT |  | `undefined` |

### Toast dismiss exists natively but is unlabelled

- **Verdict:** `FALSE_POSITIVE_ACCESSIBILITY_FINDING`
- **Owning PWA component:** `apps/web/components/feedback/ProovraToast.tsx`
- **Blast radius:** 9 of 64 applicable routes, 1 distinct element(s)
- **Evidence:** Reported missing only because the labels differ. Native DOES implement dismiss: `src/toast-context.tsx:115-120` renders a TouchableOpacity with `onPress={() => onDismiss(toast.id)}`. Its visible content is the glyph `×` and it carries NO accessibilityLabel, where web uses aria-label 'Dismiss notification'. Not a missing control — an unlabelled one, which a screen reader announces as 'times'.

Affected routes: [`/auth/mfa-challenge`](pages/auth-mfa-challenge.md), [`/billing`](pages/billing.md), [`/capture`](pages/capture.md), [`/operations/batch-analysis`](pages/operations-batch-analysis.md), [`/operations/quotas`](pages/operations-quotas.md), [`/settings`](pages/settings.md), [`/share/[id]`](pages/share-id.md), [`/teams/[id]`](pages/teams-id.md), [`/verify/[token]`](pages/verify-token.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| BUTTON |  | `undefined` |

### No table of contents in the native legal reader

- **Verdict:** `REAL_GAP`
- **Owning PWA component:** `apps/web/components/legal/LegalDocumentShell.tsx`
- **Blast radius:** 6 of 64 applicable routes, 2 distinct element(s)
- **Evidence:** Web renders an 'On this page' control and an 'Open public Trust Center' link in the legal shell, across 6 legal routes. `apps/mobile/src/ui/legal-document.tsx` contains no section index, anchor or scrollTo — grep for section/heading/anchor/scrollTo returns nothing. A multi-thousand-word policy is a single unindexed scroll on a phone.

Affected routes: [`/settings/legal/[slug]`](pages/settings-legal-slug.md), [`/trust-center/ai-disclosure`](pages/trust-center-ai-disclosure.md), [`/trust-center/methodology`](pages/trust-center-methodology.md), [`/trust-center/security`](pages/trust-center-security.md), [`/trust-center/status`](pages/trust-center-status.md), [`/trust-center/subprocessors`](pages/trust-center-subprocessors.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| BUTTON |  | `undefined` |
| LINK |  | `undefined` |

### Change-password form sits on a different native screen

- **Verdict:** `PLACEMENT_DIFFERENCE`
- **Owning PWA component:** `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`
- **Blast radius:** 3 of 64 applicable routes, 34 distinct element(s)
- **Evidence:** All 34 items (heading, Current/New/Confirm password inputs, 'sign out my other sessions', Change password, Verify & continue, Cancel) are implemented natively at `apps/mobile/app/(stack)/settings/security.tsx:218-273`. The web renders them INSIDE /settings; native gives them their own sub-screen. Per-route pairing could not see across screens — this is why the global native-presence pass exists. Not a gap; a navigation difference (see H-N4).

Affected routes: [`/organizations/[id]`](pages/organizations-id.md), [`/settings`](pages/settings.md), [`/teams/[id]`](pages/teams-id.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| HEADING |  | `undefined` |
| INPUT |  | `undefined` |
| INPUT |  | `undefined` |
| INPUT |  | `undefined` |
| INPUT |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| HEADING |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |

### Legal documents are unreachable from the native sign-in screen

- **Verdict:** `REAL_GAP`
- **Owning PWA component:** `apps/web/app/login/page.tsx`
- **Blast radius:** 3 of 64 applicable routes, 12 distinct element(s)
- **Evidence:** Web `/login` renders three tappable links — Terms of Service, Privacy Policy, Cookie Policy. Native `app/(stack)/auth.tsx:135-139` renders ONE non-interactive `<ProovraText variant="label" color={theme.color.ink.muted} center>` reading 'By continuing you agree to the Terms and acknowledge the Privacy Policy.' There is no Pressable, no onPress and no Link, so neither document can be opened at the point of consent, and Cookie Policy is not mentioned at all. The same line is painted in `ink.muted` = #94A3B8, which is 2.42:1 on `surface.app` #F7F8FC — below WCAG AA for any text size.

Affected routes: [`/auth`](pages/auth.md), [`/forgot-password`](pages/forgot-password.md), [`/login`](pages/login.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| HEADING |  | `undefined` |
| HEADING |  | `undefined` |
| HEADING |  | `undefined` |
| BUTTON |  | `undefined` |
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| LINK |  | `undefined` |
| INPUT |  | `undefined` |
| BUTTON |  | `undefined` |

### Marketing site chrome (header, footer, language switcher)

- **Verdict:** `INTENTIONAL_PLATFORM_ADAPTATION`
- **Owning PWA component:** `apps/web/components/marketing/ForgotPasswordModal.tsx`
- **Blast radius:** 3 of 64 applicable routes, 7 distinct element(s)
- **Evidence:** apps/web/middleware.ts splits the estate across an app host and a marketing host. These components render the marketing host's navigation. An installed app has no marketing site to navigate, and `docs/uc-disposition.md` records the same disposition. Native correctly renders none of them.

Affected routes: [`/auth`](pages/auth.md), [`/forgot-password`](pages/forgot-password.md), [`/login`](pages/login.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| HEADING |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| HEADING |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| LINK |  | `undefined` |

### Inbox filtering exists natively under different labels

- **Verdict:** `PLACEMENT_OR_COPY_DIFFERENCE`
- **Owning PWA component:** `apps/web/app/(app)/inbox/page.tsx`
- **Blast radius:** 2 of 64 applicable routes, 17 distinct element(s)
- **Evidence:** Reported missing (Filters, Archived, Clear filters, Refresh, Done) but native implements filtering: `app/(tabs)/notifications.tsx` imports `filterInboxItems` and `INBOX_FILTERS` and renders `ProovraFilterChips` with `const [filter, setFilter] = useState("all")`. The control set is a chip row rather than a filter sheet, so the individual labels differ. A copy/affordance difference, not an absent capability.

Affected routes: [`/inbox`](pages/inbox.md), [`/notifications`](pages/notifications.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| HEADING |  | `undefined` |
| BUTTON |  | `undefined` |
| HEADING |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |
| BUTTON |  | `undefined` |

### Enterprise sales calls-to-action on the public trust page

- **Verdict:** `INTENTIONAL_PLATFORM_ADAPTATION`
- **Owning PWA component:** `apps/web/app/trust/page.tsx`
- **Blast radius:** 2 of 64 applicable routes, 14 distinct element(s)
- **Evidence:** 'Contact sales', 'Start enterprise review', 'Review documentation' are acquisition CTAs on the marketing-host trust page. Same disposition as the marketing chrome group: an installed app carries no in-app sales funnel.

Affected routes: [`/trust`](pages/trust.md), [`/trust-center`](pages/trust-center.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| HEADING |  | `undefined` |
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| HEADING |  | `undefined` |
| HEADING |  | `undefined` |
| HEADING |  | `undefined` |
| LINK |  | `undefined` |
| LINK |  | `undefined` |
| HEADING |  | `undefined` |
| HEADING |  | `undefined` |
| HEADING |  | `undefined` |
| LINK |  | `undefined` |

### Operations empty-state copy

- **Verdict:** `SUBSUMED_BY_MISSING_SCREEN`
- **Owning PWA component:** `apps/web/components/operational/OperationalEmptyState.tsx`
- **Blast radius:** 2 of 64 applicable routes, 8 distinct element(s)
- **Evidence:** All eight strings belong to /operations and /operations/health, which have NO native screen at all. They are already counted by that finding and are not a separate defect.

Affected routes: [`/evidence/[id]`](pages/evidence-id.md), [`/home`](pages/home.md)

| Role | Label | PWA source | In native? |
|---|---|---|---|
| LINK |  | `undefined` |
| STATE_EMPTY |  | `undefined` |
| STATE_EMPTY |  | `undefined` |
| STATE_EMPTY |  | `undefined` |
| STATE_EMPTY |  | `undefined` |
| STATE_EMPTY |  | `undefined` |
| STATE_EMPTY |  | `undefined` |
| STATE_EMPTY |  | `undefined` |


## P.4 Root-cause groups — UNCLASSIFIED (177)

These were grouped mechanically and **have not been individually adjudicated**. They
are listed so nothing is hidden, and they are **not** claimed as defects.

| Routes | Items | Owning PWA component |
|---:|---:|---|
| 6 | 1 | `apps/web/components/cases-experience/matter-modals/Modal.tsx` |
| 5 | 1 | `apps/web/components/contextual-help/ContextualHelp.tsx` |
| 4 | 2 | `apps/web/components/external-portal/PortalMfaCodeStep.tsx` |
| 4 | 1 | `apps/web/app/(app)/trust-center/_version-history.tsx` |
| 3 | 6 | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx` |
| 3 | 2 | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx` |
| 3 | 1 | `apps/web/components/access/AccessGate.tsx` |
| 3 | 1 | `apps/web/components/external-portal/PortalDenialNotice.tsx` |
| 2 | 9 | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx` |
| 2 | 8 | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx` |
| 2 | 7 | `apps/web/components/identity-security/StepUpModal.tsx` |
| 2 | 2 | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx` |
| 2 | 1 | `apps/web/components/billing/PlanLimitBadge.tsx` |
| 2 | 1 | `apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx` |
| 1 | 53 | `apps/web/app/verify/[token]/page.tsx` |
| 1 | 51 | `apps/web/components/command-center/CommandCenter.tsx` |
| 1 | 37 | `apps/web/components/cases-experience/MatterWorkspace.tsx` |
| 1 | 32 | `apps/web/app/(app)/evidence/[id]/page.tsx` |
| 1 | 28 | `apps/web/app/(app)/organizations/[id]/page.tsx` |
| 1 | 26 | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx` |
| 1 | 26 | `apps/web/app/(app)/teams/[id]/page.tsx` |
| 1 | 23 | `apps/web/components/home-experience/HomeSections.tsx` |
| 1 | 22 | `apps/web/app/support/page.tsx` |
| 1 | 22 | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx` |
| 1 | 20 | `apps/web/app/(app)/collaboration-teams/page.tsx` |
| 1 | 20 | `apps/web/app/(app)/settings/_sections/AiSection.tsx` |
| 1 | 19 | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx` |
| 1 | 19 | `apps/web/app/(app)/evidence-requests/[id]/page.tsx` |
| 1 | 19 | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx` |
| 1 | 18 | `apps/web/app/(app)/organizations/page.tsx` |
| 1 | 17 | `apps/web/app/(app)/search/page.tsx` |
| 1 | 15 | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx` |
| 1 | 15 | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx` |
| 1 | 14 | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx` |
| 1 | 13 | `apps/web/components/cases-experience/CasesIndex.tsx` |
| 1 | 12 | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx` |
| 1 | 12 | `apps/web/app/(app)/capture/page.tsx` |
| 1 | 12 | `apps/web/app/intake/[token]/page.tsx` |
| 1 | 12 | `apps/web/app/register/page.tsx` |
| 1 | 11 | `apps/web/app/(app)/cases/components/SiuPanel.tsx` |
| 1 | 11 | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx` |
| 1 | 10 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx` |
| 1 | 10 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx` |
| 1 | 10 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx` |
| 1 | 10 | `apps/web/app/pricing/page.tsx` |
| 1 | 10 | `apps/web/components/notifications/NotificationPreferencesPanel.tsx` |
| 1 | 9 | `apps/web/app/auth/mfa-challenge/page.tsx` |
| 1 | 9 | `apps/web/components/ai/CaptureAiAssistant.tsx` |
| 1 | 9 | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx` |
| 1 | 9 | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx` |
| 1 | 9 | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx` |
| 1 | 9 | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx` |
| 1 | 9 | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx` |
| 1 | 9 | `apps/web/components/notifications/ContactChannelVerificationCard.tsx` |
| 1 | 8 | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx` |
| 1 | 8 | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` |
| 1 | 8 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx` |
| 1 | 8 | `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx` |
| 1 | 8 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx` |
| 1 | 8 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab.tsx` |

_…117 further groups in `global-findings.json`._

## P.5 Per-page registers

- [`/abuse-reporting`](pages/abuse-reporting.md) — web 104el/6f · native 78el/3f · 11 missing
- [`/auth`](pages/auth.md) — web 180el/6f · native 67el/3f · 23 missing
- [`/auth/callback/ui`](pages/auth-callback-ui.md) — web 38el/1f · native 67el/3f · 3 missing
- [`/auth/mfa-challenge`](pages/auth-mfa-challenge.md) — web 123el/6f · native 69el/4f · 15 missing
- [`/auth/mfa-recovery/verify`](pages/auth-mfa-recovery-verify.md) — web 18el/1f · native 53el/2f · 1 missing
- [`/auth/verify-email`](pages/auth-verify-email.md) — web 119el/4f · native 50el/2f · 8 missing
- [`/billing`](pages/billing.md) — web 503el/23f · native 98el/3f · 42 missing
- [`/capture`](pages/capture.md) — web 718el/28f · native 157el/3f · 49 missing
- [`/cases`](pages/cases.md) — web 300el/19f · native 64el/2f · 23 missing
- [`/cases/[id]`](pages/cases-id.md) — web 1283el/31f · native 103el/2f · 132 missing
- [`/collaboration-teams`](pages/collaboration-teams.md) — web 307el/13f · native 62el/2f · 26 missing
- [`/collaboration-teams/[teamId]`](pages/collaboration-teams-teamId.md) — web 653el/21f · native 159el/5f · 65 missing
- [`/collaboration-teams/[teamId]/collaboration`](pages/collaboration-teams-teamId-collaboration.md) — web 2el/1f · native 159el/5f · 0 missing
- [`/collaboration-teams/invites/[token]/accept`](pages/collaboration-teams-invites-token-accept.md) — web 97el/6f · native 56el/2f · 12 missing
- [`/data-retention`](pages/data-retention.md) — web 104el/6f · native 78el/3f · 11 missing
- [`/evidence`](pages/evidence.md) — web 371el/19f · native 170el/2f · 38 missing
- [`/evidence-requests/[id]`](pages/evidence-requests-id.md) — web 357el/14f · native 107el/2f · 43 missing
- [`/evidence/[id]`](pages/evidence-id.md) — web 1933el/70f · native 291el/5f · 208 missing
- [`/forgot-password`](pages/forgot-password.md) — web 180el/6f · native 58el/3f · 22 missing
- [`/home`](pages/home.md) — web 1478el/20f · native 104el/3f · 113 missing
- [`/inbox`](pages/inbox.md) — web 220el/12f · native 64el/2f · 22 missing
- [`/intake-links`](pages/intake-links.md) — web 691el/26f · native 74el/2f · 49 missing
- [`/intake/[token]`](pages/intake-token.md) — web 171el/4f · native 72el/2f · 12 missing
- [`/intake/[token]/capture`](pages/intake-token-capture.md) — web 4el/1f · native 62el/2f · 2 missing
- [`/invite/[token]`](pages/invite-token.md) — web 147el/7f · native 56el/2f · 10 missing
- [`/legal/[slug]`](pages/legal-slug.md) — web 104el/6f · native 78el/3f · 11 missing
- [`/login`](pages/login.md) — web 180el/6f · native 67el/3f · 23 missing
- [`/notifications`](pages/notifications.md) — web 220el/12f · native 64el/2f · 22 missing
- [`/operations`](pages/operations.md) — **no native screen**
- [`/operations/batch-analysis`](pages/operations-batch-analysis.md) — web 202el/10f · native 84el/2f · 10 missing
- [`/operations/health`](pages/operations-health.md) — **no native screen**
- [`/operations/quotas`](pages/operations-quotas.md) — web 207el/10f · native 69el/2f · 6 missing
- [`/org-invites/[token]/accept`](pages/org-invites-token-accept.md) — web 77el/6f · native 66el/2f · 7 missing
- [`/organizations`](pages/organizations.md) — web 132el/6f · native 52el/2f · 22 missing
- [`/organizations/[id]`](pages/organizations-id.md) — web 502el/15f · native 107el/3f · 75 missing
- [`/people`](pages/people.md) — web 67el/6f · native 135el/3f · 4 missing
- [`/portal`](pages/portal.md) — web 27el/3f · native 49el/2f · 5 missing
- [`/portal/[token]`](pages/portal-token.md) — web 70el/4f · native 66el/2f · 10 missing
- [`/portal/[token]/work/[workflowId]`](pages/portal-token-work-workflowId.md) — web 80el/5f · native 68el/2f · 11 missing
- [`/portal/accept/[grantId]`](pages/portal-accept-grantId.md) — web 45el/4f · native 49el/2f · 7 missing
- [`/pricing`](pages/pricing.md) — web 230el/6f · native 98el/3f · 21 missing
- [`/privacy`](pages/privacy.md) — web 104el/6f · native 78el/3f · 11 missing
- [`/register`](pages/register.md) — web 207el/5f · native 74el/4f · 18 missing
- [`/reports`](pages/reports.md) — web 242el/15f · native 59el/2f · 14 missing
- [`/reset-password`](pages/reset-password.md) — web 152el/4f · native 62el/4f · 13 missing
- [`/search`](pages/search.md) — web 437el/13f · native 63el/2f · 34 missing
- [`/settings`](pages/settings.md) — web 1068el/35f · native 100el/2f · 127 missing
- [`/settings/legal/[slug]`](pages/settings-legal-slug.md) — web 130el/7f · native 78el/3f · 6 missing
- [`/settings/reviewer-criteria`](pages/settings-reviewer-criteria.md) — web 156el/6f · native 111el/3f · 18 missing
- [`/share/[id]`](pages/share-id.md) — web 171el/9f · native 291el/5f · 15 missing
- [`/subprocessors`](pages/subprocessors.md) — web 104el/6f · native 78el/3f · 11 missing
- [`/support`](pages/support.md) — web 310el/5f · native 54el/2f · 33 missing
- [`/teams/[id]`](pages/teams-id.md) — web 857el/27f · native 135el/3f · 99 missing
- [`/terms`](pages/terms.md) — web 104el/6f · native 78el/3f · 11 missing
- [`/trust`](pages/trust.md) — web 303el/6f · native 77el/2f · 25 missing
- [`/trust-center`](pages/trust-center.md) — web 303el/6f · native 77el/2f · 25 missing
- [`/trust-center/ai-disclosure`](pages/trust-center-ai-disclosure.md) — web 218el/12f · native 77el/2f · 8 missing
- [`/trust-center/methodology`](pages/trust-center-methodology.md) — web 187el/11f · native 77el/2f · 9 missing
- [`/trust-center/security`](pages/trust-center-security.md) — web 182el/11f · native 77el/2f · 7 missing
- [`/trust-center/status`](pages/trust-center-status.md) — web 204el/7f · native 77el/2f · 12 missing
- [`/trust-center/subprocessors`](pages/trust-center-subprocessors.md) — web 207el/9f · native 77el/2f · 10 missing
- [`/verify`](pages/verify.md) — web 216el/13f · native 80el/3f · 19 missing
- [`/verify/[token]`](pages/verify-token.md) — web 543el/9f · native 80el/3f · 59 missing
- [`/workspaces`](pages/workspaces.md) — web 381el/11f · native 65el/2f · 43 missing
