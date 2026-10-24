# Review is not forensic custody — boundary, model and operator runbook

Owner decision, 2026-10-24. Internal Review workflow is an internal operational
judgment. It establishes nothing about the evidence bytes, their integrity,
origin, timestamps, anchors or storage, and it is never forensic custody.

**Nothing in this document has been run against Production.** Every command
below is for the owner to run, after deploying this release.

---

## 1. The confirmed defect

An immutable report v5 was issued after Review actions. It said "7 reportable
custody events were recorded after report v4". The seven were custody
sequences 352–372: Review status changes REOPENED, IN_REVIEW, CLOSED, REOPENED,
IN_REVIEW, APPROVED_INTERNAL, CLOSED. The causes:

- Every Review status change was appended to forensic custody as
  `REVIEW_DECISION_RECORDED` with payload `{ status, actorUserId }`. This was
  done by `appendReviewerAuditEventTx` (ET-CUS-12, 2026-09-29) and extended
  to the decision route, Escalate/Reopen/Close, bulk actions and the
  workflow editor on 2026-10-23.
- `REVIEW_DECISION_RECORDED` was in `REPORTABLE_CUSTODY_EVENT_TYPES`, so it
  marked the latest report stale and owed a new version.
- The report's custody summarizer had no case for it. A default branch
  printed `status: CLOSED • actorUserId: <uuid>` into the PDF.
- Both packages shipped the event. FULL included the raw payload; EXTERNAL
  included the type and status.
- Public Verify listed it by type and label.
- After Close, the stored status is CLOSED. The web and mobile label map
  read CLOSED as "Not accepted", so "Approve then Close" showed
  "Status: Not accepted".

## 2. Before / after — disclosure matrix

Measured by `services/api/test/review-custody-boundary.integration.test.ts`
against PostgreSQL, Redis, MinIO, the real report worker and real Chromium,
with the seven events seeded as stored history (synthetic identifiers).

| Surface | Before | After |
|---|---|---|
| Report freshness ("Update available") | 7 reportable changes, report owed | 0, nothing owed |
| PDF report (extracted text) | actor UUID, "Review decision recorded", `actorUserId`, `status: CLOSED` | none |
| FULL package `custody.json` / `forensic-custody.json` / embedded PDF | event type, actor UUID, `APPROVED_INTERNAL`, `actorUserId` | withheld continuity entry in `custody.json` only (sequence, time, hashes) |
| EXTERNAL package `custody.json` / `forensic-custody.json` / `disclosure-manifest.json` | event type, `APPROVED_INTERNAL`, `actorUserId` key | withheld continuity entry in `custody.json` only |
| Public Verify API | event type and label | absent |
| New Review actions | 7 forensic custody rows | 0; recorded in Review history, reviewer audit, tenant audit |
| Approve then Close | "Status: Not accepted" | Workflow: Closed · Decision: Approved |

FULL package identifiers (owner decision, 2026-10-24): FULL keeps its
documented, recomputable evidence-custody chain. The owner and workspace
identifiers stay where genuine evidence custody records them. No reviewer,
member or admin identifier is included, and nothing internal to Review.
EXTERNAL remains the third-party artifact, with identifiers withheld.

## 3. The model now

**Boundary.** No Review writer appends forensic custody:

- the decision authority;
- Escalate, Reopen and Close;
- bulk actions and bulk triage;
- the workflow editor;
- claim, assign and start.

Review activity is recorded in:

