# Phase B.3 — Workflow Orchestration + Deploy-Blocker Fix

**Status:** Deploy blocker (`useCallback` called conditionally in `ReviewerCommandConsole.tsx`) fixed by removing the duplicate hook and reusing the existing `load` callback declared above all conditional returns. Phase B.3 layered: new workspace-scoped multi-stage summary endpoint, inbox extension for review_decision items, frontend summary card + scope-panel updates, hook-rule regression guard test. **Web build clean. 224/224 E2E green.**
**Date:** 2026-05-27
**Predecessors:** [`PHASE_B2_REVIEW_GOVERNANCE.md`](./PHASE_B2_REVIEW_GOVERNANCE.md)

---

## 1. Exact Build Fix

**Error (from Vercel):**
```
components/reviewer-experience/ReviewerCommandConsole.tsx:132
Error: React Hook "useCallback" is called conditionally.
React Hooks must be called in the exact same order in every component render.
```

**Root cause:** In Phase B-1 I added a `reload` callback at line ~132 of `ReviewerCommandConsole.tsx`, BELOW the three early-return conditionals:
```tsx
  if (state.status === "loading") return <ShellLoading />;
  if (state.status === "auth_error") return <ShellAuthError code={state.code} />;
  if (state.status === "unavailable") return <ShellUnavailable …/>;

  const env = state.envelope;
  const isTeam = …;
  const callerUserId = …;

  // ❌ HOOK AFTER CONDITIONAL RETURN — illegal
  const reload = useCallback(() => { … }, [teamId]);
```

This violated the **rules of hooks**: when `state.status === "loading"`, the function returns early and `useCallback(reload)` is NEVER called; when `state.status === "ready"`, it IS called. Different render paths → different hook order → React error.

**Critically, `next build` runs ESLint with `react-hooks/rules-of-hooks` as an ERROR, while `typecheck` only runs `tsc`.** That's why typecheck passed locally but Vercel build failed.

**Fix (no ESLint disable):** The component ALREADY had a `load` callback declared at line 64 — ABOVE all conditionals — with the same fetch path and same setState transitions. The `reload` was an unnecessary duplicate. Two changes:

1. **Deleted** the `useCallback(reload, [teamId])` declaration entirely.
2. **Renamed** the prop usage at the `<QueuePeekSection>` call site: `onMutated={reload}` → `onMutated={load}`.

Both edits are surgical (~5 lines removed, 1 line changed). Bulk reviewer operations functionality is fully preserved — the bulk-bar refresh after submit now calls the canonical `load` instead of a duplicate.

## 2. Why Hook Order Is Now Safe

The rules of hooks require every render to call hooks in the exact same order. After the fix:

```tsx
export function ReviewerCommandConsole() {
  const ctx = usePlatformContext();            // hook 1
  const teamId = useActiveSpaceId();           // hook 2
  const [state, setState] = useState(...);     // hook 3
  const reviewerPersona = usePersonaProfile(); // hook 4
  const load = useCallback(...);               // hook 5  ✅ ABOVE conditionals
  useEffect(...);                              // hook 6  ✅ ABOVE conditionals

  if (ctx.envelope && !ctx.can("REVIEWER_OPS_VIEW")) return …;
  if (state.status === "loading") return <ShellLoading />;
  if (state.status === "auth_error") return …;
  if (state.status === "unavailable") return …;

  // ❌ NO hook calls below this line — guaranteed.
  const env = state.envelope;
  const isTeam = env.workspace.scope === "TEAM";
  const callerUserId = ctx.envelope?.user?.id ?? null;
  return <main>...</main>;
}
```

Every render path executes hooks 1–6 in the same order. The conditionals only determine which JSX to return; they never skip a hook.

The fix is enforced by a new E2E regression test (`ReviewerCommandConsole has no hooks declared after the early-return conditionals`) that grep-asserts the source file. Any future regression will fail this test before Vercel sees it.

---

## 3. What Changed in B.3

**Backend (extension, no migration):**
- `GET /v1/reviewer-ops/decisions/summary?teamId=<uuid>` — workspace-scoped read of multi-stage review state buckets over a 90-day window. Returns `summary.byState` counts (`first_required` / `second_required` / `conflict_detected` / `resolved`) + per-state preview rows (up to 5 each).
- `GET /v1/me/inbox` extended with `review_decision` category. Emits two item types: `conflict_detected` workflows in workspaces the caller is OWNER/ADMIN of (tone: HIGH), and workflows where the caller submitted the FIRST decision and SECOND is pending (tone: INFO, awareness-only).

