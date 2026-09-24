# /cases

**PWA entry:** `apps/web/app/(app)/cases/page.tsx`
**Native entry:** `apps/mobile/app/(tabs)/cases.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 19 | 2 |
| Elements | 300 | 64 |
| Interactive elements | 48 | 15 |
| Conditionally-rendered elements | 103 | 33 |
| Style rules resolved | 137 (522 props) | 67 (84 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/cases/page.tsx` | 2 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/cases-experience/CasesIndex.tsx` | 146 | `CasesIndex` |
| 2 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell,PageSection,PageHeader` |
| 2 | `apps/web/lib/platform-context/CapabilityDegradedPanel.tsx` | 2 | `CapabilityDegradedPanel` |
| 2 | `apps/web/components/ui/Badge.tsx` | 2 | `Badge` |
| 2 | `apps/web/components/contextual-help/ContextualHelp.tsx` | 10 | `ContextualHelp` |
| 2 | `apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx` | 12 | `CreateCaseModal` |
| 3 | `apps/web/components/cases-experience/matter-modals/Modal.tsx` | 9 | `Modal` |
| 3 | `apps/web/lib/platform-context/WorkspaceContextBanner.tsx` | 5 | `WorkspaceContextBanner` |
| 3 | `apps/web/components/access/AccessGate.tsx` | 2 | `AccessGate` |
| 2 | `apps/web/components/ui/FilterBar.tsx` | 16 | `FilterBar` |
| 2 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 2 | `apps/web/components/ui/Card.tsx` | 11 | `Card` |
| 2 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(tabs)/cases.tsx` | 22 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraShell,ProovraSection,ProovraButton,ProovraKpiGrid,ProovraText,ProovraCard,ProovraFormField,ProovraInput,ProovraLoadingState,ProovraErrorState,ProovraEmptyState,ProovraListRow,ProovraBadge` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 4 | 1 | -3 |
| BUTTON | 24 | 8 | -16 |
| CARD | 1 | 2 | 1 |
| CONTAINER | 60 | 23 | -37 |
| DIALOG | 2 | 0 | -2 |
| FORM | 1 | 0 | -1 |
| HEADING | 4 | 0 | -4 |
| ICON | 53 | 0 | -53 |
| INPUT | 9 | 4 | -5 |
| LINK | 2 | 0 | -2 |
| LIST | 5 | 2 | -3 |
| OTHER | 40 | 3 | -37 |
| STATE_EMPTY | 0 | 2 | 2 |
| STATE_ERROR | 6 | 1 | -5 |
| STATE_LOADING | 3 | 3 | 0 |
| TEXT | 86 | 15 | -71 |

### C.1 Paired (4)

| Role | Label | PWA | Native |
|---|---|---|---|
| BADGE → STATE_LOADING ⚠ | {envelope.total} {envelope.total === 1 ? "case" : "cases"} | `apps/web/components/cases-experience/CasesIndex.tsx:396` | `apps/mobile/app/(tabs)/cases.tsx:175` |
| BUTTON | Create case | `apps/web/components/cases-experience/CasesIndex.tsx:906` | `apps/mobile/app/(tabs)/cases.tsx:143` |
| BUTTON | Cancel | `apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx:145` | `apps/mobile/app/(tabs)/cases.tsx:122` |
| INPUT | Search cases, owners, IDs, or references… | `apps/web/components/cases-experience/CasesIndex.tsx:647` | `apps/mobile/app/(tabs)/cases.tsx:150` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (23)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | Clear filters | `apps/web/components/cases-experience/CasesIndex.tsx:925` |
| INPUT | Select all cases in view | `apps/web/components/cases-experience/CasesIndex.tsx:1019` |
| INPUT | Reason (optional, recorded in the audit trail) | `apps/web/components/cases-experience/CasesIndex.tsx:1046` |
| BUTTON | Clear | `apps/web/components/cases-experience/CasesIndex.tsx:1066` |
| INPUT | `Select case ${row.name}` | `apps/web/components/cases-experience/CasesIndex.tsx:1156` |
| BUTTON | Case actions | `apps/web/components/cases-experience/CasesIndex.tsx:1521` |
| BUTTON | Open | `apps/web/components/cases-experience/CasesIndex.tsx:1546` |
| BUTTON | Rename | `apps/web/components/cases-experience/CasesIndex.tsx:1549` |
| BUTTON | Change status | `apps/web/components/cases-experience/CasesIndex.tsx:1552` |
| BUTTON | Archive | `apps/web/components/cases-experience/CasesIndex.tsx:1555` |
| BUTTON | Delete | `apps/web/components/cases-experience/CasesIndex.tsx:1565` |
| BADGE | Risk: {level} {typeof score === "number" ? ` · ${score}` : ""} | `apps/web/components/cases-experience/CasesIndex.tsx:1611` |
| BUTTON | Retry | `apps/web/components/cases-experience/CasesIndex.tsx:1843` |
| STATE_ERROR | `Not available in ${workspaceLabel}` | `apps/web/lib/platform-context/CapabilityDegradedPanel.tsx:82` |
| BUTTON | Hide | `apps/web/components/contextual-help/ContextualHelp.tsx:197` |
| DIALOG | Create case | `apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx:137` |
| BUTTON | {submitting ? "Creating…" : "Create case"} | `apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx:168` |
| BUTTON | Close | `apps/web/components/cases-experience/matter-modals/Modal.tsx:223` |
| STATE_ERROR | headline | `apps/web/components/access/AccessGate.tsx:200` |

