# /operations/batch-analysis

**PWA entry:** `apps/web/app/(app)/operations/batch-analysis/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/operations/batch-analysis.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 10 | 2 |
| Elements | 202 | 84 |
| Interactive elements | 24 | 23 |
| Conditionally-rendered elements | 88 | 34 |
| Style rules resolved | 38 (117 props) | 66 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/operations/batch-analysis/page.tsx` | 74 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/dashboard/DashboardShell.tsx` | 13 | `DashboardShell` |
| 1 | `apps/web/components/ui-legacy.tsx` | 27 | `Button,Card,Skeleton,EmptyState` |
| 2 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 3 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/operations/batch-analysis.tsx` | 42 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraText,ProovraBadge,ProovraButton,ProovraScreen,ProovraPageHeader,ProovraLoadingState,ProovraErrorState,ProovraEmpty,ProovraResultCount,ProovraCard,ProovraSheet,ProovraFormField,ProovraInput,ProovraListRow,ProovraConfirmSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 2 | 2 |
| BUTTON | 12 | 10 | -2 |
| CARD | 5 | 1 | -4 |
| CONTAINER | 75 | 28 | -47 |
| DIALOG | 0 | 2 | 2 |
| FORM | 1 | 0 | -1 |
| HEADING | 5 | 0 | -5 |
| ICON | 54 | 0 | -54 |
| IMAGE | 4 | 0 | -4 |
| INPUT | 5 | 7 | 2 |
| LINK | 2 | 0 | -2 |
| LIST | 0 | 2 | 2 |
| OTHER | 13 | 4 | -9 |
| STATE_EMPTY | 1 | 2 | 1 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 1 | 4 | 3 |
| TEXT | 21 | 21 | 0 |

### C.1 Paired (5)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | + New Batch Job | `apps/web/app/(app)/operations/batch-analysis/page.tsx:211` | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:317` |
| STATE_EMPTY | No Batch Jobs | `apps/web/app/(app)/operations/batch-analysis/page.tsx:600` | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:346` |
| BUTTON | Export CSV | `apps/web/app/(app)/operations/batch-analysis/page.tsx:743` | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:149` |
| INPUT | Add notes about this batch | `apps/web/app/(app)/operations/batch-analysis/page.tsx:479` | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:396` |
| BUTTON | Cancel | `apps/web/app/(app)/operations/batch-analysis/page.tsx:516` | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:163` |


### C.2 MISSING in Native (10)

| Role | Label | PWA source |
|---|---|---|
| INPUT | e.g., Q1 2026 Review | `apps/web/app/(app)/operations/batch-analysis/page.tsx:459` |
| INPUT | "e.g.\nabc-123\ndef-456\nghi-789" | `apps/web/app/(app)/operations/batch-analysis/page.tsx:499` |
| BUTTON | Create & Start Batch | `apps/web/app/(app)/operations/batch-analysis/page.tsx:509` |
| BUTTON | Cancel | `apps/web/app/(app)/operations/batch-analysis/page.tsx:754` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |

### C.3 EXTRA in Native (16)

| Role | Label | Native source |
|---|---|---|
| BADGE | batchStatusLabel(job.status) | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:115` |
| BUTTON | Back | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:324` |
| STATE_LOADING | Loading jobs | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:339` |
| BUTTON | New batch job | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:350` |
| INPUT | Name | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:385` |
| INPUT | What this batch is for | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:386` |
| INPUT | Description (optional) | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:395` |
| INPUT | Records | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:406` |
| INPUT | Search your evidence | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:407` |
| STATE_LOADING | Loading your evidence | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:423` |
| STATE_EMPTY | No records match that. | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:425` |
| BADGE | Chosen | `apps/mobile/app/(stack)/operations/batch-analysis.tsx:435` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (12)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/(app)/operations/batch-analysis/page.tsx:629` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/dashboard/DashboardShell.tsx:32` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (38 rules, 117 properties)

**`.section`** — `apps/web/app/globals.css` · `.section`

- `padding`: **120px 0 160px**

**`.section`** — `apps/web/app/globals.css` · `html[dir="rtl"] .section`

- `direction`: **rtl**
- `text-align`: **right**

**`.app-section`** — `apps/web/app/globals.css` · `.app-section`

- `padding`: **0**
- `flex`: **1**
- `display`: **flex**
- `flex-direction`: **column**

**`.app-hero`** — `apps/web/app/globals.css` · `.app-hero`

- `position`: **relative**
- `z-index`: **1**

**`.app-hero`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .card:first-child`

