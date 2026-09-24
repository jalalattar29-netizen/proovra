# /reports

**PWA entry:** `apps/web/app/(app)/reports/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/reports.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 15 | 2 |
| Elements | 242 | 59 |
| Interactive elements | 24 | 13 |
| Conditionally-rendered elements | 87 | 22 |
| Style rules resolved | 115 (377 props) | 60 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/reports/page.tsx` | 2 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/reports-experience/ReportsIndex.tsx` | 88 | `ReportsIndex` |
| 2 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell,PageHeader,PageSection` |
| 2 | `apps/web/components/contextual-help/ContextualHelp.tsx` | 10 | `ContextualHelp` |
| 2 | `apps/web/components/ui/Card.tsx` | 11 | `Card` |
| 2 | `apps/web/components/ui/FilterBar.tsx` | 16 | `FilterBar,FilterBar.Search` |
| 2 | `apps/web/components/governance/GovernedExportAction.tsx` | 16 | `GovernedExportAction` |
| 2 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 2 | `apps/web/components/ui/EmptyState.tsx` | 15 | `EmptyState` |
| 2 | `apps/web/components/access/AccessGate.tsx` | 2 | `AccessGate` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/reports.tsx` | 17 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraKpiGrid,ProovraFilterChips,ProovraAsyncView,ProovraEmpty,ProovraResultCount,ProovraCard,ProovraListRow,ProovraBadge,ProovraCursorPager,ProovraText` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 1 | 1 |
| BUTTON | 14 | 7 | -7 |
| CARD | 4 | 1 | -3 |
| CONTAINER | 56 | 22 | -34 |
| HEADING | 3 | 0 | -3 |
| ICON | 45 | 0 | -45 |
| INPUT | 2 | 1 | -1 |
| LINK | 5 | 0 | -5 |
| LIST | 6 | 2 | -4 |
| OTHER | 39 | 7 | -32 |
| STATE_EMPTY | 3 | 2 | -1 |
| STATE_ERROR | 5 | 0 | -5 |
| STATE_LOADING | 2 | 2 | 0 |
| TEXT | 58 | 14 | -44 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| STATE_EMPTY → BUTTON ⚠ | title | `apps/web/components/reports-experience/ReportsIndex.tsx:1398` | `apps/mobile/src/ui/index.tsx:453` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (14)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | Previous | `apps/web/components/reports-experience/ReportsIndex.tsx:750` |
| BUTTON | Next | `apps/web/components/reports-experience/ReportsIndex.tsx:763` |
| LINK | Case: {row.caseTitle ?? `#${row.caseId.slice(0, 6)}`} | `apps/web/components/reports-experience/ReportsIndex.tsx:863` |
| BUTTON | {busy === "report" ? "Opening…" : DOWNLOAD_REPORT_LABEL} | `apps/web/components/reports-experience/ReportsIndex.tsx:1122` |
| BUTTON | {busy === "package" ? "Opening…" : DOWNLOAD_PACKAGE_LABEL} | `apps/web/components/reports-experience/ReportsIndex.tsx:1172` |
| LINK | Open evidence | `apps/web/components/reports-experience/ReportsIndex.tsx:1245` |
| LINK | Open evidence | `apps/web/components/reports-experience/ReportsIndex.tsx:1404` |
| STATE_EMPTY | Reports & Artifacts couldn't load | `apps/web/components/reports-experience/ReportsIndex.tsx:1543` |
| BUTTON | Hide | `apps/web/components/contextual-help/ContextualHelp.tsx:197` |
| STATE_ERROR | headline | `apps/web/components/access/AccessGate.tsx:200` |

