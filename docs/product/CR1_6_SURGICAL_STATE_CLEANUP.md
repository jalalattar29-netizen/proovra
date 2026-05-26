# PHASE CR1.6 — Surgical State Cleanup

**Status:** Complete.
**Date:** 2026-05-25.
**Scope:** Targeted cleanup of the bounded debt items CR1.5 identified. No redesign. No refactor. No new features. No new state library. No backend permission semantics changed. No capture / upload / finalize / custody / TSA / OTS / report / package logic touched.

This phase exists because CR1.5 proved that the platform state layer is healthy but left four bounded follow-ups. CR1.6 resolves the three high-confidence ones and adds the opt-in focus-refresh hook for the fourth.

---

## 1. What CR1.5 found

From `docs/product/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md` (Sections 6.2, 7.3, 10):

| # | Item | Severity | CR1.6 action |
|---|---|---|---|
| 1 | Three dead `ShellNoWorkspace()` functions + `"no_workspace"` LoadState branches in `WorkspaceAdminPanel`, `ReviewerCommandConsole`, `GovernanceControlPlane` — unreachable today but represent latent regression risk | MEDIUM | **Removed** |
| 2 | `teams/[id]/page.tsx` self-fetches `/v1/users/me` only to derive `currentUserId` — duplicates envelope state | LOW | **Migrated** to `envelope.user.id` |
| 3 | `settings/page.tsx` PATCHes `/v1/users/me` — legitimate mutation but flagged by the self-fetch detector | LOW | **Audit-confirmed**: PATCH-only, paired with `ctx.refresh()` (R1 Part 4) — allow-list reason refined |
| 4 | No auto-pickup of admin-granted capability changes — required manual reload | LOW | **Opt-in focus-refresh** added behind `NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED` |

---

## 2. What was cleaned

### 2.1 Dead `no_workspace` branches — REMOVED

Three files had a `LoadState` union value `{ status: "no_workspace" }`, a render-switch arm checking it, and a `ShellNoWorkspace()` function rendering "No workspace selected". None of them ever called `setState({ status: "no_workspace" })` — the state machine left `!teamId` cases as `"loading"`. PageRouteGate plus the in-component `CapabilityDegradedPanel` handle the personal-workspace case correctly, so the dead branch was pure surface area for regression.

**Files modified (surgical only):**

- `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx`
  - Removed `"no_workspace"` from `LoadState` union.
  - Removed the `if (state.status === "no_workspace") return <ShellNoWorkspace />;` switch arm.
  - Removed the `function ShellNoWorkspace()` definition.
  - Added a CR1.6 comment explaining the canonical no-team rendering path is PageRouteGate + CapabilityDegradedPanel.

- `apps/web/components/reviewer-experience/ReviewerCommandConsole.tsx`
  - Same three edits. Canonical path: PageRouteGate (`review.queue`, ORGANIZATION_ONLY) + in-component `CapabilityDegradedPanel` (REVIEWER_OPS_VIEW).

- `apps/web/components/governance-experience/GovernanceControlPlane.tsx`
  - Same three edits. Canonical path: PageRouteGate (`governance.hub`, ORGANIZATION_ONLY) + in-component `CapabilityDegradedPanel` (GOVERNANCE_VIEW).

**Behavior preserved:**

- `loading`, `auth_error`, `unavailable` (and `not_found` for WorkspaceAdminPanel) LoadState branches untouched.
- `CapabilityDegradedPanel` paths untouched.
- PageRouteGate behavior untouched.
- No backend or route changes.

### 2.2 `teams/[id]/page.tsx` migrated off `/v1/users/me`

The legacy `loadData()` function executed five parallel fetches:

```ts
const [meRes, teamRes, invitesRes, casesRes, activitiesRes] =
  await Promise.all([
    apiFetch("/v1/users/me") as Promise<MeResponse>,
    apiFetch(`/v1/teams/${teamId}`) as Promise<Team>,
    // ...three more
  ]);
const meId = meRes?.user?.id ?? meRes?.id ?? "";
setCurrentUserId(meId);
```

The only purpose of the `/v1/users/me` self-fetch was to derive `currentUserId`, which is already available on the canonical envelope (`envelope.user.id`). CR1.6 replaces the self-fetch with:

```ts
const platformCtx = usePlatformContext();
const currentUserId = platformCtx.envelope?.user?.id ?? "";
// ...
const [teamRes, invitesRes, casesRes, activitiesRes] = await Promise.all([
  apiFetch(`/v1/teams/${teamId}`) as Promise<Team>,
  // ...three more, no /v1/users/me
]);
```

**Behavior preserved:**

- Team-detail data fetching unchanged (`/v1/teams/:id`, `/invites`, `/cases`, `/activity`).
- Permission/role logic unchanged (`team?.currentUserRole`, `myMemberRecord`).
- The `myMemberRecord` useMemo still keys on `currentUserId` + `team?.members`, and now reacts correctly when the envelope user id resolves.
- No backend changes.
- The local `MeResponse` type was removed (no longer used) alongside the local `setCurrentUserId` state.

### 2.3 `settings/page.tsx` PATCH refresh — audit-confirmed and pinned