- `margin-top`: **8px**

**`.app-hero`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .grid-2:first-child`

- `position`: **relative**

**`.app-hero`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > div:first-child`

- `position`: **relative**

**`.app-hero-full`** — `apps/web/app/globals.css` · `.app-hero-full`

- `padding-top`: **52px**
- `padding-bottom`: **34px**

**`.container`** — `apps/web/app/globals.css` · `.container`

- `max-width`: **1180px**  _(--container-max=1180px)_
- `margin`: **0 auto**
- `width`: **100%**
- `padding`: **0 16px**  _(--container-gutter=16px)_

**`.container`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .card:first-child`

- `margin-top`: **8px**

**`.container`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .grid-2:first-child`

- `position`: **relative**

**`.container`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > div:first-child`

- `position`: **relative**

**`.page-title`** — `apps/web/app/globals.css` · `.page-title`

- `display`: **flex**
- `align-items`: **flex-start**
- `justify-content`: **space-between**
- `gap`: **24px**
- `flex-wrap`: **wrap**
- `margin-bottom`: **0**

**`.page-title`** — `apps/web/app/globals.css` · `.page-title > div:first-child`

- `min-width`: **0**

**`.app-page-title`** — `apps/web/app/globals.css` · `.app-page-title` _[@media (max-width: 900px)]_

- `flex-direction`: **column**
- `align-items`: **stretch**

**`.app-page-title`** — `apps/web/app/globals.css` · `.app-page-title > div:first-child`

- `min-width`: **0**

**`.app-body`** — `apps/web/app/globals.css` · `.app-body`

- `position`: **relative**
- `z-index`: **1**

**`.app-body`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .card:first-child`

- `margin-top`: **8px**

**`.app-body`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .grid-2:first-child`

- `position`: **relative**

**`.app-body`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > div:first-child`

- `position`: **relative**

**`.app-body-full`** — `apps/web/app/globals.css` · `.app-body-full`

- `padding-top`: **10px**
- `padding-bottom`: **72px**

**`.toast-container`** — `apps/web/app/globals.css` · `.toast-container`

- `position`: **fixed**
- `top`: **20px**
- `right`: **20px**
- `z-index`: **9999**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **10px**
- `width`: **380px**
- `max-width`: **calc(100vw - 40px)**
- `pointer-events`: **none**

**`.toast-container`** — `apps/web/app/globals.css` · `.toast-container > *`

- `animation`: **pf-toast-in 0.28s cubic-bezier(0.16, 1, 0.3, 1)**

**`.modal-overlay`** — `apps/web/app/globals.css` · `.modal-overlay`

- `position`: **fixed**
- `inset`: **0**
- `background`: **rgba(0, 0, 0, 0.7)**
- `z-index`: **9998**
- `animation`: **fadeIn 0.2s ease-out**
- `backdrop-filter`: **blur(2px)**

**`.modal-content`** — `apps/web/app/globals.css` · `.modal-content`

