# T-12 — remaining absent controls: dispositions + plan (session 2, 2026-09-24)

Three read-only spec passes re-checked every open T-12 row against current source.
"CLOSE" = verified present / excluded with evidence; "BUILD" = real gap.

## Verified present or excluded (close with evidence)
| Ledger row (web source) | Disposition | Evidence |
|---|---|---|
| CasesIndex.tsx:667 Risk level, :1033 Bulk action | VERIFIED_EXCLUSION — enterprise-only (`useEnterpriseSurfaceAccess`, CasesIndex.tsx:180,666,941) | native shows the self-serve Cases |
| SiuWorklistPanel.tsx:641 | VERIFIED_EXCLUSION — only in MatterWorkspace (enterprise), cases/[id]/page.tsx:52-58,85-89 | |
| PersonalSecuritySections.tsx:1848, :2008 | VERIFIED_EQUIVALENT — mis-attributed (renders on /settings#security only); native settings/security.tsx:428-433, :457-461 | fix: failed events read masked as "no events" |
| organizations/[id]/page.tsx:1016, :1472 | VERIFIED_EQUIVALENT — organizations/[id].tsx:360-383, :447-560 | fix: failed workspaces read says "visible to administrators" (route is member-readable) |
| teams/[id]/page.tsx:2235 Workspace role | VERIFIED_EQUIVALENT — workspace-people.tsx:562-594 | |
| BulkActionsToolbar.tsx:307 Target case | VERIFIED_EQUIVALENT — (tabs)/evidence.tsx:906-938,1239-1285 | |
| AssignmentsTab.tsx:964 Assignee (edit) | VERIFIED_EQUIVALENT — collaboration-work.tsx:318-374 | fix: offer ACTIVE members only |
| collaboration-teams/page.tsx:1560 Team template | VERIFIED_EQUIVALENT — (tabs)/teams.tsx:161-169 | |
| ReportsIndex.tsx:632, :656, :1543 | VERIFIED_EQUIVALENT — reports.tsx:137-166 | |
| LegalNotesPanel.tsx:79 (create) | VERIFIED_EQUIVALENT — evidence-internal-materials.tsx:226-230,389-401 | |
| evidence/[id]/page.tsx:1522 Assigned reviewer | VERIFIED_EQUIVALENT — the web select offers ONLY the current assignee; native shows it (reviewer-workflow-panel.tsx:215) | |

## Build (real gaps)
| Row | Work |
|---|---|
| search/page.tsx:1986 Sort | add `sort` (5 web modes). **Also fix: native sends `documentType=` but the API reads `documentTypes` (Type filter does nothing); `run` deps omit mode/recency (stale).** |
| verify/[token] :4612, :4634 | "Verification Failed" title; "Evidence Not Found" when no hash/signature/items (native currently shows "Verified record" — overclaim) |
| PreferencesSection.tsx:171 UI language | persist `PATCH /v1/users/me {locale}` (native kept it device-only) |
| WorkspaceMembersPanel.tsx:326 | members status filter + search (`status`, `q`) |
| ReportsIndex.tsx:671 Filters | add evidence-title search (`search`, ≤80) |
| invites accept :405, :440 | "View billing" (/billing) + "Back to Teams"; web titles; no retry that cannot succeed |
| collaboration-teams list :738,:750,:758,:766 | scope (governors) / status (includeArchived) / type / sort + search |
| LegalNotesPanel.tsx:112 | legal note EDIT (PATCH) |
| reviewer-criteria :199, :203 | version history + from/to compare (client diff) |
| MembersTab.tsx:1031 | add workspace members to a collaboration team (eligible-members + add/bulk, role) |
| WorkspaceAuditTab.tsx:129 | tenant audit list with outcome filter (`/v1/audit/tenant`), org + TEAM_MANAGE |
| EvidenceRequestAssignment.tsx:279 | assign reviewer (member picker) on /evidence-requests/[id]; send prerequisite |
| WorkspaceMemberSelect.tsx:189 | shared member picker; case Access tab (grant access) |
| TeamResponsibilityPanel.tsx:515/533/553 | record-side team responsibility (read/assign/edit/remove) on case + evidence |
| evidence/[id]/page.tsx:1447 | assign evidence to a case from the detail screen |
| EvidenceCertificationsPanel.tsx:544 | request a declaration |
| EvidenceRequestPanel.tsx:625/656 | create an evidence request from the evidence detail (intakeIncluded) |
| EvidenceDerivedReviewTab.tsx:288 | derived source keyframes (authenticated Image) |
| CaptureLocationMapPanel.tsx:101 | capture location map (OSM tiles + open in map) |
| collaboration-teams/[teamId]/page.tsx:794 | external reviewers link — needs a native /review/external destination (T-13 scope); keep open |
| steps.tsx:166, :490 (intake) | with T-16 native creation |
