# What changes for existing records on deployment, without reconciliation

Scope: records that exist when this PR is deployed, after the additive migration `20281127120000_review_remediation_policy` and before any reconciliation is applied. Each item compares the base `bd1926c4b` with this PR's head.

## Second-review requirement: unchanged for existing records
After the source-review corrections (E.1, E.2), **no existing escalation or escalated review changes its second-review behaviour on deployment**:
- **Pre-change escalations** (`requires_independent_review IS NULL`) follow exactly the pre-change rule. They force unless the automatic sweep raised them (no creator and a sweep reason).
- **Reviews held in stored status ESCALATED** keep forcing unless the escalation that set the status was recorded after the change.
- **Unchanged causes:** legal holds, redaction requirements, reviewer disagreements, integrity escalations and pinned rounds.

The simplified rule applies only to **new** escalations: a new administrative escalation stores `false` and adds no second reviewer; an explicit request or an integrity reason stores `true`. Reclassifying specific existing records needs the owner's approval of a plan (`RECONCILIATION.md`).

## Behaviour that does change immediately
1. **Write-time eligibility.** The decision authority re-checks the assignee's eligibility (active membership, review permission, case reach, required placement) inside the decision transaction. An existing assignee who lost eligibility is refused (`reviewer_not_eligible`) instead of having the decision recorded. This includes an unplaced assignee in an Enterprise workspace whose contract requires placement, or that has no active contract (fail closed).
2. **Team/Pro review placement.** Before, placement was required for review assignment, claim, QC, escalation routing, second-review take and workload offers. Now it is required only when the workspace's Review policy `review_requires_team_placement` is on (default off). Unplaced but otherwise eligible members become assignable reviewers at once. Case and Operations work keep the placement rule.
3. **Requests for information.**
   - New requests write no decision row; existing REQUEST_INFO rows are read with the existing settled-round rules.
   - A new request after a recorded FIRST decision supersedes it: new round, requirement carried. The history labels that FIRST decision "Set aside — information was requested".
   - The full reason (up to 4,000 characters) is kept in the event value and shown in the history.
   - The request still completes the FIRST_REVIEW deadline.
4. **Coding.**
   - Writes, clears, schema rebinding and finalization serialize on the review's row lock.
   - Writes against a review that closed, or for a schema that is no longer bound, are refused (`WORKFLOW_CLOSED`, `SCHEMA_VERSION_MISMATCH`).
   - Clients that send `expectedRevision` (the web Coding panel) get 409 `CODING_VALUE_CONFLICT` when another tab or reviewer changed the field; older clients and bulk keep last-writer-wins.
   - Seeded verdict help text is shown corrected.
   - Snapshots are written only by decisions that finalize after deployment.
   - `POST /v1/coding/schemas` answers 410.
5. **Challenges.**
   - Resolving OVERTURNED/PARTIAL after deployment supersedes the outcome in the same transaction (Reopen, or a round advance).
   - A challenge whose decision is no longer current resolves with `already_superseded` and no workflow change.
   - A failure answers 409 `DISAGREEMENT_SUPERSEDE_FAILED` with nothing changed.
   - Challenges resolved before deployment are unchanged (report-only category).
6. **API contracts.**
   - Bulk coding and tagging answer 207 when any item fails, with `ok:false` when all fail.
   - The REQUEST_INFO decision response carries `decision: null` and `stageRecorded: "NONE"`.
   - `viewer.escalationForcesIndependentReview` is removed.
   - New fields: escalation rows (`viewerActions`, `createdByName`), disagreement rows (`viewerIndependent`), decisions GET (`informationRequests`, `independentReviewerCount`), coding GET (per-field revisions).
7. **Review pages.**
   - The floating assistant launcher is replaced by a header "Assistant" entry.
   - A reviewer whose access ends mid-review sees every action withdrawn and the refused draft kept.
   - Enter on a focused link or button in the Inbox activates that control.
8. **Copy.**
   - "Review not accepted (internal)" and "First review recorded — waiting for an independent reviewer…".
   - Refusals say "second decision".
   - The REVIEW_SECOND_REVIEWER_UNAVAILABLE email text has changed.
9. **Second-reviewer counts** scan every member (previously the first 200), shown capped as "50+".
10. **Free-text escalation notes** equal to `reviewer_disagreement` are stored as `Note: reviewer_disagreement`.

## Preservation
- No historical decision row, DECISION_LOGGED event or escalation row is rewritten.
- Pinned rounds stay pinned: a FIRST decision logged under a requirement keeps it.
- Resolving or reclassifying an escalation never finalizes a pinned FIRST decision.
- Conflicts and unresolved adjudications keep `escalation_reason = 'reviewer_disagreement'`; a later escalation can no longer overwrite it.
