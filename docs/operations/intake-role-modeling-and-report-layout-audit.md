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

---

## Part 2 — Enterprise Intake artifact audit + targeted fix (2026-07-02)

Verified against **real generated artifacts** (SMS intake + a Web-Capture control):
`report-{intake,web}.pdf/html`, and the `technical-metadata/*.json` package files,
produced by driving the actual production builders (`buildReportViewModel` →
`renderReportHtml` → `renderPdfFromHtml`, and `buildTechnicalMetadataPackageFiles`)
with realistic SMS-intake DB rows. (A live Twilio→worker→S3 round-trip is not
runnable in this environment — local Postgres/Redis/S3 are down — so the real
builders were driven with realistic intake data instead of a live submission.)

### Findings + fixes (intake-only; Web Capture confirmed unchanged)

1. **Submitted By (Req 1) — FIXED.** The PDF **Technical Appendix → Identity &
   Provenance** rendered `Submitted By Email` = the contributor's (masked) email
   for intake, via `buildTechnicalIdentityRows`. It now shows a role label
   (`Submitted By = Remote Contributor via Secure Intake Link`, + `Contributor
   Identity`) for intake, and keeps `Submitted By Email` + the uploader email for
   Web Capture. Same guard applied to the (currently unrendered) `meta.submittedByLabel`
   and `buildReviewReadinessRows` for defense-in-depth. Executive Summary already
   did the right thing (prior pass). **Verified in report-intake.pdf p2 + p10:
   zero occurrences of the contributor email.**

2. **Identity / custody wording (Req 2/6) — already correct, re-verified.**
   `applyFlowAwareCustodyWording` rewrites intake wording → submission/upload for
   non-intake; intake preserves "recorded at intake" / "intake authorization".
   Roles are distinct in the Appendix: `Submitted By User Ref` (contributor) vs
   `Created/Uploaded By User Ref` (link creator / workspace owner), all redacted.
   No surface implies the workspace owner captured/submitted the evidence.

3. **Technical Summary layout (Req 3) — OK.** With EXIF it renders a dense 3-block
   2-column grid on a single page (report-intake.pdf p8). With NO EXIF the whole
   section is byte-neutral (`renderTechnicalSummarySection` returns `""`), so there
   is **no empty standalone page** — device rows are absorbed into the Executive
   Summary for non-intake, and into the Evidence Acquisition table for intake.

4. **capture-environment.json (Req 4) — PRESENT, not removed.** Emitted by
   `verification-package-technical-metadata.ts` whenever `evidence.capture_environment`
   is recorded (it is, for the browser-based intake submission). Privacy-safe:
   masked IP + UA hash + country only, never the full IP / raw UA. It intentionally
   carries the **raw** `captureMethod`/`uploadSource` enums (source-of-truth layer);
   the PDF/verify humanize them ("Secure Intake Link") — representation difference,
   not a contradiction.

5. **intake-delivery.json (Req 5) — OK.** `deliveryChannel` = `SMS` for SMS.
   Recipient is masked preview + `sha256:` hash only, `fullValueIncluded:false`;
   no phone/email/provider IDs (Twilio SID / message ID) anywhere. See **Part 3**
   for the channel-scope cleanup (no QR; reusable/one-time → Public Secure Link).

6. **Role separation (Req 6) — OK.** Workspace Owner / Link Creator (Created/
   Uploaded By refs) vs Remote Contributor (Submitted By role + Contributor
   Identity) are never merged or mislabeled on any generated surface.

7. **Verify page (Req 7) — verified safe (data contract), live render not run.**
   The public verify endpoint hard-sets `submittedByEmail: null`; the page hides
   the row (no contributor email, no owner confusion). The public acquisition
   projection (`toPublicAcquisition`) carries NO recipient; network is internal-only.
   So the hard privacy constraints already hold. Showing the explicit PDF role
   label on the verify page would require plumbing `acquisition.isIntake` into the
   public verify payload/types — a separate change that could not be render-verified
   in this environment, so it is left as a documented optional enhancement.

