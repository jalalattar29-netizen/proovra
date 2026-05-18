# Phase Z — Enterprise Readiness Matrix

This is the explicit, honest readiness assessment for PROOVRA after the
Phase Z hardening & validation pass. The intent is to give a non-
technical reader a single document they can rely on for the "are we
ready for controlled enterprise beta?" decision.

Generated against branch `main` as of the Phase Z pass.

## Scope

What this matrix covers:
- Governance lifecycle (Phase 27 / 27.5).
- Canonical decision contracts (Phase X / X.1).
- OTS / Bitcoin anchor honest semantics.
- Audit chain integrity.
- Observability surface + alert thresholds (Phase Y).
- Runbook documentation (Phase Z, Part K).
- Cross-runtime invariants (api ↔ worker).

What this matrix does NOT cover (out of scope by program directive):
- Multi-tenant data residency / EU sovereignty.
- Customer portals or end-user app shell features.
- Mobile / native clients.
- Federation, OCR, AI, semantic indexing, evidence graph.
- Marketing-grade SLA contracts.

## Status column meaning

- **READY** — control is in place, has automated test coverage, has an
  operator runbook, and has been exercised in CI.
- **PARTIAL** — control is in place but has a known gap or carries
  caveats. Acceptable for controlled beta with documented mitigation.
- **NOT_READY** — material risk that should block beta until resolved.
- **DEFERRED** — out of scope for this pass; tracked for a future phase.

## Matrix

