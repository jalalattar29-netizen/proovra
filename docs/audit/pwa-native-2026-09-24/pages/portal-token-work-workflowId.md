# /portal/[token]/work/[workflowId]

**PWA entry:** `apps/web/app/portal/[token]/work/[workflowId]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/portal/work/[workflowId].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 5 | 2 |
| Elements | 80 | 68 |
| Interactive elements | 18 | 15 |
| Conditionally-rendered elements | 39 | 36 |
| Style rules resolved | 0 (0 props) | 62 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx` | 56 | `(entry)` |
| 1 | `apps/web/components/external-portal/PortalMfaCodeStep.tsx` | 11 | `PortalMfaCodeStep` |
| 2 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/components/external-portal/PortalDenialNotice.tsx` | 5 | `PortalDenialNotice` |
| 1 | `apps/web/components/external-portal/WatermarkOverlay.tsx` | 3 | `WatermarkOverlay` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx` | 26 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraEmpty,ProovraCard,ProovraText,ProovraPageSection,ProovraLoadingState,ProovraFormField,ProovraInput,ProovraConfirmSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 9 | 8 | -1 |
| CARD | 0 | 4 | 4 |
| CONTAINER | 23 | 24 | 1 |
| DIALOG | 0 | 1 | 1 |
| HEADING | 4 | 0 | -4 |
| INPUT | 4 | 5 | 1 |
| LINK | 1 | 0 | -1 |
| LIST | 0 | 1 | 1 |
| OTHER | 7 | 4 | -3 |
| STATE_EMPTY | 0 | 2 | 2 |
| STATE_ERROR | 1 | 0 | -1 |
| STATE_LOADING | 1 | 3 | 2 |
| TEXT | 30 | 16 | -14 |

### C.1 Paired (3)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | {busy ? "Trying again…" : "Try again"} | `apps/web/components/external-portal/PortalDenialNotice.tsx:157` | `apps/mobile/src/ui/index.tsx:531` |
| INPUT | Add a comment to the workflow… | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:621` | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:192` |
| BUTTON | Post | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:636` | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:202` |


### C.2 MISSING in Native (11)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Confirm it is you | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:279` |
| LINK | ← Back to dashboard | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:328` |
| HEADING | Decision | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:466` |
| BUTTON | Retry | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:477` |
| INPUT | Bounded rationale (≤ 600 chars). Required for non-APPROVE verdicts. | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:508` |
| HEADING | Review communication | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:614` |
| INPUT | Reply… | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:684` |
| BUTTON | Reply | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:699` |
| HEADING | Enter your sign-in code | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:196` |
| BUTTON | {busy === "verify" ? "Checking code…" : "Verify code"} | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:267` |
| BUTTON | {busy ? "Signing in…" : "Sign in again"} | `apps/web/components/external-portal/PortalDenialNotice.tsx:146` |

### C.3 EXTRA in Native (12)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:152` |
| STATE_EMPTY | This review is not open | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:157` |
| BUTTON | Back to your reviews | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:163` |
| STATE_LOADING | Loading discussion | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:171` |
| STATE_EMPTY | No comments on this review yet. | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:173` |
| INPUT | What should the workspace know? | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:193` |
| INPUT | Note (optional) | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:219` |
| INPUT | Recorded with your decision | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:220` |
| BUTTON | portalDecisionLabel(d) | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx:231` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |

### C.4 SOURCE-UNRESOLVED labels (4)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx:525` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:217` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:277` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (0 rules, 0 properties)

_no static classes on this route_



### D.2 PWA SOURCE-UNRESOLVED (3)

- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (62 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 5 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 80 |
| Native elements identified | 68 |
| Pairable PWA elements | 20 |
| Paired | 1 |
| Missing in Native | 11 |
| Extra in Native | 12 |
| Unlabelled (not pairable by label) | 2 |
| SOURCE-UNRESOLVED labels | 4 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 3 |
| Native style properties resolved | 72 |
| PWA interactive elements | 18 |
| Native interactive elements | 15 |
| PWA conditional branches | 39 |
| Native conditional branches | 36 |
