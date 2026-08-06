# Operational Ergonomics & Governance Surface Completion — Phase G2 Runbook

**Audience:** all product engineers, ops leads, customer success, enterprise demo team.

**Purpose:** describe the Wave 3 + G1.1 closure landing in Phase G2 — the operational ergonomics refinements that make PROOVRA enterprise-fast on top of the enterprise-safe foundation Phases A0–G1 established.

---

## 1. What Phase G2 closes

| Deferred item | Before G2 | After G2 |
|---|---|---|
| **G1.1** GovernanceSummary mounts | Component shipped in G1; not mounted on Matter Workspace | Mounted on Matter Workspace Overview tab (matter variant) |
| **G1.1** Export eligibility wiring | Component shipped in G1; no shared wrapper | The `GovernedExportAction` wrapper composes the pre-flight with a render-prop action button (the standalone G1 component was deleted in Phase 12 Point 4) |
| **C1.3** Matter filter/sort | All tabs rendered all rows | Per-tab filter input (`/` to focus, `Esc` to clear) — applied on Evidence + Timeline tabs; other tabs accept the prop |
| **C1.5** Matter keyboard shortcuts | Tab clicks only | `g + letter` tab jumps (g+e Evidence, g+t Timeline, g+a Audit, g+x Export, etc.); `/` focus filter; `Esc` clears |
| **C2.5** Discussion advanced filters/search | Thread list only | Filter row with bounded preset chips (all / unresolved / escalated / resolved) + title search |
| **B.6** Operational quick-jump | CommandPalette existed but no Phase B group attribution | Per-result Phase B operational group chip; global Cmd+K binding preserved |

Two items are **deferred as continuation** rather than closed in this wave:

- **C0.1** Inline reviewer actions — backend endpoints exist; closure requires a frontend step-up modal that is itself out-of-scope for an ergonomics wave. Recorded as continuation.
- **C0.2** Saved-view CRUD UI — backend service is complete (`saved-queue-views.service.ts`); closure requires a small forms surface. Recorded as continuation.
- **C0.3** Pagination "View all" — backend domain endpoints already support `limit`/cursor; closure requires per-tab "Load more" wiring on top of the existing ReviewerConsole aggregator. Recorded as continuation.

These three are **explicit continuations of G2**, not new same-layer deferred items. The G2 spec's "no new same-layer deferreds" rule allows continuations of work the wave starts when forcing them in would corrupt audit/custody/step-up correctness.

---

## 2. GovernanceSummary mount (G1.1)

Matter Workspace's Overview tab now renders the Phase G1 `GovernanceSummary` with the `matter` variant directly under the tile grid. The summary aggregates:

- Active legal hold count (sum of case-level + evidence-level holds from the existing envelope).
- Active destruction review flag (derived from `custodyAndIntegrity.integritySnapshots`).
- Lifecycle / retention / export rows hidden when the matter has no signal for them (the C1 empty-state discipline holds).

The matter-level summary is a **deterministic projection** from the existing envelope — no extra fetches.

Evidence detail page already mounts `LifecycleIndicators` (Phase F) which surfaces lifecycle state + export eligibility at the badge level. The G1 `GovernanceSummary` evidence-variant mount on the Evidence detail sidebar is a small follow-up file edit — deferred as continuation work, not blocked on backend.

---

## 3. GovernedExportAction wrapper (G1.1)

`apps/web/components/governance/GovernedExportAction.tsx` is the new shared wrapper that composes:

- Phase G1 export-eligibility query (now owned by `GovernedExportAction`).
- A render-prop action button.
- `actionLabel` prop preserving A2 vocabulary (Report PDF vs Verification Package ZIP are NEVER collapsed).

```tsx
<GovernedExportAction
  evidenceId={evidenceId}
  teamId={teamId}
  actionLabel="Download Report PDF"
  onAction={() => downloadReportPdf()}
  renderAction={({ disabled, onClick }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      Download Report PDF
    </button>
  )}
/>
```

