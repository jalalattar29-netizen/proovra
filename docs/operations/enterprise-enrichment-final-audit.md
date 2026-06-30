# Enterprise Evidence Enrichment — Final Audit (Device/Camera/OS + Intake Recipient Privacy)

**Date:** 2026-07-01
**Type:** Audit (Part 0) + implementation plan (Parts 1–3)
**Scope:** Finalize the device/camera/OS enrichment and add a privacy-safe intake-recipient delivery context. No new generic metadata section. No reintroduction of Mixed/Partial/Network/IP/GPS duplicate blocks. No change to crypto/custody/OTS/timestamps/signatures/anchoring.

---

## PART 0 — AUDIT FINDINGS

### 1. Where is Capture Device derived from?
- **EXIF camera make/model only.** `formatCameraLabel(make, model)` at [projections.ts:158](packages/shared-runtime/src/technical-metadata/projections.ts) combines `cameraMake` + `cameraModel` (de-duping when model starts with make → "Apple iPhone 14 Pro").
- It is **never** derived from browser UA, mobile-app payload, or a generated fallback. If no EXIF camera → Capture Device is null and only the capture-environment (OS/browser/device-class) context shows.
- Used by PDF [technical-summary.ts:45](services/worker/src/report-v2/sections/technical-summary.ts) ("Captured with"), package [verification-package-technical-metadata.ts:182](services/worker/src/verification-package-technical-metadata.ts), verify [VerifyTechnicalMetadataSection.tsx:93](apps/web/components/verify-v2/VerifyTechnicalMetadataSection.tsx).

### 2. Camera Make / Model storage
- Stored **separately** as `cameraMake` / `cameraModel` on `TechnicalMetadata` and `ExifSummary` ([types.ts:71,115](packages/shared-runtime/src/technical-metadata/types.ts)).
- **Display today is combined** (single `camera` label) in PDF/verify. The package `exif-details.json` already emits both separated (`cameraMake`, `cameraModel`) plus the combined `camera`.
- `device-enrichment.json` currently carries source/confidence **per field** but as **top-level keys** (not under a `fields:` wrapper), and does not separate make/model. → **fix to the field-level `fields:{}` shape** the task specifies.

### 3. OS derivation
- Parsed from User-Agent in [capture-environment.ts:49](packages/shared-runtime/src/technical-metadata/capture-environment.ts).
- **Android** → `Android <version>` (e.g. "Android 15") — provable from the UA, kept.
- **Windows** → osName "Windows", and `Windows NT 10.0` is **mapped to osVersion "10/11"** ([capture-environment.ts:91](packages/shared-runtime/src/technical-metadata/capture-environment.ts)). This is a fabrication — the UA cannot distinguish Windows 10 from 11. → **change: emit `osVersion = null` for NT 10.0 so OS renders as just "Windows".** Keep provable versions (8.1/8/7).
- No client-hints path; UA only.

### 4. Browser display
- PDF shows Browser **only when there is no EXIF camera** ([technical-summary.ts:64](services/worker/src/report-v2/sections/technical-summary.ts)) — i.e. desktop. **Mobile browser/intake uploads that DO carry a camera never show the browser.** → **change: also show Browser when device-class is mobile and browserName is known.**
- Verify public card shows no browser today. Useful surfaces: PDF (desktop + mobile-browser), Verify (when useful), Package + Internal (full). Not high-value enough to force everywhere.

### 5. Software / Firmware
- Raw `softwareTag` (e.g. `S731BXXS7BZF3`) is **already kept out of PDF/Verify** and lives only in package `exif-details.json` (`software` field) ([verification-package-technical-metadata.ts:117](services/worker/src/verification-package-technical-metadata.ts)). → **keep package-only; relabel intent as "device firmware/software tag".** No public exposure.

### 6. Orientation & White Balance
- PDF Camera Metadata block renders **Orientation** (Portrait/Landscape) and **White balance** (raw, e.g. "Auto") unconditionally ([technical-summary.ts:92–93](services/worker/src/report-v2/sections/technical-summary.ts)). →
  - **White balance:** hide from PDF when value is "Auto".
  - **Orientation:** hide from PDF when normal/landscape; show only when Portrait (rotated/abnormal).
  - **Keep both** raw in package `exif-details.json` and internal.

### 7. EXIF Original Capture Time
- Labelled inconsistently: PDF/verify "Original capture time"; internal "Original capture time (from file)". → **rename to "EXIF Original Capture Time"** everywhere, with a note that it is distinct from PROOVRA submission/preservation timestamps (PDF already has that note; reinforce).

### 8. device-enrichment.json field-level source/confidence
- Today: top-level keys `capturedWith` / `camera` / `operatingSystem` / `deviceClass` / `originalCaptureTime`, each `{value, source, confidence}` (object-level grouping, not nested under `fields`). → **restructure to `{ schemaVersion, generatedAtUtc, evidenceId, fields: { captureDevice, cameraMake, cameraModel, operatingSystem, deviceClass, browser, originalCaptureTime } }`** with `{value, source, confidence}` per field. Sources: `exif` (camera/make/model/capture-time, high) and `capture_environment` (OS/device/browser, medium).

