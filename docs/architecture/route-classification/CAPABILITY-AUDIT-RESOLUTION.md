# Phase 12 — Capability-Preservation Audit & Resolution (2026-07-28)

## Why this audit happened

The earlier Phase-12 convergence pass drove `MISSING_PRODUCT_CONSUMER` from 117 → 8
**mostly by deleting routes** (~140 route registrations across 32 files, plus 13
backing service files and several pinning tests). The governing heuristic was
"zero product consumers ⇒ obsolete route."

That heuristic was rejected. **Missing product wiring was itself the discovered
defect** — so the absence of a client caller is *not* proof that a capability is
obsolete. Deleting an unwired-but-real capability is an accidental capability loss,
not a cleanup.

## The bar applied

For every deleted route (baseline = `HEAD` pre-Phase-12, target = working tree), a
deletion could remain deleted only if classified as exactly one of:

- **SUPERSEDED_WITH_FULL_BEHAVIORAL_PARITY** — a canonical replacement exists,
  is web-consumed, **and** matches the deleted route's *full server behavior*.
- **DEAD_DUPLICATE_WITH_ZERO_UNIQUE_CAPABILITY** — provably no unique capability.
- **APPROVED_PRODUCT_SCOPE_REMOVAL** — supported by the approved product
  architecture. *A coding agent may not self-assign this; absent that support it
  is UNPROVEN.*

"Zero callers, passing `tsc`, and deleted tests are **not** parity proof."

## Finding

| Classification | Count | Disposition |
|---|---|---|
| SUPERSEDED_WITH_FULL_BEHAVIORAL_PARITY | 0 | — |
| DEAD_DUPLICATE_WITH_ZERO_UNIQUE_CAPABILITY | 0 | — |
| APPROVED_PRODUCT_SCOPE_REMOVAL | 0 | (agent cannot self-authorize) |
| ACCIDENTAL_CAPABILITY_LOSS + UNPROVEN | **all 140** | **RESTORED** |

The 13 routes with the strongest supersession evidence (governance legal-hold /
policy / retention → `/v1/lifecycle/*` + `/v1/reviewer-ops/sla-policy`; `search/
{cases,evidence}` → unified `/v1/search`; `users/legal-status` → `legal-acceptance`
+ server enforcement) do have **web-consumed canonical siblings** — but their
deleted handlers carried server behavior (pagination, step-up purposes, handler
composition via `runGovernanceHandler`, delegated-tier gating) whose **full
behavioral parity on the canonical surface was not proven** to the required bar.
Under the mandate they are therefore **UNPROVEN**, not SUPERSEDED, and were restored.

Three "catalog/window" discovery routes initially looked like dead duplicates, but
`/v1/intelligence/catalogs` is deliberately auth-hardened by `phase-ia` — evidence
of a real secured capability — so all three were preserved too.

## Resolution

- **Deletions after audit: 0.** Every route was restored from `HEAD`:
  routes (`services/api/src/routes/*`), 13 backing services
  (`services/api/src/services/*`), and 2 case-legal-hold test suites.
- **`tsc --noEmit`: 0 errors.**
- **Preserved-but-unwired backlog: 131** `MISSING_PRODUCT_CONSUMER` routes, tracked
  in the executable registry (`slice-e.json`, `phase-12-coverage-manifest.test.ts`).
  This is the honest remaining Phase-12 work: **wire** each capability into the
  product (add a real consumer), or remove it **only** once full behavioral parity
  or a product-approved scope decision is proven.
- **Ratchet:** the backlog may only shrink via wiring / proven-parity removal —
  never grow, never be silently deleted. `phase-12-dead-routes-removed.test.ts`
  now guards an **empty** removed-set.
- **Behavioral tests restored:** ~26 pinning/behavioral suites that had been flipped
  to assert deletion were restored to their positive HEAD form or reframed to verify
  authz parity on the canonical surface (e.g. `phase-ia` legal-hold / policy /
  retention now assert `requireDelegatedTierAny` / `requireReviewerActor` on the
  canonical routes).

## Gate status

- `ACCIDENTAL_CAPABILITY_LOSS = 0` ✅ (nothing real remains deleted)
- `UNPROVEN = 0` ✅ (nothing remains deleted-and-unproven)
- `DEAD_LEGACY_ROUTE = 0` ✅
- `MISSING_PRODUCT_CONSUMER = 131` — the wiring backlog; Phase-12 **closure**
  (backlog → 0) is deferred to the wiring program and is **not** reachable by deletion.

Route count may decrease again **only** when capability preservation is proven.
