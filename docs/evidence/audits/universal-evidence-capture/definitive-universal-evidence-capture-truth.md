# Definitive Universal Evidence Capture Truth

**C. UNIVERSAL EVIDENCE CAPTURE NOT READY**

103 of 119 findings fixed with proof; 16 are code-complete but await device/store/external proof (4 of them P1: UC-AND-003, UC-IOS-001, UC-IOS-002, UC-IOS-004); required journeys PASS 14 · FAIL 0 · BLOCKED 6. A P0/P1 is resolved only when FIXED with proof, so an unproven device path keeps the headline where it is.

At the audit baseline the headline was **C. UNIVERSAL EVIDENCE CAPTURE NOT READY**.

Baseline `47034f45403e87089b29571e3e702311c9d1a2a4` (origin/main (== local main) at audit start, 2026-09-30). Branch `audit/universal-evidence-capture-truth`. Generated from `definitive-universal-evidence-capture-truth.json` by `tooling/build.mjs`; do not edit by hand.

## Remediation reconciliation

Remediation branch `fix/universal-evidence-capture-closure` from `47034f45403e87089b29571e3e702311c9d1a2a4`. Ledger: `remediation/remediation-ledger.json` (mechanical, built by `remediation/build-ledger.mjs`).

- Every finding has exactly one ledger row; dispositions are FIXED_RUNTIME_PROVEN, FIXED_SOURCE_AND_TEST_PROVEN or BLOCKED_EXTERNAL_PROOF only (no deferred, unknown or accepted-risk row).
- BLOCKED_EXTERNAL_PROOF means the code change is made and tested to the limit of this host; the remaining proof needs a device, macOS, a store, a sandbox or a CI runner that this environment does not have.
- Remediated runtime evidence was produced on disposable loopback infrastructure only (PostgreSQL 16, Redis 7, MinIO); no Production system, credential or data was touched.
- The audit's findings, observations and baseline verdicts are kept verbatim; the post-remediation state is added beside them, never written over them.

- Findings: 119 = fixed 103 (runtime-proven 62 · source+test-proven 41) + blocked on external proof 16 + open 0.
- Unresolved by severity: P0 0 · P1 4 · P2 9 · P3 3.

| Finding | Sev | Disposition | Commits | External proof |
|---|---|---|---|---|
| UC-AND-003 | P1 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-06 |
| UC-CASE-001 | P1 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-EXT-001 | P1 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7 | — |
| UC-EXT-003 | P1 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7 | — |
| UC-IOS-001 | P1 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-002 | P1 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-004 | P1 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-OUT-001 | P1 | FIXED_RUNTIME_PROVEN | b4b035380ac8, d87a3673bb63 | — |
| UC-PROV-001 | P1 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8, d87a3673bb63 | — |
| UC-STR-001 | P1 | FIXED_RUNTIME_PROVEN | 6934514c6d49 | — |
| UC-STR-002 | P1 | FIXED_RUNTIME_PROVEN | 6934514c6d49, 9f3d8203c057 | — |
| UC-AND-004 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-06 |
| UC-AND-006 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49 | — |
| UC-AND-007 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-06, EP-14 |
| UC-ARCH-001 | P2 | FIXED_RUNTIME_PROVEN | 6934514c6d49 | — |
| UC-ARCH-002 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, 193e42c49ad0, 9f3d8203c057, 9671120a39ba | — |
| UC-ARCH-003 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, 9f3d8203c057 | — |
| UC-ARCH-004 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 718a4d15ec93 | — |
| UC-ARCH-005 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, 068efffd9da4 | — |
| UC-CASE-002 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-CASE-003 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-COM-001 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, f0527e0c454a | — |
| UC-DER-001 | P2 | FIXED_RUNTIME_PROVEN | 69e995c58803 | — |
| UC-DER-002 | P2 | FIXED_RUNTIME_PROVEN | 69e995c58803 | — |
| UC-DER-003 | P2 | FIXED_RUNTIME_PROVEN | 69e995c58803 | — |
| UC-DER-004 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 69e995c58803 | — |
| UC-DER-005 | P2 | FIXED_RUNTIME_PROVEN | 69e995c58803, d8e1f8605c5f, 9f3d8203c057 | — |
| UC-DER-006 | P2 | FIXED_RUNTIME_PROVEN | 69e995c58803, d8e1f8605c5f, b4b035380ac8, 5b17f3321b08, 83dd6cf482c8 | — |
| UC-DER-007 | P2 | FIXED_RUNTIME_PROVEN | b4b035380ac8 | — |
| UC-DER-010 | P2 | FIXED_RUNTIME_PROVEN | 69e995c58803, b4b035380ac8, 9f3d8203c057 | — |
| UC-EXT-002 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 1fd1813d6ca7 | — |
| UC-EXT-004 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 1fd1813d6ca7, 6934514c6d49, 5e145b8cec61 | — |
| UC-EXT-005 | P2 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7 | — |
| UC-EXT-006 | P2 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7, 0364d89aef47, 0f6f924408ec | — |
| UC-EXT-007 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 1fd1813d6ca7 | — |
| UC-IOS-003 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-005 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-006 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-007 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-008 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-009 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-IOS-010 | P2 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-08 |
| UC-LCH-001 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47, 0f6f924408ec | — |
| UC-PROV-002 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8 | — |
| UC-PROV-003 | P2 | FIXED_RUNTIME_PROVEN | 6934514c6d49, b4b035380ac8 | — |
| UC-PROV-004 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 1fd1813d6ca7 | — |
| UC-PROV-005 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8 | — |
| UC-SEC-001 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-SEC-002 | P2 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7, 718a4d15ec93, 482d69375a59 | — |
| UC-SEC-003 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-SEC-004 | P2 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7, 6934514c6d49 | — |
| UC-STR-003 | P2 | FIXED_RUNTIME_PROVEN | 6934514c6d49 | — |
| UC-TQ-002 | P2 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7, 0364d89aef47 | — |
| UC-TQ-003 | P2 | FIXED_RUNTIME_PROVEN | 69e995c58803, 0364d89aef47, 786a28254e16 | — |
| UC-TQ-004 | P2 | FIXED_RUNTIME_PROVEN | 0364d89aef47, 786a28254e16 | — |
| UC-TQ-007 | P2 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7 | — |
| UC-TQ-008 | P2 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7 | — |
| UC-TRUST-001 | P2 | FIXED_RUNTIME_PROVEN | b4b035380ac8 | — |
| UC-TRUST-002 | P2 | FIXED_RUNTIME_PROVEN | b4b035380ac8 | — |
| UC-TRUST-003 | P2 | FIXED_RUNTIME_PROVEN | b4b035380ac8, 5b17f3321b08, d87a3673bb63, 9f3d8203c057 | — |
| UC-TRUST-004 | P2 | FIXED_RUNTIME_PROVEN | b4b035380ac8, 5b17f3321b08, 24846684b41c, d87a3673bb63, 9f3d8203c057 | — |
| UC-TRUST-005 | P2 | FIXED_RUNTIME_PROVEN | b4b035380ac8 | — |
| UC-TRUST-008 | P2 | FIXED_RUNTIME_PROVEN | b4b035380ac8, a606dcaa5e29, d0034b073eb1, bd87a9e52666, 715ba79b2c4a | — |
| UC-WEB-001 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47, 718a4d15ec93, 9f3d8203c057 | — |
| UC-WEB-003 | P2 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-WEB-004 | P2 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47 | — |
| UC-AND-008 | P3 | FIXED_RUNTIME_PROVEN | 6934514c6d49 | — |
| UC-AND-010 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49 | — |
| UC-AND-011 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49 | — |
| UC-AND-012 | P3 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-06 |
| UC-AND-013 | P3 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-06, EP-14 |
| UC-AND-014 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49 | — |
| UC-ARCH-006 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 718a4d15ec93, b4b035380ac8 | — |
| UC-ARCH-007 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49, 0364d89aef47 | — |
| UC-ARCH-008 | P3 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, 482d69375a59, ac372da90ced, 58fb7e919694 | — |
| UC-ARCH-009 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 1fd1813d6ca7 | — |
| UC-CASE-004 | P3 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, d8e1f8605c5f | — |
| UC-CASE-005 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47, 718a4d15ec93 | — |
| UC-COM-002 | P3 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-COM-003 | P3 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, 068efffd9da4 | — |
| UC-COM-004 | P3 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, d8e1f8605c5f | — |
| UC-DER-008 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 69e995c58803, b4b035380ac8 | — |
| UC-DER-009 | P3 | FIXED_RUNTIME_PROVEN | 69e995c58803 | — |
| UC-DER-011 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 69e995c58803 | — |
| UC-DER-012 | P3 | FIXED_RUNTIME_PROVEN | 69e995c58803, 786a28254e16 | — |
| UC-DER-013 | P3 | FIXED_RUNTIME_PROVEN | 69e995c58803, 0408adaaa26b | — |
| UC-DER-014 | P3 | FIXED_RUNTIME_PROVEN | 69e995c58803, d8e1f8605c5f, 9f3d8203c057 | — |
| UC-DER-015 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8 | — |
| UC-EXT-008 | P3 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7, b91d4b0d3cb3 | — |
| UC-EXT-009 | P3 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7 | — |
| UC-EXT-010 | P3 | FIXED_RUNTIME_PROVEN | 1fd1813d6ca7, 6934514c6d49 | — |
| UC-IOS-011 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49 | — |
| UC-IOS-012 | P3 | BLOCKED_EXTERNAL_PROOF | 6934514c6d49 | EP-14 |
| UC-LCH-002 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47, 7af5861c5013 | — |
| UC-LCH-003 | P3 | FIXED_RUNTIME_PROVEN | 0364d89aef47 | — |
| UC-LCH-004 | P3 | FIXED_RUNTIME_PROVEN | 0364d89aef47 | — |
| UC-LCH-005 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 1fd1813d6ca7 | — |
| UC-LCH-006 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47 | — |
| UC-OUT-002 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47 | — |
| UC-OUT-003 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8 | — |
| UC-OUT-004 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47 | — |
| UC-OUT-005 | P3 | FIXED_RUNTIME_PROVEN | b4b035380ac8, d87a3673bb63 | — |
| UC-PROV-006 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8 | — |
| UC-PROV-007 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8 | — |
| UC-PROV-008 | P3 | FIXED_RUNTIME_PROVEN | b4b035380ac8 | — |
| UC-PROV-009 | P3 | FIXED_RUNTIME_PROVEN | 718a4d15ec93, d8e1f8605c5f | — |
| UC-PROV-010 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49 | — |
| UC-PROV-011 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47 | — |
| UC-SEC-005 | P3 | FIXED_RUNTIME_PROVEN | 718a4d15ec93 | — |
| UC-SEC-006 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49, 718a4d15ec93, b4b035380ac8, 482d69375a59 | — |
| UC-STR-004 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 6934514c6d49 | — |
| UC-STR-006 | P3 | FIXED_RUNTIME_PROVEN | 6934514c6d49 | — |
| UC-TQ-005 | P3 | FIXED_RUNTIME_PROVEN | 6934514c6d49 | — |
| UC-TQ-006 | P3 | FIXED_RUNTIME_PROVEN | 0364d89aef47 | — |
| UC-TRUST-006 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47, b4b035380ac8 | — |
| UC-TRUST-007 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | b4b035380ac8, 9f3d8203c057 | — |
| UC-WEB-002 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47 | — |
| UC-WEB-005 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47, 9f3d8203c057 | — |
| UC-WEB-006 | P3 | FIXED_SOURCE_AND_TEST_PROVEN | 0364d89aef47 | — |

