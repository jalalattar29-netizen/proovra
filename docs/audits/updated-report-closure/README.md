# Updated report & recovery — closure proof

Branch `fix/updated-report-terminal-lockout`. Recorded runs of the specs in
`e2e/updated-report/` against the disposable Linux stack
(`e2e/updated-report/stack/`), and of the Feature CI workflow
`.github/workflows/updated-report-journey.yml`. Nothing here touched
Production.

## The journey (real browser → API → queue → production worker → MinIO)

| Step | Recorded |
|---|---|
| v1 issued while the RFC 3161 token is kept but **not validated** | v1 PDF states "TRUSTED TIMESTAMP Timestamp pending … could not be validated: no timestamp trust anchor is configured" |
| TSA validated through `repair-tsa-failed-with-token` (stack TSA root as anchor) | `tsa_status` STAMPED, `tsa_validated_at_utc` set, failure code NULL |
| OTS anchored by the worker's upgrade processor (`ots upgrade`/`ots info`) | `ots_status` ANCHORED, `ots_anchor_check` PROOF_STRUCTURE |
| Artifacts tab explains the newer facts | `01-status-freshness.png` |
| Dialog: Generate report v2, reason, credit/storage effect, immutability | `02-modal.png` |
| Confirm sends the SIGNED offer revision (`ofr1.…`) → 202, durable request + queue job | `journey-proof.json` → `durableRequest` |
| Progress card; full reload mid-run keeps it (persisted step) | `03-…`, `04-progress-after-reload.png` |
| Durable steps written by the worker (DB-sampled) | RENDERING_REPORT → VERIFYING_REPORT / REPORT_COMMITTED → BUILDING_PACKAGE → VERIFYING_PACKAGE → SUCCEEDED |
| v2 Latest, v1 Previous, each beside its own package | `05-…`, `06-version-history.png` |
| v2 PDF states the current trust | "Trusted timestamp Verified …", "BITCOIN ANCHORING Anchored" |
| Extracted v2 ZIP | 43/43 checksum entries match; seal binds the checksums and the v2 report digest; Ed25519 seal signature valid; embedded `reports/proovra-verification-report-v2.pdf` = stored v2 PDF byte for byte |
| v1 unchanged | v1 PDF and ZIP re-downloaded after v2: identical bytes and SHA-256 |

Feature CI (Linux runner, run 37404887956, job 112080131137, SHA
`38ae0e2af`): **25/25 passed**; v1 report `feb278a0…27f7`, v1 package
`845d4643…02df`; v2 report `fc180fbb…708c`, v2 package `8535b1c8…ab9a`; seal
valid; 43 entries; request `efb3ffb6-1152-492c-9077-3355736bf7cf`, job
`report-efb3ffb6-1152-492c-9077-3355736bf7cf`.

Feature CI (run 37410509036, job 112097652698, SHA `206681d59`): **25/25
passed**; v1 report `e7b4aaa8…0157`, v1 package `1ef92db5…dce2`; v2 report
`030acfc9…d00c`, v2 package `2de7fec4…244b`; seal valid; 43 entries; request
`6a011cc0-5fe1-4e7f-b257-3862f8a738e3`, job
`report-6a011cc0-5fe1-4e7f-b257-3862f8a738e3`. Every run mints fresh evidence
and keys, so the digests differ run to run; what each run proves is the
relation between them (v2 package seal ↔ v2 report digest, v1 bytes unchanged).

Disclosed: on `206681d59` build-test failed once in
`webhook-destinations.render.test.tsx` (automation webhooks, untouched here);
the identical tree re-ran green, and the test passes locally alone and under
three parallel full render suites. It is tracked separately, not masked.

## Failure, recovery and concurrency matrix

| Case | Result |
|---|---|
| Dialog open while another member issues v2 | stale answer in place ("A newer report version was completed."), reason kept, target becomes v3, the stale confirmation creates nothing; confirming creates v3 — versions 1,2,3 each with its own package |
| Dialog open while the TSA is validated | stale ("The trusted timestamp's status changed."), freshness lists it, reason kept |
| Dialog open while permission is removed | typed "You don't have permission to do that", reason kept, nothing created; removed member → 404 on status and action |
| Double-click Confirm | one request, one v2 |
| 20 concurrent confirmations of one revision + a second member at once | 3×202 (same request id, replays), 18×429; exactly one request, one v2 |
| Worker down before render | request waits QUEUED (card shows Queued), processed once the worker returns |
| Worker SIGKILLed after the report is committed, before the package | still PROCESSING at the kill; after the lease the run resumes package-only; one v2 report, one v2 package, v1 untouched |
| Storage (MinIO) paused during the run | never shown complete while paused; one v2 pair after recovery |
| Redis stopped at Confirm | **was a hang (no answer in 120 s) — fixed**: 202 QUEUE_UNAVAILABLE "saved, will be picked up"; one v2 after Redis returns |
| Report and package object deleted from storage | 410 typed, no storage key/bucket/URL in the body; UI: "…stored file is unavailable. Contact support; nothing has been changed."; other versions download |
| Integrity terminal | no updated-report action; card "This record needs review" + support reference; confirm 409 |
| Outsider (another workspace) | 404 on status, action and downloads; nothing created |

`matrix/stale-offer-updated-in-place.png`, `matrix/permission-removed.png`.

## Accessibility, responsive, RTL, colour schemes

`a11y/`: keyboard-only flow (focus lands on the reason, Tab trapped both ways,
Escape closes and returns focus to the trigger), accessible names on every
control and no nested interactive controls, `aria-invalid` + described error
with `role=alert`, AA contrast on the artifact text, no horizontal scroll and
no clipped action at 320 px, tablet, desktop and the 125 % / 200 % zoom-equivalent
widths, pseudo-localised long strings in RTL (logical layout mirrors), legible
under a dark OS preference and under the surface's dark token hook (a 1.4:1
dialog title found and fixed), no backdrop motion under reduced motion.
