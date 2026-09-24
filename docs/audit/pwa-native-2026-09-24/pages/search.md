# /search

**PWA entry:** `apps/web/app/(app)/search/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/search.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 13 | 2 |
| Elements | 437 | 63 |
| Interactive elements | 67 | 14 |
| Conditionally-rendered elements | 227 | 30 |
| Style rules resolved | 283 (1217 props) | 64 (78 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/search/page.tsx` | 219 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/app-primitives/AppStatusBadge.tsx` | 2 | `AppStatusBadge` |
| 1 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/components/search/SearchAuditLogPanel.tsx` | 41 | `SearchAuditLogPanel` |
| 1 | `apps/web/app/(app)/search/components/SearchStates.tsx` | 59 | `SearchUnavailableAlert,SearchReadinessNotice,SearchResultSkeletons,SearchRestrictedState,SearchUnavailableState,SearchEmptyWorkspaceState,SearchInitializingState,SearchStalledState,SearchPristineState,SearchNoResultsState` |
| 1 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 1 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 1 | `apps/web/app/(app)/search/components/SearchGuidance.tsx` | 37 | `SearchGuidancePanel` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/search.tsx` | 21 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraSection,ProovraInput,ProovraButton,ProovraFilterChips,ProovraText,ProovraLoadingState,ProovraEmptyState,ProovraErrorState,ProovraResultCount,ProovraCard,ProovraListRow,ProovraBadge,ProovraCursorPager` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 10 | 1 | -9 |
| BUTTON | 30 | 5 | -25 |
| CARD | 0 | 1 | 1 |
| CONTAINER | 84 | 23 | -61 |
| FORM | 1 | 0 | -1 |
| HEADING | 9 | 0 | -9 |
| ICON | 43 | 0 | -43 |
| INPUT | 5 | 2 | -3 |
| LINK | 11 | 0 | -11 |
| LIST | 36 | 2 | -34 |
| OTHER | 88 | 7 | -81 |
| STATE_EMPTY | 1 | 3 | 2 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 1 | 4 | 3 |
| TEXT | 115 | 14 | -101 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Try again | `apps/web/components/search/SearchAuditLogPanel.tsx:179` | `apps/mobile/src/ui/index.tsx:531` |


### C.2 MISSING in Native (34)

| Role | Label | PWA source |
|---|---|---|
| BADGE | Search index status unavailable | `apps/web/app/(app)/search/page.tsx:1798` |
| INPUT | Search evidence, cases, reports, notes, OCR text… | `apps/web/app/(app)/search/page.tsx:1816` |
| BUTTON | Search | `apps/web/app/(app)/search/page.tsx:1878` |
| BUTTON | {helpOpen ? "Hide" : "Show"} | `apps/web/app/(app)/search/page.tsx:1896` |
| BUTTON | Records | `apps/web/app/(app)/search/page.tsx:1937` |
| BUTTON | Search activity | `apps/web/app/(app)/search/page.tsx:1948` |
| BUTTON | Apply filters | `apps/web/app/(app)/search/page.tsx:2118` |
| BUTTON | Clear filters | `apps/web/app/(app)/search/page.tsx:2128` |
| BUTTON | {savingView ? "Saving…" : "Save current view"} | `apps/web/app/(app)/search/page.tsx:2146` |
| BUTTON | v.description ?? "" | `apps/web/app/(app)/search/page.tsx:2163` |
| BUTTON | {loading ? "Loading…" : "Load more"} | `apps/web/app/(app)/search/page.tsx:2468` |
| LINK | Open case graph | `apps/web/app/(app)/search/page.tsx:2850` |
| LINK | Open timeline view | `apps/web/app/(app)/search/page.tsx:2863` |
| LINK | Review duplicates and similars | `apps/web/app/(app)/search/page.tsx:2878` |
| BUTTON | {running ? "Running dry run…" : "Run backfill (dry run)"} | `apps/web/app/(app)/search/page.tsx:3270` |
| BUTTON | Clear all | `apps/web/app/(app)/search/page.tsx:3575` |
| BUTTON | `Remove search "${r}"` | `apps/web/app/(app)/search/page.tsx:3614` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| HEADING | Search activity | `apps/web/components/search/SearchAuditLogPanel.tsx:135` |
| INPUT | Withheld results only | `apps/web/components/search/SearchAuditLogPanel.tsx:146` |
| BADGE | Results withheld | `apps/web/components/search/SearchAuditLogPanel.tsx:239` |
| BADGE | Completed | `apps/web/components/search/SearchAuditLogPanel.tsx:247` |
| BUTTON | {state.kind === "loading" ? "Loading…" : "Load more"} | `apps/web/components/search/SearchAuditLogPanel.tsx:260` |
| BUTTON | Clear filters | `apps/web/app/(app)/search/components/SearchStates.tsx:109` |
| BUTTON | {retrying ? "Retrying…" : "Retry Connection"} | `apps/web/app/(app)/search/components/SearchStates.tsx:149` |
| LINK | Contact Support | `apps/web/app/(app)/search/components/SearchStates.tsx:159` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| BUTTON | Clear | `apps/web/app/(app)/search/components/SearchGuidance.tsx:61` |
| HEADING | Saved searches | `apps/web/app/(app)/search/components/SearchGuidance.tsx:98` |
| HEADING | Search tips | `apps/web/app/(app)/search/components/SearchGuidance.tsx:133` |
| LINK | Contact system admin | `apps/web/app/(app)/search/components/SearchGuidance.tsx:167` |

