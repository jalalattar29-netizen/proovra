# /teams/[id]

**PWA entry:** `apps/web/app/(app)/teams/[id]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/workspace-people.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 27 | 3 |
| Elements | 857 | 135 |
| Interactive elements | 136 | 46 |
| Conditionally-rendered elements | 480 | 82 |
| Style rules resolved | 244 (946 props) | 63 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/teams/[id]/page.tsx` | 245 | `(entry)` |
| 1 | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx` | 62 | `WorkspaceMembersPanel` |
| 2 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 3 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 2 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 1 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx` | 31 | `WorkspaceOwnershipTransferCard` |
| 2 | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx` | 156 | `StepUpVerify` |
| 3 | `apps/web/components/ui/Card.tsx` | 11 | `Card` |
| 3 | `apps/web/components/ui/Badge.tsx` | 2 | `Badge` |
| 3 | `apps/web/components/ui/EmptyState.tsx` | 15 | `EmptyState` |
| 3 | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx` | 56 | `ContactFactorEnrollmentPanel` |
| 1 | `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx` | 31 | `WorkspaceClosureCard` |
| 1 | `apps/web/app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx` | 29 | `TeamAccessReviewCard` |
| 2 | `apps/web/components/access/AccessGate.tsx` | 2 | `AccessGate` |
| 3 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 4 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 5 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 5 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/cases-experience/matter-modals/Modal.tsx` | 9 | `Modal` |
| 1 | `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx` | 37 | `TeamPermissionMatrix` |
| 1 | `apps/web/app/(app)/teams/[id]/components/DangerConfirmModal.tsx` | 7 | `DangerConfirmModal` |
| 1 | `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx` | 27 | `MemberRemovalDialog` |
| 2 | `apps/web/components/ui-legacy.tsx` | 27 | `Button` |
| 3 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 4 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |

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
| BADGE | 4 | 2 | -2 |
| BUTTON | 75 | 19 | -56 |
| CARD | 14 | 8 | -6 |
| CONTAINER | 239 | 25 | -214 |
| DIALOG | 8 | 11 | 3 |
| FORM | 5 | 0 | -5 |
| HEADING | 26 | 0 | -26 |
| ICON | 109 | 0 | -109 |
| INPUT | 21 | 9 | -12 |
| LINK | 8 | 0 | -8 |
| LIST | 75 | 6 | -69 |
| OTHER | 48 | 9 | -39 |
| STATE_EMPTY | 2 | 10 | 8 |
| STATE_ERROR | 4 | 1 | -3 |
| STATE_LOADING | 1 | 4 | 3 |
| TEXT | 218 | 31 | -187 |

### C.1 Paired (15)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Try again | `apps/web/app/(app)/teams/[id]/page.tsx:1219` | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | Resend | `apps/web/app/(app)/teams/[id]/page.tsx:1624` | `apps/mobile/app/(stack)/workspace-people.tsx:625` |
| BUTTON | Revoke | `apps/web/app/(app)/teams/[id]/page.tsx:1643` | `apps/mobile/app/(stack)/workspace-people.tsx:632` |
| INPUT | Workspace name | `apps/web/app/(app)/teams/[id]/page.tsx:1924` | `apps/mobile/app/(stack)/workspace-people.tsx:916` |
| BUTTON | {showAddCase ? "Close" : "Link a case"} | `apps/web/app/(app)/teams/[id]/page.tsx:2075` | `apps/mobile/app/(stack)/workspace-people.tsx:683` |
| BUTTON | {loadingMore ? "Loading…" : "Load more"} | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx:501` | `apps/mobile/app/(stack)/workspace-people.tsx:553` |
| BUTTON | Close this workspace… | `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx:351` | `apps/mobile/app/(stack)/workspace-people.tsx:762` |
| BUTTON | Request closure | `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx:385` | `apps/mobile/app/(stack)/workspace-people.tsx:840` |
| DIALOG → BUTTON ⚠ | title | `apps/web/app/(app)/teams/[id]/components/DangerConfirmModal.tsx:98` | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | {isEditingName ? "Cancel" : "Rename"} | `apps/web/app/(app)/teams/[id]/page.tsx:1900` | `apps/mobile/app/(stack)/workspace-people.tsx:504` |
| BUTTON | {savingName ? "Saving…" : "Save name"} | `apps/web/app/(app)/teams/[id]/page.tsx:1932` | `apps/mobile/app/(stack)/workspace-people.tsx:924` |
| DIALOG | Invite a person to this workspace | `apps/web/app/(app)/teams/[id]/page.tsx:2189` | `apps/mobile/app/(stack)/workspace-people.tsx:814` |
| BUTTON | Cancel | `apps/web/app/(app)/teams/[id]/page.tsx:2197` | `apps/mobile/app/(stack)/workspace-people.tsx:740` |
| INPUT | colleague@example.com | `apps/web/app/(app)/teams/[id]/page.tsx:2221` | `apps/mobile/app/(stack)/workspace-people.tsx:572` |
| BUTTON | Confirm transfer | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:519` | `apps/mobile/src/ui/step-up-sheet.tsx:89` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (99)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Members &amp; Access | `apps/web/app/(app)/teams/[id]/page.tsx:1112` |
| HEADING | Members &amp; Access | `apps/web/app/(app)/teams/[id]/page.tsx:1202` |
| LINK | Back to workspaces | `apps/web/app/(app)/teams/[id]/page.tsx:1227` |
| HEADING | Members &amp; Access | `apps/web/app/(app)/teams/[id]/page.tsx:1312` |
| BUTTON | Role permissions | `apps/web/app/(app)/teams/[id]/page.tsx:1332` |
| BUTTON | Invite person | `apps/web/app/(app)/teams/[id]/page.tsx:1341` |
| LINK | Open Cases | `apps/web/app/(app)/teams/[id]/page.tsx:1454` |
| LINK | Review plan and seats | `apps/web/app/(app)/teams/[id]/page.tsx:1471` |
| HEADING | Pending invitations | `apps/web/app/(app)/teams/[id]/page.tsx:1540` |
| BUTTON | Try again | `apps/web/app/(app)/teams/[id]/page.tsx:1564` |
| HEADING | Recent activity | `apps/web/app/(app)/teams/[id]/page.tsx:1704` |
| HEADING | Workspace lifecycle | `apps/web/app/(app)/teams/[id]/page.tsx:1768` |
| HEADING | Delete this workspace | `apps/web/app/(app)/teams/[id]/page.tsx:1810` |
| BUTTON | {deletingTeam ? "Deleting…" : "Delete workspace"} | `apps/web/app/(app)/teams/[id]/page.tsx:1818` |
| HEADING | Invite people | `apps/web/app/(app)/teams/[id]/page.tsx:1848` |
| BUTTON | Invite person | `apps/web/app/(app)/teams/[id]/page.tsx:1859` |
| HEADING | Workspace overview | `apps/web/app/(app)/teams/[id]/page.tsx:1898` |
| LINK | Open billing | `apps/web/app/(app)/teams/[id]/page.tsx:1980` |
| HEADING | Collaboration Teams | `apps/web/app/(app)/teams/[id]/page.tsx:2011` |
| LINK | Organise members | `apps/web/app/(app)/teams/[id]/page.tsx:2040` |
| HEADING | Cases in this workspace | `apps/web/app/(app)/teams/[id]/page.tsx:2073` |
| BUTTON | {linkingCaseId === c.id ? "Linking…" : "Link"} | `apps/web/app/(app)/teams/[id]/page.tsx:2126` |
| BUTTON | Remove | `apps/web/app/(app)/teams/[id]/page.tsx:2164` |
| BUTTON | {inviting ? "Sending…" : "Send invitation"} | `apps/web/app/(app)/teams/[id]/page.tsx:2204` |
| DIALOG | What each role can do | `apps/web/app/(app)/teams/[id]/page.tsx:2261` |
| BUTTON | Close | `apps/web/app/(app)/teams/[id]/page.tsx:2268` |
| HEADING | Members | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx:295` |
| INPUT | canManageTeam ? "Search by name or email" : "Search by name" | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx:315` |
| BUTTON | Try again | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx:344` |
| BUTTON | Invite person | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx:375` |
| BUTTON | Remove | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx:469` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| HEADING | Transfer ownership | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:353` |
| BUTTON | Try again | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:373` |
| BUTTON | Show more members | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:462` |
| BUTTON | Transfer ownership… | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:483` |
| BUTTON | Keep ownership | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:530` |
| HEADING | Change password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:419` |
| INPUT | Current password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:433` |
| INPUT | New password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:445` |
| INPUT | Confirm new password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:457` |
| INPUT | Sign out my other sessions after the change | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:477` |
| BUTTON | Change password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:490` |
| BUTTON | Verify &amp; continue | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:621` |
| BUTTON | Cancel | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:632` |
| BUTTON | Close | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:646` |
| HEADING | Sign-in methods | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:921` |
| BUTTON | Add password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:977` |
| BUTTON | Connect | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:986` |
| BUTTON | Disconnect | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1004` |
| INPUT | New password (12+ chars, upper- and lower-case, a number) | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1032` |
| BUTTON | {busy ? "Adding…" : "Add password"} | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1043` |
| HEADING | Two-factor authentication | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1333` |
| BUTTON | {busy ? "Starting…" : "Set up two-factor authentication"} | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1348` |
| BADGE | Active | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1386` |
| BUTTON | Remove | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1390` |
| BUTTON | Regenerate recovery codes | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1403` |
| INPUT | 6-digit code from your app | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1469` |
| BUTTON | Verify &amp; enable | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1485` |
| BUTTON | Cancel | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1500` |
| INPUT | I saved these recovery codes in a safe place. | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1553` |
| BUTTON | Done | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1562` |
| BADGE | Current session | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1759` |
| BADGE | Restricted | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1764` |
| BUTTON | Sign out | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1773` |
| HEADING | Your active sessions | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1822` |
| BUTTON | Sign out other sessions | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1828` |
| STATE_EMPTY | Session inventory unavailable | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1848` |
| HEADING | Account &amp; security activity | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1996` |
| STATE_EMPTY | No security events in the recent window | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2008` |
| BUTTON | View more ( {rows.length - visibleCount} older) | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2090` |
| HEADING | Verified contact device | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:601` |
| BUTTON | {revokingId === f.factorId ? "Revoking…" : "Revoke"} | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:655` |
| BUTTON | Replace this device | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:675` |
| INPUT | Work handset | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:783` |
| BUTTON | Cancel | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:809` |
| BUTTON | Start over | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:938` |
| HEADING | Close workspace | `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx:264` |
| BUTTON | Cancel closure request | `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx:316` |
| BUTTON | Keep this workspace | `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx:395` |
| BUTTON | Reopen workspace | `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx:430` |
| HEADING | External collaborators | `apps/web/app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx:224` |
| BUTTON | Try again | `apps/web/app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx:239` |
| BUTTON | {open ? "Hide cases" : `Show cases for ${who}`} | `apps/web/app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx:312` |
| BUTTON | Revoke access | `apps/web/app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx:338` |
| STATE_ERROR | headline | `apps/web/components/access/AccessGate.tsx:200` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | Close | `apps/web/components/cases-experience/matter-modals/Modal.tsx:223` |
| HEADING | Who can do what | `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:217` |
| BUTTON | Try again | `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:279` |
| BUTTON | {pending ? "Working…" : confirmLabel} | `apps/web/app/(app)/teams/[id]/components/DangerConfirmModal.tsx:140` |
| DIALOG | `Remove ${member.label}` | `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx:232` |
| BUTTON | Cancel | `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx:243` |
| BUTTON | {submitting ? "Removing…" : "Remove member"} | `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx:251` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |

### C.3 EXTRA in Native (25)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/workspace-people.tsx:466` |
| STATE_EMPTY | No workspace is selected | `apps/mobile/app/(stack)/workspace-people.tsx:471` |
| STATE_LOADING | Loading people | `apps/mobile/app/(stack)/workspace-people.tsx:478` |
| BADGE | overview.effectivePlan | `apps/mobile/app/(stack)/workspace-people.tsx:501` |
| STATE_EMPTY | No members are listed. | `apps/mobile/app/(stack)/workspace-people.tsx:518` |
| BADGE | m.status | `apps/mobile/app/(stack)/workspace-people.tsx:544` |
| INPUT | Email address | `apps/mobile/app/(stack)/workspace-people.tsx:571` |
| STATE_EMPTY | Invitations are managed by workspace admins. | `apps/mobile/app/(stack)/workspace-people.tsx:601` |
| STATE_EMPTY | No invitations are outstanding. | `apps/mobile/app/(stack)/workspace-people.tsx:606` |
| STATE_EMPTY | Linked cases are visible to workspace members. | `apps/mobile/app/(stack)/workspace-people.tsx:648` |
| STATE_EMPTY | No cases are linked to this workspace yet. | `apps/mobile/app/(stack)/workspace-people.tsx:653` |
| BUTTON | Unlink | `apps/mobile/app/(stack)/workspace-people.tsx:670` |
| STATE_EMPTY | Workspace activity is visible to workspace members. | `apps/mobile/app/(stack)/workspace-people.tsx:694` |
| STATE_EMPTY | Nothing has happened here yet. | `apps/mobile/app/(stack)/workspace-people.tsx:699` |
| STATE_EMPTY | There is no other active member to transfer ownership to. | `apps/mobile/app/(stack)/workspace-people.tsx:784` |
| INPUT | Type the confirmation phrase | `apps/mobile/app/(stack)/workspace-people.tsx:825` |
| INPUT | closure?.confirmationPhrase ?? "" | `apps/mobile/app/(stack)/workspace-people.tsx:826` |
| STATE_LOADING | Loading your cases | `apps/mobile/app/(stack)/workspace-people.tsx:897` |
| STATE_EMPTY | There is no case to link. | `apps/mobile/app/(stack)/workspace-people.tsx:899` |
| DIALOG | Rename this workspace | `apps/mobile/app/(stack)/workspace-people.tsx:911` |
| INPUT | Workspace name | `apps/mobile/app/(stack)/workspace-people.tsx:917` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| INPUT | field.label | `apps/mobile/src/ui/step-up-sheet.tsx:78` |
| INPUT | field.placeholder | `apps/mobile/src/ui/step-up-sheet.tsx:79` |

