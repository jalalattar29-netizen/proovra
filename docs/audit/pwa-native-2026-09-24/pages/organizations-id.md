# /organizations/[id]

**PWA entry:** `apps/web/app/(app)/organizations/[id]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/organizations/[id].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 15 | 3 |
| Elements | 502 | 107 |
| Interactive elements | 96 | 28 |
| Conditionally-rendered elements | 314 | 73 |
| Style rules resolved | 28 (98 props) | 61 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/organizations/[id]/page.tsx` | 166 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/ui/Badge.tsx` | 2 | `Badge` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell,PageHeader` |
| 1 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/components/ui/Card.tsx` | 11 | `Card` |
| 1 | `apps/web/components/ui/EmptyState.tsx` | 15 | `EmptyState` |
| 1 | `apps/web/components/organizations/OrgWorkspaceLifecycleControls.tsx` | 13 | `OrgWorkspaceLifecycleControls` |
| 1 | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx` | 156 | `StepUpVerify` |
| 2 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 2 | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx` | 56 | `ContactFactorEnrollmentPanel` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/organizations/[id].tsx` | 57 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraLoadingState,ProovraErrorState,ProovraEmpty,ProovraCard,ProovraBadge,ProovraDetailRows,ProovraPageSection,ProovraListRow,ProovraText,ProovraConfirmSheet,ProovraSheet,ProovraFormField,ProovraInput` |
| 1 | `apps/mobile/src/ui/step-up-sheet.tsx` | 8 | `StepUpSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 9 | 2 | -7 |
| BUTTON | 49 | 13 | -36 |
| CARD | 21 | 6 | -15 |
| CONTAINER | 141 | 23 | -118 |
| DIALOG | 0 | 7 | 7 |
| FORM | 6 | 0 | -6 |
| HEADING | 10 | 0 | -10 |
| ICON | 42 | 0 | -42 |
| INPUT | 20 | 5 | -15 |
| LINK | 14 | 0 | -14 |
| LIST | 24 | 4 | -20 |
| OTHER | 32 | 7 | -25 |
| STATE_EMPTY | 3 | 8 | 5 |
| STATE_ERROR | 5 | 1 | -4 |
| STATE_LOADING | 3 | 3 | 0 |
| TEXT | 123 | 28 | -95 |

### C.1 Paired (7)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Transfer ownership | `apps/web/app/(app)/organizations/[id]/page.tsx:1492` | `apps/mobile/app/(stack)/organizations/[id].tsx:449` |
| BUTTON | Close this organization… | `apps/web/app/(app)/organizations/[id]/page.tsx:1560` | `apps/mobile/app/(stack)/organizations/[id].tsx:493` |
| BUTTON | Request closure | `apps/web/app/(app)/organizations/[id]/page.tsx:1594` | `apps/mobile/app/(stack)/organizations/[id].tsx:598` |
| BUTTON | Leave organization | `apps/web/app/(app)/organizations/[id]/page.tsx:554` | `apps/mobile/app/(stack)/organizations/[id].tsx:439` |
| STATE_EMPTY | No workspaces bound to this organization. | `apps/web/app/(app)/organizations/[id]/page.tsx:1016` | `apps/mobile/app/(stack)/organizations/[id].tsx:367` |
| BUTTON | Cancel closure request | `apps/web/app/(app)/organizations/[id]/page.tsx:1533` | `apps/mobile/app/(stack)/organizations/[id].tsx:466` |
| BUTTON | Confirm suspension | `apps/web/components/organizations/OrgWorkspaceLifecycleControls.tsx:201` | `apps/mobile/src/ui/step-up-sheet.tsx:89` |


### C.2 MISSING in Native (75)