### C.3 EXTRA in Native (10)

| Role | Label | Native source |
|---|---|---|
| INPUT | Case name | `apps/mobile/app/(tabs)/cases.tsx:140` |
| INPUT | e.g. Site inspection — Unit 4 | `apps/mobile/app/(tabs)/cases.tsx:141` |
| STATE_EMPTY | No cases yet | `apps/mobile/app/(tabs)/cases.tsx:179` |
| BUTTON | + New case | `apps/mobile/app/(tabs)/cases.tsx:179` |
| STATE_EMPTY | No matches | `apps/mobile/app/(tabs)/cases.tsx:181` |
| BADGE | caseStatusDisplay(c.status).label | `apps/mobile/app/(tabs)/cases.tsx:190` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (19)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/CasesIndex.tsx:613` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/cases-experience/CasesIndex.tsx:667` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/cases-experience/CasesIndex.tsx:1033` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/CasesIndex.tsx:1056` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/cases-experience/CasesIndex.tsx:1200` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/components/cases-experience/CasesIndex.tsx:1230` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/components/cases-experience/CasesIndex.tsx:1279` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx:199` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/matter-modals/Modal.tsx:219` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/FilterBar.tsx:124` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui/FilterBar.tsx:234` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui/FilterBar.tsx:356` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Card.tsx:250` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (137 rules, 522 properties)

**`.cases-page-heading`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-page-heading .cc-title`

- `font-size`: **30px**
- `line-height`: **1.15**
- `font-weight`: **720**
- `letter-spacing`: **-0.025em**
- `color`: **#172033**
- `margin`: **0**

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

**`.cc-title`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-page-heading .cc-title`

- `font-size`: **30px**
- `line-height`: **1.15**
- `font-weight`: **720**
- `letter-spacing`: **-0.025em**
- `color`: **#172033**
- `margin`: **0**

**`.app-header-primary-action`** — `apps/web/app/(app)/evidence/evidence-library.css` · `.evidence-library-header .app-header-primary-action` _[@media (max-width: 720px)]_

- `flex`: **1 0 100%**
- `justify-content`: **center**

**`.app-header-primary-action`** — `apps/web/components/app-shell-v2/app-shell-v2.css` · `.app-header-primary-action`

- `height`: **36px**
- `display`: **inline-flex**
- `align-items`: **center**
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
- `transition`: **filter 120ms ease, box-shadow 120ms ease**

**`.app-header-primary-action`** — `apps/web/components/app-shell-v2/app-shell-v2.css` · `.app-header-primary-action:hover:not(:disabled)`

- `filter`: **brightness(1.05)**
- `box-shadow`: **0 2px 8px rgba(109, 40, 217, 0.32)**

**`.app-header-primary-action`** — `apps/web/components/app-shell-v2/app-shell-v2.css` · `.app-header-primary-action:disabled`

- `opacity`: **0.55**
- `cursor`: **not-allowed**
- `filter`: **none**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.12)**

**`.app-header-primary-action`** — `apps/web/components/app-shell-v2/app-shell-v2.css` · `.app-header-primary-action svg`

- `flex`: **0 0 auto**

**`.app-header-primary-action`** — `apps/web/components/app-shell-v2/app-shell-v2.css` · `.app-account-toolbar .app-header-zone-right .app-header-primary-action` _[@media (max-width: 980px)]_

- `display`: **none**

**`.cases-toolbar`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-toolbar`

