# Review remediation — behaviour specification (working contract)

Base: `origin/main` = `bd1926c4b` (no drift since the audit). Source audit: Review audit v3, 2026-11-27 (findings F-01…F-37). Product directions in the implementation instruction of 2026-11-27 supersede the audit's recommendations where they conflict.

One Review engine serves Team and Enterprise. Differences come from explicit workspace policy flags and the Enterprise contract — never from plan-name branches in Review code.

## 1. The ordinary Team journey

1. **Assign or claim.** An assigner assigns, or a reviewer claims. Eligibility is §3.
2. **Inspect the evidence** on the Review page.
3. **Optionally note or classify.** Notes and coding are optional unless §6 policy requires them.
4. **Request information** if something is missing (§5). The review waits; the assignee records the response; the review continues.
5. **Approve or reject.** With no applicable independent-review requirement (§2), the assignee's decision **finalizes** the review.
6. **See the outcome.** The page shows the recorded outcome and the next step (none, or "waiting for an independent reviewer", §2).

## 2. Independent review

### 2.1 What requires it

A round needs an independent SECOND decision **only** for one of these explicit causes:

| Cause code | Source |
|---|---|
| `independent_review_requested` | A person explicitly requested independent review: the "Request independent review" action, or "Also require an independent review" in the Escalate dialog. It is stored as an escalation with `requires_independent_review = true`. |
| `integrity_escalation` | An escalation whose reason is an integrity control (`INTEGRITY_RISK`, `VERIFICATION_MISMATCH`). It always requires independent review. |
| `workspace_policy` | The workspace policy "Every review needs an independent second decision" (`review_requires_independent_approval`) is on. |
| `active_legal_hold` | Unchanged: an active legal hold on the evidence. |
| `redaction_required` | Unchanged: a redaction-required visibility decision. |
| `workflow_escalated` | The stored status is ESCALATED **because of a reviewer disagreement** (a conflict or an unresolved adjudication; `escalation_reason = 'reviewer_disagreement'`, written since before this change). An administrative Escalate made **after** this change that moved the status to ESCALATED does not force. |
| `legacy_escalated_status` | Compatibility (§10, source review E.2): the stored status is ESCALATED and the escalation that moved it there (the `escalationId` on the review's newest ESCALATED event) was recorded **before** this change (`requires_independent_review IS NULL`) or cannot be identified. Before the change every ESCALATED status forced, so these keep forcing. A later escalation (e.g. an overdue sweep) never changes the answer. |
| `unresolved_adjudication` | Unchanged. |
| `legacy_escalation` | Compatibility (§10, source review E.1): an escalation created **before** this change (`requires_independent_review IS NULL`) keeps exactly the pre-change rule — it forces unless it is an automatic-sweep escalation (no creator **and** a sweep reason: REVIEW_OVERDUE, FIRST_REVIEW_OVERDUE, COMPLETION_OVERDUE, WORKFLOW_STALLED). That includes creator-less escalations with any other reason. It keeps forcing until an owner reclassifies the specific record through the plan-bound reconciliation. |

**Administrative escalations do not require independent review.** These are lateness, workload or stalled work: REVIEW_OVERDUE, FIRST_/COMPLETION_OVERDUE, WORKFLOW_STALLED, NO_REVIEWER_ASSIGNED, REVIEWER_INACTIVE, EVIDENCE_REQUEST_UNRESOLVED, GOVERNANCE_BLOCKED, REPEATED_REJECTION_LOOP and REVIEWER_ESCALATED. This holds whether they are raised manually or automatically, unless the raiser explicitly asks for independent review. The Escalate dialog states the effect before raising.

### 2.2 Recording versus finalizing

- A FIRST decision is always recordable when the actor is allowed to decide, even if nobody is currently eligible to give the SECOND decision.
- The review then shows **"First review recorded — waiting for an independent reviewer"** with:
  - the cause, who requested it and when;
  - the required next actor;
  - a staffing path (Invite member / Assign second reviewer).
- It never shows a final approval. Report, package and public-verify gates stay closed until the derived decision is final (unchanged gate).
- The same person can never give both decisions (unchanged, `same_reviewer_blocked`).
- A missing second reviewer never waives the requirement.
- Lifting the requirement (resolving the escalation) never finalizes a recorded FIRST decision (unchanged pinning).

## 3. Reviewer eligibility (one authority)

`assertReviewAssigneeEligible` / `countEligibleSecondReviewers` are the single rule for:

- assignment and claim;
- second-review hand-off;
- the viewer's available actions;
- decision submission, re-checked at write time.

A user is eligible when **all** of these hold:

- they are an ACTIVE workspace member;
- they hold the review capability (`evidence_request.review`);
- they can read the evidence (reach — restricted cases unchanged);
- they are placed in a Collaboration Team, **only if** placement is required.

**When placement is required** (`reviewAssignmentRequiresPlacement`, in `placement-policy.ts`):

- **Team / Pro:** only when the workspace policy `review_requires_team_placement` is on (default **off**).
- **Enterprise:** the active contract term `assignmentRequiresTeamPlacement` (unchanged).
- **Case/work assignment** outside Review keeps its existing rule (`assignmentRequiresPlacement`).

**Counting:** every active member is considered, in batches (no 200-member sample). The count stops early at 50 eligible and is reported as `50+`.

**Losing eligibility:**

- Removed or suspended members: unchanged (held reviews are released).
- Demoted members: unchanged.
- **New:** when placement is required and a member leaves their last Collaboration Team, their held reviews are released to the queue (decision history kept).
- A decision attempt by someone no longer eligible is refused with `reviewer_not_eligible` and a reason.
- **Lock order (IR-06, 2026-11-28):** every transaction that writes a review takes the review row first and the deciding member's Collaboration Team membership second (`FOR SHARE`).
  - This covers verdicts, requests for information and coding.
  - Suspending or removing a member under a placement rule locks the reviews they hold (`lockReviewWorkflowsHeldByTx`, in id order) before it writes the membership.
  - Outcome of a race between a decision and a placement loss: the decision is recorded and the loss then releases the review if it is still open; or the decision is refused (`reviewer_not_eligible`) and the review is released.
  - It is never a deadlock or a raw error. A transaction PostgreSQL aborts to break a lock cycle is retried as a whole, at most 3 times.

## 4. One authority for actions

The server projection `viewer.actions[]` (`computeViewerActions`) carries `allowed` plus `reason` for every review action. That includes `challenge` and `request_independent_review`.

- Escalations carry `viewerActions` for acknowledge, resolve and suppress, computed with the same independence rule the mutation enforces.
- The web, Evidence Detail and mobile render only what the projection allows. Disabled controls show the reason copy (`packages/shared` `review-action-copy`).
- The frontend may validate input; it adds **no** business gate. The web staffing block (F-01) is removed.

**On refusal** (stale state, concurrency, policy):

- the draft is kept;
- a message says **"Not recorded: <reason>"**;
- the displayed state refreshes.

## 5. Request information

- A workflow action, not a vote. **No `workflow_review_decisions` row is written** for new requests.
- An authorized request (assignee, or the assigned second reviewer):
  - moves the stage to NEEDS_MORE_INFO;
  - writes a `NEEDS_MORE_INFO` event with the reason, the requester and `requestedFrom`. `requestedFrom` is the evidence owner by default, or an optional named member; it uses the existing notification path.
- The response path is unchanged: the assignee clicks **Record response**, which moves the stage to RESPONSE_RECEIVED, then **Start** returns it to IN_REVIEW.
- A repeat by the same requester while the review still waits is a replay: nothing new is recorded.
- The request is the reviewer's first substantive response, so it completes the FIRST_REVIEW deadline (`first_decided_at_utc`) exactly as a first decision did before. It still uses no FIRST/SECOND slot.
- The decision history (`GET …/decisions`) lists requests in `informationRequests`: who asked, of whom, why, when, and any superseded decision. They are never shown as decision rows.
- The reason keeps the decision rationale contract: required, at most 4,000 characters, same wording checks on every door (Review page, legacy request-info route, Evidence page / mobile door). The **full** reason is stored in the request's event value (`nextValue.reason`). The event `note` column (VARCHAR 1000) holds a summary that says so when it is shortened. Every history read returns the full reason (source review D).

**After a FIRST decision** (round `second_required`):

- The request **supersedes** that first decision for the current round. The round number advances, the earlier decision stays in history, and the event records `supersededDecisionId`.
- The requirement cause is **carried** into the new round (`carriedSecondReviewCause`), so independence still applies to the eventual verdict.
- **Rationale:** the first decision was made without the information now requested.

**Legacy rows:** historical REQUEST_INFO decision rows are still read with the existing settled-round rules. No data rewrite.

## 6. Coding

- The **decision is authoritative**. The REVIEWER_VERDICT field type is shown as **"Assessment (recommendation)"**. Stored labels and ids are unchanged; the UI adds the qualifier.
- When the chosen decision differs from the coded assessment, the decision form warns: "Your assessment for this review is X". It never blocks and never syncs.
- **Required fields** mean the assessment is incomplete (a warning).
  - Enforcement only applies when the workspace policy `review_requires_complete_coding` is on, and only to rounds whose **current Start happened after** the policy's `since` timestamp.
  - Then APPROVE/REJECT are refused with `coding_incomplete` and the missing field ids. REQUEST_INFO is never refused for this.
  - **Adjudication (IR-03):** the policy applies to every decision that finishes a review with an approval or a rejection. `UPHOLD_FIRST` / `UPHOLD_SECOND` are checked with the verdict they uphold, under the same pre-policy round exemption. Adjudicated `NEEDS_MORE_INFO` and `UNRESOLVED` are never refused for this. There is no adjudicator override.
- **Recording a decision saves Coding first (IR-02):** before a verdict or an adjudication is sent, the Review page saves what the reviewer has entered in Coding and waits until each field's save has settled.
  - This covers an edited field still focused, a debounced confidence change, and a save in flight with a newer edit queued behind it.
  - If an entry cannot be stored (no connection, refused, conflict, or still saving after 20 s), the decision is **held**: "Not recorded yet: your coding for <field> is not saved. Retry or reload that field in Coding (your entry is kept), then record the decision again." The decision draft and the coding draft both stay.
  - Coding stays optional: untouched and cleared fields hold nothing. A request for information is never held (it finalizes nothing).
  - **Submission boundary (IR-02, second review):** from the click on Record decision until the decision is recorded, held, refused or cancelled, Coding is paused. Every field, Retry and Reload are disabled, with "Saving your coding before the decision is recorded. Coding is paused until the decision is recorded or held." and then "Recording the decision. Coding is paused until it is recorded or cancelled." The pause covers the coding save, the identity confirmation and the decision request.
  - A held decision, a cancelled confirmation, a failed request and a refusal end the pause with every draft as entered. A recorded decision keeps the pause until Coding has been re-read ("Decision recorded. Updating Coding…"), then shows the stored state (read-only once the review is closed).
  - One submission at a time: a repeated click never sends a second decision. Requesting information is never paused.
- **Autosave:**
  - Inputs are controlled and show the server state.
  - Each field shows `Saving… / Saved / Not saved — Retry`, announced through a live region.
  - Values can be cleared explicitly (`DELETE` value).
  - Booleans are a Yes/No/not-set choice.
  - Confidence shows "Not set" until chosen.
  - Each field has one save queue: at most one request in flight and one pending latest intent. Every request carries the field revision it is based on; a stale change is refused (409 `CODING_VALUE_CONFLICT`) and offers Reload / Keep mine (source review A).
  - "Saved" means the server holds this session's latest entry for the field. When a newer stored value is read in page (another tab or reviewer), that value is the field's state: the old "Saved" is cleared, and editing back to an earlier value is saved on the new revision (IR-01).
  - Leaving the page while a save is pending asks for confirmation.
  - When writes would be refused (closed review, no permission), the fields are read-only and show the reason.
  - Values are re-read immediately after the schema is bound.
  - Only values of the currently bound schema's fields are shown as current.
- **Snapshots:** the finalizing DECISION_LOGGED event stores `codingSnapshot` (values plus schema id and version). Reopening preserves it; later rounds write new snapshots. Rounds finalized before this change show "No snapshot was recorded".
- **Seeded help text:** "Bounded reviewer decision; recorded on closure." is replaced at read time with "Your assessment (recommendation). The review decision is recorded separately." A scoped reconciliation can update the stored rows.

## 7. Challenges and adjudication

- **Conflict** (two independent decisions differ) is resolved by an independent OWNER/ADMIN adjudicator (unchanged rule). The adjudication form appears only when `viewer.actions.adjudicate` is allowed.
- **Challenge:** a formal challenge to a specific recorded decision.
  - Offered only when the projection lists challengeable decisions: recorded, not by the viewer, and the viewer holds `review.disagree`.
  - Resolution outcomes (resolution and supersede are one transaction; a supersede failure records nothing):
    - `RESOLVED_UPHELD`: the outcome stands.
    - `RESOLVED_OVERTURNED` and `RESOLVED_PARTIAL`: the challenged outcome is **superseded**. The workflow reopens into a new round through the canonical reopen transition, with a REOPENED event that references the challenge. Original decisions and the challenge are kept. Projections and report/package eligibility are recomputed by the existing derivation; previously issued artifacts are untouched.
  - When nobody is eligible to resolve, the page explains why and names the staffing path.
- **External portal opinions** stay advisory. They never count as a SECOND decision.
- **Organization titles** grant no review powers. Workspace capabilities decide.

## 8. Bulk, saved views, External Review

- **Bulk:**
  - The response is always `{total, succeeded, failed, items[]}`; HTTP 200 when everything succeeded, otherwise 207.
  - All-failed batches are never reported as success: `ok` is false.
  - The UI announces counts and per-item reasons, removes succeeded items from the selection, keeps failed ones selected, and retries only those.
- **"Bulk decide"** (`/v1/reviewer/bulk/decide`) writes coding only. It is renamed in the UI to **"Set assessment tag"**, and its response says `recordsDecision: false`.
- **Saved views:**
  - The Save control is hidden for actors without the capability.
  - A duplicate name shows "A view named … already exists".
  - Ownership and visibility are unchanged.
- **External Review** uses the canonical active workspace id (Personal Team workspaces included) for invite, scope, renew and revoke. Step-up is unchanged.

## 9. Review UI

- **Inbox views:** a wrapping row of view links at ≥1024 px; below that, one labelled "View" menu. No horizontal scrolling and no clipped labels.
- **Review tools:** link cards where the whole row is clickable, with hover and focus.
- Status is plain text.
- The forcing cause is named once, with the next step.
- The Challenge panel appears only with challengeable decisions.
- The help bubble does not cover inputs.
- Focus is visible, contrast is at least 4.5:1, and touch targets are at least 44 px.

Review-scoped CSS only; no global primitive restyle.

## 10. Existing records

| Record | Behaviour |
|---|---|
| Open escalations with `requires_independent_review IS NULL` | Read with the legacy rule (a person-raised, non-sweep escalation forces). The reconciliation dry-run lists them; an owner may approve reclassifying administrative ones. |
| Rounds pinned by a recorded FIRST decision | Unchanged: they keep their requirement. |
| Open reviews whose stored status is ESCALATED (not a reviewer disagreement), set before this change | **Unchanged** (source review E.2): the status keeps forcing (`legacy_escalated_status`). The plan lists each one: `legacy_escalated_status` (the setting escalation is known; the owner may approve reclassifying it) or `legacy_escalated_status_unknown` (report only). |
| Creator-less escalations recorded before this change with a non-sweep, non-integrity reason | **Unchanged** (source review E.1): they keep forcing. Listed as `legacy_creatorless_escalations`. |
| Historical REQUEST_INFO decision rows | Read as before. |
| Challenges already resolved OVERTURNED / PARTIAL without a supersede record | Not retro-applied. The plan lists each one (`overturned_challenges_before_change`, report only), decided per challenge from supersede evidence, not by date (IR-05). |
| Coding values | Untouched. There are no snapshots for past rounds. |
| Seeded help text | Corrected at read time; optional data update. |
| Older mobile/API clients | Still receive `viewer.actions` (superset) and `outcome` fields. REQUEST_INFO responses carry `stageRecorded:"NONE"`, `reviewState:"first_required"` and `nextRequirement:"information"`, and `decision: null`. |

The reconciliation is `services/api/src/scripts/review-remediation-reconcile.ts` (`plan` → `apply` → `compensate`), documented in `RECONCILIATION.md`. `plan` is read-only and lists every affected record with its precondition and effect, identified by a content hash. `apply` is bound to that hash, touches only listed records (compare-and-set), re-checks each item's reviewed context under row locks and refuses an item whose context changed (IR-04), writes a durable audit row per change, reports records changed since planning, and is idempotent. `compensate` restores the captured values of exactly what the plan applied.
