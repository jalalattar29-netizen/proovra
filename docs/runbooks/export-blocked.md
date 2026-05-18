# Runbook — Compliance export blocked

**Failure modes:** FM-EXP-001 (PENDING_DESTRUCTION export), FM-EXP-002 (review gate), FM-EXP-003 (hold precedence).

## What this means

Operator reports a compliance export build returning `BLOCKED_*` for
a record they expected to export. The platform refuses exports under
several conditions; this runbook helps the operator identify the
specific block and clear the underlying state (where appropriate).

## First action (under 60s)

Call the export-eligibility probe for the evidence:

```bash
curl -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/v1/governance/export/eligibility?evidenceId=<id>"
```

The response carries `outcome` and `reason`:

| outcome | reason | What it means |
| ------- | ------ | ------------- |
| `BLOCKED_BY_HOLD` | `active_legal_hold` | Direct or case hold is ACTIVE — operator must clear hold first |
| `BLOCKED_BY_LIFECYCLE` | `evidence_destroyed` | Evidence has been destroyed; never exportable |
| `BLOCKED_BY_LIFECYCLE` | `pending_destruction` | Destruction review in flight; finish or cancel the review |
| `BLOCKED_BY_LIFECYCLE` | `lifecycle_on_hold` | Lifecycle state is ON_HOLD — separate from legal hold |
| `BLOCKED_BY_LIFECYCLE` | `retention_locked` | Retention-locked state; operator must unlock through retention engine |
| `BLOCKED_BY_REVIEW_GATE` | `active_destruction_review` | Non-terminal destruction review (PENDING / UNDER_REVIEW / DEFERRED / APPROVED) gating |
| `ALLOWED` | `ok` | Export should proceed; if it still fails, investigate package builder |

## Triage

The hold check runs FIRST in `canonicalEvaluateExportEligibility`. If
both a hold and a lifecycle gate apply, operator sees `BLOCKED_BY_HOLD`
first — that's intentional (most-restrictive wins). Clear the hold
before troubleshooting the lifecycle state.

## Containment

Export refusal is the containment. Do not bypass.

## Root cause

The export gate is enforced in three places:
- `canonicalEvaluateExportEligibility` (the pure formula in shared).
- `export-governance.service.ts` (the api runtime — gathers facts, calls
  the formula, emits security events on BLOCKED outcomes).
- The compliance package builder (consumes the formula's outcome).

For a wrongly-blocked export, the most common cause is a stale
DestructionReview row left in `DEFERRED` after the operator
investigated and walked away.

## Recovery

- For `active_destruction_review` blocks, walk the review through to a
  terminal status (CANCELLED, DENIED, RESTORED) via the destruction
  review UI. The export becomes ALLOWED on the next probe.
- For `lifecycle_on_hold`, release the hold (governance.service).
- For `retention_locked`, the retention engine must move the record
  back to ACTIVE — only allowed if the policy permits it.
- For `evidence_destroyed`, there is no recovery. The evidence is gone.

## Postmortem checklist

- [ ] Confirm the security feed received the
      `compliance_export_blocked` event for the blocked attempt.
- [ ] If the operator escalated because they didn't see the BLOCKED
      reason, check whether the UI properly rendered the canonical
      reason (the operator should have seen the reason before paging).
- [ ] If a workflow regularly trips an export gate, consider whether
      the workflow should integrate the eligibility probe earlier in
      the user journey.
