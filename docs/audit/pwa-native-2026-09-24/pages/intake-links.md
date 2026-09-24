# /intake-links

**PWA entry:** `apps/web/app/(app)/intake-links/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/intake-links.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 26 | 2 |
| Elements | 691 | 74 |
| Interactive elements | 95 | 17 |
| Conditionally-rendered elements | 234 | 36 |
| Style rules resolved | 369 (1406 props) | 63 (73 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/intake-links/page.tsx` | 35 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/app/(app)/intake-links/_components/icons.tsx` | 76 | `IconLink,IconPlus` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell` |
| 1 | `apps/web/app/(app)/intake-links/_components/States.tsx` | 53 | `InlineMutationError,LoadingState,FeatureUnavailableState,RestrictedState,ErrorState,EmptyState,RefreshingNotice,NoMatchState` |
| 1 | `apps/web/app/(app)/intake-links/_components/KpiGrid.tsx` | 8 | `KpiGrid` |
| 1 | `apps/web/app/(app)/intake-links/_components/FilterToolbar.tsx` | 22 | `FilterToolbar` |
| 2 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 3 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/app/(app)/intake-links/_components/RecordsSurface.tsx` | 96 | `RecordsSurface` |
| 2 | `apps/web/components/app-primitives/AppStatusBadge.tsx` | 2 | `AppStatusBadge` |
| 2 | `apps/web/components/app-primitives/AppRowMenu.tsx` | 10 | `AppRowMenu` |
| 1 | `apps/web/app/(app)/intake-links/_components/Pagination.tsx` | 13 | `Pagination` |
| 1 | `apps/web/app/(app)/intake-links/_components/wizard/CreateLinkWizard.tsx` | 28 | `CreateLinkWizard` |
| 2 | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx` | 48 | `StepRequest,StepDelivery,StepRules,StepReview` |
| 3 | `apps/web/app/(app)/intake-links/_components/wizard/fields.tsx` | 28 | `Field,ChoiceCards,KindChips` |
| 3 | `apps/web/app/(app)/intake-links/_components/wizard/MessagePreview.tsx` | 29 | `MessagePreview` |
| 1 | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx` | 30 | `LinkCreatedDialog` |
| 1 | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx` | 68 | `DetailsDrawer` |
| 2 | `apps/web/app/(app)/intake-links/_components/Drawer.tsx` | 9 | `Drawer` |
| 1 | `apps/web/app/(app)/intake-links/_components/DeliveryHistoryDrawer.tsx` | 21 | `DeliveryHistoryDrawer` |
| 1 | `apps/web/app/(app)/intake-links/_components/SubmissionsDrawer.tsx` | 22 | `SubmissionsDrawer` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/intake-links.tsx` | 32 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraSection,ProovraButton,ProovraLoadingState,ProovraEmptyState,ProovraErrorState,ProovraCard,ProovraListRow,ProovraBadge,ProovraText,ProovraSheet,ProovraFormField,ProovraInput` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 9 | 1 | -8 |
| BUTTON | 32 | 9 | -23 |
| CARD | 1 | 3 | 2 |
| CONTAINER | 116 | 24 | -92 |
| DIALOG | 7 | 1 | -6 |
| FRAGMENT | 3 | 0 | -3 |
| HEADING | 15 | 0 | -15 |
| ICON | 117 | 0 | -117 |
| INPUT | 22 | 3 | -19 |
| LINK | 2 | 0 | -2 |
| LIST | 40 | 2 | -38 |
| OTHER | 97 | 2 | -95 |
| STATE_EMPTY | 1 | 2 | 1 |
| STATE_ERROR | 5 | 2 | -3 |
| STATE_LOADING | 6 | 4 | -2 |
| TEXT | 218 | 21 | -197 |

### C.1 Paired (2)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Try again | `apps/web/app/(app)/intake-links/_components/States.tsx:176` | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | {stepIndex === 0 ? "Cancel" : "Back"} | `apps/web/app/(app)/intake-links/_components/wizard/CreateLinkWizard.tsx:425` | `apps/mobile/app/(stack)/intake-links.tsx:193` |


