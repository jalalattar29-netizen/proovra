# /evidence-requests/[id]

**PWA entry:** `apps/web/app/(app)/evidence-requests/[id]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/evidence-request/[id].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 14 | 2 |
| Elements | 357 | 107 |
| Interactive elements | 40 | 22 |
| Conditionally-rendered elements | 220 | 51 |
| Style rules resolved | 75 (290 props) | 68 (77 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/evidence-requests/[id]/page.tsx` | 78 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/navigation/OperationalBreadcrumb.tsx` | 8 | `OperationalBreadcrumb` |
| 1 | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx` | 20 | `EvidenceRequestAssignment` |
| 2 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx` | 11 | `WorkspaceMemberSelect` |
| 3 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 4 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx` | 148 | `EvidenceRequestEventsTab` |
| 1 | `apps/web/components/notifications/ContextualDeliveryStatus.tsx` | 9 | `ContextualDeliveryStatus` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/evidence-request/[id].tsx` | 65 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraEmptyState,ProovraButton,ProovraErrorState,ProovraCard,ProovraBadge,ProovraText,ProovraSection,ProovraListRow,ProovraEmpty,ProovraSheet,ProovraFormField,ProovraInput` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 9 | 4 | -5 |
| BUTTON | 20 | 12 | -8 |
| CARD | 0 | 7 | 7 |
| CONTAINER | 106 | 25 | -81 |
| DIALOG | 0 | 2 | 2 |
| FORM | 1 | 0 | -1 |
| HEADING | 15 | 0 | -15 |
| ICON | 42 | 0 | -42 |
| INPUT | 5 | 5 | 0 |
| LINK | 8 | 0 | -8 |
| LIST | 18 | 3 | -15 |
| OTHER | 10 | 11 | 1 |
| STATE_EMPTY | 0 | 5 | 5 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 1 | 5 | 4 |
| TAB | 1 | 0 | -1 |
| TEXT | 118 | 27 | -91 |

### C.1 Paired (4)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Back | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:730` | `apps/mobile/app/(stack)/evidence-request/[id].tsx:167` |
| INPUT | Reviewer note (workspace-internal, optional) | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:447` | `apps/mobile/app/(stack)/evidence-request/[id].tsx:345` |
| BADGE | identifierLabel(d.status) | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:572` | `apps/mobile/app/(stack)/evidence-request/[id].tsx:288` |
| INPUT | Reviewer | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:280` | `apps/mobile/app/(stack)/evidence-request/[id].tsx:402` |


### C.2 MISSING in Native (43)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Evidence request unavailable | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:333` |
| LINK | Return to matter | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:336` |
| BADGE | `Due ${formatDateTime(data.dueAtUtc)}` | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:402` |
| BADGE | Review-ready | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:405` |
| BADGE | Required items remaining | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:407` |
| BADGE | Needs more info | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:410` |
| HEADING | Deliverables | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:528` |
| BADGE | d.required ? "Required" : "Optional" | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:568` |
| BUTTON | {actionBusy === `waive:${d.id}` ? "Waiving…" : "Waive"} | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:594` |
| HEADING | Responses received | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:612` |
| BADGE | identifierLabel(r.status) | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:648` |
| LINK | Open evidence | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:654` |
| BUTTON | Accept | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:678` |
| BUTTON | Request more | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:687` |
| BUTTON | Reject | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:696` |
| LINK | ← Back to matter | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:723` |
| HEADING | Follow-up link created | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:748` |
| BUTTON | Copy link | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:781` |
| BUTTON | Close | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:794` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| HEADING | Assigned reviewer | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:206` |
| BUTTON | {assigned ? "Change reviewer" : "Assign reviewer"} | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:228` |
| BUTTON | Remove reviewer | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:249` |
| BUTTON | Send to assigned reviewer | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:260` |
| BUTTON | Save reviewer | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:289` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:298` |
| LINK | Assign a reviewer | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:325` |
| BUTTON | Search | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:162` |
| BUTTON | {loadingMore ? "Loading more members…" : "Show more members"} | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:207` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| HEADING | Matter risk snapshot | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:217` |
| HEADING | AI categorization (advisory) | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:354` |
| HEADING | Immutable storage drift | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:509` |
| INPUT | Show all checks | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:519` |
| HEADING | Approval history | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:645` |
| HEADING | Activity timeline | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:722` |
| HEADING | Organizational health | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:830` |
| HEADING | Routing recommendations | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:918` |
| HEADING | Access anomalies | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:1016` |
| BUTTON | {busyId === d.id ? "Retrying…" : "Retry"} | `apps/web/components/notifications/ContextualDeliveryStatus.tsx:105` |