### C.3 EXTRA in Native (8)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/reports.tsx:133` |
| STATE_EMPTY | Deliverables are unavailable | `apps/mobile/app/(stack)/reports.tsx:163` |
| STATE_EMPTY | filter === "all" ? "No reports or packages yet" : "Nothing matches this filter" | `apps/mobile/app/(stack)/reports.tsx:168` |
| BUTTON | Clear filter | `apps/mobile/app/(stack)/reports.tsx:177` |
| BUTTON | Get | `apps/mobile/app/(stack)/reports.tsx:217` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (12)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/reports-experience/ReportsIndex.tsx:688` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/reports-experience/ReportsIndex.tsx:1223` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Card.tsx:250` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/FilterBar.tsx:124` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui/FilterBar.tsx:234` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui/FilterBar.tsx:356` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (115 rules, 377 properties)

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

**`.rpt-summary__grid`** — `apps/web/components/reports-experience/reports.css` · `.rpt-summary__grid`

- `display`: **grid**
- `grid-template-columns`: **repeat(auto-fill, minmax(196px, 1fr))**
- `grid-auto-rows`: **1fr**
- `gap`: **12px**
- `margin`: **0**
- `padding`: **0**
- `list-style`: **none**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card`

- `position`: **relative**
- `inline-size`: **100%**
- `block-size`: **100%**
- `min-inline-size`: **0**
- `display`: **flex**
- `flex-direction`: **column**
- `align-items`: **flex-start**
- `gap`: **2px**
- `padding`: **14px 14px 13px**
- `padding-inline-start`: **16px**
- `text-align`: **start**
- `font`: **inherit**
- `cursor`: **pointer**
- `background`: **rgba(255, 255, 255, 0.5)**
- `border`: **1px solid rgba(255, 255, 255, 0.6)**
- `border-radius`: **14px**
- `box-shadow`: **0 6px 18px rgba(15, 23, 42, 0.03)**
- `transition`: **border-color 140ms ease,     background-color 140ms ease,     box-shadow 140ms ease**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card::before`

- `content`: **""**
- `position`: **absolute**
- `inset-block`: **12px**
- `inset-inline-start`: **0**
- `inline-size`: **3px**
- `border-start-end-radius`: **3px**
- `border-end-end-radius`: **3px**
- `background`: **#667085**  _(--app-metric-tone→(fallback) var(--app-ink-secondary → --app-ink-secondary=#667085)_
- `opacity`: **0.85**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card:hover`

- `background`: **rgba(255, 255, 255, 0.72)**
- `border-color`: **rgba(15, 23, 42, 0.08)**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 6px 18px rgba(15, 23, 42, 0.03),     0 0 0 3px rgba(124, 58, 237, 0.28)**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[aria-pressed="true"]`

- `background`: **rgba(255, 255, 255, 0.9)**
- `border-color`: **rgba(109, 40, 217, 0.24)**
- `box-shadow`: **0 6px 18px rgba(109, 40, 217, 0.08)**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[aria-pressed="true"]::before`

- `opacity`: **1**
- `inset-block`: **8px**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card:not(button):not(a)`

- `cursor`: **default**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card:not(button):not(a):hover`

- `background`: **rgba(255, 255, 255, 0.5)**
- `border-color`: **rgba(255, 255, 255, 0.6)**

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[data-app-metric-tone="success"]`

- `--app-metric-tone`: **#15803D**  _(--success-standard=#15803D)_

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[data-app-metric-tone="warning"]`

- `--app-metric-tone`: **#EA580C**  _(--orange-500=#EA580C)_

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[data-app-metric-tone="danger"]`

- `--app-metric-tone`: **#DC2626**  _(--error=#DC2626)_

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[data-app-metric-tone="info"]`

- `--app-metric-tone`: **#2563EB**  _(--info=#2563EB)_

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[data-app-metric-tone="accent"]`