## Safety

- productionContacted: **NO**
- deployed: **NO**
- migratedProduction: **NO**
- productionDataChanged: **NO**
- mainTouched: **NO**
- productSourceFilesChanged: **0**
- Every database, Redis, object store and API used was a disposable loopback container or process started by this audit.
- prisma generate refused to run without DATABASE_URL because the audit worktree has no .env: the Production fallback is absent by construction.
- Web build pinned NEXT_PUBLIC_API_BASE=http://127.0.0.1:9; extension build pinned PROOVRA_API_ORIGIN=http://127.0.0.1:4000; mobile export pinned EXPO_PUBLIC_API_BASE=http://127.0.0.1:9 with EXPO_OFFLINE=1.
- Two generated files touched by runs (docs/architecture/point5-family-proven-cases.json by the integration ledger; apps/mobile/package.json and apps/mobile/android/ by expo prebuild) were restored/removed immediately; the final product diff is zero.

## Runtime-evidence caveats

- Teardown gap (auditor): the first harness run's parent process and tsx-watch wrappers for API and worker survived the port-level kills at ~20:52Z and lived until rec.sh's 3600 s timeout at 21:34:12Z. They restarted their API/worker children whenever the auditor rebuilt shared packages (20:51, 21:11, 21:25, 21:30Z) against the same loopback container ports later stacks reused. This caused the EADDRINUSE 4001 worker failure of phase-2 attempt 1 (that run is discarded: runtime/journeys-phase2-raw.invalid-run.json). The restarted orphans emitted no structured log lines, so it cannot be proven that none of them consumed a queue job during phase-2b (21:22-21:31Z); if one did, it ran the same commit with the same worker configuration against the same disposable services, so outputs would be identical. No orphan could reach Production: the worktree has no .env and the fixture environment is loopback-only.

## Environment limits

- No macOS/Xcode: iOS native compilation, prebuild and device execution are BLOCKED.
- No JDK/Android SDK/emulator/device: Android native compilation and device execution are BLOCKED; Android prebuild (native project generation) ran.
- No sandbox credentials for TSA, OpenTimestamps, AWS S3 Object Lock, Stripe, PayPal, Chrome Web Store, Edge Add-ons, App Store Connect or Google Play: every such proof is in the external proof register, never counted as passed.

## UC verdicts

| UC | Name | Verdict | Audit verdict | Key findings | External blockers |
|---|---|---|---|---|---|
| UC-0a | Provenance Truth Repair | **COMPLETE** | PRESENT BUT UNTRUTHFUL | UC-PROV-001, UC-PROV-002, UC-ARCH-001, UC-PROV-003, UC-PROV-004, UC-PROV-005 | — |
| UC-0b | Trust / Attestation Repair | **COMPLETE LOCALLY, EXTERNAL PROOF PENDING** | PARTIALLY COMPLETE | UC-TRUST-008, UC-TRUST-005, UC-TRUST-002, UC-TRUST-001, UC-TRUST-003, UC-TRUST-004 | EP-01, EP-02, EP-03 |
| UC-0c | Derivative Lifecycle Closure | **COMPLETE** | PARTIALLY COMPLETE | UC-DER-002, UC-DER-006, UC-DER-005, UC-DER-007, UC-DER-013, UC-DER-014 | — |
| UC-1 | Chrome / Edge Web Capture | **COMPLETE LOCALLY, EXTERNAL PROOF PENDING** | PRESENT BUT UNREACHABLE | UC-EXT-001, UC-EXT-003, UC-SEC-002, UC-TQ-007, UC-EXT-004, UC-EXT-005 | EP-04, EP-05, EP-12 |
| UC-2 | Android Direct Screen Capture | **CODE COMPLETE, EXTERNAL PROOF REQUIRED** | PARTIALLY COMPLETE | UC-AND-003, UC-AND-006, UC-AND-007, UC-AND-011, UC-AND-012 | EP-06, EP-07, EP-14 |
| UC-3 | Continuous Capture + Streaming | **CODE COMPLETE, EXTERNAL PROOF REQUIRED** | PRESENT BUT UNTRUTHFUL | UC-STR-002, UC-STR-001, UC-AND-004, UC-STR-003, UC-STR-006 | EP-06, EP-14 |
| UC-4 | Keyframes / OCR / Conversation Reconstruction | **COMPLETE LOCALLY, EXTERNAL PROOF PENDING** | PARTIALLY COMPLETE | UC-DER-001, UC-DER-003, UC-DER-004, UC-DER-005, UC-TQ-003, UC-DER-010 | EP-13, EP-14 |
| UC-5 | iOS | **CODE COMPLETE, EXTERNAL PROOF REQUIRED** | PRESENT BUT DISCONNECTED | UC-IOS-001, UC-IOS-002, UC-IOS-004, UC-IOS-003, UC-IOS-010 | EP-08, EP-09, EP-14 |
| UC-6 | Full Public Launch | **COMPLETE LOCALLY, EXTERNAL PROOF PENDING** | PARTIALLY COMPLETE | UC-LCH-001, UC-LCH-002, UC-LCH-003, UC-LCH-004, UC-TQ-002, UC-TQ-004 | EP-04, EP-05, EP-06, EP-07, EP-08, EP-09, EP-10, EP-11 |

