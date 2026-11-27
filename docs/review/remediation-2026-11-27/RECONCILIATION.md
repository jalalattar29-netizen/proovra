# Review remediation — reconciliation of existing records

Implementation:
- service: `services/api/src/services/reviewer-ops/review-remediation-reconcile.service.ts`;
- CLI: `services/api/src/scripts/review-remediation-reconcile.ts`, run as `pnpm --filter proovra-api ops:review-remediation-reconcile`.

Tests: `services/api/test/review-remediation-reconcile.integration.test.ts`, on isolated fixtures only.

**Nothing in this procedure runs automatically, and none of it has been run against production.** Reads never depend on it: legacy records keep their pre-change meaning until an owner approves a specific change.

## Commands
1. **Plan (read-only):**

   `plan --out plan.json [--team <uuid>]`

   Writes the complete plan and prints its `planHash`, the SHA-256 of the canonical plan content. Each record is one item with:
   - its category;
   - the record id, workspace and review;
   - the exact change: table, field, `from`, `to`;
   - the effect: before/after behaviour, whether the review's current round is pinned, and the other causes that keep a second decision required.

   There is no sampling: every affected record is listed.

2. **Apply:**

   `apply --plan plan.json --plan-hash <sha256> --categories a,b --operator "<name>"`

   - Refuses a plan whose content does not hash to `--plan-hash`, an unknown or report-only category, and a missing operator.
   - Applies only the named categories, and only to records listed in the plan; records created after planning are never touched.
   - Each record runs in its own transaction: a compare-and-set on the planned `from`, plus a durable tenant audit row in the same transaction. The audit row records:
     - action `review.remediation.reconcile.applied`;
     - correlation = plan hash;
     - service actor `ops.review-remediation-reconcile`;
     - operator, category, table, field, record, review;
     - bounded before/after values.
   - A record whose value changed after planning is reported as `changed_since_plan` and left alone.
   - A failure rolls back that record's change together with its audit row.
   - Re-applying the same plan reports `already_applied` and writes nothing.

3. **Compensate:**

   `compensate --plan plan.json --plan-hash <sha256> --operator "<name>"`

   - Restores the `from` values captured in this plan's audit rows, compare-and-set on the applied `to` value.
   - Writes one audit row per record (`review.remediation.reconcile.compensated`).
   - A record changed since the apply is reported as `conflict` and left alone.
   - Repeated compensation reports `already_compensated`.

## Categories
| Category | Applicable | Change | Behaviour today (without applying) | After applying |
|---|---|---|---|---|
| legacy_administrative_escalations | yes, **needs approval** | ACTIVE pre-change escalation raised by a person, non-integrity reason: `requires_independent_review` NULL → false | forces (pre-change rule) | stops forcing; a round pinned by a FIRST decision stays pinned |
| legacy_creatorless_escalations | yes, **needs approval** | ACTIVE pre-change escalation with no creator and a reason that is neither sweep nor integrity: NULL → false | forces (pre-change rule; source review E.1) | stops forcing; pinned rounds stay pinned |
| legacy_escalated_status | yes, **needs approval** | the escalation that set a stored ESCALATED status (not a disagreement): NULL → false | the status forces (source review E.2) | the status stops forcing by itself |
| legacy_integrity_escalations | yes | integrity reason: NULL → true | forces | forces (no change in behaviour) |
| escalated_by_backfill | yes | `evidence_review_workflows.escalated_by_user_id` NULL → the newest person-raised escalation's creator | — | attribution only |
| seeded_verdict_help_text | yes | coding field help text: legacy text → corrected text | already corrected when read | stored corrected text |
| legacy_escalated_status_unknown | **report only** | — | the status forces; the setting escalation cannot be identified | unchanged; an owner resolves it through normal Review actions |
| overturned_challenges_before_change | **report only** | — | challenge resolved overturned without reopening | unchanged; reopen through the normal Reopen action if wanted |

## What changes on deployment without reconciliation
See `IMMEDIATE-CHANGES.md`. Since the source-review corrections, no category of existing escalations or escalated reviews changes its second-review behaviour on deployment.