- the Review workflow events and the decision rounds;
- the escalation records;
- the reviewer audit log;
- the existing tenant audit (`recordReviewActivityTx`, in each action's own
  transaction, under the taxonomy's `review.*` actions).

**Taxonomy** (`packages/shared/src/review-event-taxonomy.ts`). Only a verdict
is `REVIEW_DECISION_RECORDED`. Reopen, In review, Close, claim, assignment and
priority each have their own code. Historical custody rows are named by their
payload status in internal views only; their bytes are never changed.

**Workflow state vs decision.** The stored status is the workflow STATE. The
current round's DECISION (`NO_DECISION` / `APPROVED` / `NOT_ACCEPTED`) is read
from what the decision authority recorded (`review-outcome.service.ts`).
Close never creates, defaults or rewrites a verdict. Reopen starts a new
round with no decision. These read the decision:

- the Evidence page;
- the queues;
- the export governance gate;
- dual approval;
- the analytics;
- mobile.

**Staleness.** One authority, `deriveReportFreshnessForRecord`
(shared-runtime), shared by the API and the worker. It reports reportable
custody grouped by reason, plus TSA, OTS (one rule with the worker's
automatic version) and integrity changes. Review activity, access, downloads,
views and issuance bookkeeping are never reportable. The card shows the
server's explanation: the reasons, the count, the time range, the version a
generation would create, and that the existing version stays unchanged.

**External projection** (`projectCustodyEventForExternalArtifact`). A
historical Review row becomes a withheld continuity entry (sequence, time,
hashes) in the PDF hash-chain table and in package `custody.json`. Public
Verify excludes it. Package READMEs state that these entries keep their links
checkable but cannot be re-hashed.

## 4. The already-issued report v5 (Production record)

**It is immutable and stays untouched.** Do not edit, replace or delete it
or its storage object, and do not rewrite custody.

**No external serving channel exists.** PROOVRA serves issued report and
package bytes only to authenticated workspace members. Public Verify, the
package record page and verification links offer no report or package
download. So there is nothing for PROOVRA to "withdraw from public delivery".
A copy a member already sent elsewhere cannot be recalled by any system.

**After deploying this release, with no data change:**

- The record's "Update available" for those seven events disappears, because
  staleness is derived and the Review rows are no longer reportable.
- Public Verify no longer lists them.
- Any NEW report or package carries them only as withheld continuity entries.

**Read-only diagnostics.** Run these as a read-only database role, after
setting `EVIDENCE_ID`:

```sql
-- Issued reports and their custody horizons.
SELECT version, generated_at_utc, custody_through_sequence, issue_kind, issue_reason
FROM reports WHERE evidence_id = :'EVIDENCE_ID' ORDER BY version;

-- The historical Review rows (never modified).
SELECT sequence, at_utc, event_type, payload->>'status' AS status
FROM custody_events
WHERE evidence_id = :'EVIDENCE_ID' AND event_type = 'REVIEW_DECISION_RECORDED'
ORDER BY sequence;

-- Packages per version and profile.
SELECT version, report_version, disclosure_profile, state
FROM verification_packages WHERE evidence_id = :'EVIDENCE_ID' ORDER BY version;

-- Verification links that name a report version (revocable through the app).
SELECT id, purpose, report_version, revoked_at_utc
FROM verification_share_tokens WHERE evidence_id = :'EVIDENCE_ID';
```

**Optional corrected successor.** Only if the owner decides v5 must be
superseded for anyone who received it; never automatic. This uses the
existing explicit correction flow, a new version with a recorded reason, run
by an authorized user in the workspace:

```bash
# Read the current offer revision first (the confirmation is signed over it).
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$API/v1/evidence/$EVIDENCE_ID/artifacts/status" | jq -r '.outputs.offer.revision'

curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "idempotency-key: correction-$EVIDENCE_ID-v6" \
  "$API/v1/evidence/$EVIDENCE_ID/reports/regenerate" \
  -d '{"intent":"NEW_VERSION","offerRevision":"<revision>","reason":"Corrected successor: internal review activity is not evidence custody and is withheld from the chronology."}'
```

To stop a verification link someone was given, use the existing revoke action
on the record's verification links (`POST
/v1/evidence/:id/verify-links/:linkId/revoke`).

## 5. Post-deployment checklist

1. On a record with historical Review custody, the Evidence ID page shows no
   "Update available" caused by it, and the Reviewer workflow card shows
   "Workflow: Closed · Decision: Approved" for an approved-then-closed review.
2. A new Review action (claim, close, reopen, approve) adds no row to
   `custody_events`, and adds `review.*` rows to the tenant audit
   (`admin_audit_logs`, `resource_id` = the workflow id).
3. `GET /public/verify/<ref>` contains no `REVIEW_DECISION_RECORDED`.
4. A newly generated package's `custody.json` stays continuous: every
   sequence is present and each `prevEventHash` equals the previous
   `eventHash`. Any historical Review row appears as
   `WITHHELD_INTERNAL_RECORD` with no payload.
5. A reportable fact (for example a legal hold placed) shows as "A legal-hold
   change was recorded after report vN." with "Generating creates report
   vN+1", and the generated report states the same sentence.
