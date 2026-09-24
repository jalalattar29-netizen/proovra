# /collaboration-teams/[teamId]

**PWA entry:** `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/collaboration-team/[id].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 21 | 5 |
| Elements | 653 | 159 |
| Interactive elements | 105 | 46 |
| Conditionally-rendered elements | 269 | 86 |
| Style rules resolved | 212 (844 props) | 76 (82 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` | 88 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell` |
| 1 | `apps/web/components/billing/PlanLimitBadge.tsx` | 5 | `PlanLimitBadge` |
| 1 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx` | 79 | `OverviewTab` |
| 2 | `apps/web/components/app-primitives/AppStatusBadge.tsx` | 2 | `AppStatusBadge` |
| 2 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 1 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx` | 86 | `MembersTab` |
| 2 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 3 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx` | 97 | `AssignmentsTab` |
| 2 | `apps/web/components/cases-experience/matter-modals/Modal.tsx` | 9 | `Modal` |
| 1 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx` | 45 | `DiscussionPanel` |
| 1 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx` | 55 | `SettingsTab` |
| 1 | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/ActivityTab.tsx` | 50 | `ActivityTab` |
| 1 | `apps/web/app/(app)/collaboration-teams/[teamId]/_components/CreateAssignmentModal.tsx` | 33 | `CreateAssignmentModal` |
| 2 | `apps/web/components/app-primitives/AppSearchSelect.tsx` | 10 | `AppSearchSelect` |

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
| BADGE | 5 | 7 | 2 |
| BUTTON | 39 | 17 | -22 |
| CARD | 0 | 10 | 10 |
| CONTAINER | 173 | 31 | -142 |
| DIALOG | 3 | 4 | 1 |
| FORM | 3 | 0 | -3 |
| HEADING | 20 | 0 | -20 |
| ICON | 85 | 0 | -85 |
| IMAGE | 1 | 0 | -1 |
| INPUT | 17 | 8 | -9 |
| LINK | 9 | 0 | -9 |
| LIST | 59 | 13 | -46 |
| OTHER | 51 | 19 | -32 |
| STATE_EMPTY | 0 | 8 | 8 |
| STATE_ERROR | 3 | 3 | 0 |
| STATE_LOADING | 0 | 6 | 6 |
| TAB | 5 | 0 | -5 |
| TEXT | 180 | 33 | -147 |

### C.1 Paired (5)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | {loadingMore ? "Loading…" : "Load more"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:562` | `apps/mobile/src/ui/collaboration-work.tsx:264` |
| BADGE | Overdue · {formatUserDate(assignment.dueAtUtc)} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:742` | `apps/mobile/src/ui/collaboration-work.tsx:252` |
| INPUT | placeholder | `apps/web/components/app-primitives/AppSearchSelect.tsx:215` | `apps/mobile/src/ui/index.tsx:340` |
| INPUT | Search members by name or email | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:313` | `apps/mobile/src/ui/collaboration-settings.tsx:199` |
| BUTTON | Delete | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx:370` | `apps/mobile/src/ui/collaboration-settings.tsx:317` |


### C.2 MISSING in Native (65)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Loading team… | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:343` |
| HEADING | Couldn&apos;t load team | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:383` |
| LINK | Back to Teams | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:408` |
| LINK | Collaboration Teams | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:538` |
| BUTTON | Create assignment | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:758` |
| BUTTON | Discussion | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:773` |
| LINK | External reviewers | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:794` |
| BUTTON | Reopen in Settings | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:908` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| LINK | Upgrade | `apps/web/components/billing/PlanLimitBadge.tsx:145` |
| HEADING | Needs attention | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:120` |
| BUTTON | Open work | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:121` |
| HEADING | Work | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:196` |
| HEADING | Who is carrying what | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:274` |
| BUTTON | Members | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:275` |
| HEADING | Team health | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:331` |
| HEADING | Your role | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:393` |
| BUTTON | Review | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:484` |
| HEADING | Members ( {activeMemberCount} ) | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:220` |
| BUTTON | Add workspace members | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:231` |
| LINK | Upgrade | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:291` |
| BUTTON | {rosterLoading ? "Loading…" : "Load more members"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:392` |
| BUTTON | Suspend | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:684` |
| BUTTON | Remove from team | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:698` |
| LINK | workspace people | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:900` |
| LINK | Invite someone to the workspace | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:942` |
| INPUT | add-member-candidate | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:981` |
| BUTTON | Cancel | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:1059` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| INPUT | Search work | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:420` |
| BUTTON | Create assignment | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:432` |
| BUTTON | Start | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:760` |
| BUTTON | Complete | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:771` |
| BUTTON | Complete | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:786` |
| BUTTON | Edit | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:809` |
| BUTTON | Remove from team | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:830` |
| DIALOG | Edit work | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:936` |
| BUTTON | Cancel | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:944` |
| BUTTON | {busy ? "Saving…" : "Save changes"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:947` |
| BUTTON | Close | `apps/web/components/cases-experience/matter-modals/Modal.tsx:223` |
| HEADING | Team discussion | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx:118` |
| INPUT | Write a comment for the team… | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx:146` |
| BUTTON | {busy ? "Posting…" : "Post comment"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx:175` |
| BUTTON | Save | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx:325` |
| BUTTON | Cancel | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx:334` |
| BUTTON | Edit | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx:361` |
| HEADING | General details | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:311` |
| BUTTON | {busy ? "Saving…" : "Save changes"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:354` |
| HEADING | Team configuration | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:369` |
| HEADING | Leadership | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:435` |
| BUTTON | {busy ? "Working…" : "Make Lead"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:475` |
| HEADING | Danger zone | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:504` |
| BADGE | Archived | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:508` |
| BUTTON | {busy ? "Reopening…" : "Reopen team"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:548` |
| BUTTON | Archive team | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:558` |
| BUTTON | Delete team | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx:626` |
| HEADING | Create assignment | `apps/web/app/(app)/collaboration-teams/[teamId]/_components/CreateAssignmentModal.tsx:193` |
| INPUT | `Search ${kind.toLowerCase()}s in this workspace` | `apps/web/app/(app)/collaboration-teams/[teamId]/_components/CreateAssignmentModal.tsx:241` |
| INPUT | targetId | `apps/web/app/(app)/collaboration-teams/[teamId]/_components/CreateAssignmentModal.tsx:272` |
| INPUT | Add context so the assignee knows what's expected. | `apps/web/app/(app)/collaboration-teams/[teamId]/_components/CreateAssignmentModal.tsx:327` |
| BUTTON | Cancel | `apps/web/app/(app)/collaboration-teams/[teamId]/_components/CreateAssignmentModal.tsx:341` |
| BUTTON | {busy ? "Creating…" : "Create assignment"} | `apps/web/app/(app)/collaboration-teams/[teamId]/_components/CreateAssignmentModal.tsx:349` |

### C.3 EXTRA in Native (35)

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
| INPUT | Group name | `apps/mobile/src/ui/collaboration-settings.tsx:200` |
| INPUT | Description | `apps/mobile/src/ui/collaboration-settings.tsx:208` |
| INPUT | What this group is for | `apps/mobile/src/ui/collaboration-settings.tsx:209` |
| STATE_EMPTY | This group's history is visible to its members. | `apps/mobile/src/ui/collaboration-settings.tsx:262` |
| STATE_EMPTY | Nothing has been recorded yet. | `apps/mobile/src/ui/collaboration-settings.tsx:267` |
| BUTTON | Load older | `apps/mobile/src/ui/collaboration-settings.tsx:282` |
| BUTTON | Reopen this group | `apps/mobile/src/ui/collaboration-settings.tsx:295` |
| BUTTON | Archive this group | `apps/mobile/src/ui/collaboration-settings.tsx:302` |
| DIALOG | pending?.kind === "archive" ? "Archive this group?" : pending?.kind === "unarchive" ? "Reopen this group?" : "Delete thi | `apps/mobile/src/ui/collaboration-settings.tsx:377` |

### C.4 SOURCE-UNRESOLVED labels (13)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:578` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:827` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:310` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:416` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:906` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:1048` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:656` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/matter-modals/Modal.tsx:219` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (212 rules, 844 properties)

**`.app-page-header`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header`

- `display`: **flex**
- `align-items`: **flex-start**
- `justify-content`: **space-between**
- `gap`: **16px**
- `flex-wrap`: **wrap**

**`.app-page-header__lead`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__lead`

- `display`: **flex**
- `align-items`: **flex-start**
- `gap`: **12px**
- `min-width`: **0**
- `flex`: **1 1 auto**

**`.app-page-header__icon`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__icon`

- `width`: **42px**
- `height`: **42px**
- `border-radius`: **12px**
- `display`: **grid**
- `place-items`: **center**
- `flex-shrink`: **0**
- `color`: **#7C3AED**
- `background`: **linear-gradient(145deg, rgba(124, 58, 237, 0.10), rgba(73, 184, 255, 0.08))**
- `border`: **1px solid rgba(124, 58, 237, 0.16)**
- `box-shadow`: **inset 0 1px 0 rgba(255, 255, 255, 0.8)**

**`.app-page-header__text`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__text`

- `min-width`: **0**

**`.app-page-header__title`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__title`

- `font-size`: **30px**
- `line-height`: **1.15**
- `font-weight`: **720**
- `letter-spacing`: **-0.025em**
- `color`: **#172033**  _(--app-ink-heading=#172033)_
- `margin`: **0**

**`.app-page-header__subtitle`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-page-header__subtitle`

- `margin`: **4px 0 0**
- `font-size`: **13.5px**
- `line-height`: **1.5**
- `color`: **#5F6878**
- `max-width`: **64ch**

**`.app-panel`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel`

- `min-width`: **0**
- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**

**`.app-skeleton`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-skeleton`

- `position`: **relative**
- `overflow`: **hidden**
- `background`: **rgba(15, 23, 42, 0.05)**
- `border-radius`: **8px**

**`.app-skeleton`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-skeleton::after`

- `content`: **""**
- `position`: **absolute**
- `inset`: **0**
- `transform`: **translateX(-100%)**
- `background`: **linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent)**
- `animation`: **app-skeleton-shimmer 1.4s infinite**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty`

- `background`: **rgba(255, 255, 255, 0.5)**
- `border`: **1px solid rgba(15, 23, 42, 0.06)**
- `border-radius`: **14px**
- `padding`: **40px 24px**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **10px**
- `align-items`: **center**
- `text-align`: **center**
- `color`: **#475569**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty strong`

- `color`: **#172033**
- `font-size`: **15px**
- `font-weight`: **700**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty p`

- `margin`: **0**
- `font-size`: **13px**
- `line-height`: **1.5**
- `max-width`: **46ch**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty[data-tone="danger"] strong`

- `color`: **#C9363E**

**`.app-empty`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty[data-tone="restricted"] strong`

- `color`: **#B45309**  _(--warning-ink=#B45309)_

**`.app-empty__icon`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty__icon`

- `width`: **52px**
- `height`: **52px**
- `border-radius`: **14px**
- `display`: **grid**
- `place-items`: **center**
- `color`: **#7C3AED**
- `background`: **linear-gradient(145deg, rgba(124, 58, 237, 0.10), rgba(73, 184, 255, 0.08))**
- `border`: **1px solid rgba(124, 58, 237, 0.16)**
- `margin-bottom`: **2px**

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

**`.ops-banner-card`** — `apps/web/components/app-shell-v2/app-shell-v2.css` · `.ops-banner-card`

- `position`: **relative**
- `overflow`: **hidden**
- `border`: **1px solid rgba(255, 255, 255, 0.06)**
- `border-radius`: **16px**
- `padding`: **16px 20px**
- `margin`: **0**
- `color`: **#f8fafc**
- `background`: **linear-gradient(       90deg,       #0b1024 0%,       #0b1024 42%,       rgba(13, 18, 42, 0.55) 74%,       rgba(16, 20, 46, 0.15) 100%     ),     url("/assets/cards/icon-card.png") right center / auto 260% no-repeat,     #0b1024**
- `box-shadow`: **0 1px 2px rgba(8, 11, 26, 0.2),     0 14px 34px rgba(8, 11, 26, 0.28)**
- `display`: **flex**
- `align-items`: **center**
- `gap`: **16px**
- `flex-wrap`: **wrap**

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



### D.2 PWA SOURCE-UNRESOLVED (28)

- ``app-tab${t === activeTab ? " is-active" : ""}`` at `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:827` — className built from a runtime expression
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-action-list` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:147` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-health-list` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:339` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-perm-details` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:409` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-perm-groups` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:413` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-perm-group` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:415` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-perm-group__title` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:416` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-perm-list` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:417` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-action-row` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:472` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-action-count` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:476` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-action-label` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:480` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-action-hint` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:481` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-health-row` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:504` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-health-label` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:505` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overview-health-detail` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/OverviewTab.tsx:516` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-status-badge${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusBadge.tsx:109` — className built from a runtime expression
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression
- `app-table-footer` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:391` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-member-capacity-badge` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:438` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- `app-table__link` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:656` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-field__help` at `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:971` — no CSS rule in apps/web and not a recognised stock Tailwind utility

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
| PWA files inspected (rendered tree) | 21 |
| Native files inspected (rendered tree) | 5 |
| PWA elements identified | 653 |
| Native elements identified | 159 |
| Pairable PWA elements | 102 |
| Paired | 3 |
| Missing in Native | 65 |
| Extra in Native | 35 |
| Unlabelled (not pairable by label) | 19 |
| SOURCE-UNRESOLVED labels | 13 |
| PWA style properties resolved | 844 |
| PWA style items SOURCE-UNRESOLVED | 28 |
| Native style properties resolved | 82 |
| PWA interactive elements | 105 |
| Native interactive elements | 46 |
| PWA conditional branches | 269 |
| Native conditional branches | 86 |
