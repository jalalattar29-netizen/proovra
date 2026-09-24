# /billing

**PWA entry:** `apps/web/app/(app)/billing/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/billing.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 23 | 3 |
| Elements | 503 | 98 |
| Interactive elements | 60 | 13 |
| Conditionally-rendered elements | 294 | 62 |
| Style rules resolved | 272 (957 props) | 74 (80 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/billing/page.tsx` | 50 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageHeader,PageShell,PageSection` |
| 1 | `apps/web/components/ui-legacy.tsx` | 27 | `Skeleton` |
| 2 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 3 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |
| 1 | `apps/web/components/ui/Card.tsx` | 11 | `Card` |
| 1 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/components/ui/EmptyState.tsx` | 15 | `EmptyState` |
| 1 | `apps/web/app/(app)/billing/_sections/AccountSelector.tsx` | 12 | `AccountSelector` |
| 1 | `apps/web/app/(app)/billing/_sections/PlanAndUsage.tsx` | 18 | `ActionRequiredBanner,EnterpriseContractCard` |
| 2 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 1 | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx` | 71 | `BillingOverview,EvidenceDetailCard,PlanCapabilitiesCard` |
| 1 | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx` | 78 | `StorageAddonsSection,BillingHistorySection` |
| 2 | `apps/web/components/ui/Badge.tsx` | 2 | `Badge` |
| 1 | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx` | 37 | `ManagePlanDrawer` |
| 2 | `apps/web/app/(app)/billing/_sections/BillingDrawer.tsx` | 9 | `BillingDrawer` |
| 1 | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx` | 52 | `CheckoutDrawer` |
| 2 | `apps/web/app/(app)/billing/_sections/PaymentMethodChoice.tsx` | 12 | `PaymentMethodChoice` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/billing.tsx` | 29 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraButton,ProovraSection,ProovraLoadingState,ProovraErrorState,ProovraCard,ProovraText,ProovraBadge` |
| 1 | `apps/mobile/src/ui/billing-sections.tsx` | 27 | `BillingSections` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 1 | 6 | 5 |
| BUTTON | 31 | 8 | -23 |
| CARD | 9 | 8 | -1 |
| CONTAINER | 120 | 29 | -91 |
| DIALOG | 4 | 1 | -3 |
| HEADING | 21 | 0 | -21 |
| ICON | 58 | 0 | -58 |
| INPUT | 5 | 1 | -4 |
| LINK | 6 | 0 | -6 |
| LIST | 25 | 1 | -24 |
| OTHER | 66 | 8 | -58 |
| STATE_EMPTY | 2 | 1 | -1 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 4 | 4 | 0 |
| TEXT | 148 | 30 | -118 |

