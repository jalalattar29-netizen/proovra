# /portal

**PWA entry:** `apps/web/app/portal/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/portal/index.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 3 | 2 |
| Elements | 27 | 49 |
| Interactive elements | 8 | 9 |
| Conditionally-rendered elements | 11 | 14 |
| Style rules resolved | 0 (0 props) | 59 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/portal/page.tsx` | 11 | `(entry)` |
| 1 | `apps/web/components/external-portal/PortalMfaCodeStep.tsx` | 11 | `PortalMfaCodeStep` |
| 2 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/portal/index.tsx` | 7 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraCard,ProovraText,ProovraFormField,ProovraInput,ProovraButton` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 5 | 5 | 0 |
| CARD | 0 | 1 | 1 |
| CONTAINER | 7 | 21 | 14 |
| HEADING | 2 | 0 | -2 |
| INPUT | 2 | 3 | 1 |
| LIST | 0 | 1 | 1 |
| OTHER | 1 | 2 | 1 |
| STATE_LOADING | 1 | 2 | 1 |
| TEXT | 9 | 14 | 5 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (5)

| Role | Label | PWA source |
|---|---|---|
| HEADING | PROOVRA External Reviewer Portal | `apps/web/app/portal/page.tsx:99` |
| BUTTON | Use a different invitation | `apps/web/app/portal/page.tsx:160` |
| BUTTON | {busy ? "Opening portal…" : "Open portal"} | `apps/web/app/portal/page.tsx:175` |
| HEADING | Enter your sign-in code | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:196` |
| BUTTON | {busy === "verify" ? "Checking code…" : "Verify code"} | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:267` |

### C.3 EXTRA in Native (7)

| Role | Label | Native source |
|---|---|---|
| INPUT | Access token | `apps/mobile/app/(stack)/portal/index.tsx:50` |
| INPUT | Paste the token from your email | `apps/mobile/app/(stack)/portal/index.tsx:51` |
| BUTTON | Open my reviews | `apps/mobile/app/(stack)/portal/index.tsx:59` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (4)

| Role | PWA source | Why unpairable |
|---|---|---|
| INPUT | `apps/web/app/portal/page.tsx:113` | label is computed at runtime and contains no string literal — cannot be paired statically |
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

### D.3 Native StyleSheet rules resolved (59 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 3 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 27 |
| Native elements identified | 49 |
| Pairable PWA elements | 10 |
| Paired | 0 |
| Missing in Native | 5 |
| Extra in Native | 7 |
| Unlabelled (not pairable by label) | 1 |
| SOURCE-UNRESOLVED labels | 4 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 3 |
| Native style properties resolved | 72 |
| PWA interactive elements | 8 |
| Native interactive elements | 9 |
| PWA conditional branches | 11 |
| Native conditional branches | 14 |