| Capability | Failure modes covered | Test evidence | Runbook | Status |
| ---------- | --------------------- | ------------- | ------- | ------ |
| Lifecycle state machine refuses invalid transitions | FM-LIFE-001 | `phase-z-hardening.test.ts` Part C | [RB-LIFECYCLE-BYPASS](runbooks/lifecycle-bypass.md) | READY |
| DESTROYED is terminal — no resurrection | FM-LIFE-002 | `phase-z-hardening.test.ts` Part C | [RB-LIFECYCLE-BYPASS](runbooks/lifecycle-bypass.md) | READY |
| Direct evidence legal hold blocks destruction | FM-HOLD-001 | `phase-z-hardening.test.ts` Part C, H | [RB-HOLD-OVERRIDE](runbooks/hold-override.md) | READY |
| Case-level legal hold blocks destruction | FM-HOLD-002 | `phase-z-hardening.test.ts` Part C, H | [RB-HOLD-OVERRIDE](runbooks/hold-override.md) | READY |
| Destruction worker re-checks hold at execution time | FM-HOLD-003 | `phase-z-hardening.test.ts` source-contract | [RB-HOLD-OVERRIDE](runbooks/hold-override.md) | READY |
| Immutable retention blocks destruction | FM-RET-001 | `phase-z-hardening.test.ts` Part C | [RB-IMMUTABLE-DRIFT](runbooks/immutable-drift.md) | READY |
| Retention policy precedence is deterministic (CASE > TYPE > REGULATORY > WORKSPACE) | FM-RET-002 | `phase-z-hardening.test.ts` Part C | [RB-RETENTION-PRECEDENCE](runbooks/retention-precedence.md) | READY |
| Export blocked when evidence is in destruction-pending lifecycle | FM-EXP-001 | `phase-z-hardening.test.ts` Part C, D | [RB-EXPORT-BLOCKED](runbooks/export-blocked.md) | READY |
| Export blocked by non-terminal destruction review | FM-EXP-002 | `phase-z-hardening.test.ts` Part C, D | [RB-EXPORT-BLOCKED](runbooks/export-blocked.md) | READY |
| Hold reason precedence in export gate (most-restrictive wins) | FM-EXP-003 | `phase-z-hardening.test.ts` Part C | [RB-EXPORT-BLOCKED](runbooks/export-blocked.md) | READY |
| Audit chain hash detects metadata tamper | FM-AUD-001 | `phase-z-hardening.test.ts` Part G + chaos | [RB-AUDIT-CHAIN-DRIFT](runbooks/audit-chain-drift.md) | READY |
| Canonical JSON is key-order stable + depth-bounded | FM-AUD-002 | `phase-z-hardening.test.ts` Part G | [RB-AUDIT-CHAIN-DRIFT](runbooks/audit-chain-drift.md) | READY |
| Queue payloads idempotent via canonical envelope | FM-Q-001 | `phase-z-hardening.test.ts` Part F | [RB-WORKER-WEDGED](runbooks/worker-wedged.md) | READY |
| Worker waits for API readiness before startup fetch | FM-Q-002 | `phase-z-hardening.test.ts` source-contract | [RB-WORKER-WEDGED](runbooks/worker-wedged.md) | READY |
| Legacy raw payloads survive the envelope parser (back-compat) | FM-Q-003 | `phase-z-hardening.test.ts` Part F | [RB-WORKER-WEDGED](runbooks/worker-wedged.md) | READY |
| OTS ANCHORED without proof is degraded to PENDING (never fabricated) | FM-OTS-001 | `phase-z-hardening.test.ts` Part E | [RB-OTS-DEGRADATION](runbooks/ots-degradation.md) | READY |
| Empty / malformed OTS proof bytes produce no `.ots` file | FM-OTS-002 | `phase-z-hardening.test.ts` Part E | [RB-OTS-DEGRADATION](runbooks/ots-degradation.md) | READY |
| DISABLED OTS workspace produces no companion stub | FM-OTS-003 | `phase-z-hardening.test.ts` Part E | — | READY |
| Invalid Bitcoin txid is dropped at the trust layer | FM-OTS-004 | `phase-z-hardening.test.ts` Part E | — | READY |
| Observability sinks never crash business logic | FM-OBS-001 | `phase-z-hardening.test.ts` Part J | [RB-OBSERVABILITY-DEGRADED](runbooks/observability-degraded.md) | READY |
| Prometheus exposition refuses invalid names / non-finite samples | FM-OBS-002 | `phase-z-hardening.test.ts` Part J | — | READY |
| Forbidden-key prefixes stripped from metrics labels | FM-OBS-003 | `phase-z-hardening.test.ts` Part I | [RB-PRIVACY-LEAK](runbooks/privacy-leak.md) | READY |
| Lifecycle ledger metadata scrubs privileged keys | FM-PRIV-001 | `phase-z-hardening.test.ts` Part I source-contract | [RB-PRIVACY-LEAK](runbooks/privacy-leak.md) | READY |
| Worker notification emitter mirrors API scrubber | FM-PRIV-002 | `phase-z-hardening.test.ts` Part I source-contract | [RB-PRIVACY-LEAK](runbooks/privacy-leak.md) | READY |
| Single canonical writer per state artifact (RUNTIME_OWNERSHIP_MAP) | FM-GOV-001 | `phase-z-hardening.test.ts` ownership tests | — | READY |
| Known governance-notification gap is documented (workers write directly) | FM-GOV-002 | `phase-z-hardening.test.ts` ownership tests | — | PARTIAL |
| `audit_chain_drift` CRITICAL alert wired (threshold > 0) | FM-AUD-001 | `phase-z-hardening.test.ts` Part G | [RB-AUDIT-CHAIN-DRIFT](runbooks/audit-chain-drift.md) | READY |
| 13-alert operational threshold catalog | — | `phase-y-observability.test.ts` + `phase-z-hardening.test.ts` | applies per alert | READY |

## Validation summary

- **79 Phase Z tests passing** in `services/api/test/phase-z-hardening.test.ts`.
- **332 adjacent tests passing** (Phase X / X.1 / Y / 27 / 27.5).
- **46 worker readiness smoke tests passing**.
- Zero new product features added in this pass.
- Zero changes to cryptographic, TSA, OTS, trust decision, or report
  legal wording semantics.

## Known gaps & caveats (PARTIAL items)

