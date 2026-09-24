# /workspaces

**PWA entry:** `apps/web/app/(app)/workspaces/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/spaces.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 11 | 2 |
| Elements | 381 | 65 |
| Interactive elements | 34 | 14 |
| Conditionally-rendered elements | 129 | 33 |
| Style rules resolved | 35 (145 props) | 60 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/workspaces/page.tsx` | 3 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/navigation/OperationalBreadcrumb.tsx` | 8 | `OperationalBreadcrumb` |
| 1 | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx` | 55 | `WorkspaceAdministrationHome` |
| 2 | `apps/web/components/contextual-help/ContextualHelp.tsx` | 10 | `ContextualHelp` |
| 2 | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx` | 215 | `WorkspaceAdminPanel` |
| 3 | `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx` | 28 | `WorkspaceAuditTab` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/spaces.tsx` | 23 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraListRow,ProovraBadge,ProovraText,ProovraScreen,ProovraPageHeader,ProovraButton,ProovraLoadingState,ProovraErrorState,ProovraPageSection,ProovraCard,ProovraEmpty` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 1 | 1 |
| BUTTON | 7 | 7 | 0 |
| CARD | 0 | 3 | 3 |
| CONTAINER | 124 | 22 | -102 |
| HEADING | 25 | 0 | -25 |
| ICON | 38 | 0 | -38 |
| INPUT | 2 | 1 | -1 |
| LINK | 17 | 0 | -17 |
| LIST | 40 | 2 | -38 |
| OTHER | 22 | 8 | -14 |
| STATE_EMPTY | 0 | 2 | 2 |
| STATE_ERROR | 4 | 1 | -3 |
| STATE_LOADING | 1 | 3 | 2 |
| TAB | 8 | 0 | -8 |
| TEXT | 93 | 15 | -78 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | Organizations | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:57` | `apps/mobile/app/(stack)/spaces.tsx:221` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (43)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| HEADING | Spaces | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:51` |
| HEADING | Personal Space | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:79` |
| LINK | Manage billing | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:103` |
| LINK | Open Personal Space | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:110` |
| HEADING | Organizations · {organizations.length} | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:127` |
| LINK | Manage governance | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:194` |
| HEADING | Actions | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:216` |
| LINK | View all organizations | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:245` |
| LINK | Account billing | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:252` |
| HEADING | Legacy workspace diagnostics · {duplicates.length} | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:269` |
| LINK | Review | `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:311` |
| BUTTON | Hide | `apps/web/components/contextual-help/ContextualHelp.tsx:197` |
| HEADING | Overview | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:228` |
| HEADING | Overview | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:238` |
| LINK | Manage billing | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:271` |
| LINK | Manage integrations | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:273` |
| HEADING | Access & Roles | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:297` |
| HEADING | Access & Roles · {a.members.length} | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:306` |
| HEADING | Pending invites · {a.invites.length} | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:355` |
| HEADING | Role Permission Matrix | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:432` |
| HEADING | Governance Snapshot | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:479` |
| HEADING | Governance Snapshot | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:495` |
| LINK | Open governance control plane | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:525` |
| HEADING | Integrations Posture | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:547` |
| HEADING | Integrations Posture | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:557` |
| LINK | Manage in Integrations | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:579` |
| HEADING | Billing & Seats | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:604` |
| HEADING | Billing & Seats | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:614` |
| LINK | Open billing | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:642` |
| HEADING | Operational Accountability | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:662` |
| LINK | Reviewer Ops | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:731` |
| HEADING | Loading workspace… | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:773` |
| HEADING | Workspace not found | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:819` |
| HEADING | Temporarily unavailable | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:832` |
| HEADING | Audit history | `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:113` |
| INPUT | Filter by action (exact) | `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:121` |
| INPUT | Filter by outcome | `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:129` |
| BUTTON | Export | `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:140` |
| BUTTON | Load more | `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:184` |

### C.3 EXTRA in Native (10)

