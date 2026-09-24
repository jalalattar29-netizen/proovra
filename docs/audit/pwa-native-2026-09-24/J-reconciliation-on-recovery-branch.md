# J — RECONCILIATION ONTO THE RECOVERY BRANCH

**Baseline audit SHA:** `f822de79ad9397928cb59d1760e42bd63e583457`
**Re-run SHA:** `10668edbe4ac189ff965a09c7e8be17953d83f4a` (this branch, artifacts committed)
**Branch:** `uc6-public-launch` · worktree `.claude/worktrees/native-convergence`
**Date:** 2026-09-24

No worktree, branch or parallel audit was created. No push, merge, deploy, migration
or stash operation was performed. All seven stashes are untouched.

---

## J.1 A correction to the stated premise

The task described the audit as *"created against the OLD main SHA"*. Measured:

```
git rev-parse origin/main              → f822de79ad9397928cb59d1760e42bd63e583457
git merge-base main uc6-public-launch  → f822de79ad9397928cb59d1760e42bd63e583457
git rev-list --left-right --count main...uc6-public-launch → 0   26
```

**`origin/main` has not moved.** `f822de79a` is simultaneously current `origin/main`,
current local `main`, and the exact merge-base of the recovery branch. The recovery
branch is `uc6-public-launch` @ `e47dc7e70`, **26 ahead / 0 behind** — a strict
descendant with no divergence.

So the audit was not computed against a stale ancestor of some diverged line. It was
computed at the precise point this branch grew from, which makes the re-run a clean
before/after over exactly those 26 commits.

## J.2 What was on the recovery branch

The 26 commits touch 10 files in `apps/mobile`, 6 in `apps/web`, 5 in `infra/grafana`,
4 in `apps/extension`, plus CI, docs and one each in `services/api` and
`packages/shared`.

**None of them touch the audit's authorities:**

```
git log f822de79a..HEAD~1 -- \
  apps/web/lib/navigation/routeRegistry.ts \
  apps/mobile/tools/derive-product-manifest.mjs \
  apps/mobile/src/product/native-destinations.mjs \
  docs/architecture/current-runtime-capability-map.json
→ (no commits)
```

That is why the route and endpoint numbers are bit-identical (J.4), and it is stated
here rather than left as a coincidence.

## J.3 An instrument defect found *by* the re-run

The five instruments pinned `const REPO = resolve("D:/digital-witness")`. Run from this
worktree they would have silently re-measured the **main** checkout and reported
"nothing changed" no matter what this branch contained — a check that cannot fail.

Fixed before the re-run: `REPO` now derives from `import.meta.dirname` (three levels up),
overridable with `PROOVRA_AUDIT_REPO` for a deliberate cross-tree comparison. `auditedSha`
is now read from `git rev-parse HEAD` instead of being a hardcoded string, and
`emit-markdown.mjs`'s output directory is likewise relative.

**Every number below was produced after that fix**, and `auditedSha` in the regenerated
JSON reads `10668edbe…`, which is the proof the instruments measured this tree.

## J.4 Finding-by-finding reconciliation

### Unchanged — structural measures (authorities untouched)

| Measure | Baseline `f822de79a` | Recovery `10668edbe` | |
|---|---:|---:|---|
| Web routes discovered | 208 | 208 | = |
| Applicable | 64 | 64 | = |
| Excluded (admin / enterprise / marketing) | 36 / 92 / 16 | 36 / 92 / 16 | = |
| Endpoints with consumers | 961 | 961 | = |
| Distinct endpoints never called by native | **195** | **195** | = |
| Routes with page-scoped gaps | 35 | 35 | = |
| Shell-level gaps | 9 | 9 | = |
| Native-only endpoints | 12 | 12 | = |
| Ledger `CODE_PARITY` | 62 / 62 | 62 / 62 | = |
| `physicallyAccepted: true` | **0 / 62** | **0 / 62** | = |
| Routes with zero tests | 18 | 18 | = |
| Distinct native screens | 41 | 41 | = |

