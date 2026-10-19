# Forward evidence-output closure ledger

The finding registry is the Production-backed evidence-output audit of 2026-10-19 / 2026-10-20, run against origin/main `99c87eea1`.

**Scope: forward-only.** Historical test evidence is not repaired, regenerated or reconciled. No historical report or package is re-issued. That population will be retired separately through the canonical lifecycle authority.

## Statuses

| Status | Meaning |
|---|---|
| OPEN | not yet addressed |
| ALREADY CLOSED | proven by behaviour at the baseline |
| FIXED IN PHASE n | fixed in that phase, with a behaviour test that fails on the baseline |
| HISTORICAL-DATA-ONLY | accepted without repair |
| REQUIRES PHYSICAL DEVICE PROOF | the code change is tested, but the behaviour can only be proven on a device |
| REQUIRES POST-DEPLOY OPERATOR PROOF | can only be proven after deployment, by an operator |

Every row names its proof. A finding never leaves this table.

## Ledger

| AUD | Severity | Title | Status | Proof / notes |
|---|---|---|---|---|
| AUD-01 | P1 | ARCHIVED / RETENTION_ARCHIVED evidence receives new outputs via worker paths | OPEN | Characterized: `services/api/test/forward/forward-output-pipeline.integration.test.ts` (Phase 1 block) |
| AUD-02 | P1 | Worker producers enqueue without entitlement / lifecycle checks | OPEN | same suite |
| AUD-03 | P1 | Plan refusal → FAILED_TERMINAL + Sentry + critical alert | OPEN | |
| AUD-04 | P1 | Commercial terminal after READY → NEEDS_ATTENTION | OPEN | |
| AUD-05 | P1 | Seal check memoizes PUBLISHED across key revocation | OPEN | |
| AUD-06 | P1 | FULL_FORENSIC package ignores `allowOriginalDownload=false` | OPEN | |
| AUD-07 | P1 | Customer PII in tracked docs and the generated runbook catalog | OPEN | Git-history rewrite is a separate owner decision |
| AUD-08 | P1 | Single-part original presign not pinned to the sealed version | OPEN | |
| AUD-09 | P2 | Integrations API reviewer assignee not workspace-checked | OPEN | |
| AUD-10 | P2 | Chain catch-up re-enqueues final-VERIFIED rows every tick | OPEN | |
| AUD-11 | P2 | Forward OTS progress treated as a contradiction | OPEN | |
| AUD-12 | P2 | STORAGE_LIMIT_REACHED treated as a technical CRITICAL | OPEN | |
| AUD-13 | P2 | Reviewer share discloses the permanent `pvr_` | OPEN | |
| AUD-14 | P2 | TSA wording / tone drift across surfaces | OPEN | |
| AUD-15 | P2 | Custody lines say "validated" for raw STAMPED | OPEN | |
| AUD-16 | P2 | Kept token + NULL code → invented "no trust anchor" cause | OPEN | |
| AUD-17 | P2 | Unvalidated token genTime / serial printed as fact | OPEN | |
| AUD-18 | P2 | PDF prints the internal UUID | OPEN | |
| AUD-19 | P2 | PDF prints coordinates regardless of disclosure; external tiles | OPEN | |
| AUD-20 | P2 | Location-source backfill mislabels app GPS | HISTORICAL-DATA-ONLY | Forward writers are covered by AUD-57. No historical backfill. |
| AUD-21 | P2 | Web deviceTimeIso = Finish click; unvalidated device time | OPEN | |
| AUD-22 | P2 | Extension "server-issued session" overstatement; window unchecked | OPEN | |
| AUD-23 | P2 | Extension SESSION_BUSY → NOTHING_SAVED | OPEN | |
| AUD-24 | P2 | Continuous tail truncation seals COMPLETE | OPEN | |
| AUD-25 | P2 | `capturedAtUtc` labelled "Captured" | OPEN | |
| AUD-26 | P2 | Owner snapshot vs live verdict without a boundary | OPEN | |
| AUD-27 | P2 | Client re-derives Public Verify trust tone | OPEN | |
| AUD-28 | P2 | 410 / 429 shown as "Verification Failed" | OPEN | |
| AUD-29 | P2 | Per-record distinct-client limiter can lock shared pages | OPEN | |
| AUD-30 | P2 | Admin / ops counts not entitlement-aware | OPEN | |
| AUD-31 | P2 | Org CSV exports gated by rank | OPEN | |
| AUD-32 | P2 | Deploy safety: worker schema check, contract migrations, revision skew | OPEN | |
| AUD-33 | P2 | Test gaps; surviving mutants D / F / G | OPEN | |
| AUD-34 | P2 | Package trust gaps (shipped PEM, wording, offline claims) | OPEN | |
| AUD-35 | P2 | Package commit does not re-check lifecycle | OPEN | Characterized (Phase 1 block) |
| AUD-36 | P2 | Intake / portal entitlement gaps | OPEN | |
| AUD-37 | P2 | Mobile capture gaps | OPEN | |
| AUD-38 | P2 | Derivative / extraction truth gaps | OPEN | |
| AUD-39 | P2 | Ops seed writes onto real evidence | OPEN | |
| AUD-40 | P2 | Legacy trash backfill backdates grace | OPEN | Forward rule only; no historical rerun |
| AUD-41 | P2 | Monitoring noise and gaps | OPEN | |
| AUD-42 | P2 | TSA call inside the finalize transaction | OPEN | |
| AUD-43 | P3 | No DB guard on sealed truth columns | OPEN | |
| AUD-44 | P3 | Latent "Immutable Storage: Verified" rule | OPEN | |
| AUD-45 | P3 | Projection denylists; withheld identity labels sent | OPEN | |
| AUD-46 | P2 | CONTENT_PREVIEW sends country / timezone with location hidden | OPEN | |
| AUD-47 | P3 | Raw enums, tone / label drift | OPEN | |
| AUD-48 | P3 | Public Verify details (live delta, history, CSP, print, headers) | OPEN | |
| AUD-49 | P3 | Package vocabulary, determinism, tombstones | OPEN | |
| AUD-50 | P3 | Ops hygiene (cron lock, timeouts, publish gate) | OPEN | |
| AUD-51 | P3 | Duplicated helpers | OPEN | |
| AUD-52 | P3 | Ingress hygiene | OPEN | |
| AUD-53 | P1 | Legacy single-part composite digest fails the render gate | OPEN | Characterized (Phase 4 block). 16 historical failures and 21 exposed records are HISTORICAL-DATA-ONLY (no re-request). |
| AUD-54 | P2 | Uncoded `Error` terminals | OPEN | Throw site identified: `processor.ts:2993` raises a plain `Error("canonical verification refused for report rendering: <STATE>")` for a non-ACTIVE record. That explains the 8 Production rows on ARCHIVED records. |
| AUD-55 | P2 | Production TSA validation coverage | HISTORICAL-DATA-ONLY | Forward TSA truth is covered by Phase 8. No historical validation backfill. |
| AUD-56 | P2 | 18 records without recorded Object Lock | REQUIRES POST-DEPLOY OPERATOR PROOF | Forward: every new record must record a lock or STORAGE_PROTECTION_UNAVAILABLE. Historical: storage HEAD by the operator. |
| AUD-57 | P2 | Coordinates without location source | OPEN | Forward writer invariant (Phase 10). No historical backfill. |
| AUD-58 | P2 | Monitoring saturation | REQUIRES POST-DEPLOY OPERATOR PROOF | Producers fixed in Phases 1-3. Historical incidents are resolved through the retirement tool, not here. |