### C.1 Paired (5)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Try again | `apps/web/app/(app)/billing/page.tsx:935` | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | Cancel | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:247` | `apps/mobile/src/ui/billing-sections.tsx:203` |
| HEADING → BUTTON ⚠ | Cancel subscription | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:292` | `apps/mobile/src/ui/billing-sections.tsx:162` |
| DIALOG → BUTTON ⚠ | title | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:254` | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON → DIALOG ⚠ | Cancel | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:262` | `apps/mobile/src/ui/billing-sections.tsx:276` |

**3 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (42)

| Role | Label | PWA source |
|---|---|---|
| CARD | phase.title | `apps/web/app/(app)/billing/page.tsx:932` |
| STATE_EMPTY | Billing is managed for you | `apps/web/app/(app)/billing/page.tsx:952` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |
| BUTTON | Retry stopping storage add-ons | `apps/web/app/(app)/billing/_sections/PlanAndUsage.tsx:94` |
| BUTTON | Contact support | `apps/web/app/(app)/billing/_sections/PlanAndUsage.tsx:108` |
| HEADING | Evidence | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:594` |
| LINK | Open Reports | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:690` |
| BUTTON | Buy credits | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:698` |
| BUTTON | Choose a plan | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:710` |
| HEADING | Plan capabilities | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:764` |
| HEADING | Storage | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:91` |
| BUTTON | View plans | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:109` |
| HEADING | Storage | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:159` |
| BUTTON | {hasActive ? "Manage storage" : "Add storage"} | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:273` |
| CARD | Billing history | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:364` |
| CARD | Billing history | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:381` |
| BUTTON | Try again | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:391` |
| STATE_EMPTY | No payments yet | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:444` |
| LINK | Resume payment | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:542` |
| BUTTON | Re-check | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:553` |
| BUTTON | Cancel payment | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:566` |
| BUTTON | Abandon payment attempt | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:577` |
| DIALOG | plan.accessKind === "CONTRACT" ? "Your agreement" : plan.accessKind === "GRANTED" ? "Access details" : "Manage plan" | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:69` |
| BUTTON | Close | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:86` |
| HEADING | Current plan | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:94` |
| HEADING | Plan change in progress | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:143` |
| HEADING | Change plan | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:180` |
| HEADING | How you have this plan | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:250` |
| HEADING | Changing your agreement | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:260` |
| BUTTON | Cancel subscription | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:322` |
| HEADING | Plan | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:305` |
| INPUT | billing-plan | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:340` |
| HEADING | Purchase | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:406` |
| HEADING | Capacity | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:467` |
| INPUT | storage-addon | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:485` |
| HEADING | Payment method | `apps/web/app/(app)/billing/_sections/PaymentMethodChoice.tsx:104` |
| INPUT | name | `apps/web/app/(app)/billing/_sections/PaymentMethodChoice.tsx:128` |

### C.3 EXTRA in Native (13)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/billing.tsx:88` |
| STATE_LOADING | Loading plan | `apps/mobile/app/(stack)/billing.tsx:92` |
| BADGE | Active | `apps/mobile/app/(stack)/billing.tsx:101` |
| BADGE | Your plan | `apps/mobile/app/(stack)/billing.tsx:122` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BADGE | overview.plan | `apps/mobile/src/ui/billing-sections.tsx:144` |
| BADGE | `${overview.credits} credits` | `apps/mobile/src/ui/billing-sections.tsx:146` |
| BUTTON | Ask the provider again | `apps/mobile/src/ui/billing-sections.tsx:183` |
| BADGE | a.status | `apps/mobile/src/ui/billing-sections.tsx:213` |
| STATE_LOADING | Loading payments | `apps/mobile/src/ui/billing-sections.tsx:224` |
| STATE_EMPTY | No payments have been recorded. | `apps/mobile/src/ui/billing-sections.tsx:226` |
| BADGE | p.status | `apps/mobile/src/ui/billing-sections.tsx:241` |

### C.4 SOURCE-UNRESOLVED labels (26)

| Role | PWA source | Why unpairable |
|---|---|---|
| LINK | `apps/web/app/(app)/billing/page.tsx:1103` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Card.tsx:250` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/billing/_sections/PlanAndUsage.tsx:55` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/billing/_sections/PlanAndUsage.tsx:231` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:134` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:197` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/billing/_sections/BillingOverview.tsx:221` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:239` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:413` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:423` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/billing/_sections/ManagePlanDrawer.tsx:188` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/billing/_sections/BillingDrawer.tsx:165` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:265` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (272 rules, 957 properties)

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

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page`

- `display`: **grid**
- `gap`: **18px**
- `max-inline-size`: **1120px**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page .bill-secondary-action.ui-button`

- `background`: **#FFFFFF !important**  _(--surface-card=#FFFFFF)_
- `background-image`: **none !important**
- `color`: **#6D28D9 !important**  _(--accent-600=#6D28D9)_
- `border`: **1px solid rgba(15, 23, 42, 0.09)) !important**  _(--border-default=rgba(15, 23, 42, 0.09))_
- `box-shadow`: **none !important**
- `min-height`: **44px !important**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page .bill-secondary-action.ui-button:hover:not(:disabled)`

- `background`: **#F2ECFE !important**  _(--accent-050=#F2ECFE)_
- `border-color`: **#7C3AED !important**  _(--accent-500=#7C3AED)_
- `color`: **#6D28D9 !important**  _(--accent-600=#6D28D9)_

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page .bill-secondary-action.ui-button:active:not(:disabled)`

- `background`: **#D9C7FB !important**  _(--accent-200=#D9C7FB)_
- `transform`: **translateY(1px)**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page .bill-secondary-action.ui-button:focus-visible`

- `outline`: **2px solid #7C3AED !important**  _(--accent-500=#7C3AED)_
- `outline-offset`: **2px**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page .bill-secondary-action.ui-button:disabled`

- `background`: **#F1F4F9 !important**  _(--surface-muted=#F1F4F9)_
- `color`: **#5B6B7B !important**  _(--silver-ink=#5B6B7B)_
- `border-color`: **rgba(15, 23, 42, 0.09)) !important**  _(--border-default=rgba(15, 23, 42, 0.09))_
- `transform`: **none**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page .bill-overview__action`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `gap`: **12px**  _(--space-3=12px)_
- `align-items`: **center**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page [data-billing-support-action].ui-button`

