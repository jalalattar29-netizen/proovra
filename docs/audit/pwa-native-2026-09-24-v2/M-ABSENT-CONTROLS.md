# M — ADJUDICATED ABSENT CONTROLS

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5`
**Machine data:** `absent-controls.json` · per-route detail in `routes/*.md`

`ROLE_ABSENT_ON_SCREEN` is the strongest verdict the source comparison issues:
the native counterpart screen for that route contains **no element of that role
at all**, and the literal appears nowhere in the native tree. It is the class
that cannot be explained by different wording.

**101 occurrences on COMPARED routes → 63 distinct controls** after
deduplicating by source location. Each was then read individually.

---

## M.1 Deduplication first

| Source | Occurrences | Distinct |
|---|---:|---:|
| `components/ui/DataTable.tsx:182` — `TABLE "Actions"` | **33** | 1 |
| `security-center/.../PersonalSecuritySections.tsx:1848` — `"Session inventory unavailable"` | 2 | 1 |
| `security-center/.../PersonalSecuritySections.tsx:2008` — `"No security events in the recent window"` | 2 | 1 |
| `evidence/[id]/components/WorkspaceMemberSelect.tsx:189` — `SELECT "Choose a member"` | 3 | 1 |
| `collaboration/TeamResponsibilityPanel.tsx:515,533` — `SELECT "Team"`, `"Assignee"` | 4 | 2 |
| 57 single-route controls | 57 | 57 |
| **Total** | **101** | **63** |

Reporting 33 routes as 33 findings would have been a false multiplication. It is
one shared component.

## M.2 Distinct absent controls by role

| Role | Distinct | Adjudication |
|---|---:|---|
| `SELECT` | **39** | the substantive finding — see M.3 |
| `STATE_EMPTY` | 8 | empty-state copy for panes native does not render |
| `LINK` | 3 | cross-links to Enterprise surfaces |
| `NOTICE` | 3 | Home operator rollups |
| `SECTION` | 3 | whole sections |
| `LIST` | 3 | |
| `TABLE` | **1** | **VALID PLATFORM ADAPTATION** — see M.4 |
| `IMAGE` | 2 | `"Derived source keyframe"` on `/evidence/[id]` |
| `FORM` | 1 | `"Assign reviewer"` on `/evidence-requests/[id]` |

## M.3 The 39 absent SELECTs — read individually

Native **does** have picker patterns: `ProovraSheet` used as a modal picker
(`ui/capture-plan-sections.tsx:206`, `ui/collaboration-settings.tsx:343`) and
`ProovraFilterChips` (`ui/patterns.tsx:216`, rendered on 6 screens). So the
absence is never "native cannot do dropdowns". Each was checked against its
counterpart screen:

| Route | Control | Verdict | Evidence |
|---|---|---|---|
| `/cases/[id]` | **Priority** | **MISSING** | `priority` exists in native only as *collaboration-assignment* priority (`src/product/collaboration.ts:293`), never for case triage |
| `/cases/[id]` | **Assignee** | **MISSING** as a control | native parses `CaseAssignment` (`case/[id].tsx:126`) but renders no assignee picker |
| `/cases/[id]` | Team | **MISSING** | |
| `/cases` | **Risk level**, **Bulk action** | **MISSING** | neither term occurs in `(tabs)/cases.tsx` |
| `/collaboration-teams/[teamId]` | Filter by **status** | **PRESENT — adaptation** | `ui/collaboration-work.tsx:174` renders a `Status` chip group |
| `/collaboration-teams/[teamId]` | Filter by **work type** | **PRESENT — adaptation** | `collaboration-work.tsx:186` `Record` chips |
| `/collaboration-teams/[teamId]` | Filter by **assignee**, **priority** | **MISSING** | the query builder supports both (`collaboration.ts:305`) — no screen exposes them |
| `/collaboration-teams/[teamId]` | Assignee, Role in this team | **MISSING** as controls | roles are managed (`CollaborationSettingsSection`), the *select* is not the same control |
| `/collaboration-teams` | Which teams / status / type / sort / template | **MISSING** (5) | |
| `/evidence` | **Bulk action** | **PRESENT — adaptation** | `bulkActionsForScope`, `EvidenceBulkActionName` (`(tabs)/evidence.tsx:7-52`) |
| `/evidence` | Target case | **MISSING** | |
| `/evidence/[id]` | **Relationship type** | **PRESENT — adaptation** | `EVIDENCE_RELATIONSHIP_TYPES`, `relationshipTypeLabel` (`evidence/[id].tsx:38-43`) |
| `/evidence/[id]` | Select case, Assigned reviewer | **MISSING** | |
| `/evidence-requests/[id]` | Choose a member | **MISSING** | with the `Assign reviewer` FORM |
| `/intake-links` | **What are you asking for?**, **Link expires in** | **MISSING — but disclosed** | native states in product copy that link creation stays on web (`intake-links.tsx:339`). See M.5 |
| `/home` | Activity period | **MISSING** | web `EvidenceActivityChart` range selector |
| `/organizations/[id]` | New owner | **MISSING** | ownership transfer |

**Result: 39 absent SELECTs → 4 are present as a valid native adaptation, 35 are
genuinely absent controls.**

## M.4 `TABLE "Actions"` × 33 — VALID PLATFORM ADAPTATION

`apps/mobile/src/ui/patterns.tsx:23` documents the mapping explicitly:

> `apps/web/components/ui/DataTable.tsx` → `ProovraDataList (responsive rows)`

and `:26-28`:

> "Adaptation is layout only, and only where the device requires it: a table
> becomes stacked rows under the tablet breakpoint, an inspector becomes a sheet,
> hover affordances become always-visible controls."

The web's generic table renders an `Actions` column header; the native list row
carries its actions inline. **Not a defect.** The mandate warns against accepting
an adaptation on a comment alone — so this was checked against behaviour:
`ProovraDataList`/`ProovraListRow` do carry a `trailing` action slot, used
throughout (e.g. `(tabs)/index.tsx:354`, `:392`).

## M.5 Absent but honestly disclosed

`/intake-links` is the only surface where native **tells the user** what it will
not do (`intake-links.tsx:339`). The stated reason — a resend needs the raw token
the API never persists — is sound for **resend** and does **not** explain why
**creation** is web-only. Classified **partially-justified functional gap**.

## M.6 What M does not settle

The 63 controls here are the *decidable* subset. The larger
`COPY_OR_COMPOSITION_DIFF` class — **3,820 occurrences** — is where the native
screen *does* carry elements of the role but not that literal. Source alone
cannot separate "control missing" from "same control, different words" there;
resolving it requires the per-element reading demonstrated in this document,
applied to each. That remains **UNRESOLVED** and is counted as such in
`F-COVERAGE-LEDGER.md`.