| Role | Label | PWA source |
|---|---|---|
| BADGE | Your role · {ROLE_LABELS[org.data.callerRole]} | `apps/web/app/(app)/organizations/[id]/page.tsx:493` |
| BUTTON | ← All organizations | `apps/web/app/(app)/organizations/[id]/page.tsx:535` |
| BUTTON | Workspace admin → | `apps/web/app/(app)/organizations/[id]/page.tsx:545` |
| BUTTON | Enterprise setup → | `apps/web/app/(app)/organizations/[id]/page.tsx:578` |
| BUTTON | Open Admin → | `apps/web/app/(app)/organizations/[id]/page.tsx:590` |
| CARD | You just created this organization — next steps | `apps/web/app/(app)/organizations/[id]/page.tsx:640` |
| LINK | Members in the Admin console | `apps/web/app/(app)/organizations/[id]/page.tsx:659` |
| LINK | Workspace administration | `apps/web/app/(app)/organizations/[id]/page.tsx:677` |
| LINK | Open in Workspace administration → | `apps/web/app/(app)/organizations/[id]/page.tsx:734` |
| LINK | Open billing → | `apps/web/app/(app)/organizations/[id]/page.tsx:759` |
| INPUT | Name | `apps/web/app/(app)/organizations/[id]/page.tsx:814` |
| INPUT | Legal name | `apps/web/app/(app)/organizations/[id]/page.tsx:827` |
| INPUT | Legal email | `apps/web/app/(app)/organizations/[id]/page.tsx:839` |
| INPUT | Mailing address | `apps/web/app/(app)/organizations/[id]/page.tsx:850` |
| INPUT | Timezone | `apps/web/app/(app)/organizations/[id]/page.tsx:864` |
| INPUT | Logo URL | `apps/web/app/(app)/organizations/[id]/page.tsx:877` |
| BUTTON | {settingsBusy ? "Saving…" : "Save settings"} | `apps/web/app/(app)/organizations/[id]/page.tsx:909` |
| BUTTON | Manage members → | `apps/web/app/(app)/organizations/[id]/page.tsx:950` |
| CARD | {workspaces.kind === "loading" && <RowLoading />} {…} {…} | `apps/web/app/(app)/organizations/[id]/page.tsx:980` |
| BUTTON | Workspace admin → | `apps/web/app/(app)/organizations/[id]/page.tsx:993` |
| BUTTON | Open Workspace administration → | `apps/web/app/(app)/organizations/[id]/page.tsx:1026` |
| BADGE | personal | `apps/web/app/(app)/organizations/[id]/page.tsx:1056` |
| BADGE | OVER SEAT LIMIT | `apps/web/app/(app)/organizations/[id]/page.tsx:1081` |
| BUTTON | Open workspace | `apps/web/app/(app)/organizations/[id]/page.tsx:1101` |
| BUTTON | Open audit timeline → | `apps/web/app/(app)/organizations/[id]/page.tsx:1143` |
| CARD | Scope — what lives where | `apps/web/app/(app)/organizations/[id]/page.tsx:1170` |
| BUTTON | Keep the organization | `apps/web/app/(app)/organizations/[id]/page.tsx:1606` |
| CARD | Loading… | `apps/web/app/(app)/organizations/[id]/page.tsx:1806` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | Suspend… | `apps/web/components/organizations/OrgWorkspaceLifecycleControls.tsx:139` |
| BUTTON | Resume | `apps/web/components/organizations/OrgWorkspaceLifecycleControls.tsx:156` |
| BUTTON | Keep it running | `apps/web/components/organizations/OrgWorkspaceLifecycleControls.tsx:213` |
| HEADING | Change password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:419` |
| INPUT | Current password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:433` |
| INPUT | New password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:445` |
| INPUT | Confirm new password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:457` |
| INPUT | Sign out my other sessions after the change | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:477` |
| BUTTON | Change password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:490` |
| BUTTON | Verify &amp; continue | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:621` |
| BUTTON | Cancel | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:632` |
| BUTTON | Close | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:646` |
| HEADING | Sign-in methods | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:921` |
| BUTTON | Add password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:977` |
| BUTTON | Connect | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:986` |
| BUTTON | Disconnect | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1004` |
| INPUT | New password (12+ chars, upper- and lower-case, a number) | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1032` |
| BUTTON | {busy ? "Adding…" : "Add password"} | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1043` |
| HEADING | Two-factor authentication | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1333` |
| BUTTON | {busy ? "Starting…" : "Set up two-factor authentication"} | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1348` |
| BADGE | Active | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1386` |
| BUTTON | Remove | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1390` |
| BUTTON | Regenerate recovery codes | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1403` |
| INPUT | 6-digit code from your app | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1469` |
| BUTTON | Verify &amp; enable | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1485` |
| BUTTON | Cancel | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1500` |
| INPUT | I saved these recovery codes in a safe place. | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1553` |
| BUTTON | Done | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1562` |
| BADGE | Current session | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1759` |
| BADGE | Restricted | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1764` |
| BUTTON | Sign out | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1773` |
| HEADING | Your active sessions | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1822` |
| BUTTON | Sign out other sessions | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1828` |
| STATE_EMPTY | Session inventory unavailable | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1848` |
| HEADING | Account &amp; security activity | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1996` |
| STATE_EMPTY | No security events in the recent window | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2008` |
| BUTTON | View more ( {rows.length - visibleCount} older) | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2090` |
| HEADING | Verified contact device | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:601` |
| BUTTON | {revokingId === f.factorId ? "Revoking…" : "Revoke"} | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:655` |
| BUTTON | Replace this device | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:675` |
| INPUT | Work handset | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:783` |
| BUTTON | Cancel | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:809` |
| BUTTON | Start over | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:938` |

