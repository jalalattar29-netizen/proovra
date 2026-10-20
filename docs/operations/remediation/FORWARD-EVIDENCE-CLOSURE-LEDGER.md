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
| AUD-01 | P1 | ARCHIVED / RETENTION_ARCHIVED evidence receives new outputs via worker paths | FIXED IN PHASE 1 | One decision `decideOutputProduction` (@proovra/shared) inside the ONE writer (entitlement REQUIRED of every producer), re-asked at worker claim, report commit and package commit; both re-enqueue paths settle instead of re-queueing. forward-output-pipeline Phase 1 block (real stack) + shared output-producer-decision tests; mutants P1-A..F killed. |
| AUD-02 | P1 | Worker producers enqueue without entitlement / lifecycle checks | FIXED IN PHASE 1 | Every producer (API authority, OTS chain-verified version, first issuance / recovery, legacy drain) passes its entitlement reading to the writer; claim re-checks. Same proof as AUD-01. |
| AUD-03 | P1 | Plan refusal → FAILED_TERMINAL + Sentry + critical alert | FIXED IN PHASE 2 | New non-failure terminal request state NOT_APPLICABLE (reason NOT_APPLICABLE_*). Refusals at claim, run, report commit and package commit settle without throwing. The inner attempt catch never captures a refusal. bindWorkerEvents exempts a refusal (backstop). Proof: worker-events-business-refusal.test.ts (real extracted binding + real BullMQ on Redis: refusal -> 0 captures / 0 alerts, technical -> 1 / 1) and the forward Phase 2 block (no Sentry, no incident; technical failure still escalates). Mutants P2-A/B/C/D killed; P2-E equivalent (a legacy commercial code is converted to the same refusal by the inner catch). |
| AUD-04 | P1 | Commercial terminal after READY → NEEDS_ATTENTION | FIXED IN PHASE 2 | isCurrentReportUpdateFailure excludes commercial and NOT_APPLICABLE reasons (both Reports aggregator sites pass the reason). The ops probe excludes commercial terminals. NOT_APPLICABLE projects to NOT_REQUESTED. Proof: shared tests + forward 'refusal after a READY report' case (READY / COMPLETE). Mutant P2-F killed. |
| AUD-05 | P1 | Seal check memoizes PUBLISHED across key revocation | OPEN | |
| AUD-06 | P1 | FULL_FORENSIC package ignores `allowOriginalDownload=false` | OPEN | |
| AUD-07 | P1 | Customer PII in tracked docs and the generated runbook catalog | OPEN | Git-history rewrite is a separate owner decision |
| AUD-08 | P1 | Single-part original presign not pinned to the sealed version | OPEN | |
| AUD-09 | P2 | Integrations API reviewer assignee not workspace-checked | OPEN | |
| AUD-10 | P2 | Chain catch-up re-enqueues final-VERIFIED rows every tick | FIXED IN PHASE 3 | chainCheckDueWhere excludes VERIFIED rows at >= 144 confirmations; the sweep is ordered least-recently-checked first (CHAIN_CHECK_SWEEP_ORDER) with the existing batch bound and job-id dedup. Real reconciler on live PostgreSQL / Redis: final rows get no job across two passes, a still-confirming row does; a long-unchecked record is served before an older anchor. Mutants P3-A, P3-B killed. |
| AUD-11 | P2 | Forward OTS progress treated as a contradiction | FIXED IN PHASE 3 | compareIssuanceFactsToRecord accepts forward OTS verification progress (otsVerificationProgressionCompatible, the one ranking); a regression and a changed ANCHORED proof stay contradictions. Forward cases: chain verified during render -> run commits and v1 states ATTESTATION_RECORDED (issuance truth); regression and proof-bytes change -> refused. Mutants P3-C, D, E killed. |
| AUD-12 | P2 | STORAGE_LIMIT_REACHED treated as a technical CRITICAL | FIXED IN PHASE 2 | A package storage-allowance refusal settles NOT_APPLICABLE_STORAGE_LIMIT. STORAGE_LIMIT_REACHED is in the commercial set for historical rows. Proof: forward storage-allowance case (report stays issued, no package, no Sentry, no incident). Mutants P2-H/P2-I killed. |
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
| AUD-35 | P2 | Package commit does not re-check lifecycle | FIXED IN PHASE 1 | Package commit re-reads lifecycle under the record advisory lock; 'trashed WHILE its package builds' case + mutant P1-E killed. |
| AUD-36 | P2 | Intake / portal entitlement gaps | OPEN | |
| AUD-37 | P2 | Mobile capture gaps | OPEN | |
| AUD-38 | P2 | Derivative / extraction truth gaps | OPEN | |
| AUD-39 | P2 | Ops seed writes onto real evidence | OPEN | |
| AUD-40 | P2 | Legacy trash backfill backdates grace | OPEN | Forward rule only; no historical rerun |
| AUD-41 | P2 | Monitoring noise and gaps | OPEN (expected refusals Phase 2; OTS P2028 Phase 3; ECONNREFUSED filter and per-attempt Sentry Phase 12) | Phase 3: transient database errors (P2028, P2034, P1001/1002/1008/1017) in the OTS job are retried quietly, with exponential backoff and 0.5 jitter, and escalate once on exhaustion (real binding: 19 attempts -> 0 captures, final -> 1 capture / 1 alert). Mutants P3-F, P3-G killed. |
| AUD-42 | P2 | TSA call inside the finalize transaction | OPEN | |
| AUD-43 | P3 | No DB guard on sealed truth columns | OPEN | |
| AUD-44 | P3 | Latent "Immutable Storage: Verified" rule | OPEN | |
| AUD-45 | P3 | Projection denylists; withheld identity labels sent | OPEN | |
| AUD-46 | P2 | CONTENT_PREVIEW sends country / timezone with location hidden | OPEN | |
| AUD-47 | P3 | Raw enums, tone / label drift | OPEN | |
| AUD-48 | P3 | Public Verify details (live delta, history, CSP, print, headers) | OPEN | |
| AUD-49 | P3 | Package vocabulary, determinism, tombstones | OPEN | |
| AUD-50 | P3 | Ops hygiene (cron lock, timeouts, publish gate) | OPEN (OTS parts fixed in Phase 3: NOT_IN_ACTIVE_CHAIN backoff 1h/6h/24h and give-up at 30 days; the rest Phase 12) | ots-chain-recheck-bounds.test.ts; mutant P3-H killed. |
| AUD-51 | P3 | Duplicated helpers | OPEN | |
| AUD-52 | P3 | Ingress hygiene | OPEN | |
| AUD-53 | P1 | Legacy single-part composite digest fails the render gate | OPEN | Characterized (Phase 4 block). 16 historical failures and 21 exposed records are HISTORICAL-DATA-ONLY (no re-request). |
| AUD-54 | P2 | Uncoded `Error` terminals | OPEN (archived throw site fixed in Phase 1; full sweep Phase 4) | `processor.ts` canonical-reference refusal raises the coded business refusal (lifecycle) or `CANONICAL_REFERENCE_REFUSED`, never a plain Error. |
| AUD-55 | P2 | Production TSA validation coverage | HISTORICAL-DATA-ONLY | Forward TSA truth is covered by Phase 8. No historical validation backfill. |
| AUD-56 | P2 | 18 records without recorded Object Lock | REQUIRES POST-DEPLOY OPERATOR PROOF | Forward: every new record must record a lock or STORAGE_PROTECTION_UNAVAILABLE. Historical: storage HEAD by the operator. |
| AUD-57 | P2 | Coordinates without location source | OPEN | Forward writer invariant (Phase 10). No historical backfill. |
| AUD-58 | P2 | Monitoring saturation | REQUIRES POST-DEPLOY OPERATOR PROOF | Producers fixed in Phases 1-3. Historical incidents are resolved through the retirement tool, not here. |