- `background`: **#6D28D9 !important**  _(--accent-600=#6D28D9)_
- `background-image`: **none !important**
- `border`: **1px solid #6D28D9 !important**  _(--accent-600=#6D28D9)_
- `color`: **#ffffff !important**
- `-webkit-text-fill-color`: **#ffffff !important**
- `box-shadow`: **none !important**
- `min-height`: **40px !important**
- `border-radius`: **10px !important**
- `font-weight`: **650 !important**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page [data-billing-support-action].ui-button:hover`

- `background`: **#5b21b6 !important**  _(--accent-700→(fallback) #5b21b6)_
- `border-color`: **#5b21b6 !important**  _(--accent-700→(fallback) #5b21b6)_
- `color`: **#ffffff !important**
- `-webkit-text-fill-color`: **#ffffff !important**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page [data-billing-support-action].ui-button:focus-visible`

- `outline`: **2px solid #7C3AED !important**  _(--accent-500=#7C3AED)_
- `outline-offset`: **2px !important**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page td .app-status-text`

- `white-space`: **nowrap**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page [data-billing-history] > div:first-child`

- `flex-wrap`: **wrap**
- `gap`: **10px**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page [data-billing-history] > div:first-child > *`

- `min-inline-size`: **0**

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page .bill-panel`

- `border-color`: **rgba(15, 23, 42, 0.14))**  _(--border-strong=rgba(15, 23, 42, 0.14))_

**`.bill-page`** — `apps/web/app/(app)/billing/billing.css` · `.bill-page [data-billing-history]`

- `border-color`: **rgba(15, 23, 42, 0.14))**  _(--border-strong=rgba(15, 23, 42, 0.14))_

**`.bill-row`** — `apps/web/app/(app)/billing/billing.css` · `.bill-row`

- `display`: **grid**
- `gap`: **18px**
- `grid-template-columns`: **repeat(2, minmax(0, 1fr))**
- `align-items`: **stretch**

**`.bill-row`** — `apps/web/app/(app)/billing/billing.css` · `.bill-row:empty`

- `display`: **none**

**`.bill-row`** — `apps/web/app/(app)/billing/billing.css` · `.bill-row:has(> *:only-child)`

- `grid-template-columns`: **minmax(0, 1fr)**

**`.bill-row`** — `apps/web/app/(app)/billing/billing.css` · `.bill-row[data-billing-row="allowances"] .bill-panel`

- `display`: **flex**
- `flex-direction`: **column**
- `align-content`: **stretch**

**`.bill-row`** — `apps/web/app/(app)/billing/billing.css` · `.bill-row[data-billing-row="allowances"] .bill-panel > .bill-panel__actions`

- `margin-block-start`: **auto**
- `padding-block-start`: **4px**

**`.bill-row`** — `apps/web/app/(app)/billing/billing.css` · `.bill-row[data-billing-row="allowances"] .bill-panel > * + *:not(.bill-panel__actions)`

- `margin-block-start`: **12px**

**`.bill-support-strip`** — `apps/web/app/(app)/billing/billing.css` · `.bill-support-strip`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **center**
- `gap`: **12px**
- `padding`: **12px 16px**
- `border-radius`: **12px**
- `border`: **1px solid #D9C7FB**  _(--accent-200=#D9C7FB)_
- `background`: **#F2ECFE**  _(--accent-050=#F2ECFE)_
- `font-size`: **0.88rem**
- `color`: **#0F172A**  _(--ink-primary=#0F172A)_

**`.bill-support-strip__icon`** — `apps/web/app/(app)/billing/billing.css` · `.bill-support-strip__icon`

- `flex`: **none**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `inline-size`: **32px**
- `block-size`: **32px**
- `border-radius`: **999px**
- `background`: **#FFFFFF**  _(--surface-card=#FFFFFF)_
- `border`: **1px solid #D9C7FB**  _(--accent-200=#D9C7FB)_
- `color`: **#6D28D9**  _(--accent-600=#6D28D9)_

**`.bill-support-strip__copy`** — `apps/web/app/(app)/billing/billing.css` · `.bill-support-strip__copy`

- `margin`: **0**
- `min-inline-size`: **0**
- `flex`: **1 1 260px**
- `line-height`: **1.55**
- `overflow-wrap`: **anywhere**