### C.2 MISSING in Native (49)

| Role | Label | PWA source |
|---|---|---|
| HEADING | External intake links | `apps/web/app/(app)/intake-links/page.tsx:448` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| HEADING | Start from a common request | `apps/web/app/(app)/intake-links/_components/States.tsx:104` |
| BUTTON | Clear filters | `apps/web/app/(app)/intake-links/_components/States.tsx:146` |
| BUTTON | Dismiss | `apps/web/app/(app)/intake-links/_components/States.tsx:261` |
| INPUT | Search by request, recipient, or link id | `apps/web/app/(app)/intake-links/_components/FilterToolbar.tsx:106` |
| BUTTON | Clear filters | `apps/web/app/(app)/intake-links/_components/FilterToolbar.tsx:181` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| BUTTON | row.submissionsLabel | `apps/web/app/(app)/intake-links/_components/RecordsSurface.tsx:403` |
| HEADING | New intake link | `apps/web/app/(app)/intake-links/_components/wizard/CreateLinkWizard.tsx:353` |
| BUTTON | Close new intake link | `apps/web/app/(app)/intake-links/_components/wizard/CreateLinkWizard.tsx:360` |
| BUTTON | Continue | `apps/web/app/(app)/intake-links/_components/wizard/CreateLinkWizard.tsx:453` |
| INPUT | What are you asking for? | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:160` |
| INPUT | Recipient label | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:290` |
| INPUT | intakeRecipientLabel | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:295` |
| INPUT | Customer ID (optional) | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:317` |
| INPUT | CUST-849271 | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:323` |
| INPUT | Recipient email | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:345` |
| INPUT | intakeRecipientEmail | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:351` |
| INPUT | Recipient phone | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:374` |
| INPUT | +14155550123 | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:381` |
| INPUT | Display name | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:423` |
| INPUT | Smith &amp; Partners | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:430` |
| INPUT | Link expires in | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:484` |
| INPUT | Maximum files per submission | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:510` |
| INPUT | Expires in (hours) | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:539` |
| INPUT | Consent or disclosure text | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:587` |
| HEADING | Message preview | `apps/web/app/(app)/intake-links/_components/wizard/MessagePreview.tsx:120` |
| HEADING | Secure link created | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx:132` |
| BUTTON | Close secure link dialog | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx:140` |
| BADGE | Sent | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx:157` |
| BUTTON | {copied ? "Copied" : "Copy link"} | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx:199` |
| BUTTON | {sendBusy === "EMAIL" ? <IconSpinner size={14} /> : null} | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx:251` |
| BUTTON | {sendBusy === "SMS" ? <IconSpinner size={14} /> : null} | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx:266` |
| BUTTON | Done | `apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx:283` |
| DIALOG | row.requestName | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:53` |
| HEADING | Overview | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:64` |
| HEADING | Delivery | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:149` |
| BUTTON | Open delivery history | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:163` |
| HEADING | Activity | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:180` |
| HEADING | Submissions | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:203` |
| BUTTON | View submissions | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:211` |
| HEADING | Access | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:223` |
| BUTTON | Disable link | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:245` |
| BUTTON | `Close ${title.toLowerCase()}` | `apps/web/app/(app)/intake-links/_components/Drawer.tsx:76` |
| LINK | Open evidence | `apps/web/app/(app)/intake-links/_components/SubmissionsDrawer.tsx:178` |