- `position`: **fixed**
- `top`: **50%**
- `left`: **50%**
- `transform`: **translate(-50%, -50%)**
- `background`: **linear-gradient(135deg, #102126 0%, #1b3136 100%)**
- `border`: **1px solid rgba(158, 216, 207, 0.2)**
- `border-radius`: **12px**
- `box-shadow`: **0 0 30px rgba(158, 216, 207, 0.1), 0 20px 60px rgba(0, 0, 0, 0.4)**
- `z-index`: **9999**
- `max-width`: **500px**
- `width`: **90%**
- `max-height`: **90vh**
- `overflow-y`: **auto**
- `animation`: **slideUp 0.3s ease-out**

**`.modal-header`** — `apps/web/app/globals.css` · `.modal-header`

- `padding`: **24px**

**`.modal-header`** — `apps/web/app/globals.css` · `.modal-header h2`

- `margin`: **0**
- `font-size`: **20px**
- `font-weight`: **600**
- `color`: **#e2e8f0**

**`.modal-close`** — `apps/web/app/globals.css` · `.modal-close`

- `border`: **0**
- `background`: **transparent**
- `color`: **#e2e8f0**
- `font-size`: **24px**
- `line-height`: **1**
- `cursor`: **pointer**

**`.modal-body`** — `apps/web/app/globals.css` · `.modal-body`

- `padding`: **24px**

**`.modal-footer`** — `apps/web/app/globals.css` · `.modal-footer`

- `padding`: **24px**

**`.skeleton`** — `apps/web/app/globals.css` · `.skeleton`

- `background-color`: **#e2e8f0**
- `border-radius`: **8px**
- `animation`: **pulse 1.6s ease-in-out infinite**

**`.empty-state-container`** — `apps/web/app/globals.css` · `.empty-state-container`

- `display`: **flex**
- `flex-direction`: **column**
- `align-items`: **center**
- `justify-content`: **center**
- `padding`: **60px 24px**
- `text-align`: **center**
- `gap`: **16px**

**`.empty-state-icon`** — `apps/web/app/globals.css` · `.empty-state-icon`

- `width`: **64px**
- `height`: **64px**
- `background`: **#f0f4f8**
- `border-radius`: **12px**
- `display`: **flex**
- `align-items`: **center**
- `justify-content`: **center**
- `color`: **#64748b**
- `font-size`: **32px**

**`.empty-state-title`** — `apps/web/app/globals.css` · `.empty-state-title`

- `margin`: **0**
- `font-size`: **18px**
- `font-weight`: **600**
- `color`: **#0f1d36**

**`.empty-state-subtitle`** — `apps/web/app/globals.css` · `.empty-state-subtitle`

- `margin`: **0**
- `color`: **#64748b**
- `font-size`: **14px**

**`.empty-state-button`** — `apps/web/app/globals.css` · `.empty-state-button`

- `margin-top`: **8px**

**`.input-error`** — `apps/web/app/globals.css` · `.input-error`

- `color`: **#d64545**
- `font-size`: **12px**
- `margin-top`: **4px**

**`.select-label`** — `apps/web/app/globals.css` · `.select-label`

- `display`: **block**
- `margin-bottom`: **6px**
- `font-size`: **14px**
- `font-weight`: **500**
- `color`: **#0f1d36**


**Stock Tailwind utilities used (16).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.rounded-[999px]` → {"kind":"border-radius"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-3` → {"kind":"padding","side":"y","value":"12px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.rounded-[30px]` → {"kind":"border-radius"}
- `.p-0` → {"kind":"padding","side":"all","value":"0px"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.h-full` → {"kind":"layout","value":"h-full"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.p-6` → {"kind":"padding","side":"all","value":"24px"}
- `.px-5` → {"kind":"padding","side":"x","value":"20px"}
- `.mt-5` → {"kind":"margin","side":"t","value":"20px"}
- `.font-medium` → {"kind":"font-weight","value":500}
- `.flex` → {"kind":"layout","value":"flex"}


### D.2 PWA SOURCE-UNRESOLVED (48)

- `dashboard-batch-responsive-btn` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.95rem]` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-page` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:432` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-transparent` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:434` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shadow-none` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:434` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:438` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-cover` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:439` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-center` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:439` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `scale-[1.12]` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:439` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:445` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:446` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:p-7` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:446` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-form-grid` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:447` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-field` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:459` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-mono` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:499` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-form-actions` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:508` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.92rem]` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:509` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-metrics-grid` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:531` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-card-metric-value` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:563` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-card-metric-sub` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:569` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-job-list` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:609` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-job-card-inner` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:626` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-job-header` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:627` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-job-header-main` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:628` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-job-title` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:629` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-job-date` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:630` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-job-status` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:635` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-progress-row` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:651` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `dashboard-batch-stats-grid` at `apps/web/app/(app)/operations/batch-analysis/page.tsx:670` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (66 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 10 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 202 |
| Native elements identified | 84 |
| Pairable PWA elements | 38 |
| Paired | 3 |
| Missing in Native | 10 |
| Extra in Native | 16 |
| Unlabelled (not pairable by label) | 11 |
| SOURCE-UNRESOLVED labels | 12 |
| PWA style properties resolved | 117 |
| PWA style items SOURCE-UNRESOLVED | 48 |
| Native style properties resolved | 72 |
| PWA interactive elements | 24 |
| Native interactive elements | 23 |
| PWA conditional branches | 88 |
| Native conditional branches | 34 |