**`.bill-support-strip__action`** — `apps/web/app/(app)/billing/billing.css` · `.bill-support-strip__action`

- `flex`: **none**
- `min-block-size`: **44px**
- `display`: **inline-flex**
- `align-items`: **center**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-plan-action.ui-button`

- `min-height`: **44px !important**
- `background`: **#0F172A !important**  _(--ink-primary=#0F172A)_
- `background-image`: **none !important**
- `color`: **#F8FAFC !important**  _(--ink-inverse=#F8FAFC)_
- `border`: **1px solid #0F172A !important**  _(--ink-primary=#0F172A)_
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.18) !important**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-plan-action.ui-button:hover:not(:disabled)`

- `background`: **#000000 !important**
- `border-color`: **#000000 !important**
- `box-shadow`: **0 4px 14px rgba(15, 23, 42, 0.28) !important**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-plan-action.ui-button:active:not(:disabled)`

- `box-shadow`: **inset 0 1px 3px rgba(0, 0, 0, 0.4) !important**
- `transform`: **translateY(1px)**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-plan-action.ui-button:focus-visible`

- `outline`: **2px solid #0F172A !important**  _(--ink-primary=#0F172A)_
- `outline-offset`: **2px**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-plan-action.ui-button:disabled`

- `background`: **#0F172A !important**  _(--ink-primary=#0F172A)_
- `border-color`: **#0F172A !important**  _(--ink-primary=#0F172A)_
- `color`: **#F8FAFC !important**  _(--ink-inverse=#F8FAFC)_
- `box-shadow`: **none !important**
- `transform`: **none**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-plan-action.ui-button[aria-busy="true"]`

- `background`: **#0F172A !important**  _(--ink-primary=#0F172A)_
- `border-color`: **#0F172A !important**  _(--ink-primary=#0F172A)_
- `color`: **#F8FAFC !important**  _(--ink-inverse=#F8FAFC)_
- `box-shadow`: **none !important**
- `transform`: **none**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-cancel-action.ui-button`

- `min-height`: **44px !important**
- `background`: **#FFFFFF !important**  _(--surface-card=#FFFFFF)_
- `background-image`: **none !important**
- `color`: **#dc2626 !important**  _(--destructive=#dc2626)_
- `border`: **1px solid #dc2626 !important**  _(--destructive=#dc2626)_
- `box-shadow`: **none !important**

**`.ui-button`** — `apps/web/app/(app)/billing/billing.css` · `.bill-drawer .bill-cancel-action.ui-button:hover:not(:disabled)`

- `background`: **rgba(220, 38, 38, 0.08) !important**
- `color`: **#dc2626 !important**  _(--destructive=#dc2626)_
- `border-color`: **#dc2626 !important**  _(--destructive=#dc2626)_



### D.2 PWA SOURCE-UNRESOLVED (16)

- `cc-subtitle` at `apps/web/app/(app)/billing/page.tsx:866` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `finalClassName` at `apps/web/components/ui-legacy.tsx:163` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``card ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:179` — className built from a runtime expression
- ``input ${error ? "input-has-error" : ""} ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:293` — className built from a runtime expression
- ``select ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:360` — className built from a runtime expression
- `["ui-card",` at `apps/web/components/ui/Card.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-empty-state",` at `apps/web/components/ui/EmptyState.tsx:128` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression
- `["ui-badge",` at `apps/web/components/ui/Badge.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bill-pay` at `apps/web/app/(app)/billing/_sections/PaymentMethodChoice.tsx:116` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (74 rules, 80 properties)

**`headerRow`** — `apps/mobile/app/(stack)/billing.tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`card`** — `apps/mobile/app/(stack)/billing.tsx`

- `marginBottom`: **16**  _(theme.space.s4)_
- `gap`: **12**  _(theme.space.s3)_

**`planRow`** — `apps/mobile/app/(stack)/billing.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_
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
| PWA files inspected (rendered tree) | 23 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 503 |
| Native elements identified | 98 |
| Pairable PWA elements | 86 |
| Paired | 2 |
| Missing in Native | 42 |
| Extra in Native | 13 |
| Unlabelled (not pairable by label) | 13 |
| SOURCE-UNRESOLVED labels | 26 |
| PWA style properties resolved | 957 |
| PWA style items SOURCE-UNRESOLVED | 16 |
| Native style properties resolved | 80 |
| PWA interactive elements | 60 |
| Native interactive elements | 13 |
| PWA conditional branches | 294 |
| Native conditional branches | 62 |