- `display`: **flex**
- `align-items`: **center**
- `justify-content`: **space-between**
- `gap`: **16px**
- `flex-wrap`: **nowrap**

**`.cases-segments`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **6px**
- `padding`: **4px**
- `min-height`: **44px**
- `border-radius`: **14px**
- `border`: **1px solid rgba(15, 23, 42, 0.06)**
- `background`: **rgba(255, 255, 255, 0.42)**
- `flex`: **1 1 auto**
- `min-width`: **0**
- `max-width`: **max-content**
- `overflow-x`: **auto**
- `scrollbar-width`: **none**

**`.cases-segments`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip`

- `flex`: **none**

**`.cases-segments`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments::-webkit-scrollbar`

- `display`: **none**

**`.cases-segments`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip:hover`

- `background`: **rgba(15, 23, 42, 0.045)**
- `color`: **#172033**

**`.cases-segments`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip.is-active:hover`

- `background`: **#F2ECFE**
- `color`: **#6D28D9**

**`.cases-segments`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip.is-active`

- `background`: **#F2ECFE**
- `border-color`: **#D9C7FB**
- `color`: **#6D28D9**
- `box-shadow`: **0 3px 10px rgba(124, 58, 237, 0.08)**

**`.cases-toolbar-right`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-toolbar-right .cases-search-field` _[@media (max-width: 720px)]_

- `width`: **100%**

**`.cases-toolbar-right`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-toolbar-right`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **12px**
- `flex`: **0 0 auto**
- `justify-content`: **flex-end**
- `flex-wrap`: **wrap**

**`.cases-search-field`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-search-field`

- `position`: **relative**
- `display`: **inline-flex**
- `align-items`: **center**
- `flex`: **1 1 260px**
- `min-width`: **220px**
- `max-width`: **440px**

**`.cases-search-field`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-toolbar-right .cases-search-field` _[@media (max-width: 720px)]_

- `width`: **100%**

**`.cases-search-icon`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-search-icon`

- `position`: **absolute**
- `inset-inline-start`: **14px**
- `display`: **inline-flex**
- `color`: **#8793A6**
- `pointer-events`: **none**

**`.cases-filter-search`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-search`

- `flex`: **1**
- `width`: **100%**
- `min-width`: **200px**
- `height`: **42px**
- `padding-block`: **0**
- `padding-inline`: **38px 14px**
- `border`: **1px solid rgba(15, 23, 42, 0.08)**
- `border-radius`: **12px**
- `background`: **rgba(255, 255, 255, 0.68)**
- `font-size`: **14px**
- `color`: **#172033**
- `transition`: **border-color 160ms ease, box-shadow 160ms ease**

**`.cases-filter-search`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-search::placeholder`

- `color`: **#8793A6**

**`.cases-filter-search`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-search:focus`

- `outline`: **none**
- `border-color`: **#BEB4FF**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.12)**

**`.cases-filter-search`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-search:focus-visible`

- `outline`: **none**
- `border-color`: **#BEB4FF**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.12)**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip`

- `flex`: **none**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip:hover`

- `background`: **rgba(15, 23, 42, 0.045)**
- `color`: **#172033**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip.is-active:hover`

- `background`: **#F2ECFE**
- `color`: **#6D28D9**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-segments .cases-filter-chip.is-active`

