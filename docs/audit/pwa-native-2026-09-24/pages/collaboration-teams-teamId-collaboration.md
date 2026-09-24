# /collaboration-teams/[teamId]/collaboration

**PWA entry:** `apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/collaboration-team/[id].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 1 | 5 |
| Elements | 2 | 159 |
| Interactive elements | 0 | 46 |
| Conditionally-rendered elements | 0 | 86 |
| Style rules resolved | 1 (3 props) | 76 (82 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` | 2 | `(entry)` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/collaboration-team/[id].tsx` | 32 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraEmptyState,ProovraButton,ProovraErrorState,ProovraCard,ProovraText,ProovraBadge,ProovraSection,ProovraListRow` |
| 1 | `apps/mobile/src/ui/discussion-section.tsx` | 30 | `DiscussionSection` |
| 1 | `apps/mobile/src/ui/collaboration-work.tsx` | 24 | `CollaborationWorkSection` |
| 1 | `apps/mobile/src/ui/collaboration-settings.tsx` | 31 | `CollaborationSettingsSection` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 7 | 7 |
| BUTTON | 0 | 17 | 17 |
| CARD | 0 | 10 | 10 |
| CONTAINER | 1 | 31 | 30 |
| DIALOG | 0 | 4 | 4 |
| INPUT | 0 | 8 | 8 |
| LIST | 0 | 13 | 13 |
| OTHER | 0 | 19 | 19 |
| STATE_EMPTY | 0 | 8 | 8 |
| STATE_ERROR | 0 | 3 | 3 |
| STATE_LOADING | 0 | 6 | 6 |
| TEXT | 1 | 33 | 32 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (0)

_none_

### C.3 EXTRA in Native (40)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Loading group | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:81` |
| STATE_EMPTY | Not available | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:82` |
| BUTTON | Back | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:82` |
| STATE_EMPTY | Group not found | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:83` |
| BUTTON | Back | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:83` |
| BUTTON | Back | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:90` |
| BADGE | collaborationRoleLabel(t.viewerRole) ?? "Member" | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:97` |
| BADGE | collaborationRoleLabel(m.role) ?? "Member" | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:115` |
| BADGE | inv.status ? humanizeEnum(inv.status) : "Pending" | `apps/mobile/app/(stack)/collaboration-team/[id].tsx:130` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | Back to discussions | `apps/mobile/src/ui/discussion-section.tsx:130` |
| BADGE | threadStatusLabel(open.status) | `apps/mobile/src/ui/discussion-section.tsx:136` |
| STATE_LOADING | Loading messages | `apps/mobile/src/ui/discussion-section.tsx:139` |
| STATE_EMPTY | No messages in this thread yet. | `apps/mobile/src/ui/discussion-section.tsx:142` |
| INPUT | Reply | `apps/mobile/src/ui/discussion-section.tsx:169` |
| INPUT | Write a message | `apps/mobile/src/ui/discussion-section.tsx:170` |
| BUTTON | Send | `apps/mobile/src/ui/discussion-section.tsx:178` |
| BUTTON | nextTransition(open) === "resolve" ? "Resolve thread" : "Reopen thread" | `apps/mobile/src/ui/discussion-section.tsx:184` |
| STATE_LOADING | Loading discussions | `apps/mobile/src/ui/discussion-section.tsx:197` |
| STATE_EMPTY | Discussions are open to reviewers in this group. | `apps/mobile/src/ui/discussion-section.tsx:202` |
| STATE_EMPTY | No discussions in this group yet. | `apps/mobile/src/ui/discussion-section.tsx:214` |
| BADGE | threadStatusLabel(t.status) | `apps/mobile/src/ui/discussion-section.tsx:248` |
| STATE_LOADING | Loading work | `apps/mobile/src/ui/collaboration-work.tsx:198` |
| STATE_EMPTY | status === ALL && targetType === ALL && search.trim().length === 0 ? "This group has no assignments yet." : "No work mat | `apps/mobile/src/ui/collaboration-work.tsx:213` |
| BADGE | Overdue | `apps/mobile/src/ui/collaboration-work.tsx:252` |
| BUTTON | Load more | `apps/mobile/src/ui/collaboration-work.tsx:264` |
| INPUT | Name | `apps/mobile/src/ui/collaboration-settings.tsx:199` |
| INPUT | Group name | `apps/mobile/src/ui/collaboration-settings.tsx:200` |
| INPUT | Description | `apps/mobile/src/ui/collaboration-settings.tsx:208` |
| INPUT | What this group is for | `apps/mobile/src/ui/collaboration-settings.tsx:209` |
| STATE_EMPTY | This group's history is visible to its members. | `apps/mobile/src/ui/collaboration-settings.tsx:262` |
| STATE_EMPTY | Nothing has been recorded yet. | `apps/mobile/src/ui/collaboration-settings.tsx:267` |
| BUTTON | Load older | `apps/mobile/src/ui/collaboration-settings.tsx:282` |
| BUTTON | Reopen this group | `apps/mobile/src/ui/collaboration-settings.tsx:295` |
| BUTTON | Archive this group | `apps/mobile/src/ui/collaboration-settings.tsx:302` |
| BUTTON | Delete this group | `apps/mobile/src/ui/collaboration-settings.tsx:317` |
| DIALOG | pending?.kind === "archive" ? "Archive this group?" : pending?.kind === "unarchive" ? "Reopen this group?" : "Delete thi | `apps/mobile/src/ui/collaboration-settings.tsx:377` |

### C.4 SOURCE-UNRESOLVED labels (0)

_none_

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (1 rules, 3 properties)

**`.cc-page`** — `apps/web/components/command-center/command-center.css` · `.cc-page`

- `max-width`: **1340px**
- `margin`: **0 auto**
- `padding`: **16px 20px 32px**



### D.2 PWA SOURCE-UNRESOLVED (1)

- `app-empty__body` at `apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx:40` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (76 rules, 82 properties)

**`headerRow`** — `apps/mobile/app/(stack)/collaboration-team/[id].tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`hero`** — `apps/mobile/app/(stack)/collaboration-team/[id].tsx`

- `marginBottom`: **16**  _(theme.space.s4)_

**`gap`** — `apps/mobile/app/(stack)/collaboration-team/[id].tsx`

- `marginTop`: **8**  _(theme.space.s2)_

**`metaRow`** — `apps/mobile/app/(stack)/collaboration-team/[id].tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginTop`: **12**  _(theme.space.s3)_

**`note`** — `apps/mobile/app/(stack)/collaboration-team/[id].tsx`

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
| PWA files inspected (rendered tree) | 1 |
| Native files inspected (rendered tree) | 5 |
| PWA elements identified | 2 |
| Native elements identified | 159 |
| Pairable PWA elements | 0 |
| Paired | 0 |
| Missing in Native | 0 |
| Extra in Native | 40 |
| Unlabelled (not pairable by label) | 0 |
| SOURCE-UNRESOLVED labels | 0 |
| PWA style properties resolved | 3 |
| PWA style items SOURCE-UNRESOLVED | 1 |
| Native style properties resolved | 82 |
| PWA interactive elements | 0 |
| Native interactive elements | 46 |
| PWA conditional branches | 0 |
| Native conditional branches | 86 |