8. **Package consistency (Req 8) — cross-checked.** One inconsistency found + fixed:
   the Technical Appendix `Capture Method` mapped `EXTERNAL_INTAKE_UPLOAD` →
   "Capture method not recorded" while the Technical Summary showed "Secure Intake
   Link". `mapCaptureMethodLabel` now maps the intake-only enum to "Secure Intake
   Link". All JSONs, the PDF, and the verify projection are otherwise consistent.

### Files changed (all in services/worker; Web Capture path untouched)
- `report-v2/technical-model.ts` — `buildTechnicalIdentityRows` intake role model.
- `report-v2/build-view-model.ts` — thread `isIntake` into identity/review-readiness/
  submittedByLabel.
- `report-v2/normalizers.ts` — `mapCaptureMethodLabel` maps `EXTERNAL_INTAKE_UPLOAD`.
- `test/report-media-intelligence.test.ts` — intake-role + web-baseline regression tests.

---

## Part 3 — Intake channel scope cleanup + Verify role label (2026-07-02)

Verified against **real artifacts** for four scenarios (Web Capture, Intake SMS,
Intake Email, Public Secure Link): the PDF (`report-{web,sms,email,psl}.pdf`), the
package `technical-metadata/*.json`, and the **rendered** public verify card
(`VerifyTechnicalMetadataSection` via react-dom/server → `verify-card-*.html`).

### Part 1 — QR intake removed; Public Secure Link always
- **There is NO QR intake delivery channel** and never was one in code — only two
  stale doc-comments in `acquisition.ts` referenced "QR Code". Removed. The QR in
  the PDF is the **Verify QR** ("Scan QR code or open verification page", cover) —
  it opens the verify page and is unrelated to intake delivery. Kept.
- `mapDeliveryChannel` (`packages/shared-runtime/.../acquisition.ts`): the only
  valid channels are **SMS / WhatsApp / Email / Public Secure Link / PROOVRA
  Mobile**. Any intake link with no messaging/mobile record → **Public Secure
  Link** (reusable, anonymous, pseudonymous, or one-time manual/QR-scanned). Never
  `null`, never `"Unknown"`, never `"QR Code"`. `mapMethod` derives Public Secure
  Link vs Intake Link from the intake mode.
- `intake-delivery.json`: `deliveryChannel` fallback changed `"Unknown"` →
  `"Public Secure Link"`. **Verified per scenario:** sms→SMS, email→Email,
  psl→Public Secure Link; web emits no `intake-delivery.json`. No `"QR"` string in
  any PDF Delivery Channel / verify card / intake JSON.

### Part 2 — Verify role label (was already implemented; extended package)
- The public verify page (`VerifyTechnicalMetadataSection`, wired at
  `verify/[token]/page.tsx`) already renders, **for intake only** (projection sets
  `acquisition` only when `isIntake`): `Submitted through: Secure Intake Link ·
  Delivery Channel · Submission: Remote Contributor · Consent · Submission Status`.
  No email, no owner, no recipient, no provider IDs. **Web Capture renders no
  acquisition card** (unchanged). Confirmed in the rendered `verify-card-*.html`.
- `intake-delivery.json` now also carries a descriptive **`role`** section:
  `{ linkCreator: "Workspace Owner", contributor: "Remote Contributor" }` — no
  emails / phone / raw recipient / provider IDs.
- **Internal Evidence unchanged:** `toInternalAcquisition` still returns the masked
  recipient for the internal card; no change to that path.

### Files changed
- `packages/shared-runtime/src/technical-metadata/acquisition.ts` — remove QR
  comments; Public-Secure-Link-always mapping (dist rebuilt).
- `services/worker/src/verification-package-technical-metadata.ts` — `role` section
  + Public Secure Link fallback.
- `services/worker/test/technical-metadata.test.ts` — channel-scope + role tests.
- Docs: this file + `evidence-acquisition-context-audit.md` (QR references removed).