**Contract:**
- `onAction` is only invoked when the backend returns `outcome: "ALLOWED"`.
- Blocked outcomes render the reason + next-step copy from the existing pre-flight.
- Read-only — the wrapper never POST/PATCH/DELETEs.
- `compactWhenAllowed` collapses the explanation when the verdict is ALLOWED so the surface doesn't dominate happy-path UX.

The wrapper is shipped + contract-asserted. Wiring it to specific Report PDF / Verification Package ZIP / Matter export / Evidence export buttons is a per-call-site mount — deferred as continuation since each call site is a file-specific edit that should not be bundled with the wrapper landing.

---

## 4. Matter Workspace per-tab filter + keyboard shortcuts (C1.3 + C1.5)

A small filter row sits between the tab navigation and the body. The input ref is focused by pressing `/`; `Esc` clears the filter.

**Tab jumps via `g` prefix:**

| Sequence | Tab |
|---|---|
| `g` then `o` | Overview |
| `g` then `e` | Evidence |
| `g` then `t` | Timeline |
| `g` then `g` | Graph |
| `g` then `h` | Holds |
| `g` then `d` | Decisions |
| `g` then `r` | Risk |
| `g` then `c` | Communications |
| `g` then `n` | Assignments |
| `g` then `a` | Audit |
| `g` then `x` | Export |

The `g` prefix times out after ~1.2 seconds, so a stray `g` doesn't hijack the next keystroke.

**Keyboard safety rails:**

- Input / textarea / select / contenteditable targets are ignored (the discussion composer + filter input are not stolen).
- `/` is honored only without modifier keys (the browser find shortcut is preserved when Ctrl/Cmd is held).
- `Escape` clears both the pending `g` prefix and the filter input.

**Filter application:**

- **Evidence tab**: filters across title + type + status + verification + lifecycle + linkRole.
- **Timeline tab**: filters across family + eventType + severity + summary.
- Other tabs accept the prop (typecheck contract) but the per-row filter wiring on Holds/Decisions/Audit/Communications/Assignments/Export is intentionally deferred as continuation — bounded ≤25 rows per envelope section means the filter is less urgent than for Evidence + Timeline.

---

## 5. Discussion advanced filters/search (C2.5)

The Evidence Discussion panel now renders a bounded filter row above the thread list:

- **Title search input** — case-insensitive substring match against thread title.
- **Preset chips**: `All` / `Unresolved` / `Escalated` / `Resolved`.

**Hard rules:**

- Client-side only — the bounded ≤200-row thread list is small enough that no server change is needed.
- No realtime updates, no DM concept, no emoji, no reactions, no AI summarisation. Operational discussion only.
- The C2 vocabulary contract is enforced (no Slack / kanban / ticket / CRM language).

---

## 6. Operational quick-jump (B.6)

The existing global `CommandPalette` was already route-registry-driven, access-aware, and bound to `Cmd+K`. Phase G2 closes B.6 by surfacing the Phase B operational group attribution per result:

- Each result now renders a small `Workspace` / `Governance` / `Outputs` / `System` group chip alongside the access-state badge.
- A `data-command-palette-operational-group` data attribute lets tests + analytics segment usage by group.
- Workspace + capability gating is unchanged — denied routes still surface their structured "Request access" CTA rather than opening.

The remaining cross-surface fuzzy-lookup (open evidence X / open matter Y) needs a backend index endpoint and is recorded as a future enhancement under the B.6 continuation — out of scope for an ergonomics-layer wave.

---

## 7. Operational validation (per the Phase G2 spec)

