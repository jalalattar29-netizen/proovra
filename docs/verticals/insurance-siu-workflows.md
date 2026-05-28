# Insurance SIU Workflows (Phase M3)

**Audience:** SIU operators, adjusters, claim investigators using PROOVRA's SIU bundle on a working case.

---

## 1. Workflow phases

The bounded SIU `investigationStatus` enum encodes the workflow:

1. `intake` — a new SIU profile has been created on the case but the claimant has not yet uploaded the required evidence.
2. `collecting` — evidence is arriving via the intake template; the checklist is being populated.
3. `review` — the SIU reviewer is evaluating evidence and recording bounded indicators.
4. `follow_up` — at least one outstanding follow-up evidence request is open.
5. `export_ready` — preflight passes; an SIU bundle can be generated.
6. `exported` — at least one SIU bundle has been generated for this case.
7. `closed` — the investigation has concluded; no further evidence is expected.

Transitions are driven by the operator via the SIU profile endpoint and / or by automatic bounded transitions when checklist items become satisfied or follow-ups complete.

## 2. Adjuster / SIU reviewer actions

| Action | Bounded effect |
| --- | --- |
| Assign adjuster | Updates `assignedAdjusterUserId`. |
| Assign SIU reviewer | Updates `assignedSIUReviewerUserId`. |
| Mark evidence gap | Adds a `MISSING_REQUIRED_EVIDENCE` indicator. |
| Request follow-up | Creates a bounded `SiuFollowUpRequest`. |
| Mark checklist item satisfied | Transitions item status to `satisfied`. |
| Mark ready for SIU export | Sets `investigationStatus = "export_ready"`. |
| Escalate to SIU review | Sets `investigationStatus = "review"`. |
| Close investigation | Sets `investigationStatus = "closed"`. |
| Reopen investigation | Sets `investigationStatus` back to a non-closed bounded value. |

Each action is permission-gated through the same case-access path used by the existing case workspace and emits an `appendPlatformAuditLog` entry with a bounded action label.

## 3. Saved views (advisory)

The following bounded saved-view shapes are recommended for SIU teams. Implementing them on top of the existing `EvidenceSavedView` table is a small follow-up (no new table is required for M3):

- "Claims needing evidence" — `investigationStatus in {intake, collecting}` AND `missing required checklist items > 0`.
- "Claims ready for review" — `investigationStatus = review`.
- "Claims with integrity warnings" — `reviewIndicators[].severity = warning OR block_export`.
- "Claims ready for export" — `investigationStatus = export_ready` AND `preflight.readiness in {ready, ready_with_warnings}`.
- "Claims waiting for follow-up" — at least one `followUps[].status in {open, sent}`.

## 4. Follow-up evidence request flow

1. The operator marks a checklist item as `missing` or `submitted`.
2. The operator creates a follow-up via `POST /v1/cases/:id/siu-profile/follow-ups` with the `checklistItemId`, an optional `dueByUtc`, and an optional bounded `note`.
3. (Future) The follow-up is bound to an existing `WorkflowIntakeLink` so the claimant gets a privacy-safe link to upload the missing evidence directly.
4. When evidence arrives, the operator marks the follow-up `received` (and later `satisfied`) via the status endpoint. The returned evidence id is appended to `returnedEvidenceIds`.

SMS / email delivery is left to the existing communications surface; PROOVRA never embeds claim details in delivered messages.

## 5. Preflight + export

Run the preflight via `GET /v1/cases/:id/siu-export/preflight`. The bounded result reports `ready` / `ready_with_warnings` / `blocked` / `unavailable`. When `ready_with_warnings`, the export endpoint requires an explicit bounded `warningExportReason` (≥8 chars). When `blocked`, the export endpoint refuses with HTTP 409.

The export endpoint is gated under the bounded step-up purpose `SIU_EXPORT_GENERATE` to enforce intent confirmation.

## 6. Standing operational guarantees

- PROOVRA never auto-classifies a case as fraudulent.
- Review indicators are operational signals only.
- PROOVRA never mutates original evidence files.
- The bundle's standing limitation codes are written to every export response and ZIP.

## 7. Related documents

- `insurance-siu.md` — domain model overview.
- `insurance-siu-export-format.md` — ZIP layout.
- `insurance-evidence-guide.md` — claimant-facing guide.
- `phase-m3-insurance-siu-closure.md` — closure report.
