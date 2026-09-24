# /org-invites/[token]/accept

**PWA entry:** `apps/web/app/(app)/org-invites/[token]/accept/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/org-invite/[token].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 2 |
| Elements | 77 | 66 |
| Interactive elements | 6 | 12 |
| Conditionally-rendered elements | 16 | 15 |
| Style rules resolved | 0 (0 props) | 62 (74 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/org-invites/[token]/accept/page.tsx` | 15 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/org-invite/[token].tsx` | 24 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraEmptyState,ProovraButton,ProovraErrorState,ProovraSection,ProovraCard,ProovraText` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 4 | 9 | 5 |
| CARD | 0 | 2 | 2 |
| CONTAINER | 12 | 23 | 11 |
| HEADING | 2 | 0 | -2 |
| ICON | 38 | 0 | -38 |
| INPUT | 0 | 1 | 1 |
| LINK | 2 | 0 | -2 |
| LIST | 2 | 1 | -1 |
| OTHER | 6 | 7 | 1 |
| STATE_EMPTY | 0 | 1 | 1 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 0 | 3 | 3 |
| TEXT | 8 | 18 | 10 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (7)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Accept organization invite | `apps/web/app/(app)/org-invites/[token]/accept/page.tsx:187` |
| BUTTON | Accept invite | `apps/web/app/(app)/org-invites/[token]/accept/page.tsx:195` |
| BUTTON | Open {workspaceName(workspaceId)} | `apps/web/app/(app)/org-invites/[token]/accept/page.tsx:247` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |

### C.3 EXTRA in Native (9)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | phase === "accepting" ? "Joining…" : "Checking invitation" | `apps/mobile/app/(stack)/org-invite/[token].tsx:104` |
| STATE_EMPTY | Invitation unavailable | `apps/mobile/app/(stack)/org-invite/[token].tsx:112` |
| BUTTON | Go to app | `apps/mobile/app/(stack)/org-invite/[token].tsx:115` |
| BUTTON | Accept invitation | `apps/mobile/app/(stack)/org-invite/[token].tsx:180` |
| BUTTON | Not now | `apps/mobile/app/(stack)/org-invite/[token].tsx:181` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (4)

| Role | PWA source | Why unpairable |
|---|---|---|
| LINK | `apps/web/app/(app)/org-invites/[token]/accept/page.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (0 rules, 0 properties)

_no static classes on this route_



### D.3 Native StyleSheet rules resolved (62 rules, 74 properties)

**`actions`** — `apps/mobile/app/(stack)/org-invite/[token].tsx`

- `marginTop`: **16**
- `gap`: **8**

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
| PWA elements identified | 77 |
| Native elements identified | 66 |
| Pairable PWA elements | 11 |
| Paired | 0 |
| Missing in Native | 7 |
| Extra in Native | 9 |
| Unlabelled (not pairable by label) | 0 |
| SOURCE-UNRESOLVED labels | 4 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 0 |
| Native style properties resolved | 74 |
| PWA interactive elements | 6 |
| Native interactive elements | 12 |
| PWA conditional branches | 16 |
| Native conditional branches | 15 |