### C.4 SOURCE-UNRESOLVED labels (34)

| Role | PWA source | Why unpairable |
|---|---|---|
| LINK | `apps/web/app/(app)/teams/[id]/page.tsx:2156` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/teams/[id]/page.tsx:2285` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/teams/[id]/page.tsx:2299` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/teams/[id]/page.tsx:2313` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:400` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx:417` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:603` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:910` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1332` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1811` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1873` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1995` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Card.tsx:250` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:719` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:740` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:796` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:856` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:901` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:917` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/matter-modals/Modal.tsx:219` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:394` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/teams/[id]/components/DangerConfirmModal.tsx:131` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx:343` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (244 rules, 946 properties)

**`.section`** — `apps/web/app/globals.css` · `.section`

- `padding`: **120px 0 160px**

**`.section`** — `apps/web/app/globals.css` · `html[dir="rtl"] .section`

- `direction`: **rtl**
- `text-align`: **right**

**`.app-section`** — `apps/web/app/globals.css` · `.app-section`

- `padding`: **0**
- `flex`: **1**
- `display`: **flex**
- `flex-direction`: **column**

**`.app-section-stack`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-section-stack`

- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **16px**

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

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > .app-kpi-card`

- `height`: **100%**

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > li`

- `min-width`: **0**

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > li > .app-metric-card`