`settings/page.tsx` was the third entry on the CR1.5 self-fetch allow-list. Audit confirmed:

- The page calls `/v1/users/me` only with `method: "PATCH"` — i.e. a profile mutation, **not** a stale-read self-fetch.
- R1 Part 4 paired the PATCH with `platformCtx.refresh()` at line 292.

CR1.6 leaves the file unchanged but refines the CR1.5 allow-list entry's `reason` to reflect that this is a legitimate mutation. A new CR1.6 contract test (Test 4) enforces:
- The PATCH call still exists.
- `platformCtx.refresh()` is still called after the PATCH.
- **Every** `apiFetch("/v1/users/me", ...)` call in the file uses `method: "PATCH"` — no GET self-fetch creeps back in alongside the mutation.

### 2.4 Focus-triggered envelope refresh — opt-in helper added

CR1.6 adds a small focus / visibilitychange listener inside `PlatformContextProvider`. Default OFF. Behind the public flag:

```
NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED=true
```

When enabled, on `focus` or `visibilitychange → visible`:

- If the provider state is `READY`, AND
- More than `MIN_REFRESH_INTERVAL_MS` (60 000 ms) has elapsed since the last refresh, AND
- No focus-refresh is already in-flight,

then `refresh()` is invoked.

**Safety properties:**

