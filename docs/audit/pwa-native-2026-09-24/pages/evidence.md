# /evidence

**PWA entry:** `apps/web/app/(app)/evidence/page.tsx`
**Native entry:** `apps/mobile/app/(tabs)/evidence.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 19 | 2 |
| Elements | 371 | 170 |
| Interactive elements | 73 | 50 |
| Conditionally-rendered elements | 115 | 108 |
| Style rules resolved | 375 (1274 props) | 124 (154 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/evidence/page.tsx` | 18 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell` |
| 1 | `apps/web/app/(app)/evidence/components/EvidenceLibraryHeader.tsx` | 15 | `EvidenceLibraryHeader` |
| 1 | `apps/web/app/(app)/evidence/components/EvidenceMetrics.tsx` | 6 | `EvidenceMetrics` |
| 1 | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx` | 21 | `EvidenceFilters` |
| 2 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 3 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx` | 33 | `SavedViewsMenu` |
| 2 | `apps/web/components/cases-experience/matter-modals/Modal.tsx` | 9 | `Modal` |
| 1 | `apps/web/app/(app)/evidence/components/EvidenceList.tsx` | 29 | `EvidenceList` |
| 2 | `apps/web/components/ui/EmptyState.tsx` | 15 | `EmptyState` |
| 2 | `apps/web/app/(app)/evidence/components/EvidenceLibraryRow.tsx` | 19 | `EvidenceLibraryRow` |
| 1 | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx` | 30 | `BulkActionsToolbar` |
| 1 | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx` | 83 | `QueueSelectionPreview` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(tabs)/evidence.tsx` | 128 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraText,ProovraButton,ProovraLoadingState,ProovraErrorState,ProovraEmptyState,ProovraBadge,ProovraCard,ProovraListRow,ProovraShell,ProovraSection,ProovraInput,ProovraSheet,ProovraFormField` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 9 | 21 | 12 |
| BUTTON | 28 | 21 | -7 |
| CARD | 1 | 10 | 9 |
| CONTAINER | 75 | 46 | -29 |
| DIALOG | 4 | 2 | -2 |
| HEADING | 7 | 0 | -7 |
| ICON | 48 | 0 | -48 |
| IMAGE | 1 | 1 | 0 |
| INPUT | 6 | 5 | -1 |
| LINK | 5 | 0 | -5 |
| LIST | 9 | 8 | -1 |
| OTHER | 55 | 7 | -48 |
| STATE_EMPTY | 1 | 3 | 2 |
| STATE_ERROR | 3 | 3 | 0 |
| STATE_LOADING | 0 | 5 | 5 |
| TEXT | 119 | 38 | -81 |

### C.1 Paired (5)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Close | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:95` | `apps/mobile/app/(tabs)/evidence.tsx:182` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:155` | `apps/mobile/app/(tabs)/evidence.tsx:1251` |
| BUTTON | Open Evidence | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx:600` | `apps/mobile/app/(tabs)/evidence.tsx:382` |
| BUTTON | `Clear ${c.label}` | `apps/web/app/(app)/evidence/page.tsx:200` | `apps/mobile/app/(tabs)/evidence.tsx:1158` |
| BADGE | Status | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:130` | `apps/mobile/app/(tabs)/evidence.tsx:1326` |


### C.2 MISSING in Native (38)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| LINK | New Case | `apps/web/app/(app)/evidence/components/EvidenceLibraryHeader.tsx:59` |
| BUTTON | {refreshing ? "Refreshing…" : "Refresh"} | `apps/web/app/(app)/evidence/components/EvidenceLibraryHeader.tsx:67` |
| LINK | Upload / Capture Evidence | `apps/web/app/(app)/evidence/components/EvidenceLibraryHeader.tsx:81` |
| INPUT | Search title, filename, or record ID | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:100` |
| BADGE | Workspace scope | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:117` |
| BADGE | Evidence type | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:145` |
| BADGE | How the record entered PROOVRA | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:161` |
| BADGE | Review | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:177` |
| BADGE | Export | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:190` |
| BADGE | Case | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:202` |
| BADGE | Retention | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:214` |
| BADGE | Sort | `apps/web/app/(app)/evidence/components/EvidenceFilters.tsx:226` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| BUTTON | Saved Views | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:69` |
| BUTTON | Save Current View | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:78` |
| BUTTON | Load View | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:114` |
| BUTTON | Rename | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:117` |
| BUTTON | {view.isDefault ? "Default View" : "Make Default"} | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:130` |
| BUTTON | Delete | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:133` |
| BUTTON | Close | `apps/web/components/cases-experience/matter-modals/Modal.tsx:223` |
| HEADING | Evidence queue | `apps/web/app/(app)/evidence/components/EvidenceList.tsx:53` |
| STATE_EMPTY | No evidence records in this scope | `apps/web/app/(app)/evidence/components/EvidenceList.tsx:105` |
| LINK | Upload / Capture Evidence | `apps/web/app/(app)/evidence/components/EvidenceList.tsx:113` |
| LINK | Review Cases | `apps/web/app/(app)/evidence/components/EvidenceList.tsx:116` |
| BUTTON | Previous | `apps/web/app/(app)/evidence/components/EvidenceList.tsx:142` |
| BUTTON | Next | `apps/web/app/(app)/evidence/components/EvidenceList.tsx:150` |
| BUTTON | Run Bulk Action | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` |
| BUTTON | Clear Selection | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:350` |
| BUTTON | Close | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:406` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:416` |
| BUTTON | Download Report | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx:704` |
| BUTTON | Download Verification Package | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx:716` |
| BUTTON | Copy Verification Link | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx:728` |
| BUTTON | Close queue selection | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx:797` |

### C.3 EXTRA in Native (35)

| Role | Label | Native source |
|---|---|---|
| BUTTON | label | `apps/mobile/app/(tabs)/evidence.tsx:116` |
| STATE_LOADING | Loading selected record | `apps/mobile/app/(tabs)/evidence.tsx:191` |
| STATE_EMPTY | Preview unavailable | `apps/mobile/app/(tabs)/evidence.tsx:195` |
| BADGE | evidence.verificationStatusLabel?.trim() \|\| humanizeEnum(evidence.verificationStatus) | `apps/mobile/app/(tabs)/evidence.tsx:210` |
| BADGE | evidenceLifecycleDisplay(evidence.lifecycleState).label | `apps/mobile/app/(tabs)/evidence.tsx:226` |
| IMAGE | preview.item.label \|\| preview.item.originalFileName \|\| "Evidence preview" | `apps/mobile/app/(tabs)/evidence.tsx:258` |
| BUTTON | Open Preview | `apps/mobile/app/(tabs)/evidence.tsx:276` |
| BUTTON | Open | `apps/mobile/app/(tabs)/evidence.tsx:328` |
| BADGE | artifacts?.report ? humanizeEnum(artifacts.report) : "Unavailable" | `apps/mobile/app/(tabs)/evidence.tsx:336` |
| BUTTON | Open | `apps/mobile/app/(tabs)/evidence.tsx:356` |
| BUTTON | Share | `apps/mobile/app/(tabs)/evidence.tsx:370` |
| BADGE | s.label | `apps/mobile/app/(tabs)/evidence.tsx:1104` |
| INPUT | Search evidence | `apps/mobile/app/(tabs)/evidence.tsx:1123` |
| BADGE | evidenceTypeLabel(tf) | `apps/mobile/app/(tabs)/evidence.tsx:1129` |
| BADGE | evidenceStatusDisplay(st).label | `apps/mobile/app/(tabs)/evidence.tsx:1141` |
| BADGE | humanizeEnum(sf) | `apps/mobile/app/(tabs)/evidence.tsx:1148` |
| BADGE | rf === "ready" ? "Report ready" : "Report missing" | `apps/mobile/app/(tabs)/evidence.tsx:1155` |
| BADGE | v.isDefault ? `${v.name} ·` : v.name | `apps/mobile/app/(tabs)/evidence.tsx:1164` |
| INPUT | Name | `apps/mobile/app/(tabs)/evidence.tsx:1201` |
| INPUT | `Up to ${SAVED_VIEW_NAME_MAX} characters` | `apps/mobile/app/(tabs)/evidence.tsx:1202` |
| BUTTON | Open the library on this view | `apps/mobile/app/(tabs)/evidence.tsx:1224` |
| STATE_LOADING | Loading cases | `apps/mobile/app/(tabs)/evidence.tsx:1260` |
| STATE_EMPTY | No cases available | `apps/mobile/app/(tabs)/evidence.tsx:1267` |
| BADGE | Add | `apps/mobile/app/(tabs)/evidence.tsx:1279` |
| BUTTON | a.label | `apps/mobile/app/(tabs)/evidence.tsx:1292` |
| STATE_LOADING | Loading evidence | `apps/mobile/app/(tabs)/evidence.tsx:1299` |
| STATE_EMPTY | scope === "active" && !filtersActive && !query ? "No evidence yet" : "No matches" | `apps/mobile/app/(tabs)/evidence.tsx:1303` |
| BUTTON | + Capture | `apps/mobile/app/(tabs)/evidence.tsx:1306` |
| BADGE | isSel ? "Selected" : "Tap" | `apps/mobile/app/(tabs)/evidence.tsx:1322` |
| BUTTON | Restore | `apps/mobile/app/(tabs)/evidence.tsx:1324` |
| BUTTON | Load more | `apps/mobile/app/(tabs)/evidence.tsx:1335` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (15)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/components/EvidenceLibraryHeader.tsx:101` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:89` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:141` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/components/SavedViewsMenu.tsx:169` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/matter-modals/Modal.tsx:219` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/components/EvidenceLibraryRow.tsx:61` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:395` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:424` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx:767` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/components/QueueSelectionPreview.tsx:807` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (375 rules, 1274 properties)

**`.app-chip-row`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-chip-row`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **center**
- `gap`: **8px**
- `margin`: **0**
- `padding`: **0**
- `list-style`: **none**