### C.3 EXTRA in Native (15)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Loading intake links | `apps/mobile/app/(stack)/intake-links.tsx:196` |
| STATE_EMPTY | Not available | `apps/mobile/app/(stack)/intake-links.tsx:198` |
| STATE_EMPTY | No intake links | `apps/mobile/app/(stack)/intake-links.tsx:202` |
| BUTTON | Revoke | `apps/mobile/app/(stack)/intake-links.tsx:219` |
| BADGE | status.label | `apps/mobile/app/(stack)/intake-links.tsx:221` |
| STATE_LOADING | Loading submissions | `apps/mobile/app/(stack)/intake-links.tsx:238` |
| BUTTON | archived ? "Unarchive" : "Archive" | `apps/mobile/app/(stack)/intake-links.tsx:279` |
| BUTTON | Reveal recipient contact | `apps/mobile/app/(stack)/intake-links.tsx:286` |
| DIALOG | Reveal recipient contact? | `apps/mobile/app/(stack)/intake-links.tsx:309` |
| INPUT | Why do you need it? | `apps/mobile/app/(stack)/intake-links.tsx:320` |
| INPUT | Recorded with the disclosure | `apps/mobile/app/(stack)/intake-links.tsx:321` |
| BUTTON | Reveal and record | `apps/mobile/app/(stack)/intake-links.tsx:329` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |

### C.4 SOURCE-UNRESOLVED labels (22)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/intake-links/_components/RecordsSurface.tsx:128` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/intake-links/_components/RecordsSurface.tsx:297` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/app-primitives/AppRowMenu.tsx:171` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/app-primitives/AppRowMenu.tsx:216` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/intake-links/_components/wizard/CreateLinkWizard.tsx:435` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:622` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:710` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/intake-links/_components/wizard/fields.tsx:111` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:66` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:73` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:230` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/intake-links/_components/Drawer.tsx:71` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/intake-links/_components/DeliveryHistoryDrawer.tsx:87` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/intake-links/_components/DeliveryHistoryDrawer.tsx:132` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/intake-links/_components/DeliveryHistoryDrawer.tsx:166` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/intake-links/_components/SubmissionsDrawer.tsx:103` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/intake-links/_components/SubmissionsDrawer.tsx:156` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (369 rules, 1406 properties)

**`.app-page-header`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header`

- `display`: **flex**
- `align-items`: **flex-start**
- `justify-content`: **space-between**
- `gap`: **16px**
- `flex-wrap`: **wrap**

**`.app-page-header__lead`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__lead`

- `display`: **flex**
- `align-items`: **flex-start**
- `gap`: **12px**
- `min-width`: **0**
- `flex`: **1 1 auto**

**`.app-page-header__icon`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__icon`

- `width`: **42px**
- `height`: **42px**
- `border-radius`: **12px**
- `display`: **grid**
- `place-items`: **center**
- `flex-shrink`: **0**
- `color`: **#7C3AED**
- `background`: **linear-gradient(145deg, rgba(124, 58, 237, 0.10), rgba(73, 184, 255, 0.08))**
- `border`: **1px solid rgba(124, 58, 237, 0.16)**
- `box-shadow`: **inset 0 1px 0 rgba(255, 255, 255, 0.8)**

**`.app-page-header__text`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__text`

- `min-width`: **0**

**`.app-page-header__title`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__title`

- `font-size`: **30px**
- `line-height`: **1.15**
- `font-weight`: **720**
- `letter-spacing`: **-0.025em**
- `color`: **#172033**  _(--app-ink-heading=#172033)_
- `margin`: **0**

**`.app-page-header__subtitle`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__subtitle`

- `margin`: **4px 0 0**
- `font-size`: **13.5px**
- `line-height`: **1.5**
- `color`: **#5F6878**
- `max-width`: **64ch**

**`.ilk-context`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-context`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **center**
- `gap`: **8px**
- `font-size`: **12.5px**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.app-page-header__actions`** — `apps/web/app/(app)/operations/health/workspace-health.css` · `.wsh__header .app-page-header__actions`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **0.5rem**
- `flex-wrap`: **wrap**

**`.app-page-header__actions`** — `apps/web/app/(app)/operations/health/workspace-health.css` · `.wsh__header .app-page-header__actions button` _[@media (max-width: 40rem)]_

- `min-block-size`: **2.75rem**

**`.app-page-header__actions`** — `apps/web/app/(app)/operations/health/workspace-health.css` · `.wsh__header .app-page-header__actions a` _[@media (max-width: 40rem)]_

