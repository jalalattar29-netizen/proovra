# A — AUDIT BASELINE (v2 forensic re-audit)

**Frozen audit revision:** `71e148f34410c7c231f8930d1387d8924b10b4e5`
**Branch:** `main` (tracking `origin/main`)
**Working tree at start:** CLEAN (0 modified, 0 untracked reported by `git status --porcelain`)
**Audit date:** 2026-09-24
**Mode:** SOURCE-ONLY. No product code modified. No render, screenshot, emulator,
simulator, device run, build, deploy or EAS invocation performed by this audit.

## 1. Staleness control — the prior audit is NOT stale

The prior audit (`docs/audit/pwa-native-2026-09-24/`) declared baseline
`f822de79a` and re-run SHA `10668edbe`.

```
git diff --stat 10668edbe..HEAD -- apps/web apps/mobile packages   →  (empty)
```

**Product source is byte-identical between `10668edbe` and the frozen revision
`71e148f34`.** The three intervening commits touched only `docs/audit/**`,
`audit-output/current/architecture-facts.json`,
`docs/architecture/current-runtime-capability-map.json` and
`e2e/operations-layout/_fixtures.ts`.

Consequence: every prior finding is **source-current**, and this audit
re-adjudicates them on their merits rather than on drift.

Changes between `f822de79a` and HEAD that DO touch product source (17 files) are
listed by `git diff --stat f822de79ad9397928cb59d1760e42bd63e583457..HEAD`; the
material ones for this audit are `apps/mobile/src/auth/use-oauth.ts` (+50) and
`apps/mobile/app/(tabs)/index.tsx` (+100).

## 2. Repository scope

| Application | Root | Scale |
|---|---|---|
| PWA (reference implementation) | `apps/web` | 208 `page.tsx`, 29 `layout.tsx`, 6 `route.ts` |
| Native (Expo / React Native) | `apps/mobile` | 53 files under `app/`, 97 under `src/` |
| Shared API | `services/api` | audience/authorization authority |

Other worktrees exist (33 listed by `git worktree list`). **None was modified,
reset, cleaned or read as authority.** This audit reads `D:/digital-witness` at
the frozen revision only.

## 3. Route inventory — independently re-derived, NOT inherited

The prior audit asserted **64 applicable of 208**. This audit did not inherit
that figure. Two independent authorities were evaluated:

### 3a. `apps/mobile/tools/derive-product-manifest.mjs` (route-id/domain based)

Executed at the frozen revision. Result over all 208 discovered routes:

| Classification | Count |
|---|---:|
| NATIVE_REQUIRED | **62** |
| ENTERPRISE_ONLY | 94 |
| ADMIN_ONLY | 36 |
| PUBLIC_INFORMATIONAL_ONLY | 16 |

Note this is **62, not 64** — the prior audit hand-added two rows.

### 3b. `apps/web/lib/surface/tiers.ts` (the RUNTIME reachability authority)

`SURFACE_TIER_RULES` (52 rules, first-match-wins) is what `middleware.ts` and
`SurfaceGate` actually enforce. It is path-prefix based and therefore covers
routes the registry has not classified. Re-classifying all 208 against it
(instrument: `01-reclassify-routes.mjs`) gives:

| tier / directAccessPolicy | Count |
|---|---:|
| CORE / allow | 26 |
| UNMATCHED → default CORE / allow | 48 |
| PROFESSIONAL / redirect | 3 |
| ENTERPRISE / allow | 21 |
| ENTERPRISE / redirect | 10 |
| ENTERPRISE / notFound | 98 |
| INTERNAL / notFound | 2 |

### 3c. Divergences between the two authorities — adjudicated

| Route | Manifest said | Tier authority says | Adjudication |
|---|---|---|---|
| `/operations` | ENTERPRISE_ONLY | **CORE / allow** — *"tenant Operations — shared unresolved workspace work; gated on OPERATIONS_VIEW"* (`tiers.ts:~182`) | **MANIFEST WRONG. APPLICABLE.** The manifest's `ENTERPRISE_DOMAINS` heuristic excludes domain `OPS` wholesale; the surface was deliberately moved out of INTERNAL to CORE in ATTENTION ARCHITECTURE PHASE 4B. |
| `/operations/health` | ENTERPRISE_ONLY | **CORE / allow** (same rule) | **MANIFEST WRONG. APPLICABLE.** |
| `/settings/security/saml` | ENTERPRISE_ONLY | CORE / allow (matches the broad `/settings` rule) | **EXCLUDED, but the manifest's stated reason is wrong.** The page is a pure `redirect("/security-center/sso")` shim (`page.tsx:44-47`); the destination is ENTERPRISE/notFound. It is a procurement deep-link compatibility route with no UI of its own. Correct disposition: NOT_APPLICABLE — redirect shim into an Enterprise surface. |
| `/workspaces` | NATIVE_REQUIRED | **ENTERPRISE / redirect → `/collaboration-teams`** | **MANIFEST WRONG — FALSE INCLUSION.** Verified: `app/(app)/workspaces/layout.tsx` re-exports `EnterpriseSurfaceLayout`, so `SurfaceGate` redirects self-serve users before the page renders. The registry deliberately keeps `admin.teams` OUT of `ENTERPRISE_ONLY_ROUTE_IDS` because that one id also serves the PROFESSIONAL `/teams/[id]`; the manifest keys on the id and therefore inherits the wrong tier. |

### 3d. Corrected applicable inventory

| | Count |
|---|---:|
| Discovered routes | **208** |
| Manifest NATIVE_REQUIRED | 62 |
| + `/operations`, `/operations/health` (manifest false exclusions) | +2 |
| − `/workspaces` (manifest false inclusion; Enterprise-gated) | −1 |
| **CORRECTED APPLICABLE SET** | **63** |
| `/workspaces` — retained as BORDERLINE, compared but excluded from gap counts | 1 |

The prior audit's **64** and this audit's **63 + 1 borderline** cover the *same
set of routes*. The disagreement is one of **disposition of `/workspaces`**, not
of discovery. The prior audit's count is therefore VERIFIED as to membership and
RECLASSIFIED as to one row.

`/settings/security/saml` is a **route the prior audit's applicable set did not
contain and did not explicitly dispose of by its own reasoning** — it inherited
the manifest's domain verdict. It is disposed of explicitly here (3c).

## 4. Known limitations of this audit, stated up front

1. **Nothing was rendered.** No visual claim in this audit is a rendered claim.
2. **Production runtime configuration is not observable from source.** Where a
   finding depends on deployed environment values, it is marked and the exact
   minimal evidence required to close it is named.
3. The user's physical-iPad observations are treated as **evidence that a failure
   occurred**, never as proof of a particular cause. Each is traced to source
   independently.