**`.evidence-library-active-chips`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-active-chips`

- `margin-block`: **8px 4px**

**`.app-chip`** — `apps/web/app/(app)/intake-links/intake-links.css` · `.ilk-table .app-chip`

- `white-space`: **normal**

**`.app-chip`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-chip`

- `display`: **inline-flex**
- `align-items`: **center**
- `gap`: **6px**
- `padding`: **2px 8px**
- `border`: **1px solid rgba(15, 23, 42, 0.10)**
- `border-radius`: **6px**  _(--radius-sm=6px)_
- `background`: **rgba(255, 255, 255, 0.70)**
- `font-size`: **12px**
- `line-height`: **18px**
- `font-weight`: **500**
- `font-style`: **normal**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_
- `white-space`: **nowrap**

**`.evidence-library-active-chips__clear`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-active-chips__clear`

- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `margin-inline-start`: **4px**
- `padding`: **0**
- `border`: **none**
- `background`: **transparent**
- `color`: **inherit**
- `cursor`: **pointer**
- `border-radius`: **4px**

**`.evidence-library-active-chips__clear`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-active-chips__clear:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 2px rgba(124, 58, 237, 0.4)**

**`.evidence-library-page`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-page`

- `padding-bottom`: **40px**

**`.evidence-library-layout`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-layout`

- `display`: **grid**
- `grid-template-columns`: **minmax(0, 1fr)**
- `align-items`: **stretch**
- `min-height`: **100%**

**`.evidence-library-layout`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-layout[data-inspector="open"]` _[@media (min-width: 1100px)]_

