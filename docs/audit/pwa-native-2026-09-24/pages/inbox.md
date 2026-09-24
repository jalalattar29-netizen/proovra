# /inbox

**PWA entry:** `apps/web/app/(app)/inbox/page.tsx`
**Native entry:** `apps/mobile/app/(tabs)/notifications.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 12 | 2 |
| Elements | 220 | 64 |
| Interactive elements | 30 | 17 |
| Conditionally-rendered elements | 129 | 30 |
| Style rules resolved | 147 (575 props) | 67 (81 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/inbox/page.tsx` | 96 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell,PageHeader` |
| 1 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 1 | `apps/web/components/ui/Card.tsx` | 11 | `Card` |
| 1 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/components/ui/EmptyState.tsx` | 15 | `EmptyState` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(tabs)/notifications.tsx` | 22 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraShell,ProovraSection,ProovraButton,ProovraListRow,ProovraFilterChips,ProovraLoadingState,ProovraErrorState,ProovraEmptyState,ProovraCard,ProovraText,ProovraSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 22 | 10 | -12 |
| CARD | 2 | 1 | -1 |
| CONTAINER | 61 | 25 | -36 |
| DIALOG | 0 | 1 | 1 |
| HEADING | 6 | 0 | -6 |
| ICON | 46 | 0 | -46 |
| INPUT | 0 | 1 | 1 |
| LINK | 2 | 0 | -2 |
| LIST | 8 | 3 | -5 |
| OTHER | 16 | 3 | -13 |
| STATE_EMPTY | 1 | 1 | 0 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 1 | 3 | 2 |
| TEXT | 52 | 15 | -37 |

### C.1 Paired (2)

| Role | Label | PWA | Native |
|---|---|---|---|
| STATE_EMPTY | You're all caught up | `apps/web/app/(app)/inbox/page.tsx:1744` | `apps/mobile/app/(tabs)/notifications.tsx:181` |
| BUTTON | Mark as read | `apps/web/app/(app)/inbox/page.tsx:1981` | `apps/mobile/app/(tabs)/notifications.tsx:158` |


### C.2 MISSING in Native (22)

| Role | Label | PWA source |
|---|---|---|
| BUTTON | {state.kind === "loading" ? "Refreshing…" : "Refresh"} | `apps/web/app/(app)/inbox/page.tsx:1262` |
| BUTTON | impossible ? "Archived notifications are always marked read." : undefined | `apps/web/app/(app)/inbox/page.tsx:1328` |
| BUTTON | Filters {…} | `apps/web/app/(app)/inbox/page.tsx:1457` |
| HEADING | Status | `apps/web/app/(app)/inbox/page.tsx:1501` |
| BUTTON | Archived | `apps/web/app/(app)/inbox/page.tsx:1503` |
| HEADING | Workspace | `apps/web/app/(app)/inbox/page.tsx:1562` |
| BUTTON | Clear filters | `apps/web/app/(app)/inbox/page.tsx:1578` |
| BUTTON | Done | `apps/web/app/(app)/inbox/page.tsx:1587` |
| BUTTON | `Remove ${chip.label} filter` | `apps/web/app/(app)/inbox/page.tsx:1634` |
| BUTTON | Clear all | `apps/web/app/(app)/inbox/page.tsx:1648` |
| BUTTON | Retry | `apps/web/app/(app)/inbox/page.tsx:1728` |
| BUTTON | Clear filters | `apps/web/app/(app)/inbox/page.tsx:1799` |
| LINK | Open | `apps/web/app/(app)/inbox/page.tsx:1942` |
| BUTTON | Mark as unread | `apps/web/app/(app)/inbox/page.tsx:1968` |
| BUTTON | Unarchive | `apps/web/app/(app)/inbox/page.tsx:1998` |
| BUTTON | Archive | `apps/web/app/(app)/inbox/page.tsx:2012` |
| BUTTON | {loadingMore ? "Loading…" : "Load more"} | `apps/web/app/(app)/inbox/page.tsx:2047` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |

### C.3 EXTRA in Native (7)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Notifications | `apps/mobile/app/(tabs)/notifications.tsx:177` |
| BUTTON | Clear filter | `apps/mobile/app/(tabs)/notifications.tsx:190` |
| BUTTON | choice.label | `apps/mobile/app/(tabs)/notifications.tsx:258` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (10)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/app/(app)/inbox/page.tsx:1432` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/inbox/page.tsx:1524` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/inbox/page.tsx:1531` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Card.tsx:250` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (147 rules, 575 properties)

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

**`.ops-metrics`** — `apps/web/components/notifications/notifications.css` · `.ops-metrics`

- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **0.5rem**
- `min-inline-size`: **0**

**`.ops-metrics__grid`** — `apps/web/components/notifications/notifications.css` · `.ops-metrics__grid`

- `display`: **grid**
- `grid-template-columns`: **repeat(6, minmax(0, 1fr))**
- `gap`: **10px**
- `margin`: **0**
- `padding`: **0**
- `list-style`: **none**
- `min-inline-size`: **0**

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

**`.ops-metric`** — `apps/web/components/notifications/notifications.css` · `.ops-metric[data-ops-metric-tone="all"]`

- `--app-metric-tone`: **#0F172A**  _(--ink-primary=#0F172A)_

**`.ops-metric`** — `apps/web/components/notifications/notifications.css` · `.ops-metric[data-ops-metric-tone="unread"]`

- `--app-metric-tone`: **#2563EB**  _(--info=#2563EB)_

**`.ops-metric`** — `apps/web/components/notifications/notifications.css` · `.ops-metric[data-ops-metric-tone="critical"]`

- `--app-metric-tone`: **#DC2626**  _(--error=#DC2626)_

**`.ops-metric`** — `apps/web/components/notifications/notifications.css` · `.ops-metric[data-ops-metric-tone="high"]`

- `--app-metric-tone`: **#EA580C**  _(--orange-500=#EA580C)_

**`.ops-metric`** — `apps/web/components/notifications/notifications.css` · `.ops-metric[data-ops-metric-tone="warning"]`

- `--app-metric-tone`: **#6D28D9**  _(--accent-600=#6D28D9)_

**`.ops-metric`** — `apps/web/components/notifications/notifications.css` · `.ops-metric[data-ops-metric-tone="info"]`

- `--app-metric-tone`: **#475569**  _(--ink-secondary=#475569)_

**`.ops-metric`** — `apps/web/components/notifications/notifications.css` · `.ops-metric:disabled`

- `cursor`: **not-allowed**

**`.app-metric-card__value`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card__value`