| Role | Label | Native source |
|---|---|---|
| BADGE | Working here | `apps/mobile/app/(stack)/spaces.tsx:82` |
| BUTTON | Back | `apps/mobile/app/(stack)/spaces.tsx:131` |
| STATE_LOADING | Loading your spaces | `apps/mobile/app/(stack)/spaces.tsx:140` |
| STATE_EMPTY | You do not have a Personal Space | `apps/mobile/app/(stack)/spaces.tsx:161` |
| STATE_EMPTY | You are not in any organization workspace. | `apps/mobile/app/(stack)/spaces.tsx:187` |
| BUTTON | People in this workspace | `apps/mobile/app/(stack)/spaces.tsx:226` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (9)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/navigation/OperationalBreadcrumb.tsx:91` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/navigation/OperationalBreadcrumb.tsx:103` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/navigation/OperationalBreadcrumb.tsx:123` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:135` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:178` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:799` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (35 rules, 145 properties)

**`.cc-page`** — `apps/web/components/command-center/command-center.css` · `.cc-page`

- `max-width`: **1340px**
- `margin`: **0 auto**
- `padding`: **16px 20px 32px**

**`.cc-title`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-page-heading .cc-title`

- `font-size`: **30px**
- `line-height`: **1.15**
- `font-weight`: **720**
- `letter-spacing`: **-0.025em**
- `color`: **#172033**
- `margin`: **0**

**`.cases-row`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row`

- `border`: **none**
- `border-bottom`: **1px solid rgba(15, 23, 42, 0.05)**
- `border-radius`: **0**
- `background`: **transparent**
- `transition`: **background-color 140ms ease**

**`.cases-row`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row:last-child`

- `border-bottom`: **none**

**`.cases-row`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row:hover`

- `background`: **rgba(248, 250, 252, 0.60)**

**`.cases-row-title`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row-title`

- `display`: **block**
- `max-width`: **100%**
- `font-size`: **14.5px**
- `font-weight`: **650**
- `color`: **#172033**
- `letter-spacing`: **-0.01em**
- `text-decoration`: **none**
- `overflow`: **hidden**
- `text-overflow`: **ellipsis**
- `white-space`: **nowrap**

**`.cases-row-title`** — `apps/web/components/cases-experience/cases-experience.css` · `a.cases-row-title:hover`

- `color`: **#6D28D9**

**`.cases-row-scope`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row-scope`

- `align-self`: **flex-start**
- `font-size`: **11px**
- `font-weight`: **600**
- `letter-spacing`: **0.01em**
- `color`: **#5F6B7D**
- `font-family`: **ui-monospace, "SF Mono", Menlo, Consolas, monospace**

**`.cases-row-meta`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row-meta`

- `display`: **flex**
- `gap`: **10px**
- `margin-top`: **8px**
- `font-size`: **12px**
- `color`: **#5F6B7D**
- `flex-wrap`: **wrap**
- `align-items`: **center**

**`.cases-empty`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-empty`

- `background`: **rgba(255, 255, 255, 0.5)**
- `border`: **1px solid rgba(15, 23, 42, 0.06)**
- `border-radius`: **14px**
- `padding`: **32px 24px**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **8px**
- `align-items`: **center**
- `text-align`: **center**
- `color`: **#475569**

**`.cases-empty`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-empty strong`

- `color`: **#172033**
- `font-size`: **15px**
- `font-weight`: **700**

**`.cases-empty`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-empty p`

- `margin`: **0**
- `font-size`: **13px**
- `max-width`: **42ch**

**`.cases-list`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-list`

- `list-style`: **none**
- `margin`: **0**
- `padding`: **0**
- `display`: **flex**
- `flex-direction`: **column**

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

**`.app-tabs`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-tabs.is-sticky`

- `position`: **sticky**
- `top`: **8px**
- `z-index`: **20**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**

**`.cases-row-link`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row-link`

- `display`: **grid**
- `grid-template-columns`: **minmax(200px, 2.3fr) 128px minmax(148px, 1.3fr) 104px     minmax(120px, 1fr) 128px 44px**
- `align-items`: **center**
- `gap`: **16px**

**`.cases-row-link`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-row-link:focus-visible`

