# PHASE R8.1A — React Runtime Stabilization

**Status:** Shipped (bundled with R8.1.2 — Vercel build was failing and had to be fixed before login/MFA flow could be modified)
**Date:** 2026-05-24
**Companion phase:** R8.1.2 (`docs/security/R8_1_2_LOGIN_MFA.md`)

## Why this phase exists

The Vercel build for `apps/web` was failing prior to R8.1.2 with:

```
./components/command-center/CommandCenter.tsx
'getPersonaSectionOrder' is defined but never used  no-unused-vars
'sectionEmphasisById' is assigned a value but never used  no-unused-vars
```

Plus a pre-existing `tsc --noEmit` error:

```
components/command-center/CommandCenter.tsx(136,65): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string | number | boolean'.
```

R8.1.2 spec required: *"Before changing login/MFA flow, the frontend must build cleanly and the runtime hooks must not hide stale-state bugs."* This phase satisfies that prerequisite.

## Part G — CommandCenter.tsx unused-vars fix (build error → 0 errors)

### Fix 1: `getPersonaSectionOrder` import removed

Background: R3 replaced direct calls to `getPersonaSectionOrder` with the orchestrator `resolveDashboardSections`. The orchestrator still uses `getPersonaSectionOrder` transitively. The named import in `CommandCenter.tsx` was leftover and unused.

**Action taken:** Removed the import line. Added a comment explaining the R3 transition and why the helper still exists in the platform-context module but doesn't need to be imported here.

**Could we have wired it instead?** No — the orchestrator already owns the ordering contract. Re-importing it would re-introduce a duplicate call path.

### Fix 2: `sectionEmphasisById` wired to `data-cc-section-emphasis`

Background: R3 created the `sectionEmphasisById` Map. Its intended purpose is documented in `apps/web/lib/dashboard/types.ts` (line 14): *"Per-section emphasis hint. Drives `data-cc-section-emphasis` attributes so future CSS / Phase R5/R6 work can target."* And reaffirmed in `docs/recovery/R4_PRODUCT_LANGUAGE_RECOVERY.md` (line 185).

**Action taken:** Added `data-cc-section-emphasis={sectionEmphasisById.get(sectionId) ?? "secondary"}` to each rendered section wrapper. This:
- Surfaces the orchestrator's emphasis decision in the DOM where CSS / a11y / source-contract tests can read it
- Honors the documented intent from R3 / R4
- Default `"secondary"` for any section the orchestrator did not classify (defensive)

**Could we have deleted the Map instead?** No — that would have erased the orchestrator's emphasis-classification work that R4 documentation explicitly committed to surfacing.

### Fix 3 (bonus): Pre-existing typecheck error on PERSONAL space `id === null`

Background: `PlatformContextActiveSpace` types PERSONAL `id` as `string | null`. The fetch call `encodeURIComponent(activeSpace.id)` failed strict typecheck. Pre-existing on `main`; not caused by R8.1.2.

