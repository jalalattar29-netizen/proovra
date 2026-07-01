# Intake Role Modeling + Report Layout — Audit (Part 0)

**Date:** 2026-07-01
**Scope:** Fix intake delivery-channel/recipient resolution, creator-vs-contributor role modeling, PDF Executive Summary layout overflow, custody count naming. No crypto/custody-chain/OTS/RFC3161/signature/manifest/offline-verifier change.

---

## 1. Where the PDF Executive Summary gets its data
- **Submitted By**: `build-view-model.ts` `add("Submitted By", externalMode ? maskEmail(evidence.submittedByEmail) : safe(evidence.submittedByEmail))`; rendered in `executive-summary.ts` executive table.
- **Evidence Acquisition / Delivery Channel**: `vm.meta.acquisition` ← `buildReportAcquisitionContext` (report bridge) → `renderEvidenceAcquisition`.
- **Capture Context**: `vm.meta.captureContext` (map + lat/lng + timestamp label) → `renderCaptureContext`.
- **Technical Summary**: `vm.technicalSummary` → `renderTechnicalSummarySection` (standalone page) + `renderCaptureDeviceMini` (Exec Summary inline).
- **Chain of Custody summary**: `vm.custodyCounts` (forensic split) → custody section.

## 2. Intake delivery info sources
`CommunicationMessage` (recipient_preview, recipient_hash, channel, status, sent/delivered_at, purpose=`INTAKE_LINK`, related_intake_link_id / related_intake_session_id) ← linked to `WorkflowIntakeSession` (opened/submitted/consent) ← `WorkflowIntakeLink` (intake_mode, consent_policy_version, recipient_phone/email raw).

## 3. ROOT CAUSE — `deliveryChannel: null`
**The CommunicationMessage is created at link SEND time, when NO WorkflowIntakeSession exists yet** (the session is created later, when the contributor OPENS the link). At send, `communication.service.ts` sets `relatedIntakeLinkId` but `relatedIntakeSessionId = null` (`workflow-intake-link.service.ts` passes `related: { intakeLinkId: link.id }` only). My queries joined the message ONLY on `related_intake_session_id = wis.id` → the send-time row (session id null) never matched → `channel` came back null → `deliveryChannel: null`.
**Fix:** also match `c.related_intake_link_id = wis.intake_link_id`. purpose is exactly `'INTAKE_LINK'`; channel enum is `SMS|WHATSAPP|EMAIL`.

## 4. ROOT CAUSE — "Submitted By" for intake
`Evidence.submittedByEmail` for intake = `session.submitterEmail` (the CONTRIBUTOR's optionally-entered email), masked in externalMode — OR null when anonymous. It is NOT the workspace owner, but showing an email (or a masked contributor email) as "Submitted By" still misleads reviewers about who captured the evidence and conflates roles. **Fix:** for intake, the Submitted By row should read a role label ("Remote Contributor via Secure Intake Link") rather than an email; the workspace requester stays out of the public report (it is not currently shown, and we will not add owner email to public output).

## 5. ROOT CAUSE — PDF layout overflow
The Executive Summary page stacks, in order: (1) "What this confirms" card, (2) conclusion card, (3) Evidence Acquisition panel, (4) Capture Device mini panel, (5) Capture Context panel with a **fixed 40mm map**, (6) the executive table (10–12 rows @ 190px labels), (7) decision basis + boundary. Panels have `break-inside: avoid`, but the page is a fixed print page and the **footer is `position: fixed`**, so overflowing content is clipped and overlaps the footer. Acquisition currently emits up to 7 rows (incl. Identity Verification + Submission Time). Capture Device mini renders even for intake (duplicating context). **Fix:** cap acquisition at 5 rows, suppress the Capture Device mini for intake, shrink the Exec-Summary map, and let the page break cleanly instead of clipping.

## 6. Custody count
`attestations.json` already emits `forensicCustodyEventsCount` / `accessActivityEventsCount` / `totalEventsCount` (prior fix) via `isAccessCustodyEventType` on the queried `eventType`; `custodyEventsCount` retained as a total alias. `custody.json` holds all events (forensic+access). The residual 14-vs-15 delta is a snapshot-vs-live-query race (a package/report-generation event written between the report's `data.custody` snapshot and the attestations live query); the named counts make the semantics explicit. PDF Chain of Custody uses the forensic count.

---

## Fix plan
1. **Delivery channel**: add `related_intake_link_id = wis.intake_link_id` to the LATERAL join in the worker package builder, API verify projection, and report bridge. Package coerces `deliveryChannel` null → "Unknown" (never null).
2. **Recipient**: with the join fixed, recipient_preview/recipient_hash now resolve; add `recipientUnavailableReason` when a targeted channel exists but no masked record.
3. **Role modeling**: intake "Submitted By" → "Remote Contributor via Secure Intake Link"; package intake-delivery gains `contributor` role block.
4. **Layout**: acquisition ≤5 rows; suppress Capture Device mini for intake; smaller Exec-Summary map; page-break-inside auto on the exec page.
5. Tests for all flows.