### C.3 EXTRA in Native (25)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Loading request | `apps/mobile/app/(stack)/evidence-request/[id].tsx:166` |
| STATE_EMPTY | Request not available | `apps/mobile/app/(stack)/evidence-request/[id].tsx:167` |
| STATE_EMPTY | Not available | `apps/mobile/app/(stack)/evidence-request/[id].tsx:168` |
| BUTTON | Back | `apps/mobile/app/(stack)/evidence-request/[id].tsx:168` |
| BUTTON | Back | `apps/mobile/app/(stack)/evidence-request/[id].tsx:178` |
| BADGE | status.label | `apps/mobile/app/(stack)/evidence-request/[id].tsx:182` |
| BADGE | d.fulfilledCount > 0 ? `${d.fulfilledCount} added` : "Pending" | `apps/mobile/app/(stack)/evidence-request/[id].tsx:205` |
| STATE_EMPTY | Nothing has been submitted against this request yet. | `apps/mobile/app/(stack)/evidence-request/[id].tsx:219` |
| BADGE | rs.label | `apps/mobile/app/(stack)/evidence-request/[id].tsx:236` |
| BUTTON | Capture evidence to fulfil | `apps/mobile/app/(stack)/evidence-request/[id].tsx:251` |
| BUTTON | requestTransitionLabel(t) | `apps/mobile/app/(stack)/evidence-request/[id].tsx:265` |
| STATE_LOADING | Loading deliveries | `apps/mobile/app/(stack)/evidence-request/[id].tsx:279` |
| STATE_EMPTY | This request has not been sent yet. | `apps/mobile/app/(stack)/evidence-request/[id].tsx:281` |
| STATE_LOADING | Loading history | `apps/mobile/app/(stack)/evidence-request/[id].tsx:308` |
| STATE_EMPTY | Nothing has happened on this request yet. | `apps/mobile/app/(stack)/evidence-request/[id].tsx:310` |
| DIALOG | pending ? requestTransitionLabel(pending) : "" | `apps/mobile/app/(stack)/evidence-request/[id].tsx:332` |
| INPUT | Recorded on the request | `apps/mobile/app/(stack)/evidence-request/[id].tsx:346` |
| BUTTON | pending ? requestTransitionLabel(pending) : "Confirm" | `apps/mobile/app/(stack)/evidence-request/[id].tsx:355` |
| BUTTON | responseDecisionLabel(d) | `apps/mobile/app/(stack)/evidence-request/[id].tsx:382` |
| INPUT | Recorded on the submission | `apps/mobile/app/(stack)/evidence-request/[id].tsx:403` |
| BUTTON | responseDecisionLabel(decision) | `apps/mobile/app/(stack)/evidence-request/[id].tsx:412` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (11)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:388` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:399` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:400` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence-requests/[id]/page.tsx:456` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/navigation/OperationalBreadcrumb.tsx:91` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/navigation/OperationalBreadcrumb.tsx:103` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/navigation/OperationalBreadcrumb.tsx:123` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (75 rules, 290 properties)

**`.evidence-lifecycle__field`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-lifecycle__field`

- `display`: **grid**
- `gap`: **6px**
- `min-inline-size`: **0**

**`.evidence-lifecycle__field`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-lifecycle__field .app-form-input`

- `box-sizing`: **border-box**
- `inline-size`: **100%**
- `min-inline-size`: **0**

**`.evidence-detail-dialog-field__label`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-dialog-field__label`

- `font-size`: **11px**
- `font-weight`: **700**
- `letter-spacing`: **0.06em**
- `text-transform`: **uppercase**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.evidence-lifecycle__actions`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-lifecycle__actions`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **center**
- `gap`: **8px**
- `min-inline-size`: **0**

**`.app-form-input`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-dialog-field .app-form-input`

- `box-sizing`: **border-box**
- `inline-size`: **100%**
- `min-inline-size`: **0**

**`.app-form-input`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-lifecycle__field .app-form-input`

- `box-sizing`: **border-box**
- `inline-size`: **100%**
- `min-inline-size`: **0**