**Frontend (extension, no rebuilds):**
- `MultiStageReviewSummaryCard` injected into ReviewerCommandConsole below the existing ReconciliationSection. Renders 4 tone-mapped tiles with counts + top-3 preview workflows per state.
- `/inbox` page recognizes the new `review_decision` category in its severity-filter + category-label mapping.
- ReviewerCommandConsole's "Available now" scope panel updated to add `multi-stage-summary` and `review-decision-inbox` items.

## 4. Endpoints Reused / Added

**Reused:** EvidenceReviewWorkflow, WorkflowReviewDecision (Phase B.2), TeamMember (for adjudicator check), ReviewEscalation, EvidenceLegalHold, EvidenceWorkflowVisibilityDecision, requireReviewerActor helper, existing `/v1/me/inbox` aggregator pattern.

**Added (1 endpoint, 0 models, 0 migrations):**
- `GET /v1/reviewer-ops/decisions/summary` — purely additive.

**Extended (1 endpoint):**
- `GET /v1/me/inbox` — new `review_decision` category in items + summary.byCategory.

## 5. Remaining Gaps

| Item | Why deferred |
|---|---|
| Full queue page with filter chips (`?reviewState=conflicts\|second_required\|adjudication_required`) | The summary endpoint surfaces counts + previews on the console card; building a dedicated filtered-list page is a Phase B.4 deliverable. The deep-link from each preview row IS wired (per-workflow detail page). |
| Auto-routing rules engine | Workload snapshots remain advisory-only. Rule-based auto-assignment requires a deliberate rule model + execution engine. Honestly absent. |
| Reviewer load balancing recommendations | The workload endpoint exists (`/v1/reviewer-ops/workload`); a UI surface that recommends "assign to reviewer X because they have N capacity" is not built — would require a deliberate scoring model. |
| Stuck-review aging surface | The summary's 90-day window catches recent state, but explicit "this workflow has been in second_required for >14 days" detection is not yet surfaced. The data is queryable; the visualization is deferred. |
| Bulk multi-stage routing | Phase B's bulk surface still treats decisions as single-stage. Routing the bulk endpoint through the new state machine is real next-phase work. |
| Conflict-detection inbox count badge in the topbar | The inbox count UPDATES when conflicts emerge, but a dedicated topbar badge with the count is not wired. Operators see the count when they open /inbox. |
| Mobile-viewport regression for the summary card | Not in current test coverage. |

## 6. Final Build / Typecheck / E2E Results

**Build (Vercel-equivalent — the deploy blocker target):**
```
pnpm --filter proovra-web build → clean (only exhaustive-deps warnings, no errors)
```

**Typecheck:**
```
pnpm --filter proovra-web typecheck → clean
pnpm --filter proovra-api typecheck → clean
```

**Full Playwright E2E:**
```
224 passed (1.7m)
```

That's **+8 tests over the 216 Phase B.2 baseline**, all green:
- 4 auth/RBAC contract tests on the new `/v1/reviewer-ops/decisions/summary` endpoint
- 1 inbox contract test confirming the new `review_decision` category is in `summary.byCategory`
- 3 source-presence regression tests (backend route + inbox source + frontend card markers)
- 1 hook-rule regression guard test on `ReviewerCommandConsole.tsx`

**Live curl smoke** (post-API-restart):
```
GET /v1/reviewer-ops/decisions/summary?teamId=<unknown>  → 404 ✓ (RBAC gate; non-member)
GET /v1/me/inbox                                          → summary.byCategory.review_decision present (= 0 for fresh guest) ✓
```

---

## Honest Scope Summary

This phase was 50% deploy-blocker fix, 50% B.3 layering. The fix was small (~5 lines) but critical. The B.3 layering was deliberately scoped: one new aggregator endpoint + inbox category extension + a single new UI card. No reviewer-v2. No fake auto-routing. No fake load-balancer AI. No new schema migrations (Phase B.2's table is reused).

The brief said: "Do not fake auto-routing. Surface 'assignment recommendation unavailable' if backend missing." The operational scope panel does exactly that — `multi-stage-summary` and `review-decision-inbox` are in the "Available now" block; `auto-routing` remains in the "Deferred" block with an honest "advisory only" explanation.