### C.3 EXTRA in Native (25)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/organizations/[id].tsx:285` |
| STATE_LOADING | Loading organization | `apps/mobile/app/(stack)/organizations/[id].tsx:289` |
| STATE_EMPTY | This organization is not available to you | `apps/mobile/app/(stack)/organizations/[id].tsx:294` |
| BADGE | state.org.status | `apps/mobile/app/(stack)/organizations/[id].tsx:306` |
| BADGE | state.org.verificationState | `apps/mobile/app/(stack)/organizations/[id].tsx:309` |
| STATE_EMPTY | Members are visible to organization administrators. | `apps/mobile/app/(stack)/organizations/[id].tsx:336` |
| STATE_EMPTY | No members are listed. | `apps/mobile/app/(stack)/organizations/[id].tsx:341` |
| STATE_EMPTY | Workspaces are visible to organization administrators. | `apps/mobile/app/(stack)/organizations/[id].tsx:362` |
| STATE_EMPTY | The audit timeline is visible to organization auditors and administrators. | `apps/mobile/app/(stack)/organizations/[id].tsx:389` |
| STATE_EMPTY | No events have been recorded yet. | `apps/mobile/app/(stack)/organizations/[id].tsx:394` |
| BUTTON | Load older events | `apps/mobile/app/(stack)/organizations/[id].tsx:416` |
| DIALOG | Leave this organization? | `apps/mobile/app/(stack)/organizations/[id].tsx:516` |
| STATE_EMPTY | There is no other active member to transfer ownership to. | `apps/mobile/app/(stack)/organizations/[id].tsx:537` |
| DIALOG | transferTarget ? `Make ${transferTarget.displayName} the owner?` : "" | `apps/mobile/app/(stack)/organizations/[id].tsx:556` |
| DIALOG | Close this organization | `apps/mobile/app/(stack)/organizations/[id].tsx:567` |
| INPUT | Type the confirmation phrase | `apps/mobile/app/(stack)/organizations/[id].tsx:578` |
| INPUT | closure?.confirmationPhrase ?? "" | `apps/mobile/app/(stack)/organizations/[id].tsx:579` |
| DIALOG | Cancel the closure request? | `apps/mobile/app/(stack)/organizations/[id].tsx:606` |
| DIALOG | Confirm it is you | `apps/mobile/app/(stack)/organizations/[id].tsx:617` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| INPUT | field.label | `apps/mobile/src/ui/step-up-sheet.tsx:78` |
| INPUT | field.placeholder | `apps/mobile/src/ui/step-up-sheet.tsx:79` |

### C.4 SOURCE-UNRESOLVED labels (26)

| Role | PWA source | Why unpairable |
|---|---|---|
| BADGE | `apps/web/app/(app)/organizations/[id]/page.tsx:497` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/organizations/[id]/page.tsx:791` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/organizations/[id]/page.tsx:1063` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/organizations/[id]/page.tsx:1068` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/organizations/[id]/page.tsx:1212` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/organizations/[id]/page.tsx:1472` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/organizations/[id]/page.tsx:1792` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Card.tsx:250` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:603` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:910` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1332` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1811` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1873` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1995` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:719` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:740` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:796` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:856` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:901` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:917` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (28 rules, 98 properties)

**`.ui-page-header__actions`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .ui-page-header__actions` _[@media (max-width: 720px)]_

- `width`: **100%**
- `flex-wrap`: **wrap**
- `row-gap`: **8px**

**`.set-method-status`** — `apps/web/app/(app)/settings/settings.css` · `.set-method-status`

- `font-size`: **0.8rem**
- `font-weight`: **680**
- `background`: **transparent**
- `border`: **0**
- `padding`: **0**

