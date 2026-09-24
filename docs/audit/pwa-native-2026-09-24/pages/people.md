# /people

**PWA entry:** `apps/web/app/(app)/people/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/workspace-people.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 3 |
| Elements | 67 | 135 |
| Interactive elements | 3 | 46 |
| Conditionally-rendered elements | 6 | 82 |
| Style rules resolved | 0 (0 props) | 63 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/people/page.tsx` | 5 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/workspace-people.tsx` | 85 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraEmpty,ProovraLoadingState,ProovraErrorState,ProovraCard,ProovraText,ProovraBadge,ProovraPageSection,ProovraListRow,ProovraFormField,ProovraInput,ProovraFilterChips,ProovraSheet,ProovraConfirmSheet` |
| 1 | `apps/mobile/src/ui/step-up-sheet.tsx` | 8 | `StepUpSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 2 | 2 |
| BUTTON | 2 | 19 | 17 |
| CARD | 0 | 8 | 8 |
| CONTAINER | 7 | 25 | 18 |
| DIALOG | 0 | 11 | 11 |
| HEADING | 1 | 0 | -1 |
| ICON | 38 | 0 | -38 |
| INPUT | 0 | 9 | 9 |
| LINK | 1 | 0 | -1 |
| LIST | 0 | 6 | 6 |
| OTHER | 8 | 9 | 1 |
| STATE_EMPTY | 0 | 10 | 10 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 0 | 4 | 4 |
| TEXT | 7 | 31 | 24 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (4)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |

### C.3 EXTRA in Native (40)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/workspace-people.tsx:466` |
| STATE_EMPTY | No workspace is selected | `apps/mobile/app/(stack)/workspace-people.tsx:471` |
| STATE_LOADING | Loading people | `apps/mobile/app/(stack)/workspace-people.tsx:478` |
| BADGE | overview.effectivePlan | `apps/mobile/app/(stack)/workspace-people.tsx:501` |
| BUTTON | Rename workspace | `apps/mobile/app/(stack)/workspace-people.tsx:504` |
| STATE_EMPTY | No members are listed. | `apps/mobile/app/(stack)/workspace-people.tsx:518` |
| BADGE | m.status | `apps/mobile/app/(stack)/workspace-people.tsx:544` |
| BUTTON | Load more | `apps/mobile/app/(stack)/workspace-people.tsx:553` |
| INPUT | Email address | `apps/mobile/app/(stack)/workspace-people.tsx:571` |
| INPUT | name@example.com | `apps/mobile/app/(stack)/workspace-people.tsx:572` |
| STATE_EMPTY | Invitations are managed by workspace admins. | `apps/mobile/app/(stack)/workspace-people.tsx:601` |
| STATE_EMPTY | No invitations are outstanding. | `apps/mobile/app/(stack)/workspace-people.tsx:606` |
| BUTTON | Resend | `apps/mobile/app/(stack)/workspace-people.tsx:625` |
| BUTTON | Revoke | `apps/mobile/app/(stack)/workspace-people.tsx:632` |
| STATE_EMPTY | Linked cases are visible to workspace members. | `apps/mobile/app/(stack)/workspace-people.tsx:648` |
| STATE_EMPTY | No cases are linked to this workspace yet. | `apps/mobile/app/(stack)/workspace-people.tsx:653` |
| BUTTON | Unlink | `apps/mobile/app/(stack)/workspace-people.tsx:670` |
| BUTTON | Link a case | `apps/mobile/app/(stack)/workspace-people.tsx:683` |
| STATE_EMPTY | Workspace activity is visible to workspace members. | `apps/mobile/app/(stack)/workspace-people.tsx:694` |
| STATE_EMPTY | Nothing has happened here yet. | `apps/mobile/app/(stack)/workspace-people.tsx:699` |
| BUTTON | Cancel the closure request | `apps/mobile/app/(stack)/workspace-people.tsx:740` |
| BUTTON | Close this workspace | `apps/mobile/app/(stack)/workspace-people.tsx:762` |
| STATE_EMPTY | There is no other active member to transfer ownership to. | `apps/mobile/app/(stack)/workspace-people.tsx:784` |
| DIALOG | Close this workspace | `apps/mobile/app/(stack)/workspace-people.tsx:814` |
| INPUT | Type the confirmation phrase | `apps/mobile/app/(stack)/workspace-people.tsx:825` |
| INPUT | closure?.confirmationPhrase ?? "" | `apps/mobile/app/(stack)/workspace-people.tsx:826` |
| BUTTON | Request closure | `apps/mobile/app/(stack)/workspace-people.tsx:840` |
| STATE_LOADING | Loading your cases | `apps/mobile/app/(stack)/workspace-people.tsx:897` |
| STATE_EMPTY | There is no case to link. | `apps/mobile/app/(stack)/workspace-people.tsx:899` |
| DIALOG | Rename this workspace | `apps/mobile/app/(stack)/workspace-people.tsx:911` |
| INPUT | Workspace name | `apps/mobile/app/(stack)/workspace-people.tsx:916` |
| INPUT | Workspace name | `apps/mobile/app/(stack)/workspace-people.tsx:917` |
| BUTTON | Save | `apps/mobile/app/(stack)/workspace-people.tsx:924` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| INPUT | field.label | `apps/mobile/src/ui/step-up-sheet.tsx:78` |
| INPUT | field.placeholder | `apps/mobile/src/ui/step-up-sheet.tsx:79` |
| BUTTON | Confirm | `apps/mobile/src/ui/step-up-sheet.tsx:89` |

### C.4 SOURCE-UNRESOLVED labels (3)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (0 rules, 0 properties)

_no static classes on this route_



### D.3 Native StyleSheet rules resolved (63 rules, 72 properties)

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
| PWA elements identified | 67 |
| Native elements identified | 135 |
| Pairable PWA elements | 7 |
| Paired | 0 |
| Missing in Native | 4 |
| Extra in Native | 40 |
| Unlabelled (not pairable by label) | 0 |
| SOURCE-UNRESOLVED labels | 3 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 0 |
| Native style properties resolved | 72 |
| PWA interactive elements | 3 |
| Native interactive elements | 46 |
| PWA conditional branches | 6 |
| Native conditional branches | 82 |