- **SSR safe.** The effect short-circuits when `typeof window === "undefined"` or `typeof document === "undefined"`.
- **Test harness safe.** Bypassed when `testEnvelope` is set (consistent with the provider's existing test bypass on the initial-refresh effect).
- **State-aware.** Only fires while `state.name === "READY"`. Concurrent refreshes from in-flight provider calls (LOADING_CONTEXT, SWITCHING, FAILED, IDLE) are ignored.
- **Throttled.** At most one refresh per 60 s window (`MIN_REFRESH_INTERVAL_MS`). Hidden→visible→hidden→visible thrash doesn't burst the API.
- **Concurrency-guarded.** `focusRefreshInflightRef` blocks overlapping invocations even within the throttle window.
- **No new state library.** Pure React effect + refs.
- **No new global subscribers outside React.** Listeners are attached/removed in the effect's cleanup path.

**Defaulting OFF preserves current behavior.** Enabling the flag in staging first is the recommended rollout.

---

## 3. What was intentionally NOT changed

| Surface | Reason |
|---|---|
| `WorkspaceGateState.tsx` "No workspace selected" rendering | LIVE and correct — only triggers when `state.reason !== "personal"` (i.e. user has zero workspaces, including no Personal Space — rare). Personal users get `CapabilityDegradedPanel` instead. |
| `providers.tsx` `/v1/users/me` bootstrap fetch | This runs before `PlatformContextProvider` mounts and seeds the legacy `AuthContext`. Removing it requires re-architecting auth bootstrap — out of CR1.6 scope. |
| `settings/page.tsx` PATCH → `/v1/users/me` | Legitimate mutation endpoint; no replacement exists. PATCH is not a stale-read self-fetch. |
| `useTeamId()` callsites (~28 surviving) | Out of CR1.6 scope. R2 / R-future owns migration to `useWorkspaceId()` for personal-accepting surfaces. |
| Push channel for capability/plan changes | The focus-refresh hook is the safe MVP. A real SSE / WebSocket push channel is R-future. |
| Backend endpoints | Zero backend changes in CR1.6. |
| Permission semantics | Zero permission changes. |
| Capture / custody / TSA / OTS / report / package logic | Hard rule — file-size pin in Test 7 catches accidental drift. |

---

## 4. Self-fetch allow-list — final state

The post-CR1.6 allow-list of files that may call `/v1/users/me`:

| File | Reason |
|---|---|
| `apps/web/app/providers.tsx` | Bootstrap layer — runs before `PlatformContextProvider` mounts; seeds `AuthContext`. |
| `apps/web/app/(app)/settings/page.tsx` | Profile PATCH mutation against the only `/v1/users/me` write endpoint. R1 Part 4 paired with `ctx.refresh()`; CR1.6 verified. **Not a stale-read self-fetch.** |

Removed by CR1.6:

| File | Resolution |
|---|---|
| `apps/web/app/(app)/teams/[id]/page.tsx` | Migrated to `envelope.user.id`. No longer self-fetches `/v1/users/me`. |

---

## 5. Focus-refresh behavior details

```ts
const MIN_REFRESH_INTERVAL_MS = 60_000;

function isFocusRefreshEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED === "true"
  );
}
```

The effect installs two listeners:

| Event | Trigger semantics |
|---|---|
| `window` `focus` | Window-level focus return (tab activation, OS-level alt-tab back). |
| `document` `visibilitychange` | Branch-guarded — only fires when `document.visibilityState === "visible"`. |

The refresh callback computes:

```
if state.name !== "READY"                                  → skip (other state owns the wire)
if focusRefreshInflightRef.current                         → skip (concurrent guard)
if Date.now() - lastRefreshAtRef.current < 60 000          → skip (throttle)
else  set flag, set lastRefreshAtRef = now, refresh()
       finally: clear flag
```

A secondary `useEffect` watching `state.envelope` (when `READY`) updates `lastRefreshAtRef` after every provider-driven refresh (initial mount, manual `refresh()`, workspace switch) so the throttle window starts from real fetch time, not mount time.

**No console spam, no debug logging.** This effect does NOT emit state-observability events; the existing `platform-envelope:refreshed` event (already wired in `refresh()`) covers the trace.

---

## 6. Test coverage

### 6.1 New tests added (CR1.6)

`services/api/test/phase-cr1-6-surgical-state-cleanup.test.ts` — 7 test groups, 18 individual cases:

| # | Group | Cases |
|---|---|---|
| 1 | Documentation exists + CR1.5 follow-up | 2 |
| 2 | Dead `no_workspace` branches removed (it.each ×3) | 3 |
| 3 | `teams/[id]/page.tsx` reads `envelope.user.id`, no self-fetch | 3 |
| 4 | `settings/page.tsx` PATCH-only + refresh paired | 2 |
| 5 | Focus-refresh helper feature-gated, SSR-safe, throttled | 7 |
| 6 | Canonical contracts preserved (regression pins) | 5 |
| 7 | Capture / custody / report files untouched (file-size pin) | 5 |

### 6.2 Existing tests updated

- **`services/api/test/phase-cr1-5-state-observability.test.ts`** — `ALLOWED_SELF_FETCHERS` updated: `teams/[id]/page.tsx` removed (migrated by CR1.6). `settings/page.tsx` reason refined to document the mutation-not-self-fetch distinction.

- **`services/api/test/phase-cr1-5b-product-state-reaudit.test.ts`** — Test 2 flipped: was "dead branches REMAIN" (it.each pins), now "dead branches REMOVED + replacement comment present". Test 13 updated: was "exactly 4 files render 'No workspace selected'", now "exactly 1 file" (only the live `WorkspaceGateState.tsx`).

### 6.3 Test philosophy

Semantic, not brittle. Tests assert source-level invariants (regex against `LoadState`, capability-degraded mounting, refresh-call pairings, env-flag gating) rather than snapshot rendering. They catch real drift without locking trivial formatting choices.

---

## 7. Remaining risks

| Risk | Severity | Owner |
|---|---|---|
| Focus-refresh disabled by default — admin-granted capabilities still require manual reload until the flag is rolled out | LOW | Ops (staged rollout: dev → staging → prod) |
| `providers.tsx` `/v1/users/me` bootstrap remains | LOW | R-future (requires auth-bootstrap rearchitecture) |
| ~28 `useTeamId()` callsites still legacy | LOW | R2 / R-future |
| No SSE / WebSocket push channel for capability changes | LOW (focus-refresh is the safe MVP) | R-future |
| Logout still doesn't synchronously tear down provider state | LOW (sub-second window) | R-future |

None of these block production — they are all expected R-future improvements.

---

## 8. Definition of done — CR1.6

| Criterion | Status |
|---|---|
| Three dead `no_workspace` branches removed | ✅ |
| Three `ShellNoWorkspace()` functions removed | ✅ |
| `teams/[id]/page.tsx` migrated off `/v1/users/me` | ✅ |
| `teams/[id]/page.tsx` removed from CR1.5 allow-list | ✅ |
| `settings/page.tsx` PATCH refresh confirmed (R1 Part 4 intact) | ✅ |
| Focus-refresh helper added, gated, throttled, SSR-safe | ✅ |
| 18 new CR1.6 contract tests passing | ✅ |
| CR1.5B Test 2 flipped to assert removal | ✅ |
| CR1.5B Test 13 updated to expect 1 file (was 4) | ✅ |
| `docs/product/CR1_6_SURGICAL_STATE_CLEANUP.md` written | ✅ |
| `docs/product/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md` carries CR1.6 follow-up section | ✅ |
| No capture / custody / report / package logic touched (Test 7 file-size pin) | ✅ |
| No new state-management library introduced | ✅ |
| No new product features / routes / nav surfaces introduced | ✅ |

---

## 9. Exact next phase recommendation

**Phase 32.7 — Final Production Stabilization.**

CR1.6 closes the bounded product-state debt CR1.5 surfaced. The platform-state layer is now structurally clean; remaining items (focus-refresh rollout, `useTeamId()` long-tail migration, push channel) are operational decisions, not architectural ones.

The natural next phase is the **32.7 production stabilization** track:

1. Roll the focus-refresh flag through dev → staging → prod in three steps. Watch `platform-envelope:refreshed` rate stays bounded.
2. Audit production runtime probes (the `useGlobalRuntimeState` UNKNOWN trigger sources) to confirm none are flapping in prod.
3. Finalize `.env.example` against `.env` post-R8.C.
4. Capture/upload/finalize/custody/report regression sweep — confirm zero behavior change since CR1.5/CR1.6.

**Out of scope for 32.7 (and any near-term phase):** WebAuthn, SIEM, new IAM, new auth providers, navigation expansion, dashboard redesign, capture logic, custody logic, report logic, package logic. All of these remain frozen pending explicit CR-level scoping.