### C.3 EXTRA in Native (10)

| Role | Label | Native source |
|---|---|---|
| BUTTON | sug | `apps/mobile/app/(stack)/search.tsx:174` |
| STATE_LOADING | Preparing search | `apps/mobile/app/(stack)/search.tsx:230` |
| STATE_EMPTY | Search isn’t ready yet | `apps/mobile/app/(stack)/search.tsx:232` |
| STATE_LOADING | Searching | `apps/mobile/app/(stack)/search.tsx:237` |
| STATE_EMPTY | Search your workspace | `apps/mobile/app/(stack)/search.tsx:241` |
| STATE_EMPTY | No results | `apps/mobile/app/(stack)/search.tsx:246` |
| BADGE | type.label | `apps/mobile/app/(stack)/search.tsx:265` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |

### C.4 SOURCE-UNRESOLVED labels (24)

| Role | PWA source | Why unpairable |
|---|---|---|
| BADGE | `apps/web/app/(app)/search/page.tsx:1740` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/search/page.tsx:1999` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/search/page.tsx:2023` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/search/page.tsx:2377` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/search/page.tsx:2388` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/search/page.tsx:2444` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/search/page.tsx:2708` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/search/page.tsx:2716` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/search/page.tsx:2740` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/search/page.tsx:2759` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/search/page.tsx:2777` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/search/page.tsx:2789` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/search/page.tsx:2816` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/search/page.tsx:2941` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/search/page.tsx:3024` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/search/page.tsx:3201` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/search/components/SearchStates.tsx:58` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/search/components/SearchStates.tsx:248` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/search/components/SearchGuidance.tsx:55` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/search/components/SearchGuidance.tsx:79` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/search/components/SearchGuidance.tsx:109` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (283 rules, 1217 properties)

**`.search-page`** — `apps/web/app/(app)/search/search.css` · `.search-page`

- `display`: **grid**
- `gap`: **18px**
- `min-inline-size`: **0**

**`.app-panel`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel`

- `min-width`: **0**
- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**

**`.search-state`** — `apps/web/app/(app)/search/search.css` · `.search-state`

- `display`: **grid**
- `justify-items`: **center**
- `gap`: **10px**
- `padding`: **56px 24px**
- `text-align`: **center**
- `min-inline-size`: **0**

**`.search-state__body`** — `apps/web/app/(app)/search/search.css` · `.search-state__body`

- `margin`: **0**
- `max-inline-size`: **46ch**
- `font-size`: **13px**
- `line-height`: **1.55**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.search-header`** — `apps/web/app/(app)/search/search.css` · `.search-header`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **flex-start**
- `justify-content`: **space-between**
- `gap`: **12px 24px**
- `min-inline-size`: **0**

**`.search-header__text`** — `apps/web/app/(app)/search/search.css` · `.search-header__text`