- `height`: **100%**

**`.app-grid-kpis`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis`

- `display`: **grid**
- `grid-template-columns`: **repeat(4, minmax(0, 1fr))**
- `gap`: **12px**
- `margin`: **0**
- `padding`: **0**
- `list-style`: **none**

**`.app-kpi-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-kpi-card`

- `background`: **rgba(255, 255, 255, 0.5)**
- `border`: **1px solid rgba(255, 255, 255, 0.6)**
- `border-radius`: **14px**
- `padding`: **16px 16px 14px**
- `box-shadow`: **0 6px 18px rgba(15, 23, 42, 0.03)**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **4px**
- `min-width`: **0**

**`.app-kpi-card`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-kpis > .app-kpi-card`

- `height`: **100%**

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

**`.app-table-surface`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-table-surface`

- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**
- `overflow`: **hidden**

**`.app-skeleton-row`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-skeleton-row`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **16px**
- `padding`: **14px 18px**
- `border-bottom`: **1px solid rgba(15, 23, 42, 0.06)**

**`.app-skeleton-row`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-skeleton-row:last-of-type`

- `border-bottom`: **0**

**`.app-visually-hidden`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-visually-hidden`

- `position`: **absolute**
- `inline-size`: **1px**
- `block-size`: **1px**
- `margin`: **-1px**
- `padding`: **0**
- `overflow`: **hidden**
- `clip-path`: **inset(50%)**
- `white-space`: **nowrap**
- `border`: **0**

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