- `min-block-size`: **2.75rem**

**`.app-page-header__actions`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__actions`

- `display`: **inline-flex**
- `align-items`: **center**
- `gap`: **10px**
- `flex-shrink`: **0**

**`.app-page-header__actions`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__actions > *` _[@media (max-width: 640px)]_

- `flex`: **1 1 auto**
- `justify-content`: **center**

**`.app-primary-action`** — `apps/web/app/(app)/billing/billing.css` · `.bill-panel__actions > *:not(.app-primary-action)`

- `min-block-size`: **44px**
- `block-size`: **44px**

**`.app-primary-action`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-discussion__composer-foot > .app-primary-action` _[@media (max-width: 560px)]_

- `inline-size`: **100%**
- `justify-content`: **center**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action`

- `height`: **36px**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `gap`: **7px**
- `padding`: **0 14px**
- `border-radius`: **8px**
- `background`: **linear-gradient(135deg, #7C3AED 0%, #6D28D9 100%)**
- `color`: **#ffffff**
- `font-size`: **12.5px**
- `font-weight`: **650**
- `letter-spacing`: **-0.006em**
- `text-decoration`: **none**
- `white-space`: **nowrap**
- `border`: **1px solid rgba(109, 40, 217, 0.5)**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.12)**
- `cursor`: **pointer**
- `transition`: **filter 120ms ease, box-shadow 120ms ease**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action:hover:not(:disabled)`

- `filter`: **brightness(1.05)**
- `box-shadow`: **0 2px 8px rgba(109, 40, 217, 0.32)**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.35)**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action:disabled`

- `opacity`: **0.55**
- `cursor`: **not-allowed**
- `filter`: **none**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.12)**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action svg`

- `flex`: **0 0 auto**

**`.ilk-page`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-page`

- `--ilk-tone-slate`: **#64748b**
- `--ilk-tone-indigo`: **#6D28D9**  _(--accent-600=#6D28D9)_
- `--ilk-tone-blue`: **#2563eb**
- `--ilk-tone-green`: **#167a5b**
- `--ilk-tone-amber`: **#a86612**
- `--ilk-tone-orange`: **#EA580C**  _(--orange-500=#EA580C)_
- `--ilk-tone-red`: **#c9363e**
- `min-inline-size`: **0**

**`.ilk-note`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-note`

- `margin`: **0**
- `font-size`: **12.5px**
- `line-height`: **1.55**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.ui-page-header__actions`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .ui-page-header__actions` _[@media (max-width: 720px)]_

- `width`: **100%**
- `flex-wrap`: **wrap**
- `row-gap`: **8px**

**`.app-table-surface`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-table-surface`

- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**
- `overflow`: **hidden**

**`.ilk-skeleton-row`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-skeleton-row`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **12px**
- `padding`: **14px 16px**
- `border-block-end`: **1px solid rgba(15, 23, 42, 0.05)**

**`.app-skeleton`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-skeleton`

- `position`: **relative**
- `overflow`: **hidden**
- `background`: **rgba(15, 23, 42, 0.05)**
- `border-radius`: **8px**

**`.app-skeleton`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-skeleton::after`

- `content`: **""**
- `position`: **absolute**
- `inset`: **0**
- `transform`: **translateX(-100%)**
- `background`: **linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent)**
- `animation`: **app-skeleton-shimmer 1.4s infinite**

**`.ilk-skeleton-bar`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-skeleton-bar`

- `block-size`: **14px**

**`.ilk-skeleton-bar`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-skeleton-bar[data-span="wide"]`

- `flex`: **2 1 0**

**`.ilk-skeleton-bar`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-skeleton-bar[data-span="mid"]`

- `flex`: **1 1 0**

**`.ilk-skeleton-bar`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-skeleton-bar[data-span="pill"]`

- `inline-size`: **72px**
- `flex`: **0 0 auto**

**`.app-visually-hidden`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-visually-hidden`