### 9. Internal Evidence Detail
- Already shows Camera (EXIF), OS, browser, device-class, masked IP, country/region (internal-gated) in `EvidenceTechnicalMetadataCard` (Technical Appendix tab, collapsible) — [EvidenceTechnicalMetadataCard.tsx:88](apps/web/app/(app)/evidence/[id]/_tabs/EvidenceTechnicalMetadataCard.tsx). → **no duplication needed; add a compact "Intake delivery" subsection (masked recipient + channel + status) when intake delivery exists.** No sidebar clutter — it's inside the existing collapsible card.

### 10. Intake recipient phone — full privacy trace
- **Capture:** `recipientPhone` body field on `POST /v1/workflow/intake-links` ([workflow-intake-links.routes.ts:89](services/api/src/routes/workflow-intake-links.routes.ts)).
- **Raw storage:** `WorkflowIntakeLink.recipientPhone` (`recipient_phone`), `WorkflowIntakeSession.submitterPhone` (`submitter_phone`), `EvidenceRequest.recipientPhone` (`recipient_phone`) — all `VarChar(32)`, raw.
- **Masked/hashed storage:** `CommunicationMessage` stores **only** `recipientHash` (HMAC-SHA256, `recipient_hash`) and `recipientPreview` (masked `+CC ••• ••• 1234`, `recipient_preview`) — never raw. Plus `channel`, `status` (QUEUED/SENT/DELIVERED/FAILED/…), `sent_at_utc`, `delivered_at_utc`, `failed_at_utc`, `purpose` (`INTAKE_LINK`), `related_intake_session_id`, `related_intake_link_id`.
- **Evidence linkage:** `Evidence` ↔ `WorkflowIntakeSession.evidenceId` (`evidence_id`, unique) → `WorkflowIntakeSession.intakeLinkId` (`intake_link_id`) → delivery via `communication_messages.related_intake_session_id`.
- **Consent:** `WorkflowIntakeSession.consentAcceptedAtUtc` + `consentSnapshotJson`; link-level `consentPolicyVersion` / `consentDisclosureText`.
- **Current public exposure:** **NONE.** Worker reads no phone field (grep clean). PDF/Verify/package never include phone. External-intake projection explicitly excludes `recipientPhone` (test pinned).
- **Masking helper:** `maskPhonePreview(phone)` in `@proovra/shared` → `+CC ••• ••• 1234`. But `recipient_preview` is **already** stored masked, so the worker can use it directly and **never touch the raw phone**.

**Conclusion:** the safe, additive change is to emit `technical-metadata/intake-recipient-context.json` **only** from the already-masked `communication_messages` row (preview + hash + delivery status/timestamps), and surface the same masked delivery line internally. No raw phone ever enters the worker, the package, the PDF, or the verify page.

---

## IMPLEMENTATION PLAN

**Part 1 — Device/Camera cleanup**
- `capture-environment.ts`: Windows NT 10.0 → `osVersion = null` (renders "Windows").
- `technical-summary.ts` (PDF): hide White balance == "Auto"; hide Orientation unless Portrait; relabel "EXIF Original Capture Time"; show Browser for mobile device-class even with a camera; split Camera Make/Model rows only when both present (else the combined Capture Device label).
- `VerifyTechnicalMetadataSection.tsx`: relabel "EXIF Original Capture Time".
- `EvidenceTechnicalMetadataCard.tsx`: relabel "EXIF Original Capture Time".
- `verification-package-technical-metadata.ts`: restructure `device-enrichment.json` to `fields:{}` field-level shape (adds cameraMake/cameraModel/browser); keep `exif-details.json` raw (firmware/orientation/WB stay here).

**Part 2 — Intake recipient privacy**
- `verification-package-technical-metadata.ts`: new `intake-recipient-context.json`, emitted only when an `INTAKE_LINK` SMS/WhatsApp `communication_messages` row exists for the evidence; masked preview + hash + delivery status/timestamps; `fullValueIncluded:false`; `privacy{}` block. Never reads raw phone.
- `verify-projection.service.ts` (internal only): add `intakeDelivery` (masked recipient + channel + status + timestamps), gated `internal:true`, never public.
- `EvidenceTechnicalMetadataCard.tsx`: render a compact "Intake delivery" subsection when `intakeDelivery` present.

**Part 3 — Tests** (worker package + PDF section, api projection privacy, shared OS parser).

**Part 4 — Validation:** api/worker/web typecheck, worker + api test, web build.

**Hard rules honored:** no new generic section; no Mixed/Partial/Network/IP/GPS duplicate; no full phone publicly or in default package; no raw firmware in PDF/Verify; no crypto/custody/OTS/timestamp/signature/anchoring change.