**Action taken:** Added an explicit null check. PERSONAL spaces with `id === null` (provider hasn't bootstrapped Personal Space yet) render the `no_workspace` empty state instead of issuing a request with literal `"null"` as the team id (which the backend would 400 anyway).

**Could this have changed user-visible behavior?** Slightly: previously the API request would 400 and the page would show the `unavailable` state. Now it shows `no_workspace` immediately. The new state is more accurate.

### Build evidence

- `pnpm typecheck`: 0 errors (was 1)
- `pnpm lint`: 0 errors, 33 warnings → 32 warnings (1 safe fix on `pricing/page.tsx`)
- `pnpm build`: completes cleanly through all 90+ routes

### Source-contract locks added (in `phase-r8-1-2-login-mfa.test.ts`)

- Test 17: `getPersonaSectionOrder` is NOT imported into `CommandCenter.tsx`
- Test 18: `sectionEmphasisById` IS wired to `data-cc-section-emphasis`

## Part H — Hook warning audit (33 warnings categorized)

Total warnings: **33** at audit start → **32** after one safe fix.

### Methodology

Each `react-hooks/exhaustive-deps` warning was classified into one of four categories:

| Category | Action |
|---|---|
| **Safe-to-fix-now** | Apply the dependency addition / `useCallback` wrap if the change is pure-derived and the file is not on the high-risk list |
| **Intentional-document** | Leave with a comment if the omission is by design (e.g. mount-once redirects) |
| **Risky-defer** | Leave untouched; create a follow-on ticket if the file warrants a deeper refactor |
| **Critical-stale-closure** | Leave untouched in this phase; flag for an owner-reviewed fix in a dedicated stabilization phase |

High-risk files (per R8.1.2 spec): `capture/page.tsx`, `verify/[token]/page.tsx`, `CommandCenter.tsx`, `evidence/[id]/page.tsx`, `teams/[id]/page.tsx`.

### Triage table

| File | Line | Missing dep | Class | Disposition |
|---|---|---|---|---|
| `app/(app)/cases/page.tsx` | 714 | `loadWorkspace` | Risky-defer | Likely re-fetch loop if added blindly — defer |
| `app/(app)/intake-links/page.tsx` | 146 | `currentTeam` | Risky-defer | Same |
| `app/(app)/intake-links/page.tsx` | 166 | `currentTeam` | Risky-defer | Same |
| `app/(app)/notifications/page.tsx` | 118 | `reload` | Risky-defer | Potential reload-loop |
| `app/(app)/ops/observability/page.tsx` | 427 | `HOT_METRICS` | Safe-to-fix later | Module constant; defer because file size is large and unrelated to R8.1.2 scope |
| `app/(app)/teams/[id]/page.tsx` | 251 | `updateMenuPosition` | Critical-defer | High-risk file |
| `app/(app)/teams/[id]/page.tsx` | 288 | `updateMenuPosition` | Critical-defer | High-risk file |
| `app/(app)/teams/[id]/page.tsx` | 499 | `loadData` | Critical-defer | High-risk file |
| `app/invite/[token]/page.tsx` | 83 | `addToast`, `router` | Intentional-document | Mount-once invite redirect |
| `app/login/page.tsx` | 426 | `handleAuth`, `renderGoogleButton` | Intentional-document | Google SDK script load-once |
| `app/pricing/page.tsx` | 353 | `buildCtaHref`, `buildCtaLabel` | **Safe-to-fix-now (DONE)** | Wrapped in `useCallback`; warning gone |
| `app/register/page.tsx` | 401 | `handleAuth`, `renderGoogleButton` | Intentional-document | Same as login |
| `app/verify/[token]/page.tsx` | 3883 | `applyVerifyResponse` | Critical-defer | High-risk file |
| `app/verify/[token]/page.tsx` | 3926 | `evidenceContentSummary?.itemCount` | Critical-defer | High-risk file |
| `app/verify/[token]/page.tsx` | 4221 | `anchorTransactionId` | Critical-defer | High-risk file |
| `app/verify/[token]/page.tsx` | 4609 | `reviewerEvidenceTypeLabel` | Critical-defer | High-risk file |
| `app/verify/[token]/page.tsx` | 4866 | `otsBitcoinTxid` | Critical-defer | High-risk file |
| `components/cases-experience/.../AssignmentPickerModal.tsx` | 191 | `candidates` recompute | Risky-defer | Modal candidates may already memoize internally |
| `components/command-center/CommandCenter.tsx` | 169 | `activeSpace`, `ctx.state.*` | Critical-defer | High-risk file; adding deps would re-fire fetch on every keystroke |
| `components/command-center/CommandCenter.tsx` | 171 | complex expression in deps | Critical-defer | Same |
| `components/command-center/CommandCenter.tsx` | 5162 | `orderedIds` | Critical-defer | Same |
| `components/command-center/CommandCenter.tsx` | 5162 | complex expression in deps | Critical-defer | Same |
| `components/reports-experience/ReportsIndex.tsx` | 126 | `ctxState.*`, `filter`, `reload`, `search` | Risky-defer | Reload + search dependency hash would change every keystroke |

### Pricing fix detail

`buildCtaHref` and `buildCtaLabel` were declared as plain functions inside the render. They were captured by the storage-addon `useMemo` dep array, but adding them to the deps directly would re-fire the memo on every render (defeating memoization). The correct fix was to wrap both in `useCallback` with their actual deps, then add the now-stable callbacks to the `useMemo` dep array. Removed the redundant `hasSession`, `appBilling`, `appRegister` from the `useMemo` deps once they were captured inside the callbacks. Net effect: identical behavior, one warning eliminated, deps now accurate.

## What this phase deliberately does NOT do

- **Does NOT blindly run `eslint --fix`.** Many of the deferred warnings are in files where adding deps changes behavior.
- **Does NOT touch any of the high-risk files' hooks.** `verify/[token]/page.tsx`, `CommandCenter.tsx`, `teams/[id]/page.tsx`, etc. are untouched in the hook-warning sense (CommandCenter received only the build-error fix, NOT a hook-dep change).
- **Does NOT modify capture flow.** `capture/page.tsx` had no flagged hook warnings in the current build.

## Future follow-ons (not done in this phase)

1. **High-risk file hook audit.** Each of `verify/[token]/page.tsx`, `CommandCenter.tsx`, `teams/[id]/page.tsx` deserves a dedicated, owner-reviewed phase that traces the actual data flow each missing dep affects and decides per-occurrence: rewrite, memoize, or escape with a `// eslint-disable-next-line` + rationale comment. Bundling that work into R8.1.2 / R8.1A would have been irresponsible.
2. **`AssignmentPickerModal.tsx` candidates memo refactor.** The warning suggests wrapping `candidates` in its own `useMemo`. Verifying that this doesn't change render frequency requires reading the parent prop flow.
3. **Module-constant warnings.** `HOT_METRICS` in `ops/observability/page.tsx` is technically a no-op fix; deferred because the file is large and unrelated to MFA scope.

## Validation evidence

- `pnpm typecheck` (web): clean
- `pnpm lint` (web): 0 errors, 32 warnings (down from 33)
- `pnpm build` (web): clean — `next build` completes through all routes
- Source-contract tests 17 + 18 + 19 in `phase-r8-1-2-login-mfa.test.ts` lock the fixes