**`.app-secondary-action`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .app-secondary-action` _[@media (max-width: 720px)]_

- `flex`: **1 1 calc(50% - 4px)**
- `justify-content`: **center**

**`.app-secondary-action`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.ta-card-footer .app-secondary-action`

- `min-block-size`: **44px**

**`.app-secondary-action`** — `apps/web/app/(app)/search/search.css` · `.search-results__more > .app-secondary-action`

- `min-inline-size`: **132px**

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell [data-settings-preferences] input[type="text"] + button:not(.app-secondary-action)`

- `min-height`: **42px !important**
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell [data-settings-preferences] button:not([data-cc-preferences-save]):not(.app-secondary-action)`

- `min-height`: **42px !important**
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .app-secondary-action > *:not(.set-privacy__count)`

- `min-height`: **0 !important**
- `padding`: **0 !important**
- `border`: **0 !important**
- `background`: **none !important**
- `color`: **inherit !important**
- `-webkit-text-fill-color`: **inherit !important**

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .app-secondary-action:focus-visible`

- `outline`: **none !important**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.28) !important**

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .app-secondary-action:disabled`

- `background`: **rgba(255, 255, 255, 0.9) !important**
- `border-color`: **rgba(124, 58, 237, 0.24) !important**
- `color`: **#344054 !important**  _(--app-ink-label=#344054)_
- `-webkit-text-fill-color`: **#344054 !important**  _(--app-ink-label=#344054)_
- `opacity`: **0.55**
- `cursor`: **not-allowed**

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .app-secondary-action:disabled *`

- `background`: **rgba(255, 255, 255, 0.9) !important**
- `border-color`: **rgba(124, 58, 237, 0.24) !important**
- `color`: **#344054 !important**  _(--app-ink-label=#344054)_
- `-webkit-text-fill-color`: **#344054 !important**  _(--app-ink-label=#344054)_
- `opacity`: **0.55**
- `cursor`: **not-allowed**

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .app-secondary-action:disabled > *`

- `background`: **none !important**
- `opacity`: **1**

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-grid--summary > .set-card > .app-secondary-action`

- `margin-block-start`: **auto**

**`.app-secondary-action`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .app-secondary-action` _[@media (max-width: 640px)]_

- `white-space`: **normal**
- `min-height`: **44px**
- `height`: **auto**
- `padding-block`: **10px**
- `text-align`: **center**

**`.app-secondary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-secondary-action`

- `height`: **36px**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `gap`: **7px**
- `padding`: **0 14px**
- `border-radius`: **8px**
- `background`: **rgba(255, 255, 255, 0.9)**
- `color`: **#344054**  _(--app-ink-label=#344054)_
- `font-size`: **12.5px**
- `font-weight`: **650**
- `letter-spacing`: **-0.006em**
- `text-decoration`: **none**
- `white-space`: **nowrap**
- `border`: **1px solid rgba(124, 58, 237, 0.24)**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.06)**
- `cursor`: **pointer**
- `transition`: **background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease**

**`.app-secondary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-secondary-action:hover:not(:disabled)`

- `background`: **#F2ECFE**
- `border-color`: **#D9C7FB**
- `color`: **#172033**  _(--app-ink-heading=#172033)_

**`.app-secondary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-secondary-action:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.28)**

**`.app-secondary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-secondary-action:disabled`

- `opacity`: **0.55**
- `cursor`: **not-allowed**

**`.app-secondary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-secondary-action svg`

- `flex`: **0 0 auto**

**`.app-secondary-action`** — `apps/web/components/notifications/notifications.css` · `.ops-empty .app-secondary-action`

- `margin-block-start`: **10px**

**`.app-secondary-action--lg`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-secondary-action--lg`

- `height`: **44px**
- `padding`: **0 18px**
- `font-size`: **14px**
- `border-radius`: **10px**

**`.set-disclosure`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .set-disclosure`

- `align-self`: **flex-start**
- `margin-top`: **14px !important**
- `min-height`: **34px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background`: **transparent !important**
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.83rem !important**
- `font-weight`: **650 !important**
- `cursor`: **pointer**

**`.set-disclosure`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .set-disclosure:hover`

- `border-color`: **var(--set-accent) !important**  ⚠ undeclared --set-accent
- `background`: **var(--set-accent-soft) !important**  ⚠ undeclared --set-accent-soft
- `color`: **var(--set-accent) !important**  ⚠ undeclared --set-accent