- `position`: **absolute**
- `inline-size`: **1px**
- `block-size`: **1px**
- `margin`: **-1px**
- `padding`: **0**
- `overflow`: **hidden**
- `clip-path`: **inset(50%)**
- `white-space`: **nowrap**
- `border`: **0**

**`.app-alert`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-alert`

- `padding`: **12px**
- `border`: **1px solid rgba(15, 23, 42, 0.08)**
- `border-radius`: **12px**  _(--radius-lg=12px)_
- `background`: **rgba(255, 255, 255, 0.70)**
- `font-size`: **13px**
- `line-height`: **1.5**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.app-section-stack`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-section-stack`

- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **16px**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty`

- `background`: **rgba(255, 255, 255, 0.5)**
- `border`: **1px solid rgba(15, 23, 42, 0.06)**
- `border-radius`: **14px**
- `padding`: **40px 24px**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **10px**
- `align-items`: **center**
- `text-align`: **center**
- `color`: **#475569**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty strong`

- `color`: **#172033**
- `font-size`: **15px**
- `font-weight`: **700**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty p`

- `margin`: **0**
- `font-size`: **13px**
- `line-height`: **1.5**
- `max-width`: **46ch**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty[data-tone="danger"] strong`

- `color`: **#C9363E**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty[data-tone="restricted"] strong`

- `color`: **#B45309**  _(--warning-ink=#B45309)_

**`.app-empty__icon`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty__icon`

- `width`: **52px**
- `height`: **52px**
- `border-radius`: **14px**
- `display`: **grid**
- `place-items`: **center**
- `color`: **#7C3AED**
- `background`: **linear-gradient(145deg, rgba(124, 58, 237, 0.10), rgba(73, 184, 255, 0.08))**
- `border`: **1px solid rgba(124, 58, 237, 0.16)**
- `margin-bottom`: **2px**

**`.app-empty__actions`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty__actions`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `justify-content`: **center**
- `gap`: **8px**
- `margin-top`: **2px**



### D.2 PWA SOURCE-UNRESOLVED (17)

- `className` at `apps/web/app/(app)/intake-links/_components/icons.tsx:21` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-spinner${p.className ? ` ${p.className}` : ""}`` at `apps/web/app/(app)/intake-links/_components/icons.tsx:101` — className built from a runtime expression
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `ilk-kpi__value` at `apps/web/app/(app)/intake-links/_components/KpiGrid.tsx:65` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `ilk-kpi__label` at `apps/web/app/(app)/intake-links/_components/KpiGrid.tsx:68` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `ilk-kpi__meta` at `apps/web/app/(app)/intake-links/_components/KpiGrid.tsx:71` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `ilk-listbox` at `apps/web/app/(app)/intake-links/_components/FilterToolbar.tsx:121` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- ``app-status-badge${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusBadge.tsx:109` — className built from a runtime expression
- `triggerLabelClassName` at `apps/web/components/app-primitives/AppRowMenu.tsx:186` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-menu__item${ action.danger ? " app-menu__item--danger" : "" }`` at `apps/web/components/app-primitives/AppRowMenu.tsx:216` — className built from a runtime expression
- `ilk-status__line` at `apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx:65` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (63 rules, 73 properties)

**`note`** — `apps/mobile/app/(stack)/intake-links.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

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
| PWA files inspected (rendered tree) | 26 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 691 |
| Native elements identified | 74 |
| Pairable PWA elements | 100 |
| Paired | 2 |
| Missing in Native | 49 |
| Extra in Native | 15 |
| Unlabelled (not pairable by label) | 27 |
| SOURCE-UNRESOLVED labels | 22 |
| PWA style properties resolved | 1406 |
| PWA style items SOURCE-UNRESOLVED | 17 |
| Native style properties resolved | 73 |
| PWA interactive elements | 95 |
| Native interactive elements | 17 |
| PWA conditional branches | 234 |
| Native conditional branches | 36 |
