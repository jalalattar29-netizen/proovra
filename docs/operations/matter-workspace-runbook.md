# Matter Workspace — Phase C1 Runbook

**Audience:** investigators, reviewers, ops leads, customer success.

**Purpose:** describe PROOVRA's canonical Matter Workspace at `/cases/[id]`, what each of the eleven tabs surfaces, how empty + degraded states are handled, and how it relates to the existing scroll-spy CaseWorkspace surface.

---

## 1. The workspace at a glance

The `/cases/[id]` route is the **canonical Matter Workspace**. It is a tabbed operator surface above the Phase 32.8D matter envelope (`GET /v1/cases/:id/matter-workspace`). Eleven tabs surface the eleven operational facets of a matter:

| Tab | Envelope slice | What it shows |
|---|---|---|
| **Overview** | `sections.commandSummary` | At-a-glance posture tiles (linked evidence, holds, pending review, escalations, assignments) |
| **Evidence** | `sections.evidence` | Linked evidence rows with type / status / verification / lifecycle / artifact readiness |
| **Timeline** | `sections.timeline` | Deterministic chronology of operational events (linking, review, holds, exports) |
| **Graph** | `sections.relationships` | Relationship-role tiles + relationship count summary |
| **Holds** | `sections.governance` | Case-level holds + evidence-level holds + audit-readiness score |
| **Decisions** | `sections.workflows` + `sections.reviewerCoordination` | Active review workflows + open escalations |
| **Risk** | `risk` | Risk level + score + reason codes + recommended action |
| **Communications** | `sections.notes` | Case-level comments + unresolved reviewer comments + annotations |
| **Assignments** | `assignments` | Active assignments + assignment history |
| **Audit** | `sections.custodyAndIntegrity` | Custody events (30d) + lifecycle counts + verification counts + integrity snapshots |
| **Export** | `sections.deliverables` | Report PDFs + Verification Package ZIPs + external review links |

All eleven tabs render from **one** request to the matter envelope. Each tab consumes one (or two) envelope slices and renders either real data, an empty-state, or a degraded badge.

---

## 2. Empty-state discipline (NON-NEGOTIABLE)

Every tab MUST render one of three states; **no blank panels are permitted**:

1. **Data state** — real rows, tiles, counts, or breakdowns.
2. **Empty state** — an `EmptyState` block with `title` + `body` that explains operationally what an empty result means and what the operator's next action is.
3. **Degraded state** — the parent tab's navigation chip carries a `degraded` badge driven by `sectionStatus[tab.id]`; the tab itself still renders best-effort, or a meaningful explanation.

Empty states are deliberately *operational*, not marketing copy. Example:

> **No holds active.** No legal or retention holds apply to this matter or its evidence. Place a hold from the matter's governance surface (audited, step-up-required for sensitive holds). Holds inherit from the parent organization's retention template when one is published.

This pattern means a fresh matter with no evidence yet does NOT look broken.

---

## 3. Read-only by design

The Matter Workspace **never mutates** evidence, holds, decisions, comments, or assignments. Every action affordance delegates either:

- to the **classic** scroll-spy view at `/cases/[id]/classic` (legacy CaseWorkspace, retained for mutation actions like rename, share, link/unlink, hold place/release), via the `onOpenClassic` callback wired to a top-right "Open classic view" button; or
- to the per-evidence detail page at `/evidence/[id]` for evidence-row drill-down, via the `onOpenEvidence` callback wired to evidence-row clicks.

This preserves audit + custody + step-up enforcement on a single canonical mutation surface. The Matter Workspace is the navigation and surfacing layer above it.

---

## 4. Vocabulary discipline

The Matter Workspace inherits the platform-wide vocabulary rules and is contract-asserted by the Phase C1 source-contract suite:

- ✅ Operational labels: *linked evidence*, *integrity snapshot*, *verification status*, *audit readiness*.
- ✅ Phase A2 artifact disambiguation preserved: **Report PDF** vs **Verification Package ZIP** appear as distinct rows + tiles, never collapsed into "report" alone.
- 🚫 Forbidden: `tampered` / `tamper-proof`, `authentic`, `admissible`, `court-ready`, `forensic proof`, `guaranteed`, `factually true`. The vocabulary contract test enforces this.
- The Risk tab explicitly disclaims: *"This projection is operational decision support — it never asserts factual truth, authorship, or legal status."*

---

## 5. Degraded section handling

The matter envelope returns a `status: "ok" | "degraded" | "unavailable" | "not_applicable"` per section. The frontend maps each tab to its underlying section status and renders a `degraded` chip on the tab navigation when the upstream projection failed. The tab body still renders best-effort against whatever payload was returned.

This means a single Prisma timeout in (for example) the relationships projection only degrades the Graph tab — the rest of the workspace remains operational.

---

## 6. Tab-by-tab notes

### Overview
- Tiles: linked evidence, recently linked, active case holds, affected evidence holds, pending review, open escalations (tone = warning when > 0), active assignments.
- Empty state: command-summary projection unavailable.