### Changed — measured deltas

| Measure | Baseline | Recovery | Δ | Cause |
|---|---:|---:|---:|---|
| Mobile tests passing | 942 / 942 | **946 / 946** | **+4** | `8cd443d39` and `e47dc7e70` — render, capture and security suites had been signed out |
| Native controls (whole app) | 514 | **515** | +1 | `16c871f06` mobile Google sign-in crash fix |
| Controls on applicable screens | 484 | **485** | +1 | same |
| Controls resolved | 451 | **452** | +1 | same |
| Controls UNVERIFIED | 33 | 33 | 0 | — |
| Files scanned by the extractor | 155 | 156 | +1 | `apps/mobile/scripts/check-env-example.mjs` |

### The eight verified defects

| # | Defect | Status at `10668edbe` | Evidence |
|---|---|---|---|
| 1 | AASA served with `<APPLE_TEAM_ID>` | **PERSISTS — repo *and* production** | repo `apps/web/public/.well-known/apple-app-site-association` still has the placeholder; live probe returns it |
| 2 | `assetlinks.json` `<ANDROID_…FINGERPRINT>` | **CHANGED — fixed in repo, NOT deployed** | see J.5 |
| 3 | Apex `.well-known` 301-redirects | **PERSISTS** | live probe unchanged; this is edge config, not repo |
| 4 | `/operations` + `/operations/health` excluded by heuristic | **PERSISTS** | `routeRegistry.ts` and the deriver untouched; both still have no native screen, no ledger row, no test |
| 5 | `destinationCounts()` returns `NaN` | **PERSISTS** | executed: `{…,"PARITY":0,"CODE_PARITY":null}` vs actual `{CODE_PARITY:62}` |
| 6 | `native-conversion-status.md` stale | **PERSISTS, and drifted further** | still claims `580 / 580`; actual is now **946** |
| 7 | `/evidence/[id]` gap `[3]` names implemented work as absent | **PERSISTS** | ledger untouched; gap `[3]` still opens "STILL ABSENT…" |
| 8 | Capability map blind to path builders | **PERSISTS** | 258 mobile sites, still **0** in `evidence-detail.ts`, which still defines 22 builders |

### The four source-inferred discrepancies

| # | Discrepancy | Status | Evidence |
|---|---|---|---|
| 1 | 195 endpoints uncalled by native | **PERSISTS, identical** | re-run at this HEAD |
| 2 | RTL row direction unmirrored | **PERSISTS, identical** | 45 row files, 3 read `isRTL`, `forceRTL` count **0** |
| 3 | `userInterfaceStyle: "dark"` over a light palette, no `StatusBar` | **PERSISTS** | `app.json:12` unchanged; `grep StatusBar` still returns nothing |
| 4 | Success feedback on a minority of screens | **PERSISTS** | state counts unchanged |