- `outline`: **none**
- `box-shadow`: **inset 0 0 0 2px rgba(124, 58, 237, 0.35)**
- `border-radius`: **12px**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix`

- `width`: **100%**
- `border-collapse`: **collapse**
- `border-spacing`: **0**
- `font-size`: **13px**
- `background`: **#ffffff**
- `border`: **1px solid #e2e8f0**
- `border-radius`: **8px**
- `overflow`: **hidden**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix thead`

- `background`: **#f8fafc**
- `color`: **#475569**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix th`

- `padding`: **8px 12px**
- `text-align`: **left**
- `border-bottom`: **1px solid #f1f5f9**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix td`

- `padding`: **8px 12px**
- `text-align`: **left**
- `border-bottom`: **1px solid #f1f5f9**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix th:first-child`

- `font-weight`: **500**
- `color`: **#0f172a**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix td:first-child`

- `font-weight`: **500**
- `color`: **#0f172a**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix th + th`

- `text-align`: **center**
- `width`: **12%**
- `font-family`: **ui-monospace, "SF Mono", Menlo, Consolas, monospace**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix td + td`

- `text-align`: **center**
- `width`: **12%**
- `font-family`: **ui-monospace, "SF Mono", Menlo, Consolas, monospace**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix td[data-permission-cell="yes"]`

- `color`: **#065f46**
- `font-weight`: **600**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix td[data-permission-cell="partial"]`

- `color`: **#92400e**
- `font-weight`: **600**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix td[data-permission-cell="no"]`

- `color`: **#94a3b8**

**`.workspace-permission-matrix`** — `apps/web/components/workspace-admin/workspace-admin.css` · `.workspace-permission-matrix tbody tr:last-child td`

- `border-bottom`: **none**

**`.cases-activity-list`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-activity-list`

- `list-style`: **none**
- `margin`: **0**
- `padding`: **0**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **4px**

**`.cases-activity-row`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-activity-row`

- `display`: **flex**
- `justify-content`: **space-between**
- `align-items`: **center**
- `padding`: **10px 12px**
- `border`: **1px solid rgba(15, 23, 42, 0.045)**
- `border-radius`: **10px**
- `background`: **rgba(255, 255, 255, 0.64)**
- `font-size`: **13px**

**`.cases-activity-event`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-activity-event`

- `font-weight`: **600**
- `color`: **#172033**

**`.cases-activity-actor`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-activity-actor`

- `margin-left`: **8px**
- `font-size`: **11px**
- `color`: **#64748b**
- `font-family`: **ui-monospace, "SF Mono", Menlo, Consolas, monospace**

**`.cases-activity-time`** — `apps/web/components/cases-experience/cases-experience.css` · `.cases-activity-time`

- `font-size`: **11px**
- `color`: **#64748b**
- `font-variant-numeric`: **tabular-nums**



### D.2 PWA SOURCE-UNRESOLVED (24)

- `cc-page-header` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-kicker` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:50` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-subtitle` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:52` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:74` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section-header` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:78` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section-title` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:79` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-row-main` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:86` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-quick-action` at `apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-meta` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:157` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-tab ${tab === t.key ? "is-active" : ""}`` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:178` — className built from a runtime expression
- `cc-tile-grid` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:240` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-tile` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:241` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-tile-value` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:242` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-tile-label` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:243` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section-foot` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:264` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section-note` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:309` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cases-activity-main` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:706` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-skeleton` at `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:777` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section-sub` at `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:114` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-toolbar` at `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:120` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-input` at `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:121` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-button` at `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:140` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-empty` at `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:151` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-table` at `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:159` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (60 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 11 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 381 |
| Native elements identified | 65 |
| Pairable PWA elements | 64 |
| Paired | 0 |
| Missing in Native | 43 |
| Extra in Native | 10 |
| Unlabelled (not pairable by label) | 11 |
| SOURCE-UNRESOLVED labels | 9 |
| PWA style properties resolved | 145 |
| PWA style items SOURCE-UNRESOLVED | 24 |
| Native style properties resolved | 72 |
| PWA interactive elements | 34 |
| Native interactive elements | 14 |
| PWA conditional branches | 129 |
| Native conditional branches | 33 |