### Evidence
- Tabular view with seven columns: Title / Type / Status / Verification / Lifecycle / Link role / Artifacts.
- "Artifacts" column shows *Report PDF* and *Verification Package ZIP* readiness — Phase A2 vocabulary preserved.
- Empty state: "Link evidence from the Evidence Library or via an intake submission."

### Timeline
- Ordered list of operational events with family / type / severity / summary.
- Empty state explains that the timeline reflects RECORDED activity.

### Graph
- Relationship-role tiles (primary, supporting, related, duplicate, derived, context) + relationship-and-link count.
- Empty state distinguishes "no relationships recorded" from "no underlying connection".
- Interactive graph visualisation is deferred (C1.1 — Investigation Graph surface).

### Holds
- Case-level holds list + evidence-level holds list + audit-readiness score + blocker count.
- Empty state mentions retention inheritance from the parent organization (Phase B0).

### Decisions
- Active review workflows + open escalations.
- Empty state mentions step-up enforcement on sensitive decisions (Phase C0 / Phase 25.5).

### Risk
- Risk level + score + recommended action + reason-code list.
- Empty state explains the projection is a deterministic, explainable rollup.

### Communications
- Case-level comments + unresolved reviewer comments + unresolved annotations.
- Empty state explicitly states communications never surface on public verify pages.

### Assignments
- Active assignments + history (status ≠ ACTIVE).
- Empty state directs the operator to the classic view to assign roles.

### Audit
- Custody events (30d) tile + lifecycle state breakdown + verification status breakdown + integrity snapshots list (with reason codes).
- Empty state distinguishes "no activity in last 30d" from "matter is inactive".

### Export
- Report-PDF count + Verification-Package-ZIP count + pending-deliverables count + per-evidence lists.
- Empty state preserves Phase A2 vocabulary: *"The Report PDF and the Verification Package ZIP are distinct artifacts (Phase A2 vocabulary) — neither is a substitute for the other."*

---

## 7. Relationship to the classic CaseWorkspace

The legacy 2,671-line scroll-spy CaseWorkspace surface continues to exist unchanged at **`/cases/[id]/classic`**. It is the canonical *mutation* surface — rename, share, link/unlink, hold place/release, comment, status change — and all of its existing audit + custody + step-up enforcement is preserved.

| Surface | Role | Mounted at |
|---|---|---|
| **Matter Workspace** (NEW) | Canonical operator navigation + read surface (11 tabs) | `/cases/[id]` |
| **Classic CaseWorkspace** (LEGACY) | Mutation actions + scroll-spy long-form view | `/cases/[id]/classic` |

The Matter Workspace exposes an *"Open classic view"* button in its header that navigates to the classic route.

---

## 8. Acceptance criteria (recap of the C1 spec)

C1 is complete when:

1. ✅ `/cases/[id]` becomes a real Matter Workspace (canonical mount swapped to `MatterWorkspace`).
2. ✅ All Phase 32.8D sections render operationally (eleven tabs, each backed by an envelope slice).
3. ✅ Evidence context is first-class (own tab + table, drill-down via `onOpenEvidence`).
4. ✅ Governance + risk + holds become operationally visible (Holds + Risk + Decisions tabs).
5. ✅ Auditability is clearly surfaced (Audit tab with custody events + lifecycle + verification counts + integrity snapshots).
6. ✅ Export semantics remain correct (Report PDF vs Verification Package ZIP distinct rows + tiles, Phase A2 vocabulary preserved).
7. ✅ Empty / degraded states are enterprise-grade (every tab has an `EmptyState`; tab nav chips carry per-section `degraded` badges).
8. ✅ Operational context-switching is reduced (the workspace surfaces eleven facets without leaving the page).
9. ✅ Read-only by design (no POST / PATCH / DELETE from the component; mutation actions delegate to classic).
10. ✅ No generic SaaS drift (no kanban, no CRM, no fake summarizer, no invented analytics).

---

## 9. Reference

- Canonical page: `apps/web/app/(app)/cases/[id]/page.tsx`
- Classic fallback page: `apps/web/app/(app)/cases/[id]/classic/page.tsx`
- Matter Workspace component: `apps/web/components/cases-experience/MatterWorkspace.tsx`
- Legacy scroll-spy component (preserved): `apps/web/components/cases-experience/CaseWorkspace.tsx`
- Backend route: `services/api/src/routes/case-workspace.routes.ts` (`GET /v1/cases/:id/matter-workspace`)
- Envelope builder: `services/api/src/services/cases/matter-workspace.service.ts`
- Tests: `services/api/test/phase-c1-matter-workspace.test.ts` (19 source-contract tests)

---

## 10. Deferred follow-ups

Recorded in `docs/architecture/deferred-followups.md` as **C1.1–C1.5**:

- **C1.1** — Interactive relationship graph visualisation (the Graph tab today renders summary tiles only).
- **C1.2** — Inline row actions on tabs (assign / escalate / place-hold from the Matter Workspace without leaving the surface).
- **C1.3** — Filter + sort affordances per tab (currently top-25 rows in fixed order).
- **C1.4** — Per-tab degraded-section retry button (today degrade is silent except for the chip).
- **C1.5** — Matter Workspace keyboard shortcuts (tab number jump, `j`/`k` row nav within tabs).
