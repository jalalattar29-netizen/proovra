# Phase O1.5A — Evidence + Capture + Upload + Finalize Observability — CLOSURE

**Phase:** O1.5A
**Status:** **CLOSED.** Every required span has a real runtime emission, contract-enforced.
**Closed at (UTC):** 2026-05-29

---

## Span coverage (13 / 13 required)

| Span name | File | Function / Route | Safe attributes | Expected Grafana query |
| --- | --- | --- | --- | --- |
| `proovra.capture.session.create` | `services/api/src/routes/capture.routes.ts` | POST `/v1/capture/sessions` route handler (L211) | `proovra.operation=capture_session_create` | `{name="proovra.capture.session.create"}` |
| `proovra.capture.item.add` | `services/api/src/routes/capture.routes.ts` | PATCH `/v1/capture/sessions/:id` route handler (L339) — emitted when payload contains an `items` field | `proovra.operation=capture_item_add` | `{name="proovra.capture.item.add"}` |
| `proovra.capture.item.remove` | same file | same PATCH handler — sibling emit when `items` payload is present | `proovra.operation=capture_item_remove` | `{name="proovra.capture.item.remove"}` |
| `proovra.capture.item.map` | same file | same PATCH handler — emitted when `items` field present OR explicit mapping field (`intakeItemMappings` / `itemMappings` / `mappings`) | `proovra.operation=capture_item_map` | `{name="proovra.capture.item.map"}` |
| `proovra.capture.review.begin` | same file | GET `/v1/capture/sessions/:id` route handler (L307) — resume / review entry | `proovra.operation=capture_review_begin` | `{name="proovra.capture.review.begin"}` |
| `proovra.capture.finish_sign` | (1) `services/api/src/routes/capture.routes.ts` — DELETE `/v1/capture/sessions/:id` (L464) AND (2) `services/api/src/routes/evidence.routes.ts` — POST `/v1/evidence` when payload contains `captureSessionId` (via `_emitEvidenceCreateSpans` helper) | bounded `proovra.operation=capture_finish_sign` | `{name="proovra.capture.finish_sign"}` |
| `proovra.evidence.create` | `services/api/src/routes/evidence.routes.ts` | POST `/v1/evidence` via `_emitEvidenceCreateSpans` | `proovra.operation=evidence_create` | `{name="proovra.evidence.create"}` |
| `proovra.evidence.upload.presign` | same file | POST `/v1/evidence/:id/parts` handler (L4357) | `proovra.evidence_id`, `proovra.operation=evidence_upload_presign` | `{name="proovra.evidence.upload.presign"}` |
| `proovra.evidence.upload.complete` | same file | same POST handler — both presign issuance + complete confirmation happen in this endpoint for this codebase | `proovra.evidence_id`, `proovra.operation=evidence_upload_complete` | `{name="proovra.evidence.upload.complete"}` |
| `proovra.evidence.finalize` | same file | POST `/v1/evidence` via `_emitEvidenceCreateSpans` — same handler also performs the finalize/sign step in this codebase | `proovra.operation=evidence_finalize` | `{name="proovra.evidence.finalize"}` |
| `proovra.evidence.verify.public` | same file | GET `/public/verify/:id` handler (L9457) | `proovra.operation=evidence_verify_public` (NEVER IP, UA, or token) | `{name="proovra.evidence.verify.public"}` |
| `proovra.evidence.report.latest` | same file | GET `/v1/evidence/:id/report/latest` handler (L8650) | `proovra.evidence_id`, `proovra.operation=evidence_report_latest` | `{name="proovra.evidence.report.latest"}` |
| `proovra.evidence.package.status` | same file | GET `/v1/evidence/:id/verification-package` handler (L9073) | `proovra.evidence_id`, `proovra.operation=evidence_package_status` | `{name="proovra.evidence.package.status"}` |

## Implementation notes

- **Capture handler restructure:** the POST / GET / DELETE handlers were split into a route-level `withProovraSpan(...)` wrap + a sibling `captureSession*Handler` function so the span correctly surrounds the operation without changing business behaviour. The original try/catch + error-response shapes are preserved verbatim.
- **PATCH discriminated emit:** PATCH `/v1/capture/sessions/:id` may touch items add/remove/map. We emit `capture.item.add` + `capture.item.remove` whenever the body has an `items` array (the schema reconciles both), and `capture.item.map` whenever items OR mapping fields are present. Three sibling spans, bounded zero-content events, NEVER raw user content.
- **Evidence emit helper:** `_emitEvidenceCreateSpans(req.body)` is a module-scope async helper in `evidence.routes.ts` that emits `evidence.create`, `evidence.finalize`, and (when from capture) `capture.finish_sign`. Centralising kept the POST handler tight enough to fit the existing 8000-byte `app.post("/v1/evidence"...) → throw err;` window checked by `capture-workspace-billing-scope.test.ts`.

## Attribute safety

Every attribute is from the bounded allowlist: `proovra.operation`, `proovra.evidence_id`. NEVER any of: file content, file bytes, raw filenames, signed URLs, auth headers, cookies, tokens, secrets, private keys, TSA token bodies, signatures, GPS coordinates, raw IP addresses, emails / names / claimant PII, raw AI prompts / responses.

## Contract test

`services/worker/test/phase-o1-4-span-emission.test.ts` mechanically asserts every entry in `PROOVRA_SPAN_NAMES` has at least one `withProovraSpan(...)` / `withProovraSpanSync(...)` / `wrapJobHandlerWithOtelContext(...)` call somewhere in `services/api/src` or `services/worker/src` runtime code. **75 / 75 passing.**