- `background`: **#F2ECFE**
- `border-color`: **#D9C7FB**
- `color`: **#6D28D9**
- `box-shadow`: **0 3px 10px rgba(124, 58, 237, 0.08)**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-chip`

- `display`: **inline-flex**
- `align-items`: **center**
- `gap`: **7px**
- `height`: **40px**
- `padding`: **0 16px**
- `border`: **1px solid transparent**
- `background`: **transparent**
- `border-radius`: **12px**
- `font-size`: **13.5px**
- `font-weight`: **600**
- `line-height`: **1**
- `cursor`: **pointer**
- `color`: **#5F6878**
- `transition`: **background-color 160ms ease, border-color 160ms ease,     color 160ms ease, box-shadow 160ms ease**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-chip:hover`

- `background`: **rgba(15, 23, 42, 0.045)**
- `color`: **#172033**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-chip.is-active`

- `background`: **#F2ECFE**
- `border-color`: **#D9C7FB**
- `color`: **#6D28D9**
- `box-shadow`: **0 4px 12px rgba(124, 58, 237, 0.10)**

**`.cases-filter-chip`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-chip:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.16)**

**`.cases-empty`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-empty`

- `background`: **rgba(255, 255, 255, 0.5)**
- `border`: **1px solid rgba(15, 23, 42, 0.06)**
- `border-radius`: **14px**
- `padding`: **32px 24px**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **8px**
- `align-items`: **center**
- `text-align`: **center**
- `color`: **#475569**

**`.cases-empty`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-empty strong`

- `color`: **#172033**
- `font-size`: **15px**
- `font-weight`: **700**

**`.cases-empty`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-empty p`

- `margin`: **0**
- `font-size`: **13px**
- `max-width`: **42ch**

**`.cases-panel`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-panel`

- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**



### D.2 PWA SOURCE-UNRESOLVED (24)

- `cc-subtitle` at `apps/web/components/cases-experience/CasesIndex.tsx:389` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-meta` at `apps/web/components/cases-experience/CasesIndex.tsx:395` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-muted` at `apps/web/components/cases-experience/CasesIndex.tsx:407` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `statusSegmentClass(active)` at `apps/web/components/cases-experience/CasesIndex.tsx:613` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-table` at `apps/web/components/cases-experience/CasesIndex.tsx:940` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-th-actions` at `apps/web/components/cases-experience/CasesIndex.tsx:962` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-bulk-bar` at `apps/web/components/cases-experience/CasesIndex.tsx:1017` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-bulk-selectall` at `apps/web/components/cases-experience/CasesIndex.tsx:1018` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-row-select` at `apps/web/components/cases-experience/CasesIndex.tsx:1151` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-row-bulk-note` at `apps/web/components/cases-experience/CasesIndex.tsx:1166` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-kicker` at `apps/web/components/cases-experience/CasesIndex.tsx:1780` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-skeleton` at `apps/web/components/cases-experience/CasesIndex.tsx:1787` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-badge",` at `apps/web/components/ui/Badge.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `create-case-context-banner` at `apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx:182` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className` at `apps/web/lib/platform-context/WorkspaceContextBanner.tsx:63` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-filterbar",` at `apps/web/components/ui/FilterBar.tsx:100` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression
- `["ui-card",` at `apps/web/components/ui/Card.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (67 rules, 84 properties)

**`createCard`** — `apps/mobile/app/(tabs)/cases.tsx`

- `marginBottom`: **16**  _(theme.space.s4)_

**`search`** — `apps/mobile/app/(tabs)/cases.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_

**`filterRow`** — `apps/mobile/app/(tabs)/cases.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`filterChip`** — `apps/mobile/app/(tabs)/cases.tsx`

- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `minHeight`: **36**
- `justifyContent`: **center**

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
| PWA files inspected (rendered tree) | 19 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 300 |
| Native elements identified | 64 |
| Pairable PWA elements | 55 |
| Paired | 2 |
| Missing in Native | 23 |
| Extra in Native | 10 |
| Unlabelled (not pairable by label) | 9 |
| SOURCE-UNRESOLVED labels | 19 |
| PWA style properties resolved | 522 |
| PWA style items SOURCE-UNRESOLVED | 24 |
| Native style properties resolved | 84 |
| PWA interactive elements | 48 |
| Native interactive elements | 15 |
| PWA conditional branches | 103 |
| Native conditional branches | 33 |