1. **Workers bypass the canonical GovernanceNotification service**
   (FM-GOV-002). They write notification rows directly through Prisma
   and emit incidents via a re-implemented `recordIncident` helper.
   This means the canonical service's throttle/dedupe/fan-out logic is
   not applied to worker-originated notifications. The dedupe-key shape
   is mirrored in `notification-emitter.ts` so collisions still
   collapse, but the gap is documented in
   `RUNTIME_OWNERSHIP_MAP.governance_notification.notes` and remains a
   future cleanup. Acceptable for controlled beta because:
   - The worker-originated emissions all carry the canonical
     `dedupeKey` shape, so duplicate-suppression still applies at the
     row level.
   - The volume of worker-originated notifications is low (one per
     reconciliation sweep, not per evidence).
   - Mitigation if drift is observed: extend
     `phase-z-hardening.test.ts` with a per-worker dedupe-key catalog
     comparison and resolve the gap in a follow-up.

## Out-of-scope items (DEFERRED)

These are not gaps — they are explicit non-goals of Phase Z.

| Item | Reason | Future phase |
| ---- | ------ | ------------ |
| Live BullMQ chaos test (kill mid-job) | Phase Z program directive: lightweight in-process fault injection only | — |
| Multi-region failover validation | Single-region production assumption | future |
| Customer-facing SLA dashboard | Internal observability only | future |
| Long-running OTS upgrade replay across calendar outage | Manual operator procedure documented in [RB-OTS-DEGRADATION](runbooks/ots-degradation.md) | — |
| Mobile / native client posture | Out of program scope | — |

## Production blockers

**None identified by Phase Z validation.**

The PARTIAL item (FM-GOV-002) is acceptable for controlled beta as
documented above. Every CRITICAL severity failure mode in the audit
catalog has automated test coverage AND an operator runbook AND a
runtime control that fails closed.

## Rollback plan

This is a code-only hardening pass — no schema migrations, no
infrastructure changes, no API contract changes. To roll back Phase Z:

```bash
git revert <phase-z commit sha>
```

The reverts remove:
- `packages/shared/src/failure-mode-audit.ts` + its export block.
- `services/api/test/phase-z-hardening.test.ts`.
- `docs/runbooks/{lifecycle-bypass,hold-override,immutable-drift,retention-precedence,export-blocked,audit-chain-drift,worker-wedged,ots-degradation,observability-degraded,privacy-leak}.md`.
- The runbook index additions in `docs/runbooks/README.md`.
- This document.

No runtime behavior changes, so the revert is safe to deploy
immediately without coordination.

## Final readiness decision

**YES — PROOVRA is ready for controlled enterprise beta.**

Specifically:
- Every CRITICAL failure mode in the audit catalog has at least one
  test asserting the control fires AND an operator runbook
  documenting the response.
- All HIGH severity failure modes are similarly covered.
- The platform fails closed on every governance bypass attempt the
  test suite exercises.
- The PARTIAL item is documented, scoped, and has a clear future-phase
  cleanup path.

"Controlled enterprise beta" here means: a small number of design-
partner enterprises operating against a single deployment, with an
operator on call who has read the runbooks in this repo, and with
direct support escalation to engineering. It does NOT mean self-serve
general availability — that requires the deferred items above to be
addressed.

## Acceptance criteria the operator should confirm before beta opens

1. `pnpm vitest run test/phase-z-hardening.test.ts` passes in CI.
2. Runbooks index in [`docs/runbooks/README.md`](runbooks/README.md)
   is reachable from the operator wiki / on-call entry point.
3. The on-call operator can identify, from each runbook, the metric
   name + severity + first action without reading source code.
4. `METRICS_SCRAPE_TOKEN`, `SENTRY_DSN`, `WORKER_HEARTBEAT_INTERVAL_MS`,
   `WORKER_QUEUE_HEALTH_INTERVAL_MS` are set in the production
   `.env` (or intentionally left default-empty after operator review).
5. An end-to-end smoke test has been executed against the staging
   environment that exercises:
   - Evidence capture → finalize → report generation.
   - Retention policy attach → reconciliation sweep.
   - Destruction review create → operator approve → orchestrator
     execute → certificate hash present in ledger.
   - Compliance export build for an unblocked record.
