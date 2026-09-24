# /organizations

**PWA entry:** `apps/web/app/(app)/organizations/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/organizations/index.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 2 |
| Elements | 132 | 52 |
| Interactive elements | 22 | 9 |
| Conditionally-rendered elements | 60 | 21 |
| Style rules resolved | 0 (0 props) | 59 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/organizations/page.tsx` | 70 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/organizations/index.tsx` | 10 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraLoadingState,ProovraErrorState,ProovraEmpty,ProovraCard,ProovraListRow,ProovraBadge,ProovraText` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 3 | 1 | -2 |
| BUTTON | 10 | 5 | -5 |
| CARD | 0 | 1 | 1 |
| CONTAINER | 29 | 21 | -8 |
| FORM | 1 | 0 | -1 |
| HEADING | 4 | 0 | -4 |
| ICON | 38 | 0 | -38 |
| INPUT | 1 | 1 | 0 |
| LINK | 7 | 0 | -7 |
| LIST | 6 | 2 | -4 |
| OTHER | 7 | 2 | -5 |
| STATE_EMPTY | 0 | 1 | 1 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 0 | 3 | 3 |
| TEXT | 23 | 14 | -9 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (22)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Organizations | `apps/web/app/(app)/organizations/page.tsx:212` |
| LINK | workspace | `apps/web/app/(app)/organizations/page.tsx:217` |
| BUTTON | Accept invite token | `apps/web/app/(app)/organizations/page.tsx:231` |
| BUTTON | About Enterprise organizations | `apps/web/app/(app)/organizations/page.tsx:243` |
| HEADING | Enterprise organizations | `apps/web/app/(app)/organizations/page.tsx:265` |
| LINK | Create a workspace | `apps/web/app/(app)/organizations/page.tsx:278` |
| BUTTON | Close | `apps/web/app/(app)/organizations/page.tsx:285` |
| HEADING | Accept invite token | `apps/web/app/(app)/organizations/page.tsx:312` |
| INPUT | Invite token | `apps/web/app/(app)/organizations/page.tsx:322` |
| BUTTON | Cancel | `apps/web/app/(app)/organizations/page.tsx:345` |
| BUTTON | {joinBusy ? "Accepting…" : "Accept invite"} | `apps/web/app/(app)/organizations/page.tsx:354` |
| BUTTON | Retry | `apps/web/app/(app)/organizations/page.tsx:382` |
| LINK | Workspace administration | `apps/web/app/(app)/organizations/page.tsx:413` |
| BUTTON | About Enterprise organizations | `apps/web/app/(app)/organizations/page.tsx:417` |
| BUTTON | Accept invite token | `apps/web/app/(app)/organizations/page.tsx:425` |
| LINK | Open | `apps/web/app/(app)/organizations/page.tsx:517` |
| LINK | Workspace admin | `apps/web/app/(app)/organizations/page.tsx:525` |
| LINK | Workspace administration | `apps/web/app/(app)/organizations/page.tsx:552` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |

### C.3 EXTRA in Native (8)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/organizations/index.tsx:74` |
| STATE_LOADING | Loading organizations | `apps/mobile/app/(stack)/organizations/index.tsx:78` |
| STATE_EMPTY | You are not a member of any organization | `apps/mobile/app/(stack)/organizations/index.tsx:84` |
| BADGE | orgRoleLabel(org.role) | `apps/mobile/app/(stack)/organizations/index.tsx:107` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (6)

| Role | PWA source | Why unpairable |
|---|---|---|
| BADGE | `apps/web/app/(app)/organizations/page.tsx:478` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/organizations/page.tsx:481` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/organizations/page.tsx:485` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (0 rules, 0 properties)

_no static classes on this route_



### D.2 PWA SOURCE-UNRESOLVED (1)

- `org-list-surface` at `apps/web/app/(app)/organizations/page.tsx:191` — no CSS rule in apps/web and not a recognised stock Tailwind utility

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
| PWA files inspected (rendered tree) | 6 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 132 |
| Native elements identified | 52 |
| Pairable PWA elements | 28 |
| Paired | 0 |
| Missing in Native | 22 |
| Extra in Native | 8 |
| Unlabelled (not pairable by label) | 0 |
| SOURCE-UNRESOLVED labels | 6 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 1 |
| Native style properties resolved | 72 |
| PWA interactive elements | 22 |
| Native interactive elements | 9 |
| PWA conditional branches | 60 |
| Native conditional branches | 21 |