- `grid-template-columns`: **minmax(0, 1fr) clamp(380px, 29vw, 480px)**

**`.evidence-library-layout`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-layout > *`

- `min-block-size`: **0**

**`.evidence-library-shell`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-shell`

- `max-width`: **1440px**
- `margin`: **0 auto**
- `padding`: **28px 16px 40px**  _(--container-gutter=16px)_
- `position`: **relative**
- `z-index`: **1**

**`.evidence-library-main`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-main`

- `display`: **grid**
- `gap`: **18px**
- `align-items`: **start**

**`.evidence-library-main`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-main > *`

- `min-width`: **0**

**`.ui-page-header__actions`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .ui-page-header__actions` _[@media (max-width: 720px)]_

- `width`: **100%**
- `flex-wrap`: **wrap**
- `row-gap`: **8px**

**`.evidence-library-header`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .ui-page-header__actions` _[@media (max-width: 720px)]_

- `width`: **100%**
- `flex-wrap`: **wrap**
- `row-gap`: **8px**

**`.evidence-library-header`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .app-header-primary-action` _[@media (max-width: 720px)]_

- `flex`: **1 0 100%**
- `justify-content`: **center**

**`.evidence-library-header`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .app-secondary-action` _[@media (max-width: 720px)]_

- `flex`: **1 1 calc(50% - 4px)**
- `justify-content`: **center**

**`.evidence-library-header`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .app-title-row`

- `margin-block-start`: **-3px**

**`.app-title-row`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .app-title-row`

- `margin-block-start`: **-3px**

**`.app-title-row`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-title-row`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **12px**
- `min-inline-size`: **0**
- `font-size`: **30px**
- `line-height`: **1.15**
- `font-weight`: **720**
- `letter-spacing`: **-0.025em**

**`.app-title-icon`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-title-icon`

