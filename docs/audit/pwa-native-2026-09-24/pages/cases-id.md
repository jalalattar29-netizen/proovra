# /cases/[id]

**PWA entry:** `apps/web/app/(app)/cases/[id]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/case/[id].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 31 | 2 |
| Elements | 1283 | 103 |
| Interactive elements | 146 | 29 |
| Conditionally-rendered elements | 799 | 53 |
| Style rules resolved | 417 (1525 props) | 82 (103 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/cases/[id]/page.tsx` | 4 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/cases-experience/MatterWorkspace.tsx` | 271 | `MatterWorkspace` |
| 2 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell` |
| 2 | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx` | 228 | `CaseDetailHeader` |
| 3 | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx` | 40 | `TeamResponsibilityPanel` |
| 4 | `apps/web/components/app-primitives/AppStatusBadge.tsx` | 2 | `AppStatusBadge` |
| 4 | `apps/web/components/cases-experience/matter-modals/Modal.tsx` | 9 | `Modal` |
| 4 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 5 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 3 | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx` | 84 | `CaseCopilotPanel` |
| 4 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 4 | `apps/web/components/ai-copilot/CopilotCitation.tsx` | 8 | `CopilotCitationList` |
| 3 | `apps/web/app/(app)/evidence/[id]/components/ReasonedActionButton.tsx` | 2 | `ReasonedActionButton` |
| 3 | `apps/web/components/cases-experience/simple-case-detail/CaseStatusSelect.tsx` | 32 | `CaseStatusSelect` |
| 2 | `apps/web/components/presence/PresenceIndicator.tsx` | 4 | `PresenceIndicator` |
| 2 | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx` | 31 | `EvidenceLinkModal` |
| 3 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 2 | `apps/web/components/cases-experience/MatterAccessTab.tsx` | 35 | `MatterAccessTab` |
| 3 | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx` | 11 | `WorkspaceMemberSelect` |
| 2 | `apps/web/app/(app)/cases/components/SiuPanel.tsx` | 111 | `SiuPanel` |
| 2 | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx` | 86 | `SiuWorklistPanel` |
| 2 | `apps/web/components/governance/GovernanceSummary.tsx` | 27 | `GovernanceSummary` |
| 3 | `apps/web/components/governance/LifecycleStateBadge.tsx` | 8 | `LifecycleStateBadge` |
| 2 | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx` | 148 | `CaseRiskPanel` |
| 2 | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx` | 28 | `AssignmentPickerModal` |
| 2 | `apps/web/components/ui/EmptyState.tsx` | 15 | `UiEmptyState` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/case/[id].tsx` | 61 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraEmptyState,ProovraButton,ProovraErrorState,ProovraCard,ProovraText,ProovraBadge,ProovraSection,ProovraListRow,ProovraFormField,ProovraInput,ProovraKpiGrid,ProovraSheet,ProovraConfirmSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 4 | 2 | -2 |
| BUTTON | 68 | 19 | -49 |
| CARD | 0 | 6 | 6 |
| CONTAINER | 271 | 27 | -244 |
| DIALOG | 9 | 2 | -7 |
| HEADING | 57 | 0 | -57 |
| ICON | 67 | 0 | -67 |
| INPUT | 24 | 5 | -19 |
| LINK | 11 | 0 | -11 |
| LIST | 211 | 4 | -207 |
| OTHER | 93 | 10 | -83 |
| STATE_EMPTY | 12 | 2 | -10 |
| STATE_ERROR | 3 | 1 | -2 |
| STATE_LOADING | 1 | 3 | 2 |
| TAB | 17 | 0 | -17 |
| TEXT | 435 | 22 | -413 |

### C.1 Paired (12)

| Role | Label | PWA | Native |
|---|---|---|---|
| STATE_EMPTY → BUTTON ⚠ | title | `apps/web/components/cases-experience/MatterWorkspace.tsx:2340` | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Cancel | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1539` | `apps/mobile/app/(stack)/case/[id].tsx:367` |
| BUTTON | {busy ? "Adding…" : "Add note"} | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2130` | `apps/mobile/app/(stack)/case/[id].tsx:447` |
| BUTTON | Delete | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2229` | `apps/mobile/app/(stack)/case/[id].tsx:472` |
| BUTTON | Save | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2430` | `apps/mobile/app/(stack)/case/[id].tsx:540` |
| BUTTON | Try again | `apps/web/components/cases-experience/MatterAccessTab.tsx:311` | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | Add evidence | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:903` | `apps/mobile/app/(stack)/case/[id].tsx:388` |
| BUTTON | Add evidence | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:999` | `apps/mobile/app/(stack)/case/[id].tsx:403` |
| BUTTON | Remove from case | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1213` | `apps/mobile/app/(stack)/case/[id].tsx:423` |
| INPUT | Write a private note for this case | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2112` | `apps/mobile/app/(stack)/case/[id].tsx:445` |
| BUTTON | Delete case | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2540` | `apps/mobile/app/(stack)/case/[id].tsx:520` |
| BUTTON | Rename | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:596` | `apps/mobile/app/(stack)/case/[id].tsx:509` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (132)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| LINK | View evidence in Search | `apps/web/components/cases-experience/MatterWorkspace.tsx:874` |
| INPUT | `Filter ${activeTab}… ( / to focus, Esc to clear)` | `apps/web/components/cases-experience/MatterWorkspace.tsx:943` |
| STATE_EMPTY | Case summary unavailable | `apps/web/components/cases-experience/MatterWorkspace.tsx:1088` |
| BUTTON | Link evidence | `apps/web/components/cases-experience/MatterWorkspace.tsx:1212` |
| STATE_EMPTY | No evidence linked yet | `apps/web/components/cases-experience/MatterWorkspace.tsx:1271` |
| HEADING | Evidence requests ( {requestRows.length} {…} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1283` |
| HEADING | Linked evidence ( {ev.items.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1329` |
| BUTTON | Unlink | `apps/web/components/cases-experience/MatterWorkspace.tsx:1373` |
| STATE_EMPTY | No events recorded yet | `apps/web/components/cases-experience/MatterWorkspace.tsx:1414` |
| STATE_EMPTY | No relationships mapped yet | `apps/web/components/cases-experience/MatterWorkspace.tsx:1452` |
| STATE_EMPTY | No holds active | `apps/web/components/cases-experience/MatterWorkspace.tsx:1494` |
| LINK | Manage legal holds | `apps/web/components/cases-experience/MatterWorkspace.tsx:1501` |
| LINK | Manage legal holds | `apps/web/components/cases-experience/MatterWorkspace.tsx:1527` |
| HEADING | Case-level holds | `apps/web/components/cases-experience/MatterWorkspace.tsx:1531` |
| HEADING | Evidence-level holds ( {filteredEvidenceHolds.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1552` |
| STATE_EMPTY | No review decisions yet | `apps/web/components/cases-experience/MatterWorkspace.tsx:1598` |
| HEADING | Active workflows ( {filteredWorkflows.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1617` |
| HEADING | Open escalations ( {filteredEscalations.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1638` |
| STATE_EMPTY | Risk projection unavailable | `apps/web/components/cases-experience/MatterWorkspace.tsx:1666` |
| STATE_EMPTY | No discussion activity yet | `apps/web/components/cases-experience/MatterWorkspace.tsx:1800` |
| HEADING | Discussion threads ( {discussionThreads.length} {…} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1808` |
| HEADING | Case-level comments ( {filteredCaseComments.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1852` |
| HEADING | Unresolved reviewer comments ( {filteredReviewerComments.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:1869` |
| BUTTON | Assign teammate | `apps/web/components/cases-experience/MatterWorkspace.tsx:2001` |
| BUTTON | Assign teammate | `apps/web/components/cases-experience/MatterWorkspace.tsx:2011` |
| HEADING | Active assignments ( {active.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:2026` |
| STATE_EMPTY | No assignments yet | `apps/web/components/cases-experience/MatterWorkspace.tsx:2041` |
| BUTTON | {removingId === a.id ? "Removing…" : "Unassign"} | `apps/web/components/cases-experience/MatterWorkspace.tsx:2062` |
| HEADING | History ( {removed.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:2079` |
| STATE_EMPTY | No audit activity in the last 30 days | `apps/web/components/cases-experience/MatterWorkspace.tsx:2133` |
| HEADING | Lifecycle states | `apps/web/components/cases-experience/MatterWorkspace.tsx:2147` |
| HEADING | Verification statuses | `apps/web/components/cases-experience/MatterWorkspace.tsx:2162` |
| HEADING | Integrity snapshots ( {filteredSnapshots.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:2177` |
| STATE_EMPTY | No deliverables ready | `apps/web/components/cases-experience/MatterWorkspace.tsx:2228` |
| HEADING | Report PDFs ( {filteredReports.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:2244` |
| HEADING | Verification Package ZIPs ( {filteredPackages.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:2263` |
| HEADING | External review links ( {filteredLinks.length} ) | `apps/web/components/cases-experience/MatterWorkspace.tsx:2284` |
| LINK | Back to cases | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:286` |
| BUTTON | Retry | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:301` |
| LINK | Cases | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:626` |
| BUTTON | Copy case ID | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:727` |
| HEADING | Quick actions | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:896` |
| BUTTON | Generate report | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:916` |
| BUTTON | Create verification package | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:930` |
| BUTTON | Share | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:944` |
| HEADING | What needs attention | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:964` |
| INPUT | Search linked evidence by name, type, or record ID | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1124` |
| BUTTON | Open | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1193` |
| INPUT | Search evidence by name, type, or record ID | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1578` |
| BUTTON | Open evidence | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1943` |
| HEADING | Private case notes | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2083` |
| BUTTON | Mark resolved | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2211` |
| HEADING | Case details | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2395` |
| HEADING | Status &amp; lifecycle | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2464` |
| INPUT | viewer.disabledReasons.changeStatus ?? undefined | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2494` |
| HEADING | Delete case | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2522` |
| BUTTON | Assign to a team | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:231` |
| BUTTON | Edit | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:300` |
| BUTTON | Remove from team | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:308` |
| DIALOG | Assign this record to a team | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:332` |
| DIALOG | `Edit ${editing.teamName}'s responsibility` | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:355` |
| DIALOG | title | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:486` |
| BUTTON | Cancel | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:494` |
| BUTTON | {busy ? "Saving…" : "Save"} | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:497` |
| BUTTON | Close | `apps/web/components/cases-experience/matter-modals/Modal.tsx:223` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| HEADING | Select evidence | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:341` |
| BUTTON | Select all | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:350` |
| BUTTON | Clear | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:359` |
| INPUT | `Select ${e.title}` | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:395` |
| HEADING | Before you run | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:473` |
| BUTTON | Retry | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:527` |
| HEADING | Evidence Operations Copilot | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:586` |
| HEADING | Advisory summary | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:653` |
| HEADING | Validated sources | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:672` |
| BUTTON | title | `apps/web/components/cases-experience/simple-case-detail/CaseStatusSelect.tsx:466` |
| BUTTON | Cancel | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:232` |
| BUTTON | {submitting ? "Linking…" : "Link evidence"} | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:241` |
| BUTTON | {state.loadingMore ? "Loading…" : "Load more evidence"} | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:414` |
| INPUT | Why is this evidence linked to the matter? | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:450` |
| HEADING | Who can open this case | `apps/web/components/cases-experience/MatterAccessTab.tsx:282` |
| BUTTON | {busy === g.id ? "Removing…" : "Remove access"} | `apps/web/components/cases-experience/MatterAccessTab.tsx:333` |
| HEADING | Active workspace members | `apps/web/components/cases-experience/MatterAccessTab.tsx:365` |
| HEADING | Give a workspace member access | `apps/web/components/cases-experience/MatterAccessTab.tsx:390` |
| INPUT | Member to give access | `apps/web/components/cases-experience/MatterAccessTab.tsx:392` |
| BUTTON | {busy === "grant" ? "Giving access…" : "Give access"} | `apps/web/components/cases-experience/MatterAccessTab.tsx:402` |
| BUTTON | Search | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:162` |
| BUTTON | {loadingMore ? "Loading more members…" : "Show more members"} | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:207` |
| HEADING | Insurance / SIU | `apps/web/app/(app)/cases/components/SiuPanel.tsx:404` |
| BUTTON | Reveal PII | `apps/web/app/(app)/cases/components/SiuPanel.tsx:456` |
| HEADING | Evidence checklist | `apps/web/app/(app)/cases/components/SiuPanel.tsx:483` |
| HEADING | Review indicators | `apps/web/app/(app)/cases/components/SiuPanel.tsx:510` |
| HEADING | SIU export | `apps/web/app/(app)/cases/components/SiuPanel.tsx:527` |
| BUTTON | Run preflight | `apps/web/app/(app)/cases/components/SiuPanel.tsx:529` |
| BUTTON | Generate SIU bundle | `apps/web/app/(app)/cases/components/SiuPanel.tsx:538` |
| INPUT | Bounded reason for exporting with warnings (≥8 chars) | `apps/web/app/(app)/cases/components/SiuPanel.tsx:561` |
| HEADING | Export history | `apps/web/app/(app)/cases/components/SiuPanel.tsx:585` |
| BUTTON | {downloadingId === h.id ? "Downloading…" : "Download"} | `apps/web/app/(app)/cases/components/SiuPanel.tsx:633` |
| HEADING | Standing limitations | `apps/web/app/(app)/cases/components/SiuPanel.tsx:668` |
| HEADING | SIU worklist | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:482` |
| BUTTON | Try again | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:507` |
| HEADING | Saved views | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:526` |
| BUTTON | Clear applied view | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:538` |
| BUTTON | Refresh results | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:547` |
| BUTTON | {busy === `use:${view.id}` ? "Running…" : "Run view"} | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:580` |
| BUTTON | Delete | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:611` |
| HEADING | Create a view | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:628` |
| INPUT | View name | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:633` |
| INPUT | Missing required evidence | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:663` |
| INPUT | Open warning indicator | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:672` |
| BUTTON | {busy === "create" ? "Saving…" : "Save view"} | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:680` |
| HEADING | {activeView ? `Results · ${activeView.name}` : "Results"} | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:692` |
| LINK | {row.claimNumber ?? `Case ${row.caseId.slice(0, 8)}…`} | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:742` |
| HEADING | Intake templates | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:762` |
| HEADING | Matter risk snapshot | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:217` |
| HEADING | AI categorization (advisory) | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:354` |
| HEADING | Immutable storage drift | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:509` |
| INPUT | Show all checks | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:519` |
| HEADING | Approval history | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:645` |
| HEADING | Activity timeline | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:722` |
| HEADING | Organizational health | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:830` |
| HEADING | Routing recommendations | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:918` |
| HEADING | Access anomalies | `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:1016` |
| BUTTON | Cancel | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:228` |
| BUTTON | {submitting ? "Adding…" : "Add assignment"} | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:237` |
| INPUT | Search by name or email | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:267` |
| BUTTON | {state.loadingMore ? "Loading…" : "Load more candidates"} | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:390` |
| INPUT | Why this assignment? Any handoff notes? | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:434` |

### C.3 EXTRA in Native (15)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Loading case | `apps/mobile/app/(stack)/case/[id].tsx:324` |
| STATE_EMPTY | Case not found | `apps/mobile/app/(stack)/case/[id].tsx:325` |
| BUTTON | Back | `apps/mobile/app/(stack)/case/[id].tsx:325` |
| BUTTON | Back | `apps/mobile/app/(stack)/case/[id].tsx:331` |
| BADGE | caseStatusDisplay(status).label | `apps/mobile/app/(stack)/case/[id].tsx:337` |
| BUTTON | `Set status ${d.label}` | `apps/mobile/app/(stack)/case/[id].tsx:346` |
| STATE_EMPTY | No evidence in this case | `apps/mobile/app/(stack)/case/[id].tsx:412` |
| INPUT | Add a note | `apps/mobile/app/(stack)/case/[id].tsx:444` |
| BUTTON | note.resolved ? "Reopen" : "Resolve" | `apps/mobile/app/(stack)/case/[id].tsx:463` |
| DIALOG | Rename this case | `apps/mobile/app/(stack)/case/[id].tsx:531` |
| INPUT | Case name | `apps/mobile/app/(stack)/case/[id].tsx:532` |
| INPUT | Case name | `apps/mobile/app/(stack)/case/[id].tsx:533` |
| BADGE | a.role \|\| "Member" | `apps/mobile/app/(stack)/case/[id].tsx:570` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |

### C.4 SOURCE-UNRESOLVED labels (34)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/MatterWorkspace.tsx:900` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/components/cases-experience/MatterWorkspace.tsx:1020` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/MatterWorkspace.tsx:1330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/components/cases-experience/MatterWorkspace.tsx:2094` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:160` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:347` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:639` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:650` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1144` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1519` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1542` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1691` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1705` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:2410` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:268` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:274` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/matter-modals/Modal.tsx:219` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:491` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:661` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/ai-copilot/CopilotCitation.tsx:63` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/ReasonedActionButton.tsx:35` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:224` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:255` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:432` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:641` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:220` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:315` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/cases-experience/matter-modals/AssignmentPickerModal.tsx:408` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (417 rules, 1525 properties)

**`.cc-page`** — `apps/web/components/command-center/command-center.css` · `.cc-page`

- `max-width`: **1340px**
- `margin`: **0 auto**
- `padding`: **16px 20px 32px**

**`.app-panel`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel`

- `min-width`: **0**
- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel__body`

- `padding`: **16px 18px**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-panels--stretch > * > .app-panel__body`

- `flex`: **1 1 auto**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel--actions-bottom > .app-panel__body`

- `display`: **flex**
- `flex-direction`: **column**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel--actions-bottom > .app-panel__body > :last-child`

- `margin-top`: **auto**

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

**`.case-detail-skel`** — `apps/web/components/cases-experience/cases-experience.css` · `.case-detail-skel`

- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **12px**

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

**`.case-detail-skel-bar`** — `apps/web/components/cases-experience/cases-experience.css` · `.case-detail-skel-bar`

- `height`: **14px**

**`.case-detail-skel-bar`** — `apps/web/components/cases-experience/cases-experience.css` · `.case-detail-skel-bar:first-child`

- `width`: **38%**

**`.case-detail-skel-bar`** — `apps/web/components/cases-experience/cases-experience.css` · `.case-detail-skel-bar:last-child`

- `width`: **62%**

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

**`.case-detail-meta-item`** — `apps/web/components/cases-experience/cases-experience.css` · `.case-detail-meta-item`

- `display`: **inline-flex**
- `align-items`: **center**
- `gap`: **4px**

**`.case-detail-dot`** — `apps/web/components/cases-experience/cases-experience.css` · `.case-detail-dot`

- `flex`: **none**
- `width`: **4px**
- `height`: **4px**
- `border-radius`: **999px**
- `background`: **currentColor**
- `opacity`: **0.4**

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



### D.2 PWA SOURCE-UNRESOLVED (31)

- `matter-workspace` at `apps/web/components/cases-experience/MatterWorkspace.tsx:774` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `matter-workspace--loading` at `apps/web/components/cases-experience/MatterWorkspace.tsx:774` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `matter-workspace--error` at `apps/web/components/cases-experience/MatterWorkspace.tsx:797` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `isActive` at `apps/web/components/cases-experience/MatterWorkspace.tsx:900` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `?` at `apps/web/components/cases-experience/MatterWorkspace.tsx:900` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-tab` at `apps/web/components/cases-experience/MatterWorkspace.tsx:900` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `is-active"` at `apps/web/components/cases-experience/MatterWorkspace.tsx:900` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `:` at `apps/web/components/cases-experience/MatterWorkspace.tsx:900` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-tab"` at `apps/web/components/cases-experience/MatterWorkspace.tsx:900` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `[CASE_BUTTON_CLASS[variant],` at `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:160` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `activeTab` at `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:347` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `===` at `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:347` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tab.id` at `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:347` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-muted` at `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:709` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section` at `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:840` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `attach-evidence__kind` at `apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx:1691` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-table__link` at `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:268` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-field__help` at `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:543` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-status-badge${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusBadge.tsx:109` — className built from a runtime expression
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression
- `app-link` at `apps/web/components/ai-copilot/CopilotCitation.tsx:63` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section-note` at `apps/web/components/cases-experience/matter-modals/EvidenceLinkModal.tsx:275` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (82 rules, 103 properties)

**`headerRow`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`hero`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `marginBottom`: **16**  _(theme.space.s4)_

**`heroSub`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `marginTop`: **12**  _(theme.space.s3)_
- `flexDirection`: **row**

**`statusRow`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginTop`: **12**  _(theme.space.s3)_

**`statusChip`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `minHeight`: **40**
- `justifyContent`: **center**

**`heroActions`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `marginTop`: **16**  _(theme.space.s4)_
- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_

**`addCard`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `marginBottom`: **16**  _(theme.space.s4)_
- `gap`: **8**  _(theme.space.s2)_

**`note`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `marginTop`: **8**  _(theme.space.s2)_

**`noteRow`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.06)**  _(theme.color.border.subtle)_
- `gap`: **2**

**`noteActions`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_

**`notesComposer`** — `apps/mobile/app/(stack)/case/[id].tsx`

- `marginBottom`: **12**  _(theme.space.s3)_
- `gap`: **8**  _(theme.space.s2)_

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
| PWA files inspected (rendered tree) | 31 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 1283 |
| Native elements identified | 103 |
| Pairable PWA elements | 206 |
| Paired | 5 |
| Missing in Native | 132 |
| Extra in Native | 15 |
| Unlabelled (not pairable by label) | 28 |
| SOURCE-UNRESOLVED labels | 34 |
| PWA style properties resolved | 1525 |
| PWA style items SOURCE-UNRESOLVED | 31 |
| Native style properties resolved | 103 |
| PWA interactive elements | 146 |
| Native interactive elements | 29 |
| PWA conditional branches | 799 |
| Native conditional branches | 53 |
