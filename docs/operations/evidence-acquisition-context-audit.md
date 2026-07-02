# Evidence Acquisition Context — Audit (Part 0)

**Date:** 2026-07-01
**Subject:** How evidence reached PROOVRA via intake/delivery — NOT integrity, EXIF, GPS, or identity proof.
**Scope:** Add a privacy-safe Evidence Acquisition layer across PDF Report, Public Verify, Verification Package, Internal Evidence Detail. No migrations. No integrity/custody/OTS/signature/anchoring change.

---

## 1. Intake methods currently supported
| Method | Signal | Where created |
|---|---|---|
| SMS | `CommunicationMessage.channel = SMS` (provider TWILIO) | `communication.service.ts` send; link `POST /v1/workflow/intake-links` |
| WhatsApp | `CommunicationMessage.channel = WHATSAPP` | same |
| Email | `CommunicationMessage.channel = EMAIL` (provider RESEND) | same |
| Public secure link | any intake link with no SMS/WhatsApp/Email/mobile record (reusable, anonymous, pseudonymous, or a one-time link shared manually) | intake-link create |
| Mobile app | `captureEnvironment.uploadSource = MOBILE_APP` | citizen-capture route |
| Direct upload | `captureEnvironment.uploadSource = WEB_APP` / `Evidence.captureMethod = UPLOADED_FILE` | `POST /v1/evidence` |
| API | `captureEnvironment.uploadSource = API` | API submission |

## 2. Per-field availability (exact @map columns)
- **Intake mode**: `workflow_intake_links.intake_mode` (EXTERNAL_ONE_TIME/REUSABLE/ANONYMOUS/PSEUDONYMOUS, AUTHENTICATED_*, FIELD_TEAM). ✅
- **Recipient (raw, DB-only)**: `workflow_intake_links.recipient_phone` / `recipient_email`; `workflow_intake_sessions.submitter_phone` / `submitter_email`. ✅ (never leave DB)
- **Masked recipient preview**: `communication_messages.recipient_preview` (masked phone `+CC ••• 1234`). ✅ for SMS/WhatsApp. **Email preview = GAP** (only `recipient_hash` stored) → mask at read-time via `maskEmail(raw)` (approved helper), never expose raw.
- **Recipient hash**: `communication_messages.recipient_hash` (HMAC-SHA256). ✅
- **Delivery channel**: `communication_messages.channel`. ✅
- **Delivery status**: `communication_messages.status` (QUEUED/SENT/DELIVERED/FAILED/…). ✅
- **Opened / link-used**: `workflow_intake_sessions.opened_at_utc` + custody `EXTERNAL_INTAKE_LINK_USED`. ✅
- **Consent accepted**: `workflow_intake_sessions.consent_accepted_at_utc` + `consent_snapshot_json.policyVersion`; link `consent_policy_version`; custody `EXTERNAL_INTAKE_CONSENT_ACCEPTED`. ✅
- **Submitted at**: `workflow_intake_sessions.submitted_at_utc` + custody `EXTERNAL_INTAKE_SUBMITTED`. ✅
- **Provider IDs**: `communication_messages.provider` + provider message IDs exist in DB — **must never leave DB/package/public**. ✅ (excluded)
- **Full-value leak risk**: raw phone/email exist on link/session — the projection reads ONLY `recipient_preview`/`recipient_hash` (and `maskEmail` for email), never the raw columns into any output.

## 3. Privacy boundary (confirmed / enforced)
- Full phone/email → **DB only**.
- Masked recipient → package + internal only.
- PDF → channel/status/method/consent, **no recipient**.
- Verify → high-level acquisition, **no recipient**.
- Default package → masked + hash only, **no provider IDs**, no raw payloads.

## 4. Evidence linkage
`Evidence` ↔ `workflow_intake_sessions.evidence_id` (unique) → `.intake_link_id` → `workflow_intake_links`; delivery via `communication_messages.related_intake_session_id` (purpose `INTAKE_LINK`, channel SMS/WHATSAPP/EMAIL). Present and reliable. Gaps → show Unknown / omit, never fabricate.

## 5. Gaps (documented, not faked)
- **No QR intake delivery channel.** PROOVRA does not persist a QR delivery
  method; a QR is only a visual encoding of an intake link's URL. Any intake
  link delivered without SMS/WhatsApp/Email/mobile (including a QR-scanned link)
  is a **Public Secure Link** (never null, never "Unknown", never "QR Code").
  The QR code inside the PDF report is the unrelated *Verify* QR (it opens the
  verify page).
- **Email masked preview** not stored → computed at read-time via `maskEmail`.
- **Mobile app "recipient"** — no recipient concept → recipient omitted, channel "PROOVRA Mobile".

## 6. Implementation plan
Single normalized pure mapper `@proovra/shared-runtime/technical-metadata` `buildEvidenceAcquisitionContext(raw)` → `EvidenceAcquisitionContext` with `toPublicAcquisition` (PDF/Verify, no recipient) and `toInternalAcquisition` (masked recipient). Query wrappers in the API verify-projection and worker package builder feed raw DB values (masking email at read-time). PDF renders a compact table inside Executive Summary (before Capture Context); Verify renders a tiny card near Capture Context; package emits `technical-metadata/intake-delivery.json`; internal card gains an Evidence Acquisition subsection.
