# /collaboration-teams

**PWA entry:** `apps/web/app/(app)/collaboration-teams/page.tsx`
**Native entry:** `apps/mobile/app/(tabs)/teams.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 13 | 2 |
| Elements | 307 | 62 |
| Interactive elements | 45 | 16 |
| Conditionally-rendered elements | 93 | 31 |
| Style rules resolved | 160 (622 props) | 61 (73 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/collaboration-teams/page.tsx` | 201 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/billing/PlanLimitBadge.tsx` | 5 | `PlanLimitBadge` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell` |
| 1 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 2 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 1 | `apps/web/components/app-primitives/AppStatusBadge.tsx` | 2 | `AppStatusBadge` |
| 1 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(tabs)/teams.tsx` | 20 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraShell,ProovraSection,ProovraListRow,ProovraCard,ProovraFormField,ProovraInput,ProovraFilterChips,ProovraButton,ProovraText,ProovraLoadingState,ProovraEmptyState,ProovraErrorState,ProovraBadge` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 3 | 1 | -2 |
| BUTTON | 13 | 8 | -5 |
| CARD | 0 | 2 | 2 |
| CONTAINER | 74 | 22 | -52 |
| DIALOG | 1 | 0 | -1 |
| FORM | 1 | 0 | -1 |
| HEADING | 6 | 0 | -6 |
| ICON | 60 | 0 | -60 |
| INPUT | 4 | 3 | -1 |
| LINK | 12 | 0 | -12 |
| LIST | 33 | 3 | -30 |
| OTHER | 24 | 3 | -21 |
| STATE_EMPTY | 1 | 2 | 1 |
| STATE_ERROR | 4 | 1 | -3 |
| STATE_LOADING | 2 | 3 | 1 |
| TEXT | 69 | 14 | -55 |

### C.1 Paired (3)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | {loading ? "Loading…" : "Load more"} | `apps/web/app/(app)/collaboration-teams/page.tsx:627` | `apps/mobile/app/(tabs)/teams.tsx:227` |
| BUTTON | Try again | `apps/web/app/(app)/collaboration-teams/page.tsx:1425` | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | Cancel | `apps/web/app/(app)/collaboration-teams/page.tsx:1606` | `apps/mobile/app/(tabs)/teams.tsx:176` |


### C.2 MISSING in Native (26)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Collaboration Teams | `apps/web/app/(app)/collaboration-teams/page.tsx:375` |
| LINK | Manage members &amp; access | `apps/web/app/(app)/collaboration-teams/page.tsx:388` |
| LINK | Upgrade plan | `apps/web/app/(app)/collaboration-teams/page.tsx:402` |
| BUTTON | createDisabledReason ?? undefined | `apps/web/app/(app)/collaboration-teams/page.tsx:428` |
| INPUT | Search teams… | `apps/web/app/(app)/collaboration-teams/page.tsx:783` |
| LINK | Open | `apps/web/app/(app)/collaboration-teams/page.tsx:954` |
| BUTTON | `More actions for ${teamName}` | `apps/web/app/(app)/collaboration-teams/page.tsx:1046` |
| LINK | Open team | `apps/web/app/(app)/collaboration-teams/page.tsx:1084` |
| LINK | Add people | `apps/web/app/(app)/collaboration-teams/page.tsx:1108` |
| LINK | Settings | `apps/web/app/(app)/collaboration-teams/page.tsx:1116` |
| LINK | Upgrade plan | `apps/web/app/(app)/collaboration-teams/page.tsx:1160` |
| LINK | Upgrade plan | `apps/web/app/(app)/collaboration-teams/page.tsx:1201` |
| LINK | Upgrade plan | `apps/web/app/(app)/collaboration-teams/page.tsx:1248` |
| BUTTON | Create team | `apps/web/app/(app)/collaboration-teams/page.tsx:1317` |
| BUTTON | Show all teams | `apps/web/app/(app)/collaboration-teams/page.tsx:1338` |
| HEADING | Couldn&apos;t load Teams | `apps/web/app/(app)/collaboration-teams/page.tsx:1403` |
| BADGE | Error | `apps/web/app/(app)/collaboration-teams/page.tsx:1404` |
| HEADING | Create a team | `apps/web/app/(app)/collaboration-teams/page.tsx:1514` |
| INPUT | e.g. Claim Investigations | `apps/web/app/(app)/collaboration-teams/page.tsx:1526` |
| INPUT | What does this team work on? | `apps/web/app/(app)/collaboration-teams/page.tsx:1541` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| LINK | Upgrade | `apps/web/components/billing/PlanLimitBadge.tsx:145` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |

### C.3 EXTRA in Native (11)

| Role | Label | Native source |
|---|---|---|
| INPUT | Group name | `apps/mobile/app/(tabs)/teams.tsx:152` |
| INPUT | What is this group for? | `apps/mobile/app/(tabs)/teams.tsx:153` |
| BUTTON | Create group | `apps/mobile/app/(tabs)/teams.tsx:170` |
| BUTTON | Create a group | `apps/mobile/app/(tabs)/teams.tsx:183` |
| STATE_LOADING | Loading collaboration groups | `apps/mobile/app/(tabs)/teams.tsx:196` |
| STATE_EMPTY | Collaboration isn’t available here | `apps/mobile/app/(tabs)/teams.tsx:198` |
| STATE_EMPTY | No collaboration groups yet | `apps/mobile/app/(tabs)/teams.tsx:205` |
| BADGE | role | `apps/mobile/app/(tabs)/teams.tsx:219` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |

### C.4 SOURCE-UNRESOLVED labels (7)

| Role | PWA source | Why unpairable |
|---|---|---|
| LINK | `apps/web/app/(app)/collaboration-teams/page.tsx:859` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (160 rules, 622 properties)

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

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > .app-kpi-card`

- `height`: **100%**

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > li`

- `min-width`: **0**

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > li > .app-metric-card`

- `height`: **100%**

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis`

- `display`: **grid**
- `grid-template-columns`: **repeat(4, minmax(0, 1fr))**
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



### D.2 PWA SOURCE-UNRESOLVED (12)

- `app-panel__hint` at `apps/web/app/(app)/collaboration-teams/page.tsx:579` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-table-footer` at `apps/web/app/(app)/collaboration-teams/page.tsx:626` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression
- ``app-status-badge${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusBadge.tsx:109` — className built from a runtime expression
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (61 rules, 73 properties)

**`more`** — `apps/mobile/app/(tabs)/teams.tsx`

- `marginTop`: **16**  _(theme.space.s4)_

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
| PWA files inspected (rendered tree) | 13 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 307 |
| Native elements identified | 62 |
| Pairable PWA elements | 46 |
| Paired | 3 |
| Missing in Native | 26 |
| Extra in Native | 11 |
| Unlabelled (not pairable by label) | 10 |
| SOURCE-UNRESOLVED labels | 7 |
| PWA style properties resolved | 622 |
| PWA style items SOURCE-UNRESOLVED | 12 |
| Native style properties resolved | 73 |
| PWA interactive elements | 45 |
| Native interactive elements | 16 |
| PWA conditional branches | 93 |
| Native conditional branches | 31 |