- `--app-metric-tone`: **#6D28D9**  _(--accent-600=#6D28D9)_

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card[data-app-metric-tone="neutral"]`

- `--app-metric-tone`: **#667085**  _(--app-ink-secondary=#667085)_

**`.app-metric-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > li > .app-metric-card`

- `height`: **100%**

**`.rpt-metric`** — `apps/web/components/reports-experience/reports.css` · `.rpt-metric`

- `position`: **relative**
- `padding`: **16px 16px 15px**
- `padding-inline-start`: **18px**
- `gap`: **4px**
- `cursor`: **default**

**`.rpt-metric`** — `apps/web/components/reports-experience/reports.css` · `.rpt-metric::before`

- `content`: **""**
- `position`: **absolute**
- `inset-block`: **12px**
- `inset-inline-start`: **0**
- `inline-size`: **3px**
- `border-radius`: **999px**  _(--radius-pill=999px)_
- `background`: **#475569**  _(--rpt-tone→(fallback) var(--tone-slate → --tone-slate=var(--ink-secondary) → --ink-secondary=#475569)_

**`.app-metric-card__value`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card__value`

- `font-size`: **26px**
- `font-weight`: **720**
- `letter-spacing`: **-0.02em**
- `line-height`: **1.1**
- `color`: **#172033**  _(--app-metric-tone→(fallback) var(--app-ink-heading → --app-ink-heading=#172033)_
- `font-variant-numeric`: **tabular-nums**

**`.rpt-metric__value`** — `apps/web/components/reports-experience/reports.css` · `.rpt-metric__value`

- `font-family`: **inherit**
- `font-size`: **28px**
- `font-weight`: **700**
- `letter-spacing`: **-0.02em**
- `line-height`: **1.1**
- `font-variant-numeric`: **tabular-nums**
- `color`: **#0F172A**  _(--rpt-tone→(fallback) var(--ink-primary → --ink-primary=#0F172A)_

**`.app-metric-card__label`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card__label`

- `font-size`: **12.5px**
- `font-weight`: **650**
- `line-height`: **1.3**
- `color`: **#344054**  _(--app-ink-label=#344054)_

**`.rpt-metric__label`** — `apps/web/components/reports-experience/reports.css` · `.rpt-metric__label`

- `font-family`: **inherit**
- `font-size`: **12.5px**
- `font-weight`: **600**
- `line-height`: **1.35**
- `color`: **#475569**  _(--ink-secondary=#475569)_

**`.cases-filter-chips`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-filter-chips`

- `display`: **flex**
- `gap`: **6px**
- `flex-wrap`: **wrap**

**`.rpt-list`** — `apps/web/components/reports-experience/reports.css` · `.rpt-list`

- `margin`: **0**
- `padding`: **0**
- `list-style`: **none**

**`.rpt-pagination`** — `apps/web/components/reports-experience/reports.css` · `.rpt-pagination`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **center**
- `justify-content`: **flex-end**
- `gap`: **10px**
- `margin-block-start`: **14px**

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



### D.2 PWA SOURCE-UNRESOLVED (11)

- `cc-section-note` at `apps/web/components/reports-experience/ReportsIndex.tsx:658` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``cases-filter-chip${active ? " is-active" : ""}`` at `apps/web/components/reports-experience/ReportsIndex.tsx:688` — className built from a runtime expression
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-card",` at `apps/web/components/ui/Card.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-filterbar",` at `apps/web/components/ui/FilterBar.tsx:100` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-empty-state",` at `apps/web/components/ui/EmptyState.tsx:128` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (60 rules, 72 properties)

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
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 242 |
| Native elements identified | 59 |
| Pairable PWA elements | 38 |
| Paired | 0 |
| Missing in Native | 14 |
| Extra in Native | 8 |
| Unlabelled (not pairable by label) | 11 |
| SOURCE-UNRESOLVED labels | 12 |
| PWA style properties resolved | 377 |
| PWA style items SOURCE-UNRESOLVED | 11 |
| Native style properties resolved | 72 |
| PWA interactive elements | 24 |
| Native interactive elements | 13 |
| PWA conditional branches | 87 |
| Native conditional branches | 22 |