**`.app-form-input`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-form-input`

- `width`: **100%**
- `min-height`: **40px**
- `padding`: **9px 12px**
- `border`: **1px solid rgba(100, 116, 139, 0.22)**
- `background`: **rgba(255, 255, 255, 0.92)**
- `border-radius`: **10px**
- `color`: **#263247**  _(--app-ink-control=#263247)_
- `font-size`: **13.5px**
- `font-family`: **inherit**
- `transition`: **border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease**

**`.app-form-input`** — `apps/web/components/app-primitives/app-primitives.css` · `textarea.app-form-input`

- `width`: **100%**
- `min-height`: **40px**
- `padding`: **9px 12px**
- `border`: **1px solid rgba(100, 116, 139, 0.22)**
- `background`: **rgba(255, 255, 255, 0.92)**
- `border-radius`: **10px**
- `color`: **#263247**  _(--app-ink-control=#263247)_
- `font-size`: **13.5px**
- `font-family`: **inherit**
- `transition`: **border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease**

**`.app-form-input`** — `apps/web/components/app-primitives/app-primitives.css` · `select.app-form-input`

- `width`: **100%**
- `min-height`: **40px**
- `padding`: **9px 12px**
- `border`: **1px solid rgba(100, 116, 139, 0.22)**
- `background`: **rgba(255, 255, 255, 0.92)**
- `border-radius`: **10px**
- `color`: **#263247**  _(--app-ink-control=#263247)_
- `font-size`: **13.5px**
- `font-family`: **inherit**
- `transition`: **border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease**

**`.app-form-input`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-form-input::placeholder`

- `color`: **#98A2B3**  _(--app-ink-placeholder=#98A2B3)_

**`.app-form-input`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-form-input:focus`

- `outline`: **none**
- `border-color`: **#8b7cf6**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.14)**

**`.app-form-input`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-form-input:focus-visible`

- `outline`: **none**
- `border-color`: **#8b7cf6**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.14)**

**`.app-form-input`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-form-input:disabled`

- `opacity`: **0.6**
- `cursor`: **not-allowed**

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

**`.app-hint`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-preview__notice .app-hint`

- `max-width`: **44ch**

**`.app-hint`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-artifact__text .app-hint`

- `overflow-wrap`: **anywhere**

**`.app-hint`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-inspector__body .app-hint`

- `text-shadow`: **none**

**`.app-hint`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-hint`

- `margin`: **0**
- `font-size`: **12.5px**
- `line-height`: **1.5**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.app-hint`** — `apps/web/components/cases-experience/cases-experience.css` · `.case-detail-stack > .app-hint:first-child`

- `margin-top`: **0**

**`.app-field-error`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-field-error`

- `margin`: **6px 0 0**
- `font-size`: **12px**
- `line-height`: **1.45**
- `font-weight`: **550**
- `color`: **#DC2626**  _(--error=#DC2626)_

**`.app-ghost-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-ghost-action`

- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `gap`: **6px**
- `border`: **1px solid transparent**
- `background`: **transparent**
- `color`: **#344054**  _(--app-ink-label=#344054)_
- `border-radius`: **8px**
- `padding`: **6px 10px**
- `font-size`: **12.5px**
- `font-weight`: **600**
- `cursor`: **pointer**
- `transition`: **background-color 140ms ease, color 140ms ease**

**`.app-ghost-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-ghost-action:hover:not(:disabled)`

- `background`: **rgba(15, 23, 42, 0.05)**
- `color`: **#172033**

**`.app-ghost-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-ghost-action:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.22)**



### D.2 PWA SOURCE-UNRESOLVED (5)

- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression

### D.3 Native StyleSheet rules resolved (68 rules, 77 properties)

**`headerRow`** — `apps/mobile/app/(stack)/evidence-request/[id].tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`hero`** — `apps/mobile/app/(stack)/evidence-request/[id].tsx`

- `marginBottom`: **16**  _(theme.space.s4)_
- `gap`: **8**  _(theme.space.s2)_

**`gap`** — `apps/mobile/app/(stack)/evidence-request/[id].tsx`

- `marginTop`: **8**  _(theme.space.s2)_

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
| PWA files inspected (rendered tree) | 14 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 357 |
| Native elements identified | 107 |
| Pairable PWA elements | 62 |
| Paired | 1 |
| Missing in Native | 43 |
| Extra in Native | 25 |
| Unlabelled (not pairable by label) | 4 |
| SOURCE-UNRESOLVED labels | 11 |
| PWA style properties resolved | 290 |
| PWA style items SOURCE-UNRESOLVED | 5 |
| Native style properties resolved | 77 |
| PWA interactive elements | 40 |
| Native interactive elements | 22 |
| PWA conditional branches | 220 |
| Native conditional branches | 51 |