**No finding disappeared. One changed materially (#2). One drifted further from truth (#6).**

## J.5 The one material change, stated precisely

Commit `b1c718f5f` — *"App Links: the real Android signing fingerprint, read out of the APK"* —
parsed the APK Signing Block directly (v2 signer `0x7109871a`) because no `keytool` or
`apksigner` existed on that host, and wrote the real value into the repo:

```
repo  apps/web/public/.well-known/assetlinks.json
      "F0:59:34:F6:65:AA:59:0D:82:B8:88:23:7D:E9:CB:74:0E:69:F8:E2:82:37:42:96:65:7A:94:66:6F:37:7D:38"

live  https://www.proovra.com/.well-known/assetlinks.json
      "<ANDROID_SIGNING_SHA256_FINGERPRINT>"
```

**The repository is fixed. Production is not.** The defect's *cause* moved from "the
fingerprint is unknown" to "the fix is undeployed", which is a different owner and a
different remedy — but **Android App Links still fail for every user today**, so the
user-visible severity is unchanged.

The companion commit `b758f9dc3` narrowed the Apple side honestly: signing material
exists on the account, and what is genuinely missing is only the ten-character Team ID,
which could not be read from that environment. Defect #1 therefore persists on both
sides and is the sole remaining blocker for iOS Universal Links.

**Backlog effect:** H-1 splits.

| | |
|---|---|
| **H-1a** (Android) | repo fixed at `b1c718f5f`. Remaining action: **deploy**. Acceptance unchanged: `adb shell pm get-app-links` reports `verified`. |
| **H-1b** (Apple) | unchanged and still P0. Needs the Team ID, then deploy. |
| **H-2** (apex redirect) | unchanged, P0, edge configuration. |

## J.6 The 64 applicable routes, reconciled against the product inventory

The classification is produced by `derive-product-manifest.mjs` from
`apps/web/lib/navigation/routeRegistry.ts`. Neither changed in the 26 commits, so the
inventory reconciles exactly:

| Bucket | Manifest | This audit | Difference |
|---|---:|---:|---|
| NATIVE_REQUIRED | 62 | 62 | none |
| ADMIN_ONLY | 36 | 36 excluded | none |
| ENTERPRISE_ONLY | 94 | **92 excluded + 2 reclassified** | **the only difference** |
| PUBLIC_INFORMATIONAL_ONLY | 16 | 16 excluded | none |
| **Applicable** | **62** | **64** | **+2** |

### The two, and why the audit disagrees

| Route | routeId | domain | requiredActiveSpace | In `ENTERPRISE_ONLY_ROUTE_IDS`? |
|---|---|---|---|---|
| `/operations` | `workspace.operations` | OPS | **PERSONAL_OR_ORG** | **No** |
| `/operations/health` | `workspace.operations_health` | OPS | **PERSONAL_OR_ORG** | **No** |

Both are excluded by the deriver's own constant `ENTERPRISE_DOMAINS = {GOVERNANCE,
REVIEW_OPERATIONS, OPS}` — a heuristic internal to the tool — and by nothing in the
declared authority. The registry author listed `operations.reliability`,
`operations.automation` and `operations.analytics` in `ENTERPRISE_ONLY_ROUTE_IDS` and
did not list these two. Both are reachable by an ordinary Personal user.

**Scope has not been altered.** The manifest still emits 62; nothing in
`routeRegistry.ts` or the deriver was edited by this audit or by this reconciliation.
The audit carries them as `APPLICABLE` with `reclassified: true` in `route-matrix.json`,
and the disagreement is recorded for a human to settle via **H-3** — either add the two
ids to `ENTERPRISE_ONLY_ROUTE_IDS` with an argument, or port them.

Their concrete state is unchanged at this HEAD: **no native screen, no ledger row, no
test**, and 19 + 2 page-scoped endpoints the web consumes and native never calls.

## J.7 What remains UNVERIFIED — unchanged and non-negotiable

The re-run changed **nothing** on this axis.

| Dimension | Baseline | Recovery HEAD |
|---|---:|---:|
| **Rendered screenshots captured** | **0** | **0** |
| **Simulator sessions** | **0** | **0** |
| **Physical-device sessions** | **0** | **0** |
| `physicallyAccepted` rows | **0 / 62** | **0 / 62** |
| Authenticated runtime render | 0 / 64 | 0 / 64 |
| Live API integration / E2E | 0 | 0 |
| iPad portrait + landscape | 0 | 0 |
| RTL Arabic rendered | 0 | 0 |
| EN/DE expansion rendered | 0 | 0 |
| Rendered accessibility | 0 | 0 |

> **The exhaustive visual and functional audit that was requested is NOT complete.**
> Every control verdict in (D) — all **485** — is a *source* verdict. No control has
> been observed to reach a server on any device. All visual parity for all 64
> applicable routes remains **UNVERIFIED**, and no source-only check in this artifact
> set may be presented as a rendered visual audit.

A practical plan for closing the rendered dimension is in **K-rendered-parity-plan.md**.
