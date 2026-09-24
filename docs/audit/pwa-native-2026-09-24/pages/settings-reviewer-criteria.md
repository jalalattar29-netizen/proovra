# /settings/reviewer-criteria

**PWA entry:** `apps/web/app/(app)/settings/reviewer-criteria/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 3 |
| Elements | 156 | 111 |
| Interactive elements | 32 | 40 |
| Conditionally-rendered elements | 73 | 64 |
| Style rules resolved | 33 (119 props) | 67 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx` | 94 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx` | 35 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraLoadingState,ProovraEmpty,ProovraErrorState,ProovraCard,ProovraText,ProovraBadge,ProovraSheet,ProovraFormField,ProovraInput,ProovraConfirmSheet` |
| 1 | `apps/mobile/src/ui/criteria-draft-editor.tsx` | 34 | `CriteriaDraftEditor,CriterionRowsEditor` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 1 | 1 |
| BUTTON | 18 | 17 | -1 |
| CARD | 0 | 3 | 3 |
| CONTAINER | 37 | 29 | -8 |
| DIALOG | 0 | 2 | 2 |
| HEADING | 2 | 0 | -2 |
| ICON | 38 | 0 | -38 |
| INPUT | 11 | 16 | 5 |
| LINK | 1 | 0 | -1 |
| LIST | 7 | 1 | -6 |
| OTHER | 12 | 5 | -7 |
| STATE_EMPTY | 0 | 2 | 2 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 0 | 5 | 5 |
| TEXT | 27 | 29 | 2 |

### C.1 Paired (7)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | {showCreate ? "Close" : "New criteria set"} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:84` | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:196` |
| BUTTON | {editId === s.id ? "Close editor" : "Edit draft"} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:113` | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:294` |
| BUTTON | Save as new draft | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:438` | `apps/mobile/src/ui/criteria-draft-editor.tsx:331` |
| INPUT | key | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:454` | `apps/mobile/src/ui/criteria-draft-editor.tsx:103` |
| INPUT | What the reviewer should inspect | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:455` | `apps/mobile/src/ui/criteria-draft-editor.tsx:113` |
| INPUT | required | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:457` | `apps/mobile/src/ui/criteria-draft-editor.tsx:142` |
| BUTTON | Add criterion | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:463` | `apps/mobile/src/ui/criteria-draft-editor.tsx:151` |


### C.2 MISSING in Native (18)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Reviewer Criteria | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:83` |
| BUTTON | Publish v {s.versions[0]?.version ?? 1} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:116` |
| BUTTON | Duplicate as v {(s.versions[0]?.version ?? 1) + 1} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:122` |
| BUTTON | Retire | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:127` |
| BUTTON | {historyId === s.id ? "Hide history" : "History"} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:131` |
| BUTTON | Reload latest version | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:433` |
| BUTTON | {showCompare ? "Hide comparison" : "Compare changes"} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:434` |
| BUTTON | Overwrite with my changes | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:440` |
| BUTTON | {busy ? "Saving…" : "Save draft"} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:464` |
| INPUT | key | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:514` |
| INPUT | What the reviewer should inspect | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:515` |
| INPUT | required | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:517` |
| BUTTON | Add criterion | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:523` |
| BUTTON | {busy ? "Creating…" : "Create draft"} | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:524` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |

### C.3 EXTRA in Native (27)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:204` |
| STATE_LOADING | Resolving workspace | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:208` |
| STATE_LOADING | Loading criteria | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:209` |
| STATE_EMPTY | Reviewer criteria are part of reviewer workflows | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:214` |
| STATE_EMPTY | No criteria sets yet | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:226` |
| BUTTON | New criteria set | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:230` |
| BADGE | criteriaStatusLabel(set.status) | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:257` |
| BUTTON | criteriaActionLabel(action) | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:277` |
| BUTTON | usage[set.id] ? "Hide usage" : "Version usage" | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:314` |
| INPUT | Set name | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:371` |
| INPUT | e.g. Insurance intake review | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:372` |
| INPUT | Description (optional) | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:381` |
| INPUT | What this set is for | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:382` |
| INPUT | Version title | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:392` |
| INPUT | e.g. Baseline v1 | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx:393` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | Remove | `apps/mobile/src/ui/criteria-draft-editor.tsx:92` |
| INPUT | short-stable-identifier | `apps/mobile/src/ui/criteria-draft-editor.tsx:104` |
| INPUT | Title | `apps/mobile/src/ui/criteria-draft-editor.tsx:112` |
| INPUT | Review guidance (optional) | `apps/mobile/src/ui/criteria-draft-editor.tsx:122` |
| INPUT | How a reviewer should judge this | `apps/mobile/src/ui/criteria-draft-editor.tsx:123` |
| STATE_LOADING | Loading draft | `apps/mobile/src/ui/criteria-draft-editor.tsx:297` |
| INPUT | Version title | `apps/mobile/src/ui/criteria-draft-editor.tsx:365` |
| INPUT | What this version of the criteria is | `apps/mobile/src/ui/criteria-draft-editor.tsx:366` |

### C.4 SOURCE-UNRESOLVED labels (8)

| Role | PWA source | Why unpairable |
|---|---|---|
| INPUT | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:199` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:203` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:451` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:510` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:511` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (33 rules, 119 properties)

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

**`.app-alert`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-alert`

- `padding`: **12px**
- `border`: **1px solid rgba(15, 23, 42, 0.08)**
- `border-radius`: **12px**  _(--radius-lg=12px)_
- `background`: **rgba(255, 255, 255, 0.70)**
- `font-size`: **13px**
- `line-height`: **1.5**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.app-alert--warn`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-alert--warn`

- `border-color`: **rgba(168, 102, 18, 0.24)**
- `background`: **#FFF6E5**
- `color`: **#7C4A0C**

**`.app-panel`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel`

- `min-width`: **0**
- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel__body`

- `padding`: **16px 18px**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-panels--stretch > * > .app-panel__body`

- `flex`: **1 1 auto**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel--actions-bottom > .app-panel__body`

- `display`: **flex**
- `flex-direction`: **column**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel--actions-bottom > .app-panel__body > :last-child`

- `margin-top`: **auto**

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

**`.app-inner-surface`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-inner-surface`

- `background`: **rgba(255, 255, 255, 0.70)**
- `border`: **1px solid rgba(15, 23, 42, 0.05)**
- `border-radius`: **12px**



### D.2 PWA SOURCE-UNRESOLVED (2)

- ``app-chip ${s.status === "PUBLISHED" ? "app-chip--ok" : ""}`` at `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:107` — className built from a runtime expression
- ``app-chip ${v.publishedAt ? "app-chip--ok" : ""}`` at `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:224` — className built from a runtime expression

### D.3 Native StyleSheet rules resolved (67 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 6 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 156 |
| Native elements identified | 111 |
| Pairable PWA elements | 35 |
| Paired | 4 |
| Missing in Native | 18 |
| Extra in Native | 27 |
| Unlabelled (not pairable by label) | 2 |
| SOURCE-UNRESOLVED labels | 8 |
| PWA style properties resolved | 119 |
| PWA style items SOURCE-UNRESOLVED | 2 |
| Native style properties resolved | 72 |
| PWA interactive elements | 32 |
| Native interactive elements | 40 |
| PWA conditional branches | 73 |
| Native conditional branches | 64 |