- `min-inline-size`: **0**
- `max-inline-size`: **68ch**

**`.search-header__title`** — `apps/web/app/(app)/search/search.css` · `.search-header__title`

- `margin`: **0**
- `font-size`: **30px**
- `line-height`: **1.15**
- `font-weight`: **720**
- `letter-spacing`: **-0.025em**
- `color`: **#172033**  _(--app-ink-heading=#172033)_

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

**`.search-header__description`** — `apps/web/app/(app)/search/search.css` · `.search-header__description`

- `margin`: **6px 0 0**
- `font-size`: **13.5px**
- `line-height`: **1.55**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.search-header__context`** — `apps/web/app/(app)/search/search.css` · `.search-header__context`

- `margin`: **0**
- `padding-block-start`: **6px**
- `font-size`: **12.5px**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_
- `white-space`: **nowrap**

**`.search-admin-strip`** — `apps/web/app/(app)/search/search.css` · `.search-admin-strip`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **flex-start**
- `gap`: **8px**
- `min-inline-size`: **0**

**`.search-form-panel`** — `apps/web/app/(app)/search/search.css` · `.search-form-panel`

- `padding`: **14px 16px**

**`.search-form`** — `apps/web/app/(app)/search/search.css` · `.search-form`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **12px**
- `min-inline-size`: **0**

**`.search-form__field`** — `apps/web/app/(app)/search/search.css` · `.search-form__field`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **12px**
- `flex`: **1 1 auto**
- `min-inline-size`: **0**
- `box-sizing`: **border-box**
- `block-size`: **50px**
- `padding-inline`: **18px**
- `border`: **1px solid rgba(15, 23, 42, 0.1)**
- `border-radius`: **12px**
- `background`: **rgba(255, 255, 255, 0.72)**
- `transition`: **border-color 160ms ease, box-shadow 160ms ease**

**`.search-form__field`** — `apps/web/app/(app)/search/search.css` · `.search-form__field:focus-within`

- `border-color`: **#D9C7FB**  _(--accent-200=#D9C7FB)_
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.14)**

**`.search-form__icon`** — `apps/web/app/(app)/search/search.css` · `.search-form__icon`

- `flex`: **0 0 auto**
- `display`: **inline-flex**
- `align-items`: **center**
- `color`: **#98A2B3**  _(--app-ink-placeholder=#98A2B3)_
- `pointer-events`: **none**

**`.search-form__input`** — `apps/web/app/(app)/search/search.css` · `.search-form__input`

- `flex`: **1 1 auto**
- `inline-size`: **100%**
- `min-inline-size`: **0**
- `block-size`: **100%**
- `padding`: **0**
- `border`: **none**
- `background`: **transparent**
- `font-family`: **inherit**
- `font-size`: **14.5px**
- `color`: **#263247**  _(--app-ink-control=#263247)_

**`.search-form__input`** — `apps/web/app/(app)/search/search.css` · `.search-form__input::placeholder`

- `color`: **#98A2B3**  _(--app-ink-placeholder=#98A2B3)_

**`.search-form__input`** — `apps/web/app/(app)/search/search.css` · `.search-form__input:focus`

- `outline`: **none**
- `box-shadow`: **none**

**`.search-form__input`** — `apps/web/app/(app)/search/search.css` · `.search-form__input:focus-visible`

- `outline`: **none**
- `box-shadow`: **none**

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

**`.search-form__submit`** — `apps/web/app/(app)/search/search.css` · `.search-form__submit`

- `flex`: **0 0 auto**
- `block-size`: **50px**
- `min-inline-size`: **124px**
- `border-radius`: **12px**
- `font-size`: **14px**

**`.search-help`** — `apps/web/app/(app)/search/search.css` · `.search-help`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **center**
- `gap`: **10px 14px**
- `padding`: **12px 16px**
- `border`: **1px solid rgba(37, 99, 235, 0.16)**
- `border-radius`: **14px**
- `background`: **#eaf0fd**
- `color`: **#2563eb**
- `min-inline-size`: **0**

**`.search-help__icon`** — `apps/web/app/(app)/search/search.css` · `.search-help__icon`

- `display`: **inline-flex**
- `flex`: **0 0 auto**

**`.search-help__label`** — `apps/web/app/(app)/search/search.css` · `.search-help__label`

- `font-size`: **12.5px**
- `font-weight`: **700**
- `letter-spacing`: **0.06em**
- `text-transform`: **uppercase**

**`.search-help__toggle`** — `apps/web/app/(app)/search/search.css` · `.search-help__toggle`

- `margin-inline-start`: **auto**
- `border`: **none**
- `background`: **transparent**
- `padding`: **4px 8px**
- `border-radius`: **8px**
- `font-family`: **inherit**
- `font-size`: **12.5px**
- `font-weight`: **650**
- `color`: **#2563eb**
- `cursor`: **pointer**

**`.search-help__toggle`** — `apps/web/app/(app)/search/search.css` · `.search-help__toggle:hover`

- `background`: **rgba(37, 99, 235, 0.08)**

**`.search-help__toggle`** — `apps/web/app/(app)/search/search.css` · `.search-help__toggle:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 3px rgba(37, 99, 235, 0.28)**