- `--app-title-icon-tone`: **#7C3AED**  _(--accent-500=#7C3AED)_
- `inline-size`: **42px**
- `block-size`: **42px**
- `border-radius`: **12px**
- `display`: **grid**
- `place-items`: **center**
- `flex-shrink`: **0**
- `background`: **linear-gradient(     145deg,     rgba(91, 79, 233, 0.1),     rgba(73, 184, 255, 0.08)   )**
- `border`: **1px solid rgba(91, 79, 233, 0.16)**
- `box-shadow`: **inset 0 1px 0 rgba(255, 255, 255, 0.8)**
- `color`: **var(--app-title-icon-tone)**  ⚠ undeclared --app-title-icon-tone

**`.app-title-icon`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-title-icon svg`

- `inline-size`: **21px**
- `block-size`: **21px**
- `stroke`: **currentColor**

**`.evidence-library-subtitle`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-subtitle`

- `display`: **block**
- `max-width`: **68ch**

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



### D.2 PWA SOURCE-UNRESOLVED (15)

- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- `["ui-empty-state",` at `apps/web/components/ui/EmptyState.tsx:128` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `action` at `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `===` at `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"TRASH"` at `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `?` at `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-danger-action"` at `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `:` at `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-primary-action"` at `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:318` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (124 rules, 154 properties)

**`scopeRow`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`metricStrip`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`metricTile`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexGrow`: **1**
- `minWidth`: **22%**
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `borderRadius`: **8**  _(theme.radius.md)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `gap`: **2**

**`search`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_

**`filterRow`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`filterPanel`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_
- `gap`: **8**  _(theme.space.s2)_

**`bulkBar`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_
- `gap`: **8**  _(theme.space.s2)_

**`caseChooser`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_
- `gap`: **12**  _(theme.space.s3)_

**`caseChooserHeader`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexDirection`: **row**
- `alignItems`: **flex-start**
- `justifyContent`: **space-between**
- `gap`: **12**  _(theme.space.s3)_

**`caseChooserTitle`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flex`: **1**
- `gap`: **2**

**`caseList`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `gap`: **4**  _(theme.space.s1)_

**`smallChip`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **6**
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `minHeight`: **34**
- `justifyContent`: **center**

**`more`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `marginTop`: **16**  _(theme.space.s4)_

**`inspectorRail`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `marginTop`: **16**  _(theme.space.s4)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `borderRadius`: **12**  _(theme.radius.lg)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `maxHeight`: **720**
- `overflow`: **hidden**

**`inspectorModalBackdrop`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flex`: **1**
- `justifyContent`: **flex-end**
- `backgroundColor`: **rgba(0**

**`inspectorModal`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `maxHeight`: **90%**
- `backgroundColor`: **#F7F8FC**  _(theme.color.surface.app)_
- `borderTopLeftRadius`: **12**  _(theme.radius.lg)_
- `borderTopRightRadius`: **12**  _(theme.radius.lg)_
- `overflow`: **hidden**

**`inspectorScroll`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `padding`: **16**  _(theme.space.s4)_

**`inspector`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `gap`: **16**  _(theme.space.s4)_

**`inspectorHeader`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexDirection`: **row**
- `alignItems`: **flex-start**
- `justifyContent`: **space-between**
- `gap`: **12**  _(theme.space.s3)_

**`inspectorHeading`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flex`: **1**
- `gap`: **2**

**`inspectorBadgeRow`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_

**`inspectorMeta`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `gap`: **8**  _(theme.space.s2)_

**`inspectorMetaRow`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flexDirection`: **row**
- `justifyContent`: **space-between**
- `alignItems`: **flex-start**
- `gap`: **12**  _(theme.space.s3)_

**`inspectorMetaValue`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `flex`: **1**
- `textAlign`: **right**

**`inspectorBlock`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `gap`: **8**  _(theme.space.s2)_

**`inspectorImage`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `width`: **100%**
- `height`: **260**
- `borderRadius`: **8**  _(theme.radius.md)_
- `backgroundColor`: **#F1F4F9**  _(theme.color.surface.muted)_

**`previewNotice`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `gap`: **8**  _(theme.space.s2)_

**`inspectorFooter`** — `apps/mobile/app/(tabs)/evidence.tsx`

- `paddingTop`: **8**  _(theme.space.s2)_

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

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 19 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 371 |
| Native elements identified | 170 |
| Pairable PWA elements | 65 |
| Paired | 3 |
| Missing in Native | 38 |
| Extra in Native | 35 |
| Unlabelled (not pairable by label) | 7 |
| SOURCE-UNRESOLVED labels | 15 |
| PWA style properties resolved | 1274 |
| PWA style items SOURCE-UNRESOLVED | 15 |
| Native style properties resolved | 154 |
| PWA interactive elements | 73 |
| Native interactive elements | 50 |
| PWA conditional branches | 115 |
| Native conditional branches | 108 |