**`.set-event-outcome`** — `apps/web/app/(app)/settings/settings.css` · `.set-event-outcome`

- `font-size`: **0.8rem**
- `font-weight`: **680**
- `background`: **transparent**
- `border`: **0**
- `padding`: **0**

**`.set-event-outcome`** — `apps/web/app/(app)/settings/settings.css` · `.set-event-outcome[data-outcome="SUCCEEDED"]`

- `color`: **var(--set-ok)**  ⚠ undeclared --set-ok

**`.set-event-outcome`** — `apps/web/app/(app)/settings/settings.css` · `.set-event-outcome[data-outcome="PENDING"]`

- `color`: **var(--set-warn)**  ⚠ undeclared --set-warn

**`.set-event-outcome`** — `apps/web/app/(app)/settings/settings.css` · `.set-event-outcome[data-outcome="FAILED"]`

- `color`: **var(--set-danger)**  ⚠ undeclared --set-danger

**`.set-event-outcome`** — `apps/web/app/(app)/settings/settings.css` · `.set-event-outcome[data-outcome="DENIED"]`

- `color`: **var(--set-danger)**  ⚠ undeclared --set-danger


**Stock Tailwind utilities used (1).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.mt-2` → {"kind":"margin","side":"t","value":"8px"}


### D.2 PWA SOURCE-UNRESOLVED (10)

- `["ui-badge",` at `apps/web/components/ui/Badge.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/Badge.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/Badge.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-card",` at `apps/web/components/ui/Card.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-empty-state",` at `apps/web/components/ui/EmptyState.tsx:128` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression

### D.3 Native StyleSheet rules resolved (61 rules, 72 properties)

**`flex`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`screen`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `backgroundColor`: **#F7F8FC**  _(theme.color.surface.app)_

**`screenBody`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`centerColumn`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `width`: **100%**
- `alignItems`: **center**

**`screenPadded`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_

**`scrollContent`** — `apps/mobile/src/ui/index.tsx`

- `paddingBottom`: **40**  _(theme.space.s10)_
- `flexGrow`: **1**

**`footer`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`card`** — `apps/mobile/src/ui/index.tsx`

- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `borderRadius`: **14**  _(theme.radius.card)_
- `padding`: **20**  _(theme.space.s5)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_

**`pressed`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.94**

**`section`** — `apps/mobile/src/ui/index.tsx`

- `marginBottom`: **24**  _(theme.space.s6)_

**`sectionHead`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **space-between**
- `marginBottom`: **12**  _(theme.space.s3)_

**`button`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_
- `paddingHorizontal`: **20**  _(theme.space.s5)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignItems`: **center**
- `justifyContent`: **center**

**`buttonFull`** — `apps/mobile/src/ui/index.tsx`

- `alignSelf`: **stretch**

**`buttonDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

**`buttonInner`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_

**`buttonLabel`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `fontWeight`: **600**

**`badge`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_
- `paddingVertical`: **6**
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignSelf`: **flex-start**

**`badgeDot`** — `apps/mobile/src/ui/index.tsx`

- `width`: **8**
- `height`: **8**
- `borderRadius`: **4**

**`badgeText`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.label**  _(theme.type.size.label)_  ⚠ token path not found in proovra.generated.ts

**`row`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_

**`rowInner`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_

**`rowText`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `gap`: **2**

**`stateCenter`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **center**
- `paddingVertical`: **40**  _(theme.space.s10)_

**`stateGap`** — `apps/mobile/src/ui/index.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`field`** — `apps/mobile/src/ui/index.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **16**  _(theme.space.s4)_

**`input`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `borderWidth`: **1**
- `borderRadius`: **8**  _(theme.radius.md)_
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `color`: **#0F172A**  _(theme.color.ink.primary)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`inputDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 15 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 502 |
| Native elements identified | 107 |
| Pairable PWA elements | 134 |
| Paired | 3 |
| Missing in Native | 75 |
| Extra in Native | 25 |
| Unlabelled (not pairable by label) | 26 |
| SOURCE-UNRESOLVED labels | 26 |
| PWA style properties resolved | 98 |
| PWA style items SOURCE-UNRESOLVED | 10 |
| Native style properties resolved | 72 |
| PWA interactive elements | 96 |
| Native interactive elements | 28 |
| PWA conditional branches | 314 |
| Native conditional branches | 73 |