**`.app-empty__actions`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-empty__actions`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `justify-content`: **center**
- `gap`: **8px**
- `margin-top`: **2px**

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

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action svg`

- `flex`: **0 0 auto**

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


**Stock Tailwind utilities used (10).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.mb-4` → {"kind":"margin","side":"b","value":"16px"}
- `.m-0` → {"kind":"margin","side":"all","value":"0px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-1` → {"kind":"margin","side":"t","value":"4px"}
- `.p-5` → {"kind":"padding","side":"all","value":"20px"}
- `.mt-3` → {"kind":"margin","side":"t","value":"12px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.font-medium` → {"kind":"font-weight","value":500}


### D.2 PWA SOURCE-UNRESOLVED (29)

- `app-table__link` at `apps/web/app/(app)/teams/[id]/page.tsx:1454` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-field__help` at `apps/web/app/(app)/teams/[id]/page.tsx:2247` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-card",` at `apps/web/components/ui/Card.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-badge",` at `apps/web/components/ui/Badge.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-empty-state",` at `apps/web/components/ui/EmptyState.tsx:128` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-alert ${outcome.tone === "ok" ? "app-alert--ok" : "app-alert--danger"}`` at `apps/web/app/(app)/teams/[id]/components/TeamAccessReviewCard.tsx:267` — className built from a runtime expression
- `text-[1.1rem]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:217` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.02em]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:217` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#172033]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:217` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12.5px]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:220` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-snug` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:220` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#5F6B7D]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:220` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:p-6` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:238` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:279` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(15,23,42,0.12)]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:279` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:279` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12px]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:279` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `overflow-x-auto` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:317` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[11.5px]` at `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:463` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `finalClassName` at `apps/web/components/ui-legacy.tsx:163` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``card ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:179` — className built from a runtime expression
- ``input ${error ? "input-has-error" : ""} ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:293` — className built from a runtime expression
- ``select ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:360` — className built from a runtime expression

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
| PWA files inspected (rendered tree) | 27 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 857 |
| Native elements identified | 135 |
| Pairable PWA elements | 163 |
| Paired | 8 |
| Missing in Native | 99 |
| Extra in Native | 25 |
| Unlabelled (not pairable by label) | 15 |
| SOURCE-UNRESOLVED labels | 34 |
| PWA style properties resolved | 946 |
| PWA style items SOURCE-UNRESOLVED | 29 |
| Native style properties resolved | 72 |
| PWA interactive elements | 136 |
| Native interactive elements | 46 |
| PWA conditional branches | 480 |
| Native conditional branches | 82 |
