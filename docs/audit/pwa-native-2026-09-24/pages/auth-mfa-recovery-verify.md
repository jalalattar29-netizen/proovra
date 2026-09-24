# /auth/mfa-recovery/verify

**PWA entry:** `apps/web/app/auth/mfa-recovery/verify/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/mfa-recovery-verify.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 1 | 2 |
| Elements | 18 | 53 |
| Interactive elements | 3 | 8 |
| Conditionally-rendered elements | 2 | 23 |
| Style rules resolved | 0 (0 props) | 59 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/auth/mfa-recovery/verify/page.tsx` | 18 | `(entry)` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/mfa-recovery-verify.tsx` | 11 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraLoadingState,ProovraCard,ProovraText,ProovraButton` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 0 | 6 | 6 |
| CARD | 0 | 2 | 2 |
| CONTAINER | 2 | 21 | 19 |
| HEADING | 1 | 0 | -1 |
| INPUT | 0 | 1 | 1 |
| LINK | 3 | 0 | -3 |
| LIST | 0 | 1 | 1 |
| OTHER | 5 | 2 | -3 |
| STATE_LOADING | 0 | 3 | 3 |
| TEXT | 7 | 17 | 10 |

### C.1 Paired (2)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | Continue to home | `apps/web/app/auth/mfa-recovery/verify/page.tsx:204` | `apps/mobile/app/(stack)/mfa-recovery-verify.tsx:122` |
| LINK → BUTTON ⚠ | Return to sign in | `apps/web/app/auth/mfa-recovery/verify/page.tsx:212` | `apps/mobile/app/(stack)/mfa-recovery-verify.tsx:134` |

**2 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (1)

| Role | Label | PWA source |
|---|---|---|
| LINK | Return to sign in | `apps/web/app/auth/mfa-recovery/verify/page.tsx:237` |

### C.3 EXTRA in Native (5)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Confirming your recovery link | `apps/mobile/app/(stack)/mfa-recovery-verify.tsx:109` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (1)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/auth/mfa-recovery/verify/page.tsx:321` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (0 rules, 0 properties)

_no static classes on this route_



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
| PWA files inspected (rendered tree) | 1 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 18 |
| Native elements identified | 53 |
| Pairable PWA elements | 4 |
| Paired | 0 |
| Missing in Native | 1 |
| Extra in Native | 5 |
| Unlabelled (not pairable by label) | 0 |
| SOURCE-UNRESOLVED labels | 1 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 0 |
| Native style properties resolved | 72 |
| PWA interactive elements | 3 |
| Native interactive elements | 8 |
| PWA conditional branches | 2 |
| Native conditional branches | 23 |