- **UC-0a** — 25 findings name this UC: 25 fixed, 0 code-complete awaiting external proof, 0 open. Journeys: R01 PASS, R03 PASS. No external proof outstanding.
- **UC-0b** — 8 findings name this UC: 8 fixed, 0 code-complete awaiting external proof, 0 open. Journeys: R01 PASS, R17 PASS. External proofs outstanding: EP-01, EP-02, EP-03.
- **UC-0c** — 7 findings name this UC: 7 fixed, 0 code-complete awaiting external proof, 0 open. Journeys: R09a PASS. No external proof outstanding.
- **UC-1** — 29 findings name this UC: 29 fixed, 0 code-complete awaiting external proof, 0 open. Journeys: R05 PASS. External proofs outstanding: EP-04, EP-05, EP-12.
- **UC-2** — 22 findings name this UC: 19 fixed, 3 code-complete awaiting external proof (UC-AND-003, UC-AND-012, UC-AND-013), 0 open. Journeys: R06 BLOCKED. External proofs outstanding: EP-06, EP-07, EP-14.
- **UC-3** — 27 findings name this UC: 23 fixed, 4 code-complete awaiting external proof (UC-AND-003, UC-AND-004, UC-AND-007, UC-AND-013), 0 open. Journeys: R08 BLOCKED. External proofs outstanding: EP-06, EP-14.
- **UC-4** — 16 findings name this UC: 16 fixed, 0 code-complete awaiting external proof, 0 open. Journeys: R09a PASS, R09b BLOCKED, R10 BLOCKED. External proofs outstanding: EP-13, EP-14.
- **UC-5** — 35 findings name this UC: 24 fixed, 11 code-complete awaiting external proof (UC-IOS-001, UC-IOS-002, UC-IOS-004, UC-IOS-003, UC-IOS-005, UC-IOS-006, UC-IOS-007, UC-IOS-008, UC-IOS-009, UC-IOS-010, UC-IOS-012), 0 open. Journeys: R07 BLOCKED. External proofs outstanding: EP-08, EP-09, EP-14.
- **UC-6** — 8 findings name this UC: 8 fixed, 0 code-complete awaiting external proof, 0 open. Journeys: R01 PASS, R02 PASS, R03 PASS, R04 PASS, R11 PASS, R12 PASS, R13 PASS, R14a PASS, R14b PASS, R15a PASS, R15b BLOCKED, R16 PASS. External proofs outstanding: EP-04, EP-05, EP-06, EP-07, EP-08, EP-09, EP-10, EP-11.

## Platform matrix

| Platform | Capture | Evidence pipeline | Case at capture | Build | Real browser/device | Distribution | Note |
|---|---|---|---|---|---|---|---|
| Browser Extension | WORKS_LOCALLY | WORKS_LOCALLY | WORKS_LOCALLY | WORKS_LOCALLY | SEE_JOURNEY_R05 | BLOCKED | Workspace selection, case at capture and DOM-snapshot truth fixed; real Chrome and Edge acceptance on the remediated stack (R05). Store listing and production OAuth are EP-04/05/12. |
| Web | WORKS_LOCALLY | WORKS_LOCALLY | NOT_IMPLEMENTED | WORKS_LOCALLY | SEE_JOURNEY_R02 | N/A | File/camera/mic upload (R01) and browser screen recording through getDisplayMedia in real Chromium (R02). The Capture page does not take a case; records are linked to a case afterwards (R11). |
| PWA | WORKS_LOCALLY | WORKS_LOCALLY | NOT_IMPLEMENTED | WORKS_LOCALLY | WORKS_LOCALLY | WORKS_LOCALLY | Installable by Chromium's own criteria (CDP getInstallabilityErrors empty), service worker with a network-only policy for API and evidence bytes, offline page (UC-LCH-004). |
| Android | BLOCKED | WORKS_LOCALLY | SERVER_ONLY | PARTIAL | N/A | BLOCKED | Server seal and outputs proven on the stack (J09) and real PostgreSQL; the direct-session API accepts a case, the app does not yet send one. The Kotlin capture services COMPILE in feature CI (native-build run 36865158339, Gradle :app:assembleDebug); device behaviour, the native unit/instrumented tests and the signed release are EP-06/14/07. |
| iOS | BLOCKED | WORKS_LOCALLY | SERVER_ONLY | PARTIAL | N/A | BLOCKED | The device block the extension writes now seals SIGNED on the real server (golden fixture), and the app + ProovraBroadcast extension COMPILE and package in feature CI (native-build run 36865158339, macos-14 / Xcode 16.2, .appex embedded); ReplayKit on a device, the Swift unit test and TestFlight are EP-08/14/09. The direct-session API accepts a case, the app does not yet send one. |

## Capture-to-Public-Verify convergence

**CONVERGED WRITERS AND SIDE EFFECTS** — Every live capture channel still reaches ONE Evidence writer, ONE part writer, ONE custody appender, ONE report builder, ONE package builder and ONE Public Verify route, and now also ONE canonical finalizer that owns the completion side effects: custody EVIDENCE_COMPLETED, reviewer-workflow initialisation, tenant audit and workspace retention run exactly once for web upload, direct capture and intake alike (UC-ARCH-002/003, proven on real PostgreSQL by completion-cross-channel.integration.test.ts). The iOS manifest reaches the finalizer (UC-IOS-001 server side); its native half awaits EP-08.

## Counts

- Findings at the audit baseline: 119 (P0 0 · P1 11 · P2 55 · P3 53); 2 consolidated into kept findings.
- Status now: fixed 103 · blocked on external proof 16 · partial 0 · present 0 · accepted risk 0.
- Proof (audit): runtime-proven 12 · source-proven (device behaviour of the attachment per Apple ReplayKit documentation; device confirmation BLOCKED) 1 · source-proven 106
- Required journeys: PASS 14 · FAIL 0 · BLOCKED 6 (of 20); at the audit baseline PASS 8 · FAIL 6 · BLOCKED 6.
- Audit API integration (capture-relevant, real PG16/Redis/MinIO): 463/463 passed, 0 skipped, 64 files.
- Audit worker suite: 1152/1156 passed, 4 skipped (the 4 skipped Object-Lock cases were run separately: see commands).
- Remediated API integration (FULL suite, fresh migrated PG16 + Redis + MinIO): 2874/2874 passed, 0 failed, 0 skipped, 268 files.
- Remediated worker suite (live PG16/Redis/MinIO Object Lock): 1218/1219 passed, 0 failed, 1 skipped.

## Unresolved P0/P1 (code complete, external proof required)

### UC-AND-003 (P1, source-proven) — POST_NOTIFICATIONS is declared but never requested, so on Android 13+ the 'Capture Frame'/'Stop' notification — UC-2's only way to capture another app — is not shown