- `font-size`: **26px**
- `font-weight`: **720**
- `letter-spacing`: **-0.02em**
- `line-height`: **1.1**
- `color`: **#172033**  _(--app-metric-tone→(fallback) var(--app-ink-heading → --app-ink-heading=#172033)_
- `font-variant-numeric`: **tabular-nums**

**`.app-metric-card__label`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card__label`

- `font-size`: **12.5px**
- `font-weight`: **650**
- `line-height`: **1.3**
- `color`: **#344054**  _(--app-ink-label=#344054)_

**`.app-metric-card__meta`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-metric-card__meta`

- `margin-block-start`: **2px**
- `font-size`: **11.5px**
- `line-height`: **1.35**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.ops-metrics__note`** — `apps/web/components/notifications/notifications.css` · `.ops-metrics__note`

- `margin`: **0**
- `font`: **500 12.5px/1.4 -apple-system, "Segoe UI", system-ui**  _(--font-meta=500 12.5px/1.4 var(--font-sans, -apple-system, "Segoe UI", system-ui) → --font-sans→(fallback) -apple-system, "Segoe UI", system-ui)_
- `color`: **#94A3B8**  _(--ink-muted=#94A3B8)_

**`.ops-note`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ops-note`

- `padding`: **14px 16px !important**
- `border`: **1px solid var(--set-line) !important**  ⚠ undeclared --set-line
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background`: **var(--set-inset) !important**  ⚠ undeclared --set-inset
- `color`: **var(--set-ink-2) !important**  ⚠ undeclared --set-ink-2
- `font-size`: **0.84rem !important**
- `line-height`: **1.6 !important**



### D.2 PWA SOURCE-UNRESOLVED (11)

- `ops-item__open` at `apps/web/app/(app)/inbox/page.tsx:1942` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- `["ui-card",` at `apps/web/components/ui/Card.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-empty-state",` at `apps/web/components/ui/EmptyState.tsx:128` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (67 rules, 81 properties)

**`row`** — `apps/mobile/app/(tabs)/notifications.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_

**`rowBody`** — `apps/mobile/app/(tabs)/notifications.tsx`

- `flex`: **1**

**`dot`** — `apps/mobile/app/(tabs)/notifications.tsx`

- `width`: **8**
- `height`: **8**
- `borderRadius`: **4**
- `backgroundColor`: **#7C3AED**  _(theme.color.accent.a500)_

**`dotSpace`** — `apps/mobile/app/(tabs)/notifications.tsx`

- `width`: **8**

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
| PWA files inspected (rendered tree) | 12 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 220 |
| Native elements identified | 64 |
| Pairable PWA elements | 37 |
| Paired | 0 |
| Missing in Native | 22 |
| Extra in Native | 7 |
| Unlabelled (not pairable by label) | 3 |
| SOURCE-UNRESOLVED labels | 10 |
| PWA style properties resolved | 575 |
| PWA style items SOURCE-UNRESOLVED | 11 |
| Native style properties resolved | 81 |
| PWA interactive elements | 30 |
| Native interactive elements | 17 |
| PWA conditional branches | 129 |
| Native conditional branches | 30 |
