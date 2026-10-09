# Operations truth — existing-data reconciliation and owner-controlled rollout

This release changes what Operations **writes** from now on. Rows written by the previous
code still say what that code said. `reconcileOperationsTruth`
(`services/api/src/services/operations/operations-truth-reconciliation.service.ts`) brings those
rows in line. It does that through the canonical authorities:

- the source probes (`probeConditionActivity` / `sweepSourceTruthRecoveries`);
- the shared transition rule (`decideObservationTransition`);
- the workspace resolver (`resolveEvidenceWorkspaceId`).

It holds no domain rule of its own.

**It was never run against Production by the remediation.** The owner runs it, in the order below.

## Schema

No migration. The release adds no table, column or enum value. Every change is code, plus the
data repairs listed here.

## What each rule does

| Rule | Finding | What it does |
| --- | --- | --- |
| `retired_false_signals` | OPS-001, OPS-002 | Closes open "retry storm" and "telemetry sampler" rows, with a note that the source was retired. |
| `workspace_heartbeat_copies` | OPS-009 | Closes the per-workspace copies of the worker heartbeat. Worker liveness is now one platform condition. |
| `provider_auth_superseded_rows` | OPS-027 | Closes the old provider-auth rows. One stable platform condition per provider replaces them. |
| `routine_authorization_refusals` | OPS-014 | Closes conditions raised for expected 403 refusals. The refusals stay in the security log. |
| `legacy_unscoped_rescope` | OPS-015 | Moves a Personal record's failure into its owner's Personal Space, but only where ownership is proven. A duplicate is closed and points at the canonical row. A row whose owner cannot be proven is flagged `requires_owner_review` and is never reassigned. |
| `raw_pipeline_messages` | OPS-016 | Replaces raw error text in report/package conditions with the safe description. A duplicate created only by a changed error string is closed and points at the record's current condition. |
| `source_truth_recovery` | OPS-003, OPS-018, OPS-019 | Closes only what the canonical probe proves recovered. |
| `premature_recoveries_reopened` | OPS-004, OPS-019 | Reopens automatic resolutions from the last 180 days whose source still reports the condition. Covers report, TSA and OTS rows. |
| `billing_owner_review` | OPS-003 | Flags a billing condition whose add-on can no longer be read as `requires_owner_review`. It is never closed: only the provider can prove the charge stopped. |

General behaviour:

- Every change appends an event. History is never deleted.
- Every rule is bounded and pages by id. `truncated: true` means another pass is needed.
- Output is bounded counts only, never payloads.

## Owner-controlled order (Production)

1. Deploy the **worker** image from the merged `main` SHA. The worker now writes record-scoped,
   closed-class conditions.
2. Deploy the **API** image from the same SHA. No migration step is required.
3. Let the web deploy from `main` (Vercel builds `main` automatically).
4. Run the dry run in the API environment:

   ```bash
   pnpm --filter proovra-api ops:operations-truth-reconcile -- --limit=5000
   ```

   Review the counts per rule. Nothing is written.
5. Apply, with the explicit approval token:

   ```bash
   OPERATIONS_TRUTH_RECONCILE_APPLY=I_HAVE_OWNER_APPROVAL \
   pnpm --filter proovra-api ops:operations-truth-reconcile -- --apply --limit=5000
   ```
6. Run the dry run again. Every rule must report `changed: 0`, except a rule marked `truncated`,
   which needs another apply pass. Rows reported under `requiresOwnerReview` carry a
   `requires_owner_review` event for the owner to decide.

### Rollback and compatibility

- The release is additive. The reconciliation only appends events and changes `status`, `teamId`,
  `scope`, `title`, `safeSummary` and `resolutionNote` on the rows it repairs.
- Rolling the code back leaves those rows valid for the previous code.
- A re-opened row closes again on its own when its source recovers.

### Proof on a disposable database

`services/api/test/operations-truth-reconciliation.integration.test.ts` runs against live
PostgreSQL 16. It seeds every row shape and proves:

- dry-run writes nothing;
- apply repairs every class;
- a second apply finds nothing;
- history only grows.