**`.search-help__body`** — `apps/web/app/(app)/search/search.css` · `.search-help__body`

- `flex-basis`: **100%**
- `display`: **grid**
- `gap`: **6px**
- `margin`: **0**
- `padding-inline-start`: **0**
- `list-style`: **none**
- `color`: **#344054**  _(--app-ink-label=#344054)_
- `font-size`: **12.5px**
- `line-height`: **1.55**

**`.app-tabs`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-tabs`

- `display`: **inline-flex**
- `align-items`: **center**
- `gap`: **6px**
- `height`: **44px**
- `padding`: **4px**
- `margin-bottom`: **4px**
- `flex-wrap`: **nowrap**
- `max-width`: **100%**
- `overflow-x`: **auto**
- `scrollbar-width`: **none**
- `background`: **rgba(255, 255, 255, 0.38)**
- `border`: **1px solid rgba(15, 23, 42, 0.06)**
- `border-radius`: **14px**
- `box-shadow`: **0 4px 14px rgba(15, 23, 42, 0.025)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**

**`.app-tabs`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-tabs::-webkit-scrollbar`

- `display`: **none**



### D.2 PWA SOURCE-UNRESOLVED (8)

- ``app-tab${scope === "records" ? " is-active" : ""}`` at `apps/web/app/(app)/search/page.tsx:1937` — className built from a runtime expression
- ``app-tab${scope === "activity" ? " is-active" : ""}`` at `apps/web/app/(app)/search/page.tsx:1948` — className built from a runtime expression
- ``app-secondary-action ${ searchTypeTone(row.documentType) === "orange" ? "app-secondary-action--orange" : "app-secondary-action--accent" } search-inspector__action`` at `apps/web/app/(app)/search/page.tsx:2740` — className built from a runtime expression
- ``app-status-badge${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusBadge.tsx:109` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- ``app-alert ${tone === "danger" ? "app-alert--danger" : "app-alert--warn"} search-readiness-panel`` at `apps/web/app/(app)/search/components/SearchStates.tsx:339` — className built from a runtime expression
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression

### D.3 Native StyleSheet rules resolved (64 rules, 78 properties)

**`more`** — `apps/mobile/app/(stack)/search.tsx`

- `marginTop`: **16**  _(theme.space.s4)_

**`count`** — `apps/mobile/app/(stack)/search.tsx`

- `marginBottom`: **8**  _(theme.space.s2)_

**`suggestions`** — `apps/mobile/app/(stack)/search.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
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
| PWA files inspected (rendered tree) | 13 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 437 |
| Native elements identified | 63 |
| Pairable PWA elements | 70 |
| Paired | 1 |
| Missing in Native | 34 |
| Extra in Native | 10 |
| Unlabelled (not pairable by label) | 11 |
| SOURCE-UNRESOLVED labels | 24 |
| PWA style properties resolved | 1217 |
| PWA style items SOURCE-UNRESOLVED | 8 |
| Native style properties resolved | 78 |
| PWA interactive elements | 67 |
| Native interactive elements | 14 |
| PWA conditional branches | 227 |
| Native conditional branches | 30 |