- Remediation: **BLOCKED_EXTERNAL_PROOF** in 6934514c6d49; outstanding: device: fresh install Android 13/14, notification actions visible (EP-06)
- UCs: UC-2, UC-3 · Platforms: android
- Where: `apps/mobile/modules/proovra-screen-capture/android/src/main/AndroidManifest.xml:13`, `apps/mobile/modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ScreenCaptureService.kt:136`, `apps/mobile/modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ContinuousScreenCaptureService.kt:131`, `apps/mobile/app/(stack)/screen-capture.tsx:227`, `apps/mobile/app/(stack)/continuous-capture.tsx:428`
- Observed: Manifest-only declaration; no runtime permission request before starting either foreground service.
- Expected: Request POST_NOTIFICATIONS (PermissionsAndroid.request on API 33+) before startCapture/startContinuousCapture; if denied, disclose that out-of-app Capture Frame/Stop will be unavailable (or refuse UC-2 cross-app mode).
- Root cause: Android 13 runtime notification permission was treated as a manifest declaration.
- User impact: On a fresh Android 13+ install the notification permission is off by default and PROOVRA never asks for it. The foreground service still runs, but its notification (with the Capture Frame and Stop actions) does not appear in the shade. The screen tells the user to 'open the app you want to capture, then tap Capture Frame from the notification'; the in-app button can only capture PROOVRA itself. UC-2 cannot capture third-party content; UC-3 loses its out-of-app Stop control.
- Legal/evidentiary: none directly; the primary UC-2 acquisition is unreachable.
- Security/tenancy: none
- Remediation: Add a pre-start permission step in screen-capture.tsx/continuous-capture.tsx (PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS') when Platform.Version >= 33) and a denied-state explanation.
- Required tests: Mobile unit: start() requests the permission on API 33+ before calling the native start. Device acceptance: fresh install on Android 13/14, verify notification actions visible.
- Migration: none · Depends on: — · Aliases: —

### UC-IOS-001 (P1, runtime-proven) — Every iOS continuous-capture manifest is refused at seal: the Swift result's device object lacks screenW/screenH/densityDpi/orientation that the server validator requires

- Remediation: **BLOCKED_EXTERNAL_PROOF** in 6934514c6d49; outstanding: physical iOS device: a ReplayKit broadcast sealed end to end with the extension's real device block accepted by the server (Swift compile proven in CI) (EP-08)
- UCs: UC-5 · Platforms: api, ios
- Where: `apps/mobile/modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift:58`, `apps/mobile/src/continuous-capture.ts:121`, `packages/shared/src/screen-continuous-manifest.ts:286`, `packages/shared/src/screen-continuous-manifest.ts:289`, `services/api/src/services/capture-trust/continuous-capture.service.ts:94`, `services/api/test/uc5-ios-screen-capture.integration.test.ts:253`, `apps/mobile/test/native-module-contract.test.mjs:75`
- Observed: Swift device map has 4 keys; validator requires 8. The UC-5 integration test hand-builds a device with screenW:1179, screenH:2556, densityDpi:460, orientation:'portrait' (uc5-ios-screen-capture.integration.test.ts:253-262) that the Swift never produces, so the suite passes against a fictional payload; the native contract test compares method/event NAMES only (native-module-contract.test.mjs:75-99). RUNTIME: Sealing with the exact device block ProovraBroadcastShared.swift writes ({platform, osVersion, model, appVersion}) → HTTP 422 CONTINUOUS_MANIFEST_INVALID; record stays UPLOADING.
- Expected: The iOS result carries every device field the server requires (UIScreen.main.nativeBounds/scale for pixels, a documented densityDpi convention for iOS, orientation), or the validator accepts an iOS-specific device shape; and a test drives the manifest from the exact map the Swift emits.
- Root cause: The iOS device shape was never reconciled with the manifest schema; server tests fabricate the device object instead of deriving it from the native payload.
- User impact: No iOS screen recording can ever be sealed. The user records, uploads every segment, stages, opens Capture, taps Finish & Sign, and continuous-complete answers CONTINUOUS_MANIFEST_INVALID. The reserved record is eventually reaped; the recording is lost as evidence.
- Legal/evidentiary: UC-5 is documented as code-complete / PASS (docs/uc6-release-acceptance.md:141) while it cannot produce a single sealed record.
- Security/tenancy: none
- Remediation: Emit screenW/screenH (native pixels), densityDpi (e.g. scale*160 or points-per-inch table, documented) and orientation from the extension (it knows the buffer geometry) via result.json, and fill them in ProovraBroadcastResult.toJsMap. Add a golden fixture of the Swift result map shared by a mobile unit test (buildContinuousManifest → validateScreenContinuousManifest) and the API integration test.
- Required tests: Mobile: buildContinuousManifest(fixture-from-Swift-map) passes validateScreenContinuousManifest(expectedPlatform:'ios'). API: uc5 integration test must load the same fixture rather than an inline device literal. Test-authoring gap (consolidated UC-TQ-001): every UC-5 test hand-authors an Android-shaped device block; add a contract test that feeds the Swift result.json shape through buildContinuousManifest → validator.
- Migration: none · Depends on: — · Aliases: ET-DC-09, UC-TQ-001
- Runtime evidence: runtime/probes/continuous-ios.json#iosDeviceShape

### UC-IOS-002 (P1, source-proven) — The app cannot stop the iOS broadcast: in-app Stop and every controlled stop post a Darwin note the extension never observes, then return a fabricated INTERRUPTED summary while recording continues

- Remediation: **BLOCKED_EXTERNAL_PROOF** in 6934514c6d49; outstanding: device: stop in-app -> indicator disappears, USER_STOPPED result, last segment emitted (EP-08)
- UCs: UC-5 · Platforms: ios
- Where: `apps/mobile/modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift:100`, `apps/mobile/modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift:119`, `apps/mobile/plugins/broadcast-extension/SampleHandler.swift:35`, `apps/mobile/modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift:136`, `apps/mobile/app/(stack)/continuous-capture.tsx:112`, `apps/mobile/app/(stack)/continuous-capture.tsx:273`
- Observed: One-way IPC (extension→app only).
- Expected: An app→extension stop channel: the extension observes a stop Darwin note (or polls a stop flag in state.json on each buffer) and calls finishBroadcastWithError / finalizes and writes result.json with USER_STOPPED; the app waits (bounded) for result.json before resolving.
- Root cause: The extension side of the stop handshake was never implemented; the app-side comment (:98-99) assumes it exists.
- User impact: Tapping 'Stop & Review' (or hitting the byte ceiling / upload backpressure) does not stop recording: the status-bar indicator stays on and the extension keeps writing up to 600 segments into the container. The review shows 'Interrupted' for a session the user ended cleanly; everything recorded after the tap is never emitted or uploaded and is wiped at the next start.
- Legal/evidentiary: The sealed manifest (if it could seal) would state INTERRUPTED_SESSION/terminationReason INTERRUPTED with captureStartedAtUtc equal to the stop instant and totalDurationMs 0 — false provenance for a clean stop. The client byte/backpressure bounds (SESSION_BOUNDS_REACHED, SEGMENT_UPLOAD_BACKPRESSURE) are unenforceable on iOS.
- Security/tenancy: Recording of the screen continues after the user asked PROOVRA to stop (OS indicator remains visible; user can still stop from Control Center).
- Remediation: In SampleHandler.broadcastStarted register a Darwin observer for a dedicated stop name (not the 'finished' name the app itself listens to) that sets a flag; on the next buffer finalize the segment, write result.json (USER_STOPPED/COMPLETE or the client limitation), and finishBroadcastWithError with a user-facing 'stopped from PROOVRA' message. In the module, wait up to N seconds for result.json before reading, and never synthesize startedAtUtc=now.
- Required tests: Device acceptance: start broadcast, stop in-app → indicator disappears, result terminationReason USER_STOPPED, last segment emitted. Unit: a Swift-free JS test that the stop path waits for a result instead of accepting the fallback.
- Migration: none · Depends on: — · Aliases: —

### UC-IOS-004 (P1, source-proven) — Extension segment timing is wrong: the final segment is recorded with durationMs 0 and a start offset equal to the session end, so COMPLETE iOS sessions are refused as having an undeclared gap

- Remediation: **BLOCKED_EXTERNAL_PROOF** in 6934514c6d49; outstanding: physical iOS device: segment offsets/durations from a real broadcast match the PTS clock (contiguous segments, final segment ends at the last appended PTS) (Swift compile proven in CI) (EP-08)
- UCs: UC-5 · Platforms: api, ios
- Where: `apps/mobile/plugins/broadcast-extension/SampleHandler.swift:74`, `apps/mobile/plugins/broadcast-extension/SampleHandler.swift:121`, `packages/shared/src/screen-continuous-manifest.ts:391`, `packages/shared/src/screen-continuous-manifest.ts:402`
- Observed: Final segment duration hard-coded to 0; offsets mix wall clock and PTS.
- Expected: Final segment duration = last appended PTS − segmentStartPts; offsets derived from one clock (PTS relative to the first frame of the session).
- Root cause: finalizeSegment's force path passes a literal 0 instead of measuring the segment.
- User impact: Even with UC-IOS-001 fixed, a cleanly stopped session whose last segment is longer than 3 s (roughly half of all sessions at 6 s segments) fails Finish & Sign with CONTINUOUS_MANIFEST_INVALID. Static screens (ReplayKit delivers no new frames when nothing changes) also create >3 s wall-clock gaps between segments.
- Legal/evidentiary: The last segment's declared duration (0) is false provenance in the manifest.
- Security/tenancy: none
- Remediation: Track lastPts; on force-finalize use lastPts − segmentStartPts; compute startedAtOffsetMs from segmentStartPts − sessionFirstPts. Record a limitation when a segment spans a long no-frame interval rather than letting it read as a gap.
- Required tests: Pure timing function extracted from SampleHandler (or mirrored in TS) with a test: 6 s segments + 4 s final → contiguous offsets, validator accepts COMPLETE.
- Migration: none · Depends on: UC-IOS-001 · Aliases: ET-DC-09

## Required runtime journeys

| # | Journey | Status | Audit status | Evidence | Blockers | Note |
|---|---|---|---|---|---|---|
| R01 | Web/PWA file upload → finalize → report → package → Public Verify | **PASS** | PASS | runtime/remediation/journeys-raw.json#J01-web-upload-to-public-verify<br>runtime/remediation/journeys-raw.json#J02-package-independent-recompute<br>runtime/remediation/package-recompute.json | — | J01-web-upload-to-public-verify: PASS (22/22); J02-package-independent-recompute: PASS (2/2) |
| R02 | Web/PWA screen capture → outputs | **PASS** | FAIL | runtime/remediation/web-screen-capture.json#R02-web-screen-capture-real-chromium | — | R02-web-screen-capture-real-chromium: PASS (15/15) |
| R03 | Intake-link submission → outputs | **PASS** | PASS | runtime/remediation/journeys-raw.json#J08-intake-link-to-public-verify | — | J08-intake-link-to-public-verify: PASS (10/10) |
| R04 | Evidence Request submission → outputs | **PASS** | BLOCKED | runtime/remediation/journeys-raw.json#J14-evidence-request-to-record<br>services/api/test/runtime-proof-evidence-capture-b.integration.test.ts::POST /v1/evidence-requests/:id/send — opens the intake link, notifies the recipient and marks SENT | — | J14-evidence-request-to-record: PASS (10/10). Driven end to end on the stack (Evidence Requests enabled): create, send with intake link and recorded recipient notification, contributor submission, record in the requesting workspace, outputs. External mail delivery itself is not exercised (recording transport). |
| R05 | Browser extension capture → outputs | **PASS** | FAIL | runtime/remediation/extension-acceptance.json#R05-extension-real-browsers | — | R05-extension-real-browsers: PASS (11/11) |
| R06 | Android flow (strongest available environment) | **BLOCKED** | BLOCKED | services/api/test/uc2-android-screen-capture.integration.test.ts<br>services/api/test/uc3-continuous-capture.integration.test.ts<br>runtime/remediation/journeys-raw.json#J09-continuous-direct-capture-to-public-verify | EP-06, EP-07 | Server side proven on the stack and on real PostgreSQL; MediaProjection, foreground service and notifications need a physical Android device. |
| R07 | iOS flow (strongest available environment) | **BLOCKED** | FAIL | services/api/test/uc5-ios-screen-capture.integration.test.ts<br>apps/mobile/test/ios-broadcast-contract.test.mjs<br>native-build.yml run 36865158339 ios-simulator-build (Swift compiled, ProovraBroadcast.appex embedded) | EP-08, EP-09 | The device block the Swift extension writes now seals 200 SIGNED on the real server (it was refused 422 at the baseline), and the app + Broadcast Upload Extension compile and package on macOS CI; ReplayKit broadcasting itself needs a physical device. |
| R08 | Continuous/streaming capture with interruption and resume | **BLOCKED** | FAIL | runtime/remediation/journeys-raw.json#J09-continuous-direct-capture-to-public-verify<br>services/api/test/uc3-continuous-completeness.integration.test.ts | EP-06 | J09-continuous-direct-capture-to-public-verify: PASS (10/10). Missing tail/middle, duplicate and conflicting segments, seal racing and interruption are proven on real PostgreSQL; resume after an app/process restart needs a device. |
| R09a | Video → keyframes | **PASS** | PASS | runtime/remediation/journeys-raw.json#J10-uc4-derived-review | — | J10-uc4-derived-review: PASS (2/2) |
| R09b | Video → OCR | **BLOCKED** | BLOCKED | services/worker/test/uc4-tesseract-ocr.test.ts<br>services/worker/test/uc4-screen-intelligence-persistence.integration.test.ts<br>ci.yml build-test run 36864604761: 'Test — worker OCR with the real tesseract engine' success (UC4_REQUIRE_TESSERACT=1, >= 5 executed, 0 skipped)<br>schema-reproducibility.yml run 36864604662: worker UC-4 live-PostgreSQL integration success | EP-14 | OCR wiring, bounds and persistence are proven against live PostgreSQL, and real-text extraction by the real Tesseract engine is now proven in feature CI on fixtures. The journey itself — a recorded video through derived OCR on a running stack — has not run with the real engine (this host has no binary). |
| R10 | Conversation capture / reconstruction | **BLOCKED** | FAIL | packages/shared/tests/screen-reconstruction.test.mjs<br>services/worker/test/uc4-reconstruction.test.ts<br>ci.yml build-test run 36864604761: real-tesseract OCR step success | EP-13 | Reconstruction now merges realistic chat screens (UC-DER-004 fixtures) and the real OCR engine is CI-proven on fixtures; real conversation apps remain external. |
| R11 | Add capture to existing Case | **PASS** | PASS | runtime/remediation/journeys-raw.json#J03-case-attach-and-tenancy<br>services/api/test/completion-cross-channel.integration.test.ts::an intake link issued for a case puts the submitted record IN the case (once, source INTAKE) | — | J03-case-attach-and-tenancy: PASS (18/18) |
| R12 | Create new Evidence from capture | **PASS** | PASS | runtime/remediation/journeys-raw.json#J01-web-upload-to-public-verify | — | J01-web-upload-to-public-verify: PASS (22/22) |
| R13 | Failure and recovery journey | **PASS** | BLOCKED | runtime/remediation/journeys-raw.json#J12-failure-and-recovery | — | J12-failure-and-recovery: PASS (12/12) |
| R14a | Trash / restore | **PASS** | PASS | runtime/remediation/journeys-raw.json#J04-trash-restore | — | J04-trash-restore: PASS (6/6) |
| R14b | Permanent destruction | **PASS** | BLOCKED | runtime/remediation/journeys-raw.json#J13-governed-permanent-destruction | — | J13-governed-permanent-destruction: PASS (10/10) |
| R15a | FREE allowance: three records, fourth refused, trash keeps the slot | **PASS** | PASS | runtime/remediation/journeys-raw.json#J05-free-allowance<br>runtime/remediation/journeys-j16-raw.json#J16-free-reservation-concurrency | — | J05-free-allowance: PASS (3/3); J16-free-reservation-concurrency: PASS (3/3) |
| R15b | Credit purchase / upgrade / downgrade / webhook replay | **BLOCKED** | BLOCKED | services/api/test/billing-paypal-integrity.integration.test.ts<br>services/api/test/billing-allowance-commitments.integration.test.ts | EP-10, EP-11 | Needs Stripe/PayPal sandboxes; the commercial rules are proven on real PostgreSQL. |
| R16 | Share-link create / revoke / replace | **PASS** | PASS | runtime/remediation/journeys-raw.json#J01-web-upload-to-public-verify | — | J01-web-upload-to-public-verify: PASS (22/22) |
| R17 | Integrity mismatch and stale-status journey | **PASS** | FAIL | runtime/remediation/journeys-raw.json#J06-integrity-tamper<br>services/api/test/public-verify-stored-bytes-truth.integration.test.ts | — | J06-integrity-tamper: PASS (8/8) |

## Remediation journey runs (remediated stack)

| Run | Verdict | Checks | Failed checks |
|---|---|---|---|
| J01-web-upload-to-public-verify | **PASS** | 22/22 | — |
| J02-package-independent-recompute | **PASS** | 2/2 | — |
| J03-case-attach-and-tenancy | **PASS** | 18/18 | — |
| J04-trash-restore | **PASS** | 6/6 | — |
| J05-free-allowance | **PASS** | 3/3 | — |
| J06-integrity-tamper | **PASS** | 8/8 | — |
| J07-upload-session-member-injection | **PASS** | 3/3 | — |
| J08-intake-link-to-public-verify | **PASS** | 10/10 | — |
| J09-continuous-direct-capture-to-public-verify | **PASS** | 10/10 | — |
| J10-uc4-derived-review | **PASS** | 2/2 | — |
| J12-failure-and-recovery | **PASS** | 12/12 | — |
| J13-governed-permanent-destruction | **PASS** | 10/10 | — |
| J14-evidence-request-to-record | **PASS** | 10/10 | — |
| J15-legal-hold | **PASS** | 6/6 | — |
| J11-destroy-and-free-slot | **PASS** | 2/2 | — |
| J16-free-reservation-concurrency | **PASS** | 3/3 | — |
| DER012-derived-thumbnails-cross-origin | **PASS** | 6/6 | — |
| R02-web-screen-capture-real-chromium | **PASS** | 15/15 | — |
| R05-extension-real-browsers | **PASS** | 11/11 | — |

## Executed journey runs (audit driver)

| Run | Driver verdict | Lead-graded verdict | Checks | Lead note |
|---|---|---|---|---|
| J01-web-upload-to-public-verify | PASS | **PASS** | 22/22 |  |
| J02-package-independent-recompute | PASS | **PASS** | 2/2 |  |
| J03-case-attach-and-tenancy | PASS | **PASS** | 18/18 |  |
| J04-trash-restore | PASS | **PASS** | 6/6 |  |
| J05-free-allowance | PASS | **PASS** | 3/3 |  |
| J06-integrity-tamper | PASS | **FAIL** | 6/6 | The driver's final check matched only 'verdict'/'headline' keys and passed vacuously; the captured Public Verify answer after byte substitution reads basicVerification.original.state='verified' and storedBytes.state='verified_current'. Graded by the lead as FAIL (UC-TRUST-008, journey R17). |
| J07-upload-session-member-injection | FAIL | **FAIL** | 2/3 |  |
| J08-intake-link-to-public-verify | PASS | **PASS** | 10/10 |  |
| J09-continuous-direct-capture-to-public-verify | PASS | **PASS** | 10/10 |  |
| J10-uc4-derived-review | PASS | **PASS** | 2/2 |  |
| J11-destroy-and-free-slot | PASS | **BLOCKED** | 2/2 | Its only check is 'governed, non-5xx response'; no destruction was executed (402 ENTERPRISE_FEATURE_REQUIRED, 409 LIFECYCLE_DESTRUCTION_REQUIRES_REVIEW). Graded as BLOCKED for destruction (journey R14b). |

## Conservation gates

| Gate | Result | Detail |
|---|---|---|
| discovered capture surfaces = dispositioned capture surfaces | PASS | 27 surfaces |
| discovered mutations = dispositioned mutations | PASS | 59 mutations |
| discovered queues = classified queues | PASS | 13 queue rows |
| runtime journeys = passed + failed + blocked | PASS | {"PASS":14,"FAIL":0,"BLOCKED":6} |
| findings = fixed + blocked-external + partial + present + accepted-risk | PASS | {"fixed":103,"blockedExternal":16,"partial":0,"present":0,"acceptedRisk":0} |
| remediation ledger rows = findings (one row per finding, no extra row) | PASS | 119 rows |
| every ledger disposition is allowed | PASS |  |
| ledger counts agree with finding statuses | PASS | {"total":119,"BLOCKED_EXTERNAL_PROOF":16,"FIXED_RUNTIME_PROVEN":62,"FIXED_SOURCE_AND_TEST_PROVEN":41,"fixed":103,"blocked":16,"remaining":0} |
| ledger's own gates all pass | PASS | 9 gates |
| every fixed finding names a commit and a green test | PASS |  |
| every blocked-external finding names a registered external proof | PASS |  |
| blocked-external only where the external proof map says so | PASS |  |
| every required journey has a post-remediation decision | PASS |  |
| a BLOCKED journey names an external proof | PASS |  |
| every UC-journey mapping names a required journey | PASS |  |
| remediation API integration run executed (not skipped) and green | PASS | 2874/2874 (0 skipped) |
| remediation worker run green | PASS | 1218/1219 (1 skipped) |
| every remediation command has an exit code | PASS | 103 commands |
| every UC = complete + partial + missing + blocked | PASS | {"complete":2,"partial":0,"missing":0,"blocked":7} |
| no UNKNOWN without explicit blocker | PASS |  |
| no NOT_REVIEWED | PASS | 301 reviewed topics |
| no duplicate finding IDs | PASS |  |
| consolidations point at a kept finding | PASS |  |
| every finding has the required fields | PASS |  |
| every finding id matches UC-AREA-NNN | PASS |  |
| every UC key finding exists | PASS |  |
| every remediation-order finding exists | PASS |  |
| every open P0/P1 is in the remediation order | PASS | UC-AND-003,UC-IOS-001,UC-IOS-002,UC-IOS-004 |
| every dependsOn resolves | PASS |  |
| executed-run overrides name executed runs | PASS |  |
| runtime-bound findings exist | PASS |  |
| every blocker names an external proof row | PASS |  |
| every command in the ledger has an exit code | PASS | 40 commands |
| API integration run executed (not skipped) and green | PASS | 463/463 |
| independent package recompute passed (incl. negative controls) | PASS | 14/14 |
| worker run green | PASS | 1152/1156 (4 skipped) |
| no artifact/render disagreement | PASS |  |
| no undefined, placeholder or TODO in final artifacts | PASS |  |

## Validation commands

| Label | Exit | Log |
|---|---|---|
| ext-lint | 0 | ext-lint.log |
| ext-test | 0 | ext-test.log |
| ext-build | 0 | ext-build.log |
| mobile-typecheck | 0 | mobile-typecheck.log |
| mobile-test | 0 | mobile-test.log |
| mobile-export-android-ios | 0 | mobile-export.log |
| mobile-prebuild | 0 | mobile-prebuild.log |
| web-build | 0 | web-build.log |
| api-integration-capture | 0 | api-integration-capture.log |
| seed-journeys | 0 | seed.json |
| journeys-run1 | 0 | journeys-run1.log |
| seed-journeys-2 | 0 | seed2.json |
| journeys-run2 | 0 | journeys-run2.log |
| probes-integration | 0 | probes-integration.log |
| seed-journeys-3 | 0 | seed3.json |
| journeys-run3 | 0 | journeys-run3.log |
| seed-journeys-4 | 0 | seed4.json |
| journeys-run4 | 0 | journeys-run4.log |
| uc1-acceptance-fullstack | 1 | uc1-acceptance.log — Playwright result FAIL in both projects (AUTH INVALID_CLIENT_OR_REDIRECT). The stack was kept up for journeys J01-J07. CORRECTION: the auditor killed the listening API/web/fixture processes at ~20:52Z, but the harness parent and its tsx-watch wrappers survived until rec.sh timeout (exit 124, 21:34:12Z); see the following ledger row and META.runtimeCaveats. |
| uc1-acceptance-audit-copy | 1 | uc1-acceptance-audit-copy.log |
| worker-tests | 0 | worker-tests.log |
| uc1-acceptance-audit-copy-2 | 1 | uc1-acceptance-audit-copy.log |
| worker-object-lock-minio | 0 | worker-object-lock-minio.log |
| uc1-stack-phase2 | 1 | uc1-stack-phase2.log |
| seed-journeys-phase2 | 0 | seed5.json |
| extension-step-probe | 0 | extension-step-probe.log |
| uc1-acceptance-audit-copy-3 | 1 | uc1-acceptance-audit-copy.log |
| uc1-acceptance-audit-copy-3 | 1 | uc1-acceptance-audit-copy.log — AUTH PASS; first test x after 11.2m backstop without reaching CAPTURE; stopped by the auditor (TaskStop), ports 4000/3311/4599 killed, uc1-acc-* removed |
| journeys-phase2 | 0 | journeys-phase2.log |
| uc1-stack-phase2 (attempt 1) | 1 | uc1-stack-phase2.log — INVALID RUN (auditor teardown gap): worker died EADDRINUSE 0.0.0.0:4001 held by an orphaned worker from the previous stack; phase-2 journey results from this stack for report/package availability are discarded and rerun |
| seed-journeys-phase2b | 0 | seed6.json |
| audit-engine-check | 0 | audit-engine-check.log |
| journeys-phase2b | 0 | journeys-phase2.log |
| uc1-stack-phase2b | 0 | uc1-stack-phase2b.log — intentional keep-up server for J08-J11 and the report-link probe; worker healthy; torn down by the auditor (4000/4001/3311/4599 killed, uc1-acc-* removed) |
| package-independent-recompute | 0 | package-recompute.log |
| api-typecheck | 0 | api-typecheck.log |
| worker-typecheck | 0 | worker-typecheck.log |
| web-typecheck | 0 | web-typecheck.log |
| audit-tooling-syntax | 0 | audit-tooling-syntax.log |
| uc1-acceptance-fullstack | 124 | uc1-acceptance.log |

## Remediation validation commands

| Label | Exit | Log |
|---|---|---|
| seed-journeys | 1 | seed-r1.json |
| seed-journeys-2 | 0 | seed-r2.json |
| journeys-run1 | 0 | journeys-run1-superseded.log — SUPERSEDED: run on 068efffd..81144aa1, before a606dcaa/0408adaa; it is the red evidence for both (J06 storedBytes verified_current after substitution; J10 derived run on J09 UPLOADING record). J09 sent the V1 manifest the remediated server refuses; J11 reused the FREE user J05 had filled; J13 was driven against a TRASHED record without a review id. Rerun below on the final source. |
| uc1-acceptance-final | 0 | uc1-acceptance.run2-superseded.log — SUPERSEDED (run 2, 0408adaa). run in the background (not via rec-remediation.sh, so the stack stays up under the operator teardown); chromium PASS, edge PASS, 8/8 pages; exit recorded as the harness verdict, the process is stopped at teardown |
| uc1-acceptance-run1 | 0 | uc1-acceptance.run1.log — SUPERSEDED first stack (before a606dcaa/0408adaa): chromium PASS, edge PASS, 8/8; times approximate (background run, not wrapped) |
| seed-journeys-3 | 0 | seed-r3.json |
| seed-journeys-4 | 0 | seed-r4.json |
| journeys-final | 0 | journeys-final.run2-superseded.log — SUPERSEDED (run 2, 0408adaa): 12/13 PASS; J13 refused at EXECUTED (409 LIFECYCLE_INVALID_TRANSITION) — the red evidence for 4a49635e. Rerun below. |
| journeys-final-j11 | 0 | journeys-final-j11.run2-superseded.log — SUPERSEDED (run 2): J11 PASS 2/2. |
| uc1-acceptance-final | 0 | uc1-acceptance.run6-superseded.log — SUPERSEDED stack (no Evidence Requests flag). final source 4a49635e; background run kept up for the journeys; chromium PASS, edge PASS, 8/8 pages; stopped at teardown |
| seed-journeys-5 | 0 | seed-r5.json |
| seed-journeys-6 | 0 | seed-r6.json |
| seed-journeys-7 | 0 | seed-r7.json |
| journeys-final | 0 | journeys-final.run3-superseded.log — SUPERSEDED (run 3, 4a49635e): 11/12 PASS + J11 PASS; J13 8/9 — every destruction check passed (bytes gone, certificate, link stops) but the driver read evidence.status instead of lifecycle_state. Rerun below. |
| journeys-final-j11 | 0 | journeys-final-j11.run3-superseded.log — SUPERSEDED (run 3): J11 PASS 2/2. |
| web-screen-capture | 1 | web-screen-capture.run3-superseded.log — SUPERSEDED (run 3): recorded + sealed in real Chromium, but into the default PERSONAL (FREE) workspace, so report/package were NOT_INCLUDED_IN_PLAN (correct); probe now switches to the organization workspace and verifies through a share link. |
| seed-journeys-8 | 0 | seed-r8.json |
| seed-journeys-9 | 0 | seed-r9.json |
| seed-journeys-10 | 0 | seed-r10.json |
| journeys-final | 0 | journeys-final.run4-superseded.log — SUPERSEDED (run 4, 4a49635e): 11/12 + J11 PASS; J13 8/9 — every destruction check passed; the destruction orchestrator executed the approved review before the operator EXECUTE (designed path), which the driver did not accept. Rerun below. |
| journeys-final-j11 | 0 | journeys-final-j11.run4-superseded.log — SUPERSEDED (run 4): J11 PASS 2/2. |
| web-screen-capture | 1 | web-screen-capture.run4-superseded.log — SUPERSEDED (run 4): workspace switch 503 POLICY_NOT_PROVISIONED — the seed created organizations without the security policy product provisioning creates; seed fixed. |
| seed-journeys-11 | 0 | seed-r11.json |
| seed-journeys-12 | 0 | seed-r12.json |
| seed-journeys-13 | 0 | seed-r13.json |
| journeys-final | 0 | journeys-final.run5-superseded.log — SUPERSEDED (run 5, 4a49635e): 12/12 + J11 PASS (J13 executed by operator). Superseded only because the seed now records sessions like a real sign-in; rerun below for one coherent set. |
| journeys-final-j11 | 0 | journeys-final-j11.run5-superseded.log — SUPERSEDED (run 5): J11 PASS 2/2. |
| web-screen-capture | 1 | web-screen-capture.run5-superseded.log — SUPERSEDED (run 5): switch 403 session_not_in_inventory — seeded tokens had no session-inventory row (a sign-in records one); seed now records it with the stack identity-hash secret. |
| seed-journeys-14 | 0 | seed-r14.json |
| seed-journeys-15 | 0 | seed-r15.json |
| seed-journeys-16 | 0 | seed-r16.json |
| seed-journeys-17 | 0 | seed-r17.json |
| journeys-final | 0 | journeys-final.run6-superseded.log — SUPERSEDED (run 6, 4a49635e): 12/12 + J11 PASS. |
| journeys-final-j11 | 0 | journeys-final-j11.run6-superseded.log — SUPERSEDED (run 6): J11 PASS 2/2. |
| web-screen-capture | 1 | web-screen-capture.run6-superseded.log — SUPERSEDED (run 6): 13/14 — every functional check passed; the only failure was a console 503 from the Evidence detail page listing Evidence Requests, a feature switched off on the stack (EVIDENCE_REQUESTS_ENABLED unset; the panel handles FEATURE_DISABLED by design). The stack now runs with the flag on. |
| seed-journeys-18 | 0 | seed-r18.json |
| uc1-acceptance-final | 0 | uc1-acceptance.run7-superseded.log — SUPERSEDED by the run on 23cb5a0b (adds J14-J16, owner stored-file projection). Was: FINAL stack (4a49635e, intake + Evidence Requests flags on); background run kept up for the journeys; stopped at teardown |
| seed-journeys-19 | 0 | seed-r19.json |
| seed-journeys-20 | 0 | seed-r20.json |
| seed-journeys-21 | 0 | seed-r21.json |
| journeys-final | 0 | journeys-final.run7-superseded.log — SUPERSEDED (run 7, 4a49635e): 12/12 PASS; superseded only by later source (owner projection, J14-J16). |
| journeys-final-j11 | 0 | journeys-final-j11.run7-superseded.log — SUPERSEDED (run 7). |
| web-screen-capture | 0 | web-screen-capture.run7-superseded.log — SUPERSEDED (run 7): 15/15. |
| package-independent-recompute | 0 | package-recompute.run7-superseded.log — SUPERSEDED (run 7): 14/14. |
| mobile-export-android-ios | 0 | mobile-export.log |
| api-integration-full | 0 | api-integration.tail.log — FULL suite at d0034b07 on a freshly migrated PG16 + Redis + MinIO: 2873/2873 passed, 0 failed, 0 skipped, 268 files; summary api-integration.json (recorded after the run; start/end are the record time) |
| api-unit-full | 1 | api-unit.tail.log — at e7bf4315: 25618/25620 passed, 1 failed (phase-0-audit-self-reference: clean-tree gate counted the then-untracked runtime/remediation directory; re-run after commit is recorded separately), 1 skipped (point7 closure gate: needs the gitignored .p7tmp ledger) (recorded after the run; start/end are the record time) |
| worker-full | 0 | worker-tests.tail.log — 1218/1219 passed, 1 skipped (Tesseract binary absent on this host: EP-14) (recorded after the run; start/end are the record time) |
| web-node | 0 | web-node.tail.log — 3295 passed, 0 failed, 4 skipped (need the admin fixture server) (recorded after the run; start/end are the record time) |
| web-render | 0 | web-render.tail.log — 1655/1655 (recorded after the run; start/end are the record time) |
| shared | 0 | shared.tail.log — 1068/1068 (recorded after the run; start/end are the record time) |
| ui | 0 | ui.tail.log — 18/18 (recorded after the run; start/end are the record time) |
| extension-unit | 0 | extension.tail.log — 85/85 (recorded after the run; start/end are the record time) |
| mobile-unit | 0 | mobile.tail.log — 1893/1893 (recorded after the run; start/end are the record time) |
| lint | 0 | lint.tail.log — 0 errors (2 pre-existing web warnings) (recorded after the run; start/end are the record time) |
| typecheck | 0 | typecheck.tail.log — recorded after the run; start/end are the record time |
| build-api | 0 | build-api.tail.log — recorded after the run; start/end are the record time |
| build-worker | 0 | build-worker.tail.log — recorded after the run; start/end are the record time |
| build-extension | 0 | build-extension.tail.log — recorded after the run; start/end are the record time |
| build-web | 0 | build-web.tail.log — recorded after the run; start/end are the record time |
| api-unit-full-final | 0 | api-unit.tail.log — FINAL at 5f3be40a on a clean tree: 25619/25620 passed, 0 failed, 1 skipped (point7 closure gate: needs the gitignored .p7tmp ledger); supersedes api-unit-full (whose single failure was the clean-tree gate counting the then-untracked runtime directory). Recorded after the run. |
| final-prisma-generate | 0 | final-prisma-generate.log |
| final-safe-migrate-refuses-remote | 3 | final-safe-migrate-refusal.log — expected exit 3 (REFUSED) |
| final-migrate-from-empty | 0 | final-migrate-from-empty.log |
| final-drift-check | 0 | final-drift-check.log |
| final-raw-schema-verify | 6 | final-raw-schema-verify.log |
| final-db-preflight | 0 | final-db-preflight.log |
| final-migration-inventory-check | 0 | final-migration-inventory.log |
| final-raw-schema-verify-after-registration | 0 | final-raw-schema-verify-2.log |
| final-build-api | 0 | final-build-api.log |
| final-build-worker | 0 | final-build-worker.log |
| final-build-extension | 0 | final-build-extension.log |
| final-build-web-loopback | 0 | final-build-web.log |
| final-mobile-export-android-ios | 0 | final-mobile-export.log |
| final-pwa-installability | 0 | final-pwa-installability.log |
| final-web-admin-routing-against-production-build | 0 | final-web-admin-routing.log — 7/7, 0 skipped: the 4 tests the full web run skips (no fixture web server) executed against the production web build |
| final-layout-batch-a | 1 | layout-projects.json — 641 passed, 1 failed: capture-layout pinned the false trust-strip claim "End-to-end protected" that UC-PROV-011 removed; spec updated to the corrected wording (and now bans the false claim). Recorded after the run. |
| final-layout-batch-b | 0 | layout-projects.json — 557/557. Recorded after the run. |
| final-layout-capture-rerun | 0 | layout-projects.json — 32/32 after the spec followed UC-PROV-011. All 8 layout projects: 1199/1199. Recorded after the run. |
| uc1-acceptance-final | 0 | uc1-acceptance.log — FINAL stack at 23cb5a0b (fresh disposable PG migrated from empty by the harness, API + worker booted; intake + Evidence Requests flags on); kept up for the journeys; stopped at teardown |
| seed-journeys-final-40 | 0 | seed-r40.json |
| seed-journeys-final-41 | 0 | seed-r41.json |
| seed-journeys-final-42 | 0 | seed-r42.json |
| seed-journeys-final-43 | 0 | seed-r43.json |
| journeys-final | 0 | journeys-final.log |
| journeys-final-j11 | 0 | journeys-final-j11.log |
| journeys-final-j16 | 0 | journeys-final-j16.log |
| web-screen-capture | 0 | web-screen-capture.log |
| derived-thumbnails-cross-origin | 1 | derived-thumbnails.run1.log — 5/6: probe race — responses were recorded asynchronously after the check counted them (8 loads, 8 responses, all 200 with the session cookie in the written file); probe now awaits every record. Rerun below. |
| package-independent-recompute | 0 | package-recompute.log |
| derived-thumbnails-cross-origin | 0 | derived-thumbnails.log |
| final-stack-boot-schema-validation | 0 | final-stack-boot.log — API booted on the harness-migrated (from empty) disposable PG16: schema_validation healthy (109 checked), 0 critical/degraded; worker booted and served every journey |
| api-integration-full-at-1b955eaf | 0 | api-integration.tail.log — FULL suite at 1b955eaf on the database just migrated from empty (PG16) + Redis + MinIO: 2874/2874 passed, 0 failed, 0 skipped, 268 files; summary api-integration.json (recorded after the run; start/end are the record time) |
| api-unit-full-at-59d272da | 0 | api-unit.tail.log — at 59d272da on a clean tree: 25619/25620 passed, 0 failed, 1 skipped (point7 closure gate: needs the gitignored .p7tmp ledger) (recorded after the run; start/end are the record time) |
| worker-full-at-59d272da | 0 | worker-tests.tail.log — 1218/1219 passed, 1 skipped (Tesseract binary absent on this host: EP-14) (recorded after the run; start/end are the record time) |
| web-node-final | 0 | web-node.tail.log — 3295 passed, 0 failed, 4 skipped here (need a running web server) — executed separately against the production build: final-web-admin-routing (7/7, 0 skipped) (recorded after the run; start/end are the record time) |
| web-render-final | 0 | web-render.tail.log — 1660/1660 (recorded after the run; start/end are the record time) |
| shared-final | 0 | shared.tail.log — 1069/1069 (recorded after the run; start/end are the record time) |
| ui-final | 0 | ui.tail.log — 18/18 (recorded after the run; start/end are the record time) |
| extension-unit-final | 0 | extension.tail.log — 85/85 (recorded after the run; start/end are the record time) |
| mobile-unit-final | 0 | mobile.tail.log — 1893/1893 (recorded after the run; start/end are the record time) |
| lint-final | 0 | lint.tail.log — 0 errors (2 web warnings that predate the branch) (recorded after the run; start/end are the record time) |
| typecheck-final | 0 | typecheck.tail.log — 9 workspaces: extension, mobile, web, shared, shared-evidence-presentation, shared-runtime, ui, api, worker (recorded after the run; start/end are the record time) |

## Artifacts

- `definitive-universal-evidence-capture-truth.json`
- `definitive-universal-evidence-capture-truth.md`
- `universal-capture-surface-inventory.json`
- `universal-capture-convergence-map.json`
- `universal-capture-runtime-journeys.json`
- `universal-capture-findings.json`
- `universal-capture-external-proof-register.md`
- `universal-capture-remediation-order.md`