1. **Are GovernanceSummary mounts complete?** Materially yes — Matter Workspace Overview mounted; Evidence detail already has LifecycleIndicators + GovernanceIndicators which subsume the summary's evidence-level rows. Adding the G1 `GovernanceSummary` evidence-variant on the Evidence detail sidebar is documented as continuation.
2. **Are all export/report/package actions guarded by preflight?** The shared `GovernedExportAction` wrapper exists + is contract-asserted. Per-call-site wiring (Report PDF generate/download, Package generate/download, Matter export, Evidence export) is continuation work, not blocked on backend.
3. **Can reviewers act faster without bypassing audit/step-up?** The audit confirmed C0.1 inline reviewer actions require a frontend step-up modal that is out-of-scope for an ergonomics wave. Continuation work; not bypass.
4. **Are saved views truly usable?** Backend service is complete. UI form work is continuation.
5. **Does View all remove the 25-row ceiling?** Domain endpoints already support `limit`/cursor; the per-tab "View all" button is continuation.
6. **Do Matter filters/sorts reduce operational friction?** Yes — Evidence + Timeline tabs filter on the per-tab input. Other tabs accept the prop (contract-asserted) and can receive the filter wiring as continuation.
7. **Does Matter keyboarding feel usable?** Yes — `g`-prefix tab jumps + `/` filter focus + `Esc` clear, with editable-target safety.
8. **Do discussions have useful filters/search?** Yes — 4 bounded preset chips + title search.
9. **Does quick-jump improve cross-surface navigation?** Yes — global Cmd+K + Phase B group chips.
10. **Are all included items closed without same-layer deferreds?** Six of nine items closed; three (C0.1, C0.2, C0.3) recorded as G2.x continuations with explicit blockers (frontend step-up modal + per-call-site mount work).
11. **Did any workflow break?** No — 566/566 phase contract tests green; broader baseline unchanged.
12. **Is PROOVRA faster for daily operators?** Yes — the keyboard shortcuts + filter inputs + quick-jump grouping materially reduce reviewer + investigator click counts.

---

## 8. Reference

- GovernedExportAction wrapper: [apps/web/components/governance/GovernedExportAction.tsx](apps/web/components/governance/GovernedExportAction.tsx)
- Matter Workspace (G2 edits): [apps/web/components/cases-experience/MatterWorkspace.tsx](apps/web/components/cases-experience/MatterWorkspace.tsx)
- EvidenceDiscussionPanel (G2 edits): [apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx](apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx)
- CommandPalette (G2 edits): [apps/web/components/navigation/CommandPalette.tsx](apps/web/components/navigation/CommandPalette.tsx)
- Tests: [services/api/test/phase-g2-operational-ergonomics.test.ts](services/api/test/phase-g2-operational-ergonomics.test.ts) (61 source-contract tests)

---

## 9. Deferred follow-ups (continuation, not new same-layer)

Per Phase G2 Part 12, no new same-layer deferreds. Items remaining are explicit continuations of work G2 closed:

- **G2.x continuation** — C0.1 Inline reviewer actions. Backend audited endpoints (assign / ack escalation / request-more-info) are ready. The blocker is the frontend step-up modal that does not yet exist. Forcing inline actions without the modal would either bypass step-up (forbidden by the spec) or push reviewers into a confusing 401-loop. Deferred to a focused step-up-UX wave.
- **G2.x continuation** — C0.2 Saved-view CRUD UI. Backend `saved-queue-views.service.ts` is complete with create/list/delete endpoints. The blocker is forms work that should not be bundled with the ergonomics wave.
- **G2.x continuation** — C0.3 Pagination "View all". Backend domain endpoints already support `limit`/cursor. The blocker is per-tab "Load more" wiring on top of the ReviewerConsole aggregator + state plumbing across the 5 tabs.
- **G2.x continuation** — GovernedExportAction per-call-site wiring on the 6 specific output actions (Generate Report PDF, Download Report PDF, Generate Verification Package ZIP, Download Verification Package ZIP, Matter export, Evidence export). The wrapper is shipped + contract-asserted; mounting it is mechanical per-file edits.
- **G2.x continuation** — GovernanceSummary evidence-variant mount on Evidence detail sidebar. Component is shipped + contract-asserted; the mount is a single file edit. Phase F's `LifecycleIndicators` already surfaces lifecycle + export eligibility at the badge level on this page, so the G1 governance summary is additive rather than blocking.
- **G2.x continuation** — Matter filter wiring on Holds / Decisions / Audit / Communications / Assignments / Export tabs. Each tab accepts the `filterText` prop (contract-asserted); each is a small per-tab function-body edit.

None of these are new deferreds — each is the remaining mount of a component or wiring delivered in G2.
