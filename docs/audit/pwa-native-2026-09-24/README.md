# PWA → NATIVE FORENSIC PARITY AUDIT — 2026-09-24

**Baseline SHA:** `f822de79ad9397928cb59d1760e42bd63e583457` (= current `origin/main`, and the merge-base of this branch)
**Re-run SHA:** `10668edbe` on `uc6-public-launch` — see **J**. All findings persist; one changed (Android fingerprint fixed in repo, not deployed).
**Applicable routes:** **64** of 208 discovered
**Mode:** AUDIT ONLY — no product code, migration, stash, worktree, branch or deployment
was modified. Files written: this directory only.

---

## The three sentences that matter

1. The native app is substantial and its code is **better than its own paperwork says** —
   62/62 ledger rows at `CODE_PARITY`, 484 controls on applicable screens, 942/942 tests
   passing at this SHA.
2. **Four of twenty-five critical journeys cannot complete in production today**, all for
   one cause: the Universal Links / App Links association files are deployed to
   `www.proovra.com` with their **placeholder values still in them**.
3. **No surface has ever been accepted on hardware** (`physicallyAccepted: false` × 62),
   and this audit rendered nothing. **All visual parity is UNVERIFIED.**

---

## Artifacts

| | Artifact | What it is |
|---|---|---|
| **A** | [`A-executive-reality-report.md`](A-executive-reality-report.md) | The verdict, 8 verified defects, 4 source-inferred discrepancies, deferrals, and why visual parity is unverified |
| **B** | [`B-route-matrix.md`](B-route-matrix.md) | All **208** routes — 64 applicable with per-route counts, **144 excluded with rationale** |
| **C** | [`C-visual-discrepancy-register.md`](C-visual-discrepancy-register.md) | Element-level register: 5 source-definitive findings, 22 element classes needing hardware |
| **D** | [`D-interaction-register.md`](D-interaction-register.md) | Every one of **484** controls on applicable screens, with what each handler is wired to. No `onPress`-only passes |
| **E** | [`E-critical-journey-matrix.md`](E-critical-journey-matrix.md) | 25 journeys incl. the boot chain, all capture modes, ReplayKit, MediaProjection, finalize, intake, invites, billing |
| **F** | [`F-device-capability-matrix.md`](F-device-capability-matrix.md) | iOS/Android capability × CODE / EXTERNAL / PHYSICAL / ENVIRONMENT |
| **G** | [`G-test-coverage-matrix.md`](G-test-coverage-matrix.md) | What was **executed** (942/942), proof tiers, per-route coverage |
| **H** | [`H-repair-backlog.md`](H-repair-backlog.md) | 14 items grouped by **5 root causes**, each with acceptance criteria |
| **I** | [`I-audit-coverage-certificate.md`](I-audit-coverage-certificate.md) | Exact counts: inspected vs uninspected, rendered vs source-only, device-unverified |
| **J** | [`J-reconciliation-on-recovery-branch.md`](J-reconciliation-on-recovery-branch.md) | Re-run on `uc6-public-launch`: which findings persist, changed or disappeared |
| **K** | [`K-rendered-parity-plan.md`](K-rendered-parity-plan.md) | The practical staged plan to close rendered visual parity |

### Machine data

| File | Contents |
|---|---|
| `route-matrix.json` | all 208 rows + every count in the reports |
| `interaction-register.json` | 484 controls |
| `endpoint-gap-register.json` | the web→native endpoint join, per route |
| `native-endpoints.json` | 98 resolved path builders → 191 native paths |
| `inverse-coverage.json`, `controls-and-states.json` | regenerable intermediates — **not committed**; each step reads the previous one’s output, so the run order below matters |

### Instruments (read-only; re-runnable from `D:\digital-witness`, Node 24)

```bash
node docs/audit/pwa-native-2026-09-24/native-endpoints.mjs
node docs/audit/pwa-native-2026-09-24/inverse-coverage.mjs
node docs/audit/pwa-native-2026-09-24/controls-and-states.mjs
node docs/audit/pwa-native-2026-09-24/emit-artifacts.mjs
node docs/audit/pwa-native-2026-09-24/emit-markdown.mjs
```

---

## Relationship to existing artifacts — nothing here is replaced

This audit **consumes** the repository's existing instruments and does not duplicate them:

| Existing | Used as | Status after this audit |
|---|---|---|
| `apps/mobile/tools/derive-product-manifest.mjs` | the route authority | authoritative, with **one heuristic challenged** (H-3) |
| `apps/mobile/src/product/native-destinations.mjs` | the native ledger | authoritative; **counter is broken** (H-5), one gap stale (H-7) |
| `docs/architecture/current-runtime-capability-map.json` | endpoint consumers | **has a proven blind spot** (H-4) — corrected here by a second extractor |
| `apps/mobile/tools/contract-audit.mjs` | parser↔route binding | unchallenged; 79 bindings, 0 mismatches |
| `apps/mobile/docs/physical-acceptance.md` | **the** device script | unchanged and still correct — F points to it rather than replacing it |
| `apps/mobile/docs/native-conversion-status.md` | — | **materially stale** (H-6) |

## Read it in this order

1. **A** for the verdict.
2. **H** for what to do, in dependency order.
3. **I** to check that nothing above is claimed beyond its evidence.

> Launch readiness is **not** established by this audit and cannot be until H-1, H-2 and
> H-14 are closed.
