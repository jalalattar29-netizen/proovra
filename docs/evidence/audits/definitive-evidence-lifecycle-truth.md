# PROOVRA — Definitive Evidence Lifecycle Truth Audit

<!-- GENERATED from definitive-evidence-lifecycle-truth.json by tooling/render.mjs — do not edit by hand. -->

| field | value |
|---|---|
| auditedSha | a40ca76f41f4edcd2c0898a25664ca7c5d7d5bf8 |
| originMainShaAtStart | a40ca76f41f4edcd2c0898a25664ca7c5d7d5bf8 |
| branch | audit/definitive-evidence-lifecycle-truth |
| worktree | D:\pv-evidence-truth (detached from the shared checkout) |
| startedAt | 2026-09-29T12:02:12Z |
| completedAt | 2026-09-29 (UTC; recorded at commit) |
| productFilesChanged | none |
| productionContacted | false |

**Totals:** 153 findings — P0 6 · P1 20 · P2 77 · P3 50 · 16 duplicate candidates merged · 0 rejected (of 169 candidates) · 183 dispositioned answers.

## 1. Executive verdict

**AUDIT COMPLETE (every gate dispositioned) — PRODUCT NOT CORRECT AS A DIGITAL-EVIDENCE PLATFORM IN ITS CURRENT STATE.**

Capture, hashing and the finalize claim are sound: the server recomputes SHA-256 over the stored original object version, client digests are never trusted, finalize cannot run twice, and custody for finalization/report/package/OTS/lifecycle/destruction is written in the same transaction as the change. Recovery of reports and packages is idempotent and never charges twice (runtime-proven).

But six P0 defects were confirmed, **all six reproduced at runtime** on disposable loopback infrastructure:

1. A same-workspace member can append bytes to someone else's **sealed** record through the resumable-upload bridge; the next report run then declares it tampered (ET-UPL-01).
2. The anonymous public Verify page prints **internal legal-hold titles, release notes and actor ids** (ET-CUS-01).
3. The destruction executor **destroys evidence under an active legal hold** placed after its facts were gathered (ET-SEC-01).
4. Detaching evidence from its last case **moves it out of the workspace** — admins lose it, the creator keeps it (ET-SEC-02).
5. A legacy personal case can link **another user's private record** and read it (ET-SEC-09).
6. Public Verify headlines **"Core Integrity Verified" while its own live signature and integrity checks fail** (ET-SEC-10).

The cryptographic layer is weaker than the product claims: RFC3161 replies are recorded STAMPED **without any signature or chain validation** (a forged self-signed token was accepted, ET-TSA-01) and the "timestamp digest matches" check compares the request digest with itself (ET-TSA-03). OpenTimestamps proofs stamped since the scheduling change **are never upgraded** (ET-OTS-01/02, reproduced on BullMQ). Packages are not independently verifiable in their custody chain or seal (ET-PKG-01/02).

## 2. Audited SHA and methodology

- **Audited SHA:** `a40ca76f41f4edcd2c0898a25664ca7c5d7d5bf8` (origin/main at start, pinned; no drift during the audit — re-checked before push). Worktree `D:\pv-evidence-truth`, branch `audit/definitive-evidence-lifecycle-truth`; the shared checkout was never read or modified.
- **Source first.** 14 domain fragments (acquisition, uploads, direct capture, intake, state machine & storage, custody, TSA, OTS, queues, reports, package & Verify, recovery, commercial, security/duplicates/concurrency) were traced read-only against the pinned tree; each claim carries file:line and a code snippet. 169 candidates were raised.
- **Lead verification.** Every P0 and P1 was re-read by the lead at its cited lines (notes per finding). Every citation of every candidate was machine-resolved against the audited tree (`tooling/check-citations.mjs`: 512/534 snippets found within ±6 lines; every accepted finding has ≥1 resolving citation). P2/P3 findings not individually re-read say so in their own record.
- **Harness correction (recorded):** the first citation run found 8 candidates with zero resolving citations — all in the three fragments the lead transcribed from sub-audit hand-backs, whose snippets were paraphrases. They were replaced by the literal code (claims unchanged). Before: 497 resolved / 37 not-near / 8 zero-resolved candidates. After: 512 / 22 / 0.
- **Runtime.** 10 probes (TSA, OTS queue, Verify, tenancy, part injection, commercial, intake, Reports KPI, recovery, FREE→PRO) ran through the API's own integration configuration (credential scrub, outbound guard, network ledger) against disposable containers bound to 127.0.0.1, in one final full run. 57 outbound attempts were recorded, all 127.0.0.1 ALLOWED. Containers were removed afterwards.
- **No product file changed; no Production system was contacted;** `services/api/.env` was never read (migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1; the worker was deliberately not booted, see B6).
- **Gate interpretation.** A conservation gate PASSES when every item it names is dispositioned — mapped as correct or recorded as a defect with an ID. A product defect found is not an audit gap.

## 3. Complete lifecycle diagram

```text
CLIENT (web capture | extension UC-1 | Android UC-2/3 | iOS UC-5 | intake link | API key)
   │ POST /v1/evidence · capture-trust open/reserve · external-intake parts
   ▼
createEvidence (evidence.service.ts:428) — the ONE Evidence insert
   │ tx: Evidence(UPLOADING) + EVIDENCE_CREATED + IDENTITY_SNAPSHOT_RECORDED + UPLOAD_AUTHORIZED
   │ admission: assertWorkspaceAllowsEvidenceCreation (count, no lock)
   ▼
presigned PUT (600s) ─or─ upload-session multipart ──► bridge EvidencePart  ⚠ ET-UPL-01
   ▼
POST …/complete → completeEvidence (advisory lock, 120s tx)
   │ HEAD+GET every original by VersionId → SHA-256 → fingerprint → Ed25519 signature
   │ RFC3161: openssl ts -query → curl → ts -reply -text → STAMPED/FAILED   ⚠ ET-TSA-01/03
   │ funding settled (PLAN | EVIDENCE_CREDIT) under per-subject lock
   │ claim status CREATED|UPLOADING → SIGNED (+ custody UPLOAD_COMPLETED, SIGNATURE_APPLIED, TIMESTAMP_*)
   ▼ post-commit (one-shot)  ⚠ ET-ACQ-03
Object Lock retention by key · malware scan · webhooks · OTS request · report request
   ▼
worker: report (re-hash all parts → reject integrity on mismatch) → PDF → package → REPORTED
worker: OTS stamp → upgrade ladder (5 min)  ⚠ ET-OTS-01/02 → PENDING forever
sweeps (19): lifecycle recovery, OTS init reconciler, first issuance, trash grace, …
   ▼
Reports page (listWorkspaceArtifacts)  ⚠ ET-RPT-01
Public Verify /public/verify/:evidenceId  ⚠ ET-SEC-10, ET-CUS-01
Download gate evaluateArtifactDownload · legal hold · trash · destruction executor  ⚠ ET-SEC-01
```

## 4. Acquisition inventory

Exactly one production Evidence insert exists (`createEvidence`, evidence.service.ts:428) with three callers — web `POST /v1/evidence`, direct-capture reserve (extension, Android single/continuous, iOS) and external intake. No worker, webhook or integration creates Evidence; seed scripts are environment-guarded (one only by NODE_ENV, ET-UPL-04). Conservation of entry points: acquisition fragment 10 = 7 mapped + 2 retired (web getDisplayMedia absent; no worker/webhook creator) + 1 blocked (seed scripts); plus 9 upload-session/integration paths, 6 direct-capture modes and 6 intake paths, each dispositioned in the inventories. Client hashes are advisory only; the server hash is authoritative. The weakest points are the resumable-upload bridge (a second EvidencePart writer without guards), the absence of any reaper for abandoned rows, and caller-chosen direct-capture provenance.

| id | sev | title | disposition |
|---|---|---|---|
| [ET-DC-01](#et-dc-01) | P1 | Discard racing direct-capture completion signs a soft-deleted record, writes DELETED-then-SIGNED custody, and answers bound:true | SOURCE_PROVEN_DEFECT |
| [ET-DC-02](#et-dc-02) | P1 | Acquisition statement says the capture session was 'started before the capture'; UC-1 and UC-2 open it after the capture and the server never checks | SOURCE_PROVEN_DEFECT |
| [ET-DC-03](#et-dc-03) | P1 | 'Direct capture' provenance (e.g. 'PROOVRA's own adapter produced the bytes') is selected by the caller's mode string with no client proof | SOURCE_PROVEN_DEFECT |
| [ET-INT-01](#et-int-01) | P1 | Public /transition lets a token holder mark an intake session SUBMITTED without finalizing: link use is consumed, one-time link expires, Evidence stays CREATED | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-INT-02](#et-int-02) | P1 | A failed part PUT permanently blocks the intake session and the contributor is told the workspace refused | SOURCE_PROVEN_DEFECT |
| [ET-INT-04](#et-int-04) | P1 | 'Request more' follow-up submissions never reach the evidence request | SOURCE_PROVEN_DEFECT |
| [ET-INT-05](#et-int-05) | P1 | Parts can be added to an intake record while it is being signed or after it is signed; the worker then includes them | SOURCE_PROVEN_DEFECT |
| [ET-ACQ-01](#et-acq-01) | P2 | POST /v1/evidence authorizes by membership status only, so VIEWERs, members with expired access and members of SUSPENDED orgs can create workspace Evidence | SOURCE_PROVEN_DEFECT |
| [ET-ACQ-03](#et-acq-03) | P2 | Malware scan, the evidence.completed webhook and finalization fanout fire once after commit; a retention or lock-snapshot failure or a crash skips them permanently | SOURCE_PROVEN_DEFECT |
| [ET-ACQ-04](#et-acq-04) | P2 | The size limit is checked only after every part has been streamed and hashed inside a 120s interactive DB transaction, and the presigned PUT does not limit Content-Length | SOURCE_PROVEN_DEFECT |
| [ET-DC-04](#et-dc-04) | P2 | Extension OAuth accepts any chromiumapp.org extension id when EXTENSION_OAUTH_REDIRECT_ALLOW is unset, with no consent step | SOURCE_PROVEN_DEFECT |
| [ET-DC-05](#et-dc-05) | P2 | No reaper for ACTIVE/INTERRUPTED direct-capture sessions; the extension never discards, so failed captures leave permanent empty Evidence rows and orphan objects | SOURCE_PROVEN_DEFECT |
| [ET-DC-06](#et-dc-06) | P2 | Fixed 1h session TTL strands continuous captures finalized late; local segments are already deleted so the recording is unrecoverable | SOURCE_PROVEN_DEFECT |
| [ET-DC-07](#et-dc-07) | P2 | reserveDirectCaptureEvidence runs createEvidence on the global client inside an outer transaction, so a failed reserve leaves an unbound committed Evidence row and a retry mints a second | SOURCE_PROVEN_DEFECT |
| [ET-DC-08](#et-dc-08) | P2 | UC-2/UC-3/UC-5 screen captures always open in the personal workspace (no teamId), misfiling team work and refusing managed identities | SOURCE_PROVEN_DEFECT |
| [ET-DC-09](#et-dc-09) | P2 | Continuous-capture continuity/completeness is client-asserted; the only downstream completeness check reads session status, which is always BOUND for sealed records | SOURCE_PROVEN_DEFECT |
| [ET-INT-06](#et-int-06) | P2 | maxBytesPerSession and ipAllowlistCidrs are stored but never enforced | SOURCE_PROVEN_DEFECT |
| [ET-INT-07](#et-int-07) | P2 | Evidence-request send and request-more mint intake links without the plan and governance gates | SOURCE_PROVEN_DEFECT |
| [ET-INT-08](#et-int-08) | P2 | Cancelling/closing an evidence request does not revoke its link; submissions keep finalizing and attach responses to the cancelled request | SOURCE_PROVEN_DEFECT |
| [ET-INT-09](#et-int-09) | P2 | ONE_TIME link use and per-session Evidence creation are check-then-write races | SOURCE_PROVEN_DEFECT |
| [ET-INT-10](#et-int-10) | P2 | Integrations-API intake-link and evidence-request routes pass an API-credential id as a User id | SOURCE_PROVEN_DEFECT |
| [ET-INT-11](#et-int-11) | P2 | Intake consent is client-asserted: acceptedAtUtc taken from the body, termsAcknowledged/disclosure hash never checked, consent re-postable | SOURCE_PROVEN_DEFECT |
| [ET-INT-12](#et-int-12) | P2 | Intake submitter attribution: identity snapshot and public Verify name the link creator, not the contributor; surfaces disagree | SOURCE_PROVEN_DEFECT |
| [ET-INT-13](#et-int-13) | P2 | Intake submit can report failure after finalization; governance-denied retries append EXPORT_BLOCKED_BY_POLICY custody per anonymous retry | SOURCE_PROVEN_DEFECT |
| [ET-INT-14](#et-int-14) | P2 | Soft-deleted in-progress intake Evidence is reused for new parts | SOURCE_PROVEN_DEFECT |
| [ET-UPL-02](#et-upl-02) | P2 | One aborted or expired upload session blocks finalization of its evidence forever; the idempotency key returns the terminal session on retry | SOURCE_PROVEN_DEFECT |
| [ET-UPL-04](#et-upl-04) | P2 | seed-home-personas.ts writes fabricated SIGNED evidence and custody into whatever DATABASE_URL dotenv loads, guarded only by NODE_ENV | SOURCE_PROVEN_DEFECT |
| [ET-ACQ-05](#et-acq-05) | P3 | The required-checklist gate enforces a plan the client wrote (intakePlanJson), and the template identity stamp does not check who owns the capture session | SOURCE_PROVEN_DEFECT |
| [ET-ACQ-07](#et-acq-07) | P3 | POST /v1/evidence/:id/parts has no upper bound on partIndex, no cap on part count, and no rate limit | SOURCE_PROVEN_DEFECT |
| [ET-DC-10](#et-dc-10) | P3 | Capture trust-event sub-chain read-then-insert with no lock and no unique (session, sequence) — concurrent declarations fork the chain | SOURCE_PROVEN_DEFECT |
| [ET-DC-11](#et-dc-11) | P3 | CAPTURE_MANIFEST relabel happens after the seal outside the signed fingerprint; extension token can presign parts on any owned unsealed evidence; draft route uses a hand-rolled membership check; dead device-identity code | SOURCE_PROVEN_DEFECT |
| [ET-INT-15](#et-int-15) | P3 | Intake P3s: dead first-part capture-environment write, false magic-byte comment, UPLOAD_AUTHORIZED for an original URL never issued, swallowed LINK_USED/CONSENT custody failures, unvalidated caseId/evidenceId, stale citizen-capture comment | SOURCE_PROVEN_DEFECT |
| [ET-UPL-03](#et-upl-03) | P3 | Idempotent session reuse does not check the returned session belongs to the requested evidenceId | SOURCE_PROVEN_DEFECT |
| [ET-UPL-05](#et-upl-05) | P3 | Multipart path never enforces expectedTotalBytes/partSizeBytes, marks parts VERIFIED without a reference hash, and leaves bridged parts without uploadedByUserId | SOURCE_PROVEN_DEFECT |

## 5. Evidence state machine

`EvidenceStatus`: CREATED → UPLOADING (same transaction, so no committed row normally rests in CREATED) → SIGNED (the single finalize claim) → REPORTED (report commit); FAILED_HASH_MISMATCH is the integrity terminal (entered only by the report worker). UPLOADED is a dead enum value with readers but no writer. `lifecycleState` (ACTIVE / ARCHIVED / TRASHED / PENDING_DESTRUCTION / DESTROYED) runs orthogonally; destruction never changes `status`, so a tombstone still says SIGNED/REPORTED. Definitions: *created* = row + custody before any byte; *uploaded* = never recorded; *finalized* = SIGNED after full server re-hash, signature and TSA attempt; *immutable* = Object Lock retention applied after the SIGNED commit (by key, not version) when enabled; *custody begins* at row creation; *billable* = funding settled at completion; *reportable/verifiable* = SIGNED and entitled; *end-to-end ready* = REPORTED with package and an anchored OTS proof — which the OTS ladder defect currently prevents. Terminal states: FAILED_HASH_MISMATCH (overwritable in a race, ET-SM-02), DESTROYED; CREATED/UPLOADING have no exit.

| id | sev | title | disposition |
|---|---|---|---|
| [ET-SM-02](#et-sm-02) | P2 | Report commit (phase C) writes status=REPORTED with WHERE id only, so it can overwrite FAILED_HASH_MISMATCH and commit a Report on a trashed/destroyed record | SOURCE_PROVEN_DEFECT |
| [ET-SM-08](#et-sm-08) | P2 | Evidence library status maps (web + mobile mirror) render FAILED_HASH_MISMATCH as a neutral 'Status not recorded'; UPLOADED is a dead enum still driving UI copy and probes | SOURCE_PROVEN_DEFECT |

## 6. Storage and hash truth

Bytes hashed are the stored originals, streamed by VersionId; multipart: `fileSha256 = sha256(partHashes.join('|'))`, `multipartManifestSha256 = sha256(join('\n'))`; ETags are never used as hashes. Keys are server-built from the evidence id; clients choose only a sanitized filename suffix. Presigned PUT 600 s (≤ 900 s), UploadPart 300 s, GET 600 s. Gaps: the version id is persisted but not used on every byte path (verify viewUrl, retention apply, archive CopyObject — ET-SM-03); the integrity re-hash runs only inside report generation, so records with no report entitlement are never re-verified (ET-SM-07); abandoned uploads stay in the bucket and the row stays UPLOADING forever (ET-ACQ-02); and a sealed record can be given an extra part (ET-UPL-01). Download after destruction is impossible (no key remains).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-UPL-01](#et-upl-01) | P0 | Resumable-upload bridge attaches a new EvidencePart to any same-team evidence — including SIGNED/REPORTED or another member's in-flight record — and the next report run then declares sealed evidence FAILED_HASH_MISMATCH | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-SM-03](#et-sm-03) | P2 | Several original-byte paths still address latest-at-key instead of the signed storageVersionId (verify-content viewUrl, retention apply + lock snapshot, archive tier), while the owner can still write new versions at the key | SOURCE_PROVEN_DEFECT |
| [ET-SM-07](#et-sm-07) | P2 | Integrity re-hash (FAILED_HASH_MISMATCH gate) runs only inside report generation; records without report entitlement are never re-verified, and the declared reconciler/completion sources are dead | SOURCE_PROVEN_DEFECT |

## 7. Custody/audit truth

Per-evidence hash chain (sequence, prevEventHash, eventHash over canonical JSON), serialised by advisory lock and a unique (evidenceId, sequence). Finalization, report, package, OTS, integrity rejection, lifecycle and destruction events are written in the mutation's own transaction and retries do not duplicate them. Weaknesses: append-only is convention only and the hash is unkeyed (ET-CUS-04); many governance mutations append custody in a separate transaction with a silent catch (ET-CUS-11); legal-hold custody is best-effort (ET-CUS-03); chain-transfer events are never recorded because the enum value does not exist (ET-CUS-02); original-URL issuance leaves no custody (ET-CUS-07); the public summarizer leaks payloads (ET-CUS-01, P0).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-CUS-01](#et-cus-01) | P0 | Public Verify shows internal legal-hold notes, hold titles, publication/suspension reasons and actor user IDs to anonymous viewers | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-CUS-02](#et-cus-02) | P2 | Chain-of-custody transfers never write a custody event: the event type does not exist in the enum and the failure is swallowed | SOURCE_PROVEN_DEFECT |
| [ET-CUS-03](#et-cus-03) | P2 | Legal hold place/release reach the custody chain only best-effort: silent failure, CASE scope capped at 1000 in one Promise.all burst, WORKSPACE scope and later-linked evidence never recorded | SOURCE_PROVEN_DEFECT |
| [ET-CUS-04](#et-cus-04) | P2 | custody_events and admin_audit_logs are append-only only by convention: no trigger or REVOKE, unkeyed hash, and a fully hash-stripped chain verifies as 'legacy' valid | SOURCE_PROVEN_DEFECT |
| [ET-CUS-05](#et-cus-05) | P2 | Admin audit hash chain can fork under API/worker clock skew or same-millisecond writes, so the verifier reports a break with no tampering | SOURCE_PROVEN_DEFECT |
| [ET-CUS-06](#et-cus-06) | P2 | A retried package build (PACKAGE_FOR_VERSION) selects custody by atUtc instead of sequence, so custody.json can contain a sequence gap and broken prevHash links while claiming to be complete | SOURCE_PROVEN_DEFECT |
| [ET-CUS-07](#et-cus-07) | P2 | Presigned ORIGINAL URLs issued by the parts listing, record views and public verify leave no custody event; only /original is recorded, and EVIDENCE_DOWNLOADED is never emitted | SOURCE_PROVEN_DEFECT |
| [ET-CUS-08](#et-cus-08) | P2 | Unlock writes no custody event and EVIDENCE_LOCKED serves two meanings, so the timeline says 'Evidence record locked' after the record is unlocked | SOURCE_PROVEN_DEFECT |
| [ET-CUS-09](#et-cus-09) | P2 | Exchange package custody-chain.json omits payloads (hashes cannot be recomputed), truncates at 500 events, and turns a DB error into an empty chain | SOURCE_PROVEN_DEFECT |
| [ET-CUS-10](#et-cus-10) | P2 | Retention auto-extension fires on ANY recent custody event, including anonymous public VERIFY_VIEWED, and the extension itself is not recorded in custody | SOURCE_PROVEN_DEFECT |
| [ET-CUS-11](#et-cus-11) | P2 | Many material governance mutations commit first and append custody in a separate transaction with a SILENT catch, so a failure leaves the mutation done and the chain missing it with no signal | SOURCE_PROVEN_DEFECT |
| [ET-CUS-12](#et-cus-12) | P3 | Redaction publication and derivatives, and reviewer workflow decisions, never reach the evidence custody chain; they live in unhashed, mutable side tables | SOURCE_PROVEN_DEFECT |
| [ET-CUS-13](#et-cus-13) | P3 | Customer timelines render raw event codes and misleading or duplicate events | SOURCE_PROVEN_DEFECT |
| [ET-CUS-14](#et-cus-14) | P3 | Tenant audit seals raw client IP and User-Agent into hashed metadata (bypassing the masking the column path applies), and never fills the requestId column | SOURCE_PROVEN_DEFECT |

## 8. TSA findings

Digest submitted: the original `fileSha256` for single files, the `|`-joined composite for multipart. The request carries a nonce and `-cert`, but the reply is only printed with `openssl ts -reply -text` and parsed with regular expressions: **no signature, certificate-chain, validity, trust-root, nonce or policy-OID check exists anywhere** (ET-TSA-01, runtime-proven with a forged token). The persisted `tsaMessageImprint` is the request digest, so every read-side 'digest matches' compares a value with itself (ET-TSA-03). An imprint mismatch is correctly refused (runtime-proven). Outage, rejection and invalid token all collapse to FAILED without a persisted failure code (ET-TSA-06). tsaStatus is written once inside the finalize claim — by design there is no retry — but the operator repair CLI is a second writer (ET-TSA-09). The TSA password is passed on curl's argv.

| id | sev | title | disposition |
|---|---|---|---|
| [ET-TSA-01](#et-tsa-01) | P1 | RFC3161 responses are accepted as STAMPED without signature, certificate-chain, trust-anchor, nonce or policy validation | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-TSA-03](#et-tsa-03) | P1 | Every read-side 'timestamp digest matches' check compares the sent digest to itself | SOURCE_PROVEN_DEFECT |
| [ET-TSA-02](#et-tsa-02) | P2 | Granted reply without a parseable imprint (incl. granted status with no timeStampToken) is persisted as STAMPED | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-TSA-04](#et-tsa-04) | P2 | Verification package ships FAILED (rejected / imprint-mismatched) replies as timestamp.tsr and the README says 'Included' without the FAILED status | SOURCE_PROVEN_DEFECT |
| [ET-TSA-05](#et-tsa-05) | P2 | Multipart TSA imprint is the undocumented '\|'-joined composite, while the package tells reviewers the reproducible digest is the LF-joined manifest hash | SOURCE_PROVEN_DEFECT |
| [ET-TSA-06](#et-tsa-06) | P2 | Provider-unavailable, rejected and invalid-token outcomes all collapse to tsaStatus=FAILED; failureCode is not persisted | SOURCE_PROVEN_DEFECT |
| [ET-TSA-07](#et-tsa-07) | P3 | TSA failure classifier substring-matches the full execFile error (argv incl. URL and user:password, digest, temp path); real timeouts are never classified as timeouts | SOURCE_PROVEN_DEFECT |
| [ET-TSA-08](#et-tsa-08) | P3 | Report claims the token is available via a 'technical verification endpoint' that does not exist; comments claim a worker ASN.1 TSA parser that does not exist | SOURCE_PROVEN_DEFECT |
| [ET-TSA-09](#et-tsa-09) | P3 | Manual TSA repair CLI writes STAMPED without the serial+genTime precondition its docstring states, and contradicts the 'written once inside finalize' authority claim | SOURCE_PROVEN_DEFECT |

## 9. OTS findings

The digest stamped is the fingerprint hash; the initial `.ots` proof is stored and bound to the record. Upgrades are serialised and idempotent. The scheduling is broken: the init branch enqueues its follow-up without `selfJobId`, so it collapses onto the running job (ET-OTS-01), and where the ladder does run its follow-up id repeats and is silently dropped on the third hop (ET-OTS-02) — both reproduced on real BullMQ. Nothing recovers a PENDING row without a job (ET-OTS-03). Bitcoin attestation is not verified against a chain in the shipped image: anchors are proof-structure only and the badge honestly says CHAIN NOT CHECKED; the Verify page trusts the stored status. Calendar outages during stamping are persisted as per-record FAILED without retry (ET-OTS-04).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-OTS-01](#et-ots-01) | P1 | After initialization the upgrade follow-up collapses onto the running job itself, so no newly stamped proof is ever upgraded | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-OTS-02](#et-ots-02) | P1 | Self follow-up job id `-next-` is deterministic and collides with its own retained completed job, so the ladder dies silently on the third hop | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-OTS-03](#et-ots-03) | P2 | No automatic or operator recovery exists for a PENDING (or FAILED) row whose job is gone; pending_aged guidance falsely says the ladder is still running | SOURCE_PROVEN_DEFECT |
| [ET-OTS-04](#et-ots-04) | P2 | A calendar/network failure during `ots stamp` is persisted as per-record FAILED (no proof), never retried automatically, and its raw error text is shown publicly | SOURCE_PROVEN_DEFECT |
| [ET-OTS-05](#et-ots-05) | P3 | Initializer still promotes to ANCHORED from `ots upgrade` text alone (heuristic removed elsewhere); such an anchor is never re-checked when a txid is present | SOURCE_PROVEN_DEFECT |
| [ET-OTS-06](#et-ots-06) | P3 | A header-valid but unparseable proof (or block attestation without readable txid) is treated as transient forever and never reaches a terminal state | SOURCE_PROVEN_DEFECT |
| [ET-OTS-07](#et-ots-07) | P3 | Package verification hint `ots verify opentimestamps-proof.ots` cannot succeed; the stamped file is fingerprint.json | SOURCE_PROVEN_DEFECT |

## 10. Worker/queue findings

17 queues (15 processed + 2 DLQs), 15 Worker registrations (no duplicates), 19 interval sweeps + 3 observability timers, all started. Conservation: 10 of 15 processed queues have a production producer; mi-exif, mi-search-index, graph-domain-sync, graph-timeline-sync and org-health-refresh have consumers and no producer (ET-Q-07); report-dlq is written by design and read by nothing; media-intelligence-dlq has neither. Payloads carry only command ids — consumers re-derive tenant and plan from the database (correct). Durable rows commit before enqueue (correct). Defects: the OTS ladder (merged into ET-OTS-01/02), non-OCR intelligence runs never leaving PENDING (ET-Q-03), redaction derivatives stuck in RENDERING (ET-Q-04), a trash sweep cursor that can starve (ET-Q-05), and workers claiming jobs before bootstrap (ET-Q-06).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-Q-03](#et-q-03) | P2 | MediaIntelligenceRun rows for perceptual hashes, technical metadata, text-similarity and deferred kinds never leave PENDING, so the intelligence-run reconciler re-runs them every 10 minutes forever and starves genuinely stranded runs | SOURCE_PROVEN_DEFECT |
| [ET-Q-04](#et-q-04) | P2 | A redaction derivative that hits a transient storage error or a worker crash after its claim is stuck in RENDERING forever; retries, the reconciler and a user re-request all skip it | SOURCE_PROVEN_DEFECT |
| [ET-Q-05](#et-q-05) | P2 | Trash-grace reconciler re-reads the same oldest 200 TRASHED rows every hour; once 200 of them are blocked (hold, retention, object lock, approval pending) eligible records are never purged, and the purge job's own BLOCKED reschedule is a no-op | SOURCE_PROVEN_DEFECT |
| [ET-Q-06](#et-q-06) | P2 | 14 of 15 BullMQ workers and 4 sweeps start claiming work at module import, before secrets hydration, package-signer validation and object-lock bootstrap | SOURCE_PROVEN_DEFECT |
| [ET-Q-07](#et-q-07) | P3 | Five queues have registered consumers but no producer, and the registry asserts reconcilers/claims that do not exist (graph/org-health recovery, derived-asset recovery, OTS tenant fail-closed, timeoutMs) | SOURCE_PROVEN_DEFECT |
| [ET-Q-08](#et-q-08) | P3 | media-intelligence-dlq is a phantom sink (never written) shown as an operator DLQ, and report-dlq entries are written for requests that are still being retried | SOURCE_PROVEN_DEFECT |
| [ET-Q-09](#et-q-09) | P3 | Worker job events log an evidenceId the canonical payload never carries, OTS pending-retry classification keys on an error string no longer thrown, and malformed payloads are retried for the full budget | SOURCE_PROVEN_DEFECT |
| [ET-Q-10](#et-q-10) | P3 | The embed-owed reconciler selects chunks by the legacy `embedding` column, which nothing writes, so every chunk aged 30min-30d is 'owed' forever | SOURCE_PROVEN_DEFECT |

## 11. Report findings

Report generation is request-driven (`createReportGenerationRequest` → reservation → worker → PDF → package), bound to the evidence version and custody sequence, and never silently switches versions. The PDF does not claim verified while TSA/OTS are pending or invalid. Defects: the only legal-hold line prints the inert S3 flag ('Legal Hold: OFF') even under an active canonical hold (ET-RPT-03); `resultReportId` points at the newest report rather than the one produced (ET-RPT-07); executive wording overstates OTS when not chain-checked (ET-RPT-09).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-RPT-03](#et-rpt-03) | P2 | Report PDF prints 'Legal Hold: OFF' from the inert S3 object-lock flag even when a canonical evidence legal hold is ACTIVE | SOURCE_PROVEN_DEFECT |
| [ET-RPT-07](#et-rpt-07) | P3 | SUCCEEDED request records the newest report id, not the report the run produced or targeted | SOURCE_PROVEN_DEFECT |
| [ET-RPT-09](#et-rpt-09) | P3 | Executive conclusion says 'finalized supporting publication materials' when OTS is anchored but not chain-checked | SOURCE_PROVEN_DEFECT |

## 12. Verification-package findings

Contents are inventoried in the JSON (fingerprint, signature, public key, TSA token, OTS proof, custody/forensic custody, report, manifest, seal, checksums, README). Entry names are server-controlled (no traversal), serialization is deterministic, and the format-5 seal covers every entry including the report. A recipient **can** verify the original hash and the evidence signature (key authenticity still needs PROOVRA), and the TSA token (without its CA chain). A recipient **cannot** recompute the custody chain — payloads are rewritten after hashing (ET-PKG-01) — and the seal is verifiable only against a key shipped in the same ZIP with no published fingerprint (ET-PKG-02). The README points to the older manifest signature, which does not cover the report (ET-PKG-03), and asserts files that are not emitted (ET-PKG-04). Failed TSA replies are shipped as 'Included' (ET-TSA-04).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-PKG-01](#et-pkg-01) | P1 | Package custody.json payloads are rewritten after hashing, so the included hash chain cannot be recomputed (reads as tampered) | SOURCE_PROVEN_DEFECT |
| [ET-PKG-02](#et-pkg-02) | P1 | Package seal/manifest signing key is only self-asserted inside the ZIP; PROOVRA publishes no fingerprint, yet UI and seal docs claim a bound, checkable seal | SOURCE_PROVEN_DEFECT |
| [ET-PKG-03](#et-pkg-03) | P2 | README HOW TO VERIFY ignores the format-5 seal and points recipients at the manifest signature that does not cover the report or checksum index | SOURCE_PROVEN_DEFECT |
| [ET-PKG-04](#et-pkg-04) | P2 | Signed package-manifest.json asserts contents.verifyHtml and verificationScript = true but no such files are emitted | SOURCE_PROVEN_DEFECT |
| [ET-PKG-08](#et-pkg-08) | P2 | Package eligibility gate (hold / lifecycle / destruction review / immutable drift) is skipped for personal workspaces and when the Team row resolves isPersonal=null | SOURCE_PROVEN_DEFECT |
| [ET-PKG-11](#et-pkg-11) | P3 | historical-verification-material.json leaks key path or KMS key id and lists SIGNING_PUBLIC_KEY_PATH for every purpose including the package signer | SOURCE_PROVEN_DEFECT |
| [ET-PKG-14](#et-pkg-14) | P3 | Single-file evidence entry at ZIP root can collide with a fixed entry name when no capture/upload timestamp exists | SOURCE_PROVEN_DEFECT |
| [ET-PKG-15](#et-pkg-15) | P3 | Package streams originals without the pinned storageVersionId used by the integrity pre-read | SOURCE_PROVEN_DEFECT |

## 13. Verify-page findings

The verify 'token' is the evidence UUID (122 random bits), published by default, never expiring, not rotatable (ET-PKG-07). Unknown and malformed ids answer an identical 404 with `no-store` (runtime); unfinalized records answer a distinguishable 409 (merged into ET-SEC-31). Pending OTS and failed TSA are rendered honestly (runtime). Defects: the headline trusts a stored snapshot over live checks (ET-SEC-10, P0, runtime); raw custody payloads reach the anonymous page (ET-CUS-01, P0, runtime); 'Package Integrity Complete' and 'Immutable Storage Locked' come from file presence and DB snapshots (ET-PKG-05/06); anonymous GETs write audit, raw-IP view rows and custody (ET-PKG-09).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-SEC-10](#et-sec-10) | P0 | Public verify headline says 'Core Integrity Verified' from stored flag + materials even when live recompute (hash/signature/custody) fails; snapshot trust decision wins over live checks | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-PKG-05](#et-pkg-05) | P2 | Public Verify "Package Integrity Complete / Independent Review Enabled" is derived from file-name presence, never from seal or signature verification | SOURCE_PROVEN_DEFECT |
| [ET-PKG-06](#et-pkg-06) | P2 | Public Verify storage "verified/Immutable Storage Locked" comes from a DB snapshot (no expiry check, no object check); integrity verdict is DB self-consistency only | SOURCE_PROVEN_DEFECT |
| [ET-PKG-07](#et-pkg-07) | P2 | Public verify capability is the permanent evidence UUID: published by default, no expiry, no rotation, no per-recipient revocation | SOURCE_PROVEN_DEFECT |
| [ET-PKG-09](#et-pkg-09) | P3 | Anonymous GET writes audit + verification_views (raw IP/UA, no retention) + evidence row + debounced custody event | SOURCE_PROVEN_DEFECT |
| [ET-PKG-12](#et-pkg-12) | P3 | BASIC verify says a report copy "can be checked" via its recorded digest, but no digest is returned | SOURCE_PROVEN_DEFECT |
| [ET-PKG-13](#et-pkg-13) | P3 | /verify/[token] has no noindex/robots control; web error path sends the token to Sentry | SOURCE_PROVEN_DEFECT |
| [ET-PKG-17](#et-pkg-17) | P3 | Per-evidence public verify bucket (60/min) is shared by all viewers; two IPs can lock a record page out | SOURCE_PROVEN_DEFECT |

## 14. Reports-page findings

Cards and table come from ONE aggregator call over the same finalized population (no cap, no date window, same NULL-team arm), and a failed summary fetch renders 'temporarily unavailable', never zeros. The known risk is nevertheless real in a narrower form, reproduced at runtime: a failed *updated-report* request on a record that already has a report is counted as READY and excluded from 'Reports failed', while its row shows a Retry/Escalated badge (ET-RPT-01). Request-level BLOCKED is uncounted for reports (ET-RPT-02). `GET /v1/reports` uses a bare ACTIVE-membership check instead of the canonical authorizer (ET-SEC-18). TSA and OTS status are not shown on the Reports page at all.

| id | sev | title | disposition |
|---|---|---|---|
| [ET-RPT-01](#et-rpt-01) | P2 | A failed or retryable request on a record that already has a report is invisible to every Reports card and filter while the row shows Retry / 'Escalated to operators' | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-RPT-02](#et-rpt-02) | P2 | Request-level BLOCKED (stale policy / policy block) is uncounted for reports and mislabelled 'not requested' in rows, while 'Packages blocked' counts rows that say 'Package not requested' | SOURCE_PROVEN_DEFECT |
| [ET-SEC-18](#et-sec-18) | P2 | GET /v1/reports skips authorizeOrFail (bare ACTIVE-status membership, no permission/expiry/org-lifecycle); fallback query drops deletedAt/lifecycle filters | SOURCE_PROVEN_DEFECT |
| [ET-RPT-04](#et-rpt-04) | P3 | When loadEvidenceOutputFacts fails, every row is given action NONE with reason PERMISSION_DENIED ('Needs permission') while the list section still reports ok | SOURCE_PROVEN_DEFECT |
| [ET-RPT-05](#et-rpt-05) | P3 | Summary shows 'temporarily unavailable' during initial load and permanently on the user-scoped fallback path | SOURCE_PROVEN_DEFECT |
| [ET-RPT-06](#et-rpt-06) | P3 | Reports row renders every generation outcome in success green, including TERMINAL, RECOVERABLE_BLOCKED and QUEUE_UNAVAILABLE | SOURCE_PROVEN_DEFECT |

## 15. Recovery matrix

Every Recover/Retry control (web evidence tab, Reports row, Copilot, mobile, Operations, Admin, queue console, automatic sweep) was traced; the failure × action matrix is in `inventories["recovery.failureRecoveryMatrix"]`. Report/package recovery repairs only the missing component, rebuilds the package from the stored report after checking its hash, never mints a new report version or timestamp, never charges, and shows success only after a server reread — runtime-proven idempotent under concurrent clicks. TSA has no recovery by design. OTS recovery is 'Resume OTS anchoring', which reports QUEUED even when it collapsed or the proof is invalid (ET-REC-01/06). Gaps: OTS budget-exhausted incidents never auto-close and say the record will recover (ET-REC-02); NULL-team personal records get no recovery button (ET-REC-03); mobile's exhausted-failure retry always 400s (ET-REC-04).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-REC-02](#et-rec-02) | P2 | OTS budget-exhausted incident (WORKER, OTS:<id>:GLOBAL_BUDGET_EXHAUSTED) can never auto-resolve and tells operators the record will recover on its own | SOURCE_PROVEN_DEFECT |
| [ET-REC-03](#et-rec-03) | P2 | Recovery decision refuses team_id-NULL Personal records (WORKSPACE_UNRESOLVED) that the durable writer and worker now accept | SOURCE_PROVEN_DEFECT |
| [ET-REC-04](#et-rec-04) | P2 | Mobile Operations shows 'Retry after exhausted failure' but never sends the required reason, so it always fails with 400 | SOURCE_PROVEN_DEFECT |
| [ET-REC-01](#et-rec-01) | P3 | Resume OTS anchoring reports QUEUED (and audits success) when the enqueue collapsed onto a live job; ALREADY_IN_PROGRESS branch is dead | SOURCE_PROVEN_DEFECT |
| [ET-REC-05](#et-rec-05) | P3 | Web Operations loses the remediation outcome on 409/503; QUEUE_UNAVAILABLE (work recorded) is shown as 'could not be started' | SOURCE_PROVEN_DEFECT |
| [ET-REC-06](#et-rec-06) | P3 | 'Resume OTS anchoring' is offered and answered QUEUED for a permanently invalid proof, which the worker skips | SOURCE_PROVEN_DEFECT |
| [ET-REC-07](#et-rec-07) | P3 | Remediation audit outcomes misclassify refusals and no-ops | SOURCE_PROVEN_DEFECT |
| [ET-REC-08](#et-rec-08) | P3 | Platform queue Retry/Replay of a GenerateReportJob whose request is terminal reports success but the worker no-ops | SOURCE_PROVEN_DEFECT |
| [ET-REC-09](#et-rec-09) | P3 | Communications message manual retry writes no audit row and updates without a state predicate | SOURCE_PROVEN_DEFECT |
| [ET-REC-10](#et-rec-10) | P3 | 'Retry budget exhausted' incident fires at BullMQ attempt 5 while the durable budget (12 claims) keeps retrying | SOURCE_PROVEN_DEFECT |
| [ET-REC-11](#et-rec-11) | P3 | Every API-side recovery request fires an EVIDENCE_REPORTED automation trigger, before any report exists | SOURCE_PROVEN_DEFECT |

## 16. FREE three-evidence analysis

**The FREE limit is three lifetime evidence records** — every non-trashed, non-destroyed personal Evidence row of ANY status (drafts, uploading, failed, archived, held all count; trashed does not). A multi-file capture, folder upload, screen recording or intake submission is ONE record. Admission is checked at creation without a lock; funding is settled at completion under a per-subject advisory lock. Deterministic examples (runtime where marked): 0/3–2/3 admitted; **two concurrent creates at 2/3 are both admitted (runtime)**, and completion settlement then refuses the later-created one with 402 after its upload, stranding it; **at 3/3 the 4th is refused 409 FREE_LIMIT_REACHED with 'You have reached the record limit included in the Free plan: 3 records…' (runtime)**; a failed or abandoned third keeps its slot (runtime, ET-ACQ-02); trash frees a slot but **restore re-admits without a check (runtime, ET-COM-02)**; archived counts; an intake submission counts against the link owner and **an anonymous, never-submitted intake session consumes it (runtime, ET-INT-03)**; mobile and all creators share the backend gate; no admin bypass exists (admins can only grant credits).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-INT-03](#et-int-03) | P1 | Any intake link holder can exhaust the workspace's evidence-record allowance with never-submitted records | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-ACQ-02](#et-acq-02) | P2 | Interrupted web captures leave Evidence in UPLOADING permanently; these rows count against record caps and are never reaped | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-COM-02](#et-com-02) | P2 | Trash releases a FREE record slot but Restore-from-trash re-admits the record with no cap check, so FREE (and the frozen downgrade cap) can be exceeded without limit | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-ACQ-06](#et-acq-06) | P3 | The record-cap count is read without a lock, and SHARED workspaces are not re-checked at completion | SOURCE_AND_RUNTIME_PROVEN_DEFECT |

## 17. FREE → PRO analysis

PRO becomes authoritative only when a provider-confirmed ACTIVE subscription is applied through `syncPlanForSubscription` (verified webhook, checkout settlement that re-reads the provider, reconciliation); client redirects grant nothing; duplicate webhooks collapse. The three FREE records are preserved unchanged (no deletion, reordering or new version). Runtime: after an ACTIVE PRO sync both a 1-day-old and a 10-day-old FREE record changed from NOT_INCLUDED to ELIGIBLE_NOT_GENERATED with a GENERATE action; the upgrade itself created nothing. Automatic first issuance is the worker's job and serves only records signed within 7 days of activation unless `OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED` is on (default off) — older records need a user click (ET-COM-06, OD-2). TSA/OTS already ran at completion on FREE. Unknown plan state resolves UNRESOLVED (retry), never FREE or PRO, in API and worker; the worker re-resolves at job time.

| id | sev | title | disposition |
|---|---|---|---|
| [ET-COM-06](#et-com-06) | P3 | Historical FREE records are not issued automatically after upgrade unless a default-OFF flag is set; customer-initiated Generate bypasses the 'confirmed payment' rule during grace | SOURCE_PROVEN_DEFECT |

## 18. Credit allocation answer

One credit type exists: **evidence credits** (per-user wallet `entitlements.credits` + ledger `evidence_credit_ledger_entries`: PURCHASE, CONSUMPTION, REVERSAL, ADMIN_GRANT; purchases idempotent on provider ref; consumption unique per evidence id). Storage add-ons are subscriptions, not credits. **A FREE user with three records who buys one credit unlocks none of the three.** The credit is spent only inside a NEW record's completion, after the plan allowance is exhausted; that fourth record becomes credit-funded and earns a report and package even on FREE. Allocation is deterministic by (createdAt, id), not array order — runtime: after the purchase the next new record was admitted at cap and no existing record changed funding. Stripe credit refunds/chargebacks are never reversed (ET-COM-03; PayPal is). Whether this is the right product behaviour is OD-1.

_No confirmed findings in this section._

## 19. Downgrade/refund behaviour

No plan change deletes or relabels evidence; downgrade to FREE freezes a legacy cap at the current count, so new FREE records are refused until below it. Original/package downloads carry no plan gate; issued reports are not revoked; queued jobs re-check entitlement at run time (a PRO-completed record whose job runs after cancellation is refused as COMMERCIAL — supersedable on re-upgrade; OD-9). PAST_DUE keeps PRO through a 7-day grace, then blocks **all** creation including credit-funded (ET-COM-04, OD-3). Refund/chargeback of a subscription is recorded for review; entitlement changes only when the provider reports CANCELED. **But after the reconciliation sweep has agreed with Stripe once, a later cancellation or past-due webhook is refused as older (ET-COM-01, runtime), so a cancelled Stripe customer can keep PRO indefinitely.**

| id | sev | title | disposition |
|---|---|---|---|
| [ET-COM-01](#et-com-01) | P1 | Billing reconciliation stamps a Stripe subscription's ordering clock with its FUTURE current_period_end, after which cancellation/past-due webhooks are refused as 'older' and the account can stay PRO indefinitely | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-COM-03](#et-com-03) | P2 | Stripe credit refunds and chargebacks never reverse evidence credits (only PayPal is handled) | SOURCE_PROVEN_DEFECT |
| [ET-COM-04](#et-com-04) | P2 | A lapsed (PAST_DUE beyond grace) or ambiguous (two live subscriptions) paid account cannot create ANY evidence — worse than FREE and unable to spend purchased credits | SOURCE_PROVEN_DEFECT |

## 20. Duplicate/legacy authority inventory

Dispositioned in `inventories["security.duplicateAuthorities"]`. Canonical single authorities hold for Evidence creation, finalization, byte release, plan resolution (API and worker share one resolver), credit consumption and recovery. Real competing authorities: two EvidencePart writers with different guards (ET-UPL-01); five report/package backlog aggregators with three rules (ET-SEC-20); two case-link authorities (ET-SEC-16); two draft reapers (ET-SEC-24); storage-used populations that differ between creation and completion (ET-SEC-22); a pricing page that contradicts the commercial policy on FREE storage add-ons (ET-SEC-23); the TSA repair CLI as a second tsaStatus writer (ET-TSA-09); an integrity snapshot writing booleans from status (ET-SEC-35). Dead or phantom: UPLOADED enum, five producer-less consumers, media-intelligence-dlq, device-registry client, integration.evidence.create scope.

| id | sev | title | disposition |
|---|---|---|---|
| [ET-SEC-16](#et-sec-16) | P2 | Two case-link authorities: bulk ADD/REMOVE_FROM_CASE use a weaker case check than the single routes; case-workspace detach vs cases detach disagree on teamId reset | SOURCE_PROVEN_DEFECT |
| [ET-SEC-20](#et-sec-20) | P2 | Report/package backlog computed by five aggregators with three rules (entitlement-narrowed relation test, column test, un-narrowed); dashboard 'entitled' ignores subscription lifecycle while worker issuance honors it | SOURCE_PROVEN_DEFECT |
| [ET-SEC-21](#et-sec-21) | P2 | Case risk 'integrity' signal reads evidence_integrity_snapshots, which is backfilled once for SIGNED/REPORTED only and never refreshed, so it cannot report FAILED rows | SOURCE_PROVEN_DEFECT |
| [ET-SEC-22](#et-sec-22) | P2 | Storage-used population differs between evidence creation (includes legacy NULL-team rows) and completion/worker (strict team) for personal workspaces | SOURCE_PROVEN_DEFECT |
| [ET-SEC-23](#et-sec-23) | P2 | Pricing page says FREE storage add-ons 'Not available' while shared commercial policy and API allow FREE storage add-on purchase | SOURCE_PROVEN_DEFECT |
| [ET-SEC-24](#et-sec-24) | P2 | Two reapers expire the same capture drafts; the API sweep writes EXPIRED events for all selected rows, not only those it transitioned | SOURCE_PROVEN_DEFECT |
| [ET-SEC-34](#et-sec-34) | P3 | Dead exported legal-hold query helpers with optional teamId spread (would be unscoped if ever called) | SOURCE_PROVEN_DEFECT |
| [ET-SEC-35](#et-sec-35) | P3 | Integrity snapshot writes misleading booleans from status (MATERIALS_AVAILABLE => hash/signature/custody true; OTS matches true by status) — no reader; web library labels FAILED_HASH_MISMATCH 'Status not recorded' | SOURCE_PROVEN_DEFECT |

## 21. Security and tenant-boundary findings

Refuted at the source (and the enumeration case at runtime): cross-tenant upload, finalization, report, package and recovery; intake link rebinding; external-reviewer scope escape; worker trust in payload tenant ids; Prisma `teamId: undefined` holes on lifecycle routes. Confirmed: the NULL-team case link read (ET-SEC-09, P0) and the detach workspace escape (ET-SEC-02, P0) — both runtime; stale standing authority for expired members, suspended orgs, case grants and former creators (ET-SEC-03/04/05); cross-workspace relationship metadata (ET-SEC-07); creation authorized by membership status without `evidence.create` (ET-ACQ-01); extension OAuth fail-open (ET-DC-04); redaction derivative downloads outside the byte-release gate (ET-SEC-26); a persisted exchange-package signed URL returned to readers (ET-SEC-19).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-SEC-02](#et-sec-02) | P0 | Detaching evidence from its last case sets Evidence.teamId=NULL, moving workspace evidence into the creator's personal scope (escapes workspace/case holds, admins lose access, creator keeps bytes after revocation) | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-SEC-09](#et-sec-09) | P0 | NULL-team case can link another user's NULL-team evidence via /v1/cases/:id/evidence-links (no ownership check), and matter workspace then reads it without tenant predicate | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-SEC-03](#et-sec-03) | P1 | Legacy read gate and the byte-release gate's membership lookup ignore access expiry and organization lifecycle: expired members and members of SUSPENDED/ARCHIVED organizations can read, write collaboration content and download originals/reports/packages | SOURCE_PROVEN_DEFECT |
| [ET-SEC-04](#et-sec-04) | P1 | Stale standing authority: CaseAccess grants and case ownership survive suspension/revocation and are honored without membership re-proof (legacy read gate, case-workspace requireCaseAccess, bulk case status, attach/detach) | SOURCE_PROVEN_DEFECT |
| [ET-SEC-05](#et-sec-05) | P1 | Creator identity alone grants read, write and moderation on workspace-bound evidence after the creator leaves the workspace (contradicts canonical 'creator grants nothing') | SOURCE_PROVEN_DEFECT |
| [ET-SEC-07](#et-sec-07) | P1 | Evidence relationships link records across workspaces; target metadata leaks to the source workspace's readers | SOURCE_PROVEN_DEFECT |
| [ET-SEC-14](#et-sec-14) | P2 | Report regeneration / NEW_VERSION bypasses workspace governance policy (requireReviewBeforeReport, allowReportDownload, template overlay) | SOURCE_PROVEN_DEFECT |
| [ET-SEC-15](#et-sec-15) | P2 | AI categorization run (paid, budget-consuming mutation) gated by legacy READ access only; AI policy evaluated without role/plan inputs | SOURCE_PROVEN_DEFECT |
| [ET-SEC-17](#et-sec-17) | P2 | Case-delete legal-hold check fails OPEN on DB error before hard-deleting the case and detaching all evidence | SOURCE_PROVEN_DEFECT |
| [ET-SEC-19](#et-sec-19) | P2 | Exchange package signed URL (issued behind generate_package + step-up) is persisted and returned to any evidence.read member by list | SOURCE_PROVEN_DEFECT |
| [ET-SEC-25](#et-sec-25) | P2 | API-key upload path bypasses organization-lifecycle denial enforced on the user upload path | SOURCE_PROVEN_DEFECT |
| [ET-SEC-26](#et-sec-26) | P2 | Redaction derivative download presigns bytes outside the canonical byte-release gate (no legal-hold/export-eligibility evaluation) | SOURCE_PROVEN_DEFECT |
| [ET-SEC-31](#et-sec-31) | P3 | Existence oracles: 404-vs-403 on case access, capture sessions, cases evidence attach, evidence create with foreign teamId; public verify 409 exposes status of unfinalized records | SOURCE_PROVEN_DEFECT |
| [ET-SEC-32](#et-sec-32) | P3 | Annotation PATCH accepts any evidencePartId (no ownership check, unlike POST) | SOURCE_PROVEN_DEFECT |
| [ET-SEC-33](#et-sec-33) | P3 | Caller-supplied caseId/evidenceId on intake links and evidence requests stored without tenant validation (dangling foreign references copied to webhooks) | SOURCE_PROVEN_DEFECT |

## 22. Concurrency/idempotency findings

Sound under concurrency (source, runtime where marked): double finalize (advisory lock + status claim); double recovery/report/package requests (unique idempotency + reservation, runtime); last-credit consumption (conditional decrement + unique evidence id); OTS double upgrade (claim on proof state). Check-then-write races found: legal hold vs destruction (ET-SEC-01, P0, runtime); restore vs destruction claim (ET-SEC-06); discard vs completion (ET-DC-01); FREE admission (ET-ACQ-06, runtime); intake one-time link use and per-session evidence creation (ET-INT-09); lifecycle writers updating WHERE id only (ET-SEC-12); report commit overwriting FAILED_HASH_MISMATCH (ET-SM-02); storage capacity check outside the lock (ET-SEC-28); report lease without fencing (ET-SEC-30); exchange-package lease expiry overwrite (ET-SEC-27).

| id | sev | title | disposition |
|---|---|---|---|
| [ET-SEC-01](#et-sec-01) | P0 | Destruction executor decides eligibility from a legal-hold boolean computed BEFORE its claim; a hold placed mid-execution does not stop byte deletion + certificate | SOURCE_AND_RUNTIME_PROVEN_DEFECT |
| [ET-SEC-06](#et-sec-06) | P1 | Restore-from-trash 'succeeds' (200 + EVIDENCE_RESTORED custody) while the destruction executor holds its claim; executor then tombstones the restored record | SOURCE_PROVEN_DEFECT |
| [ET-SEC-11](#et-sec-11) | P2 | Repeat /complete on a REPORTED record returns without alreadyFinalized, re-running the one-time fan-out (duplicate EVIDENCE_COMPLETED custody event, evidence.completed webhook, malware scan, post-finalize) | SOURCE_PROVEN_DEFECT |
| [ET-SEC-12](#et-sec-12) | P2 | Archive/trash/restore/unarchive are check-then-write: read + hold evaluation outside the transaction, write by id only, no lock | SOURCE_PROVEN_DEFECT |
| [ET-SEC-13](#et-sec-13) | P2 | completeUploadSession can move an ABORTED session to COMPLETED (write guard only excludes COMPLETED) | SOURCE_PROVEN_DEFECT |
| [ET-SEC-27](#et-sec-27) | P2 | Exchange-package build race after 30-min lease expiry: late builder overwrites fixed object key after the winner committed READY with its sha; failure path unconditionally marks build FAILED | SOURCE_PROVEN_DEFECT |
| [ET-SEC-28](#et-sec-28) | P3 | Storage capacity check runs outside the capacity advisory lock; two finalizes in one workspace can both pass | SOURCE_PROVEN_DEFECT |
| [ET-SEC-29](#et-sec-29) | P3 | Package commit sets evidence verificationPackageVersion without monotonic guard; package-only recovery of an older version regresses the pointer | SOURCE_PROVEN_DEFECT |
| [ET-SEC-30](#et-sec-30) | P3 | Report request lease has no fencing token; a late worker's markRequestRetryable/terminal write overwrites the re-claimer's PROCESSING row | SOURCE_PROVEN_DEFECT |

## 23. Proven runtime cases

Ten probes, one final full run (8 vitest files / 14 cases passed + 2 standalone probes). Results are machine-readable in `runtime/results/`; the harness's own network ledger recorded 57 outbound attempts, all to 127.0.0.1. Every probe calls production code unmodified; fixture shortcuts are declared in each probe's header.

### RT-TSA — RFC3161 acceptance without signature verification

- **Source claim:** TSA-01/02/03: acceptance is `openssl ts -reply -text` + parseTsaReply; nothing verifies signature or chain.
- **Fixture:** throwaway self-signed TSA minted in a temp dir (never written to the repo); three replies: forged-granted, mismatch, granted-no-token
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh tsa`
- **Expected:** an untrusted token must not be STAMPED
- **Actual:** forged-granted -> STAMPED (openssl ts -verify REFUSED: self-signed); mismatch -> FAILED tsa_message_imprint_mismatch; granted-no-token -> openssl refuses to decode -> FAILED
- **Result:** TSA-01 DEFECT REPRODUCED; imprint-mismatch rejection CORRECT; TSA-02 concrete exploit REFUTED on OpenSSL 3.5.4
- **Cleanup:** temp dir removed in finally

### RT-OTS-QUEUE — OTS upgrade ladder on real BullMQ

- **Source claim:** OTS-01/02
- **Fixture:** real BullMQ queue on disposable Redis; production enqueueCanonicalJob + UPGRADE_OTS registry entry loaded from the built @proovra/shared the worker imports
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh ots`
- **Expected:** a follow-up job is scheduled after every hop
- **Actual:** init path: {enqueued:true, collapsed:true}, 1 hop, 0 scheduled; ladder: 3 hops then hop-3 add targets a retained completed id, reported enqueued:true, 0 scheduled
- **State before/after:** queue obliterated after each scenario
- **Result:** OTS-01 and OTS-02 DEFECTS REPRODUCED
- **Cleanup:** queue.obliterate + connections closed

### RT-VERIFY — Public Verify disclosure, states, headline

- **Source claim:** CUSTODY-01, SEC-10, Verify pending/failed states, anti-enumeration
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); genuinely Ed25519-signed records; real legal hold place/release
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration RT-VERIFY`
- **Expected:** no internal hold text on the anonymous page; FAILED/PENDING never shown as verified; a tampered signature never headlined as verified; uniform 404
- **Actual:** hold title, internal release note and actor ids disclosed; TSA FAILED/OTS PENDING rendered honestly; after signature tamper headline 'Core Integrity Verified' with signatureValid:false; unknown/malformed ids 404 no-store
- **Result:** CUSTODY-01 and SEC-10 DEFECTS REPRODUCED; states and enumeration CORRECT
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

### RT-TENANCY — Cross-user link, workspace escape, hold vs destruction

- **Source claim:** SEC-09, SEC-02, SEC-01
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); legacy NULL-team case/evidence rows seeded for SEC-09 (declared); in-memory honest storage port for SEC-01
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration RT-TENANCY`
- **Expected:** cross-user read refused; detach keeps the record in its workspace; an active hold stops destruction
- **Actual:** SEC-09 404 -> 200 after link; SEC-02 teamId NULL, admin 200 -> 404; SEC-01 DESTROYED with an active hold
- **Result:** three P0 DEFECTS REPRODUCED
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

### RT-UPL — Part injection into a sealed record

- **Source claim:** UPL-01
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); SIGNED record owned by the team OWNER; actor = team MEMBER
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration UPL-01`
- **Expected:** session creation or bridge refuses a SIGNED record the actor does not own
- **Actual:** all six calls succeeded; evidence_parts 1 -> 2; worker composite != fileSha256
- **Result:** P0 DEFECT REPRODUCED (report-run consequence source-proven; worker not booted, B6)
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

### RT-COMMERCIAL — FREE cap, race, restore, credit, Stripe ordering

- **Source claim:** FREE three-record rule, concurrent 3rd/4th, COMMERCIAL-02, ACQ-02, one-credit allocation, COMMERCIAL-01
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); harness FREE personal user; credit granted through grantEvidenceCredits (the purchase webhook's service) with a fake provider ref
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration RT-COMMERCIAL`
- **Expected:** cap 3 enforced atomically; restore re-checks the cap; cancellation after reconciliation applies
- **Actual:** race admitted 4; 409 FREE_LIMIT_REACHED thereafter; restore -> 4 active; credit admits the next NEW record only; cancel/past-due refused OBSERVATION_IS_OLDER
- **Result:** COMMERCIAL-01, COMMERCIAL-02, ACQ-02, ACQ-06 DEFECTS REPRODUCED; cap message and credit allocation behaviour CONFIRMED
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

### RT-INTAKE — Intake allowance exhaustion and link burning

- **Source claim:** INT-03, INT-01
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); throwaway intake HMAC secret set in-process; declared fixture step: owner credit set to 0 after links were minted
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration RT-INTAKE`
- **Expected:** an abandoned anonymous session does not consume the owner's allowance; /transition cannot mark SUBMITTED without finalizing
- **Actual:** owner 2 -> 3 and own create 409; session SUBMITTED with no evidence, link EXPIRED, contributor 410
- **Result:** INT-01 and INT-03 DEFECTS REPRODUCED
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

### RT-REPORTS — Reports cards vs rows

- **Source claim:** REPORTS-01 / known risk 'failure visible in table, not in KPI'
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); TEAM workspace; record with Report v1 + FAILED_TERMINAL updated-report request; control record with first-issuance failure
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration REPORTS-01`
- **Expected:** both failures counted in reportsFailed
- **Actual:** reportsFailed 1, reportsReady 1; the v1 record's row READY + ESCALATED_TO_OPERATOR
- **Result:** DEFECT REPRODUCED
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

### RT-RECOVERY — Recovery double-click

- **Source claim:** Recovery idempotency (section 13 Q15-17)
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); REPORTED record with Report v1 and a failed package request
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration double-click`
- **Expected:** one request row, no new report, no credit
- **Actual:** same requestId for concurrent calls; one QUEUED VERIFICATION_PACKAGE request; reports 1; credit ledger 0
- **Result:** CORRECT
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

### RT-FREE-PRO — Existing FREE records after upgrade

- **Source claim:** FREE -> PRO (section 15)
- **Fixture:** disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger); FREE user with records signed 1 and 10 days ago; syncPlanForSubscription with a fake ACTIVE Stripe subscription and an injected no-op superseded-canceller
- **Command:** `bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh integration "existing FREE records"`
- **Expected:** records preserved; outputs become available
- **Actual:** both records NOT_INCLUDED -> ELIGIBLE_NOT_GENERATED with a GENERATE action; the upgrade itself created 0 reports and 0 requests
- **Result:** CONFIRMED (automatic first issuance is the worker's 7-day rule; source-proven)
- **Cleanup:** docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures

## 24. Blocked external proofs

Items whose full proof needs an external system or a capability the audit may not add. For each, the source evidence still established and the proof that would close it:

- **B1** DC-01 discard-vs-complete race — blocker: a deterministic interleave requires a pause point inside completeEvidence after its entry checks; the product exposes none and the audit may not add one. Attempted: source trace of both lock keys and the claim predicate. Established from source: different advisory-lock keys; finalize claim lacks deletedAt; bound:true regardless of claim count. Future proof: remediation adds the shared lock + predicate; an injected-delay test then proves discard cannot interleave
- **B2** Package staging on the real Object Lock bucket (Sentry 150024171 class) — blocker: MinIO accepts checksum-less PUTs on a lock bucket; AWS does not. Attempted: none against AWS (Production forbidden). Established from source: staging PUT carries no checksum (package answer 10.8 records the current path). Future proof: staging-account Object Lock bucket run
- **B3** OTS calendar upgrade and Bitcoin attestation verification — blocker: no .ots fixtures in the repo; calendars and a Bitcoin node are external. Attempted: queue-ladder proof on BullMQ (RT-OTS-QUEUE). Established from source: anchors are PROOF_STRUCTURE from offline `ots info`; badge says CHAIN NOT CHECKED (OTS answers 7.13-7.16). Future proof: recorded calendar responses + a regtest node
- **B4** Behaviour against the production TSA provider — blocker: TSA credentials/provider are Production. Attempted: local untrusted TSA (RT-TSA) exercising the exact acceptance path. Established from source: no signature/chain/nonce/policy validation exists in code. Future proof: provider sandbox token + openssl ts -verify with the provider chain
- **B5** COMMERCIAL-01 end to end with real Stripe webhook timing — blocker: Stripe Production/sandbox not contacted. Attempted: production decision function with the exact stamps (RT-COMMERCIAL). Established from source: cancellation and past-due refused as OBSERVATION_IS_OLDER. Future proof: Stripe test-mode subscription + reconciliation sweep + deleted webhook
- **B6** Worker-side execution (report run after injection; first-issuance sweep) — blocker: the worker boots through its own env loader (services/worker/src/env-loader.ts) which may read services/worker/.env; the audit did not find an audited hermetic worker launcher equivalent to dev-admin-fixture-api.mjs and refused to boot it. Attempted: the consequence computed with the worker's own composite rule (RT-UPL) and the upgrade projection via the API (RT-FREE-PRO). Established from source: processor.ts:2367 rule and first-issuance-reconciliation.ts windows (source). Future proof: a hermetic worker harness, then run processReport over the injected record
- **B7** Production value of EXTENSION_OAUTH_REDIRECT_ALLOW (DC-04) — blocker: the audit never reads production configuration. Attempted: code path read. Established from source: unset => any chromiumapp.org id accepted. Future proof: owner confirms the variable is set

## 25. Owner decisions

Behaviour that is deterministic in code but whose product-correctness is a policy choice:

- **OD-1** Which evidence should a purchased credit fund? — Today the credit is never applied retroactively: it funds the next NEW record that completes over the plan allowance, chosen deterministically by (createdAt,id). The three existing FREE records stay NOT_INCLUDED. Deterministic, but a user who bought a credit 'for' an existing record gets nothing for it. **Recommendation:** Keep credits unallocated in the canonical per-user ledger; let the user explicitly choose the record (and bind evidenceId on an evidence-specific checkout); reserve transactionally; consume at the billable milestone; release on failure by class. Never allocate by array order.
- **OD-2** Should records older than 7 days get outputs automatically after an upgrade? — OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED defaults OFF; after upgrade older records show a GENERATE action (RT-FREE-PRO) but are not issued automatically. **Recommendation:** Decide explicitly; if manual, say so in the upgrade confirmation.
- **OD-3** May a PAST_DUE_EXPIRED account create evidence under the FREE allowance or with purchased credits? — COMMERCIAL-04: today it cannot create anything, which is stricter than FREE. **Recommendation:** Allow FREE-equivalent + credit-funded creation; block only paid features.
- **OD-4** How strong must the binding between a direct-capture mode and the capturing client be? — DC-03: any bearer can open any DIRECT_* mode. **Recommendation:** At minimum an adapter-scoped token per mode, plus a CLIENT_NOT_VERIFIED limitation when absent.
- **OD-5** Which TSA trust anchors are acceptable, and must test and production TSAs be separated by configuration? — TSA answer 6.24; no trust store exists. **Recommendation:** Pin the provider chain; refuse STAMPED without `ts -verify` success; refuse non-https TSA_URL in production.
- **OD-6** How should TSA and OTS disagreement be presented? — OTS answer 7.19. **Recommendation:** Show each layer's own status; never merge into one 'anchored' claim.
- **OD-7** Which bytes does a package contain for redacted evidence? — Package answer 10.10. **Recommendation:** Decide per audience; record the choice in the manifest.
- **OD-8** Is the permanent evidence UUID acceptable as the public verify capability? — PKGV-07 / package answers 11.1-11.2: no expiry, rotation or per-recipient revocation; SEC-09 shows how a known UUID can be leveraged. **Recommendation:** Introduce revocable, rotatable verify tokens distinct from the primary key.
- **OD-9** Should an output earned under PRO survive a downgrade that lands before the job runs? — Commercial answers 15.5 / security 20.7. **Recommendation:** Bind entitlement to the completion-time funding fact (as credits already are).
- **OD-10** How must custody attribute machine actions triggered by a person? — Custody answer 5.8. **Recommendation:** Record initiator and executor separately.

## 26. Ordered remediation backlog

Ordered by evidentiary risk, grouping findings that share a fix:

1. **ET-SEC-10, ET-TSA-01, ET-TSA-03, ET-PKG-05, ET-PKG-06** — Verification truth first: headline only from live checks; verify RFC3161 tokens (signature, chain, nonce, policy) before STAMPED; persist the parsed imprint; derive package/storage badges from verification, not presence.
2. **ET-UPL-01, ET-INT-05, ET-UPL-02** — One guarded EvidencePart writer (owner/intake principal, CREATED|UPLOADING, not locked/held/deleted, under the evidence lock); worker ignores NULL-uploadedAt parts; production scan for stray parts on sealed records.
3. **ET-SEC-09, ET-SEC-02, ET-SEC-03, ET-SEC-04, ET-SEC-05** — Tenancy: owner check on NULL-team case links; never NULL teamId on detach; route every read through the canonical access engine (expiry, org lifecycle, membership re-proof).
4. **ET-SEC-01, ET-SEC-06** — Executor re-reads holds inside its claim; restore refuses PENDING_DESTRUCTION.
5. **ET-CUS-01, ET-PKG-09** — Allow-list public custody summaries; never print raw payload fields; minimise anonymous-view writes.
6. **ET-OTS-01, ET-OTS-02, ET-OTS-03, ET-REC-02** — Pass selfJobId on the init branch; make follow-up ids unique per hop; add a PENDING-without-job sweep and a closable terminal incident.
7. **ET-COM-01, ET-COM-03, ET-COM-02, ET-COM-04** — Stamp providerStateAtUtc with a provider event time, not period end (backfill stamped rows); handle Stripe credit refunds/disputes; cap check on restore; decide OD-3.
8. **ET-PKG-01, ET-PKG-02, ET-PKG-03, ET-PKG-04, ET-TSA-04, ET-TSA-05** — Make packages independently verifiable: ship hash-consistent custody payloads, publish the seal key fingerprint, document the seal in README, fix the TSA digest documentation.
9. **ET-INT-01, ET-INT-03, ET-INT-02, ET-INT-04, ET-ACQ-02** — Intake: SUBMITTED only via /submit; unfinalized records do not consume allowance (or expire); part replace/remove; follow-up links attach to the request; reap abandoned rows.
10. **ET-DC-01, ET-DC-02, ET-DC-03** — Direct capture truth: shared lock + deletedAt predicate; open sessions before capture and enforce the window; bind mode to client (OD-4).
11. **ET-RPT-01, ET-RPT-02, ET-REC-03, ET-REC-04** — Reports KPIs count request-level failures and blocks; recovery for NULL-team personal records; mobile sends the required reason.
12. **ET-SM-02, ET-SEC-12, ET-SM-03, ET-SM-07** — State writers: WHERE-guarded transitions everywhere; version-pinned byte access on every path; integrity re-hash independent of report entitlement.
13. **ET-CUS-04, ET-CUS-02, ET-CUS-03, ET-CUS-11** — Custody durability: DB-enforced append-only, keyed chain; custody written in the mutation transaction; fix the chain-transfer event type.
14. **ET-Q-03, ET-Q-04, ET-Q-05, ET-Q-06** — Queue hygiene: terminal states for non-OCR intelligence runs, redaction reclaim, trash sweep cursor, workers start after bootstrap.

## Final answers

**Is capture-to-verify correct?**

No. The capture → hash → sign → finalize core is correct, but six P0 defects (all runtime-reproduced) break integrity, tenancy, legal hold and verification truth, and the OTS layer never completes.

**Are original bytes protected?**

Partly. The original object is never overwritten once hashed and is version-pinned for re-hash and download, and Object Lock applies when enabled. But a same-workspace member can add foreign bytes to a sealed record (ET-UPL-01), and the destruction executor deletes originals under an active hold (ET-SEC-01).

**Are hashes trustworthy?**

Yes as computed: server SHA-256 over the stored version; client digests are never trusted. The published multipart TSA digest is documented inconsistently (ET-TSA-05).

**Is custody complete?**

Core events are complete and transactional; custody is not DB-enforced append-only, some governance events are best-effort, and the public page leaks custody payloads (ET-CUS-01).

**Is report generation truthful?**

Mostly: version-bound and honest about pending TSA/OTS, but it prints 'Legal Hold: OFF' under an active hold (ET-RPT-03).

**Is the package independently verifiable?**

Only partially: hash and evidence signature yes (key authenticity still needs PROOVRA); custody chain no (ET-PKG-01); seal key self-asserted (ET-PKG-02).

**Is TSA cryptographically validated?**

No. No signature/chain/nonce/policy check; a forged self-signed token was stored STAMPED (ET-TSA-01, runtime).

**Is OTS correctly upgraded and verified?**

No. Newly stamped proofs are never upgraded (ET-OTS-01/02, runtime); Bitcoin attestation is not chain-checked (disclosed honestly on the badge).

**Is Recovery safe and idempotent?**

Yes for reports and packages (runtime: one request, no new version, no charge). OTS resume reports QUEUED when it did nothing (ET-REC-01/06); TSA has no recovery by design.

**Are Reports KPIs truthful?**

Not fully: a failed updated-report request is counted as ready and missing from 'Reports failed' (ET-RPT-01, runtime); blocked requests are uncounted (ET-RPT-02). A failed summary read never shows zeros.

**What exactly happens to a FREE user's first three evidence records?**

Each is admitted at creation, hashed, signed, RFC3161-timestamped and OTS-stamped at completion, funded by the plan allowance, and gets no report or package (NOT_INCLUDED). A slot is held from creation whether or not the upload finishes.

**What happens to the fourth?**

Refused at creation with 409 FREE_LIMIT_REACHED and the Free-plan message (runtime) — unless a credit exists, in which case it is admitted and the credit is spent at its completion. Concurrent creation at 2/3 can admit a 4th row, which completion settlement then refuses with 402.

**What happens after upgrading to PRO?**

Existing records are preserved and become eligible (GENERATE action, runtime); outputs are issued automatically only for records signed within 7 days of activation (default configuration); older ones need a click. No new versions are created; TSA/OTS already ran.

**If one credit is purchased, which evidence receives it and why?**

None of the existing records. The next NEW record that completes beyond the plan allowance consumes it, chosen deterministically by (createdAt, id), because consumption happens only inside a completion transaction. Product-correctness is OD-1.

**What happens on processing failure?**

Report/package: request moves to FAILED_RETRYABLE (bounded retries) or FAILED_TERMINAL with an incident; recoverable from the UI; no charge. TSA failure is permanent by design. OTS failure is persisted per record; OTS pending can stall forever (ET-OTS-03).

**What happens on retry?**

Idempotent for reports/packages (same request, same version, no charge — runtime). Intake parts cannot be retried after a failed PUT (ET-INT-02); resumable sessions cannot be retried after abort (ET-UPL-02).

**What happens on downgrade/refund?**

Evidence is never destroyed; downloads remain; new captures are capped; paid-for jobs re-check entitlement. Stripe credit refunds are not reversed (ET-COM-03), and a Stripe cancellation can be ignored after reconciliation (ET-COM-01, runtime).

**Are there duplicate authorities?**

Yes — two EvidencePart writers, five backlog aggregators, two case-link authorities, two draft reapers and two storage populations are real competing authorities; the rest are projections or dead code (inventory).

**Are there cross-tenant defects?**

Yes: a legacy personal case can read another user's record (ET-SEC-09, runtime) and case detach moves workspace evidence into a personal scope (ET-SEC-02, runtime). Direct cross-tenant upload/finalize/report/package/recovery were refuted.

**What must be fixed first?**

Verification truth (ET-SEC-10, ET-TSA-01/03), the part-injection writer (ET-UPL-01), the two tenancy P0s (ET-SEC-09, ET-SEC-02), hold-vs-destruction (ET-SEC-01), the public custody leak (ET-CUS-01), then the OTS ladder and the Stripe ordering stamp. See the ordered backlog.

## Conservation gates

| # | gate | status | detail |
|---|---|---|---|
| 1 | Every acquisition path is dispositioned | PASS | acquisition 10 = 7 mapped + 2 retired + 1 blocked; plus 9 upload/integration, 6 direct-capture and 6 intake paths each dispositioned in inventories |
| 2 | Every evidence state is defined | PASS | all EvidenceStatus values and lifecycleState values defined (statemachine.evidenceLifecycleColumns); UPLOADED recorded as dead |
| 3 | Every transition has an authority | PASS | statemachine.evidenceStatusTransitions names the writer file:line of every transition; unguarded ones are findings ET-SM-02, ET-SEC-12 |
| 4 | Every material DB writer is inventoried | PASS | statemachine.evidenceDbWriters / evidencePartDbWriters (3 EvidencePart writers), custody.custodyAppenders, custody.auditWriters |
| 5 | Every storage writer is inventoried | PASS | statemachine.storageWriters |
| 6 | Every queue producer maps to a consumer | PASS | all producers map to a consumer except report-dlq, which is a documented DLQ sink (queues.conservationTotals) |
| 7 | Every consumer maps to a producer or documented schedule | PASS | 19 sweeps scheduled; 5 consumers without a producer and media-intelligence-dlq dispositioned as defect ET-Q-07/ET-Q-08 |
| 8 | Every report/package status has one authoritative meaning | PASS | reports.reportRequestStates maps every persisted state to its writer and meaning; mis-projections recorded as ET-RPT-01/02 |
| 9 | Every Recovery action maps to specific failed components | PASS | recovery.failureRecoveryMatrix |
| 10 | Every TSA state maps to persisted evidence | PASS | tsa.stateMapping / persistedColumns; collisions recorded as ET-TSA-06 |
| 11 | Every OTS state maps to persisted evidence | PASS | ots.otsStateMap (12 persisted states with writer and display) |
| 12 | Every visible Reports KPI maps to authoritative data | PASS | reports.reportsPageFields + reports.reconciliation (runtime RT-REPORTS) |
| 13 | FREE limit behaviour is answered completely | PASS | commercial 14.1-14.6 + section 16 (runtime RT-COMMERCIAL, RT-INTAKE) |
| 14 | FREE -> PRO behaviour is answered completely | PASS | commercial 15.1-15.5 + section 17 (runtime RT-FREE-PRO) |
| 15 | Credit allocation behaviour is answered completely | PASS | commercial 16.1-16.2 + section 18 (runtime RT-COMMERCIAL); product policy is OD-1 |
| 16 | Downgrade/refund behaviour is answered | PASS | commercial 17.1-17.5 (17.5 corrected by the lead from 'not reviewed in depth' to a verified answer) |
| 17 | Every duplicate authority is dispositioned | PASS | security.duplicateAuthorities + section 20 |
| 18 | Every high-risk finding has runtime proof or a precise blocker | PASS | all 6 P0 runtime-reproduced; every section-21 item exercised (cross-tenant, FREE 3, concurrent 3rd/4th, FREE->PRO, one credit, report/package failed projection, recovery idempotency, TSA malformed/mismatched, OTS ladder, Reports KPI/table, Verify states); OTS proof-upgrade/attestation and worker-side runs carry precise blockers B3/B6; P1s not runtime-exercised are labelled as such in their own records |

## Findings register

### ET-CUS-01

**P0 · customer data exposure / public verify · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Public Verify shows internal legal-hold notes, hold titles, publication/suspension reasons and actor user IDs to anonymous viewers

- **Affected:** routes: GET /v1/public/verify/:id (evidence.routes.ts:12254), GET record view (evidence.routes.ts:9402); pages: apps/web/app/verify/[token]/page.tsx; tables: custody_events; roles: anonymous public viewer; plans: any plan with legal hold / publication governance
- **Evidence:** `services/api/src/services/governance/legal-hold.service.ts:503`, `services/api/src/services/governance/legal-hold.service.ts:336`, `services/api/src/services/governance/publication.service.ts:212`, `services/api/src/routes/evidence.routes.ts:2093`, `services/api/src/routes/evidence.routes.ts:2121`, `packages/shared/src/custody.ts:3`, `services/api/src/routes/evidence.routes.ts:13843`, `apps/web/app/verify/[token]/page.tsx:1047`
- **Citations:** 8/8 resolve in the audited tree
- **Observed:** summarizePublicPayload has explicit cases for about 25 event types. Every other type (LEGAL_HOLD_PLACED/RELEASED, CASE_LEGAL_HOLD_*, PUBLIC_VERIFY_*, DELETE_BLOCKED_*, EXPORT_BLOCKED_BY_POLICY, RETENTION_*, CAPTURE_TRUST_EVENT, investigation events) falls to a DENYLIST default. That default prints up to 5 string, number or boolean payload fields as 'key: value', masking only emails. Keys such as releaseNoteInternal, reasonInternal, title, placedByUserId, releasedByUserId, actorUserId and deviceId pass the filter.
- **Expected:** Per the code's own comments ('Release note is INTERNAL ... never surfaced on public verify', 'The public verify route NEVER returns this value'), internal governance text and actor identifiers should never reach the public projection. The default should be an allow-list or a fixed generic label.
- **Data flow:** legal-hold.service.ts:497 fanOutCustodyEvents(payload incl. releaseNoteInternal) -> custody_events.payload (jsonb) -> public verify findMany (12753) -> forensic filter -> mapPublicCustodyEvent (4412) -> summarizePublicPayload default branch -> custodyLifecycle.forensicEvents[].payloadSummary -> verify page renders it.
- **Root cause:** Payload summarisation uses a denylist default, and governance emitters put free text into custody payloads under keys the denylist does not know.
- **Blast radius:** Every PUBLISHED evidence record that has ever had an EVIDENCE-scope or CASE-scope (up to 1000 records) legal hold placed or released, or a publish/unpublish/suspend with a reason. A suspended record exposes its suspension reason once it is restored.
- **Impact:** Anyone holding the public verify link can read litigation hold titles (for example a matter name), up to 4000 characters of internal release notes, internal suspension or unpublish reasons, and internal user UUIDs.
- **Reproduction:** 1) Publish evidence E. 2) Place an EVIDENCE-scope legal hold titled 'Smith v Acme - privileged', then release it with note 'Counsel advised release after settlement'. 3) GET /v1/public/verify/E with no auth. custodyLifecycle.forensicEvents contains payloadSummary 'scope: EVIDENCE • title: Smith v Acme - privileged • legalHoldId: ... • placedByUserId: <uuid>' and 'releaseNoteInternal: Counsel advised release after settlement'.
- **Runtime evidence:** RT-VERIFY/CUSTODY-01 (rt-verify-custody01.json): a real legal hold placed and released through placeCanonicalLegalHold/releaseCanonicalLegalHold; an anonymous GET /public/verify/:id (no Authorization) returned 200 with payloadSummary 'title: ET-CONFIDENTIAL-MATTER-… v. Acme • placedByUserId: …' and 'releaseNoteInternal: ET-INTERNAL-ONLY settlement discussed with counsel …'.
- **Recommended remediation:** Make the default branch return a fixed label per event type with no payload echo. Add explicit safe cases for the governance events that say only what happened ('Legal hold placed'). Never place free text in custody payloads that reach public projections, or strip *Internal / *Note / title / *UserId keys at the projection boundary via an allow-list.
- **Acceptance proof:** Integration test: every CustodyEventType value, given a payload containing sentinel strings under arbitrary keys, produces a public payloadSummary containing no sentinel.
- **Migration/backfill:** none (projection-only fix; historical payloads stay sealed in the chain)
- **Dependency:** none
- **Lead verification:** Lead re-read evidence.routes.ts:2093-2125 (default branch prints up to 5 string fields, masking only emails) and :12753 (all custody events, take 500, feed the public summarizer). Then runtime-reproduced.
- **Owner decision:** Confirm whether governance events (legal hold, publication) should appear on the public timeline at all.

```text
services/api/src/services/governance/legal-hold.service.ts:503  releaseNoteInternal: note.slice(0, 4000),
services/api/src/services/governance/legal-hold.service.ts:336  title: hold.title, ⏎     placedByUserId: input.actorUserId,
services/api/src/services/governance/publication.service.ts:212  // The public verify route NEVER returns this value. ⏎       reasonInternal: reason,
services/api/src/routes/evidence.routes.ts:2093  default: { const safeEntries = Object.entries(obj) .filter(([key, value]) => { const lowered = key.toLowerCase();
services/api/src/routes/evidence.routes.ts:2121  `${key}: ${maskPublicEmailsInText(String(value))}`
packages/shared/src/custody.ts:3  const ACCESS_CUSTODY_EVENT_TYPES = new Set<string>([ "VERIFY_VIEWED", ... ]) // everything else is 'forensic'
services/api/src/routes/evidence.routes.ts:13843  custodyLifecycle,
apps/web/app/verify/[token]/page.tsx:1047  {cleanSummary ?? "No additional event summary provided."}
```

### ET-SEC-01

**P0 · concurrency/legal-hold · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Destruction executor decides eligibility from a legal-hold boolean computed BEFORE its claim; a hold placed mid-execution does not stop byte deletion + certificate

- **Affected:** routes: legal hold placement routes; jobs: destruction-orchestrator, trash-grace, retention; tables: evidence, evidence_legal_holds, destruction_executions
- **Evidence:** `services/worker/src/governance/destruction-orchestrator.worker.ts:169`, `services/worker/src/governance/destruction-orchestrator.worker.ts:244`, `packages/shared-runtime/src/evidence-destruction/executor.ts:318`, `packages/shared-runtime/src/evidence-destruction/executor.ts:400`, `packages/shared-runtime/src/evidence-destruction/executor.ts:471`, `packages/shared-runtime/src/evidence-destruction/executor.ts:608`, `services/api/src/services/governance/legal-hold.service.ts:295`
- **Citations:** 7/7 resolve in the audited tree
- **Observed:** The hold verdict is read by the caller (orchestrator :169, also processor.ts:5668/5688, destruction-review.service.ts:658/670, destruction-governance.service.ts:579/590) and passed as a boolean. The executor re-reads the evidence row after its claim but never re-reads evidence_legal_holds. placeCanonicalLegalHold only verifies the tenant (:264-286) and inserts; it neither checks lifecycleState PENDING_DESTRUCTION nor takes any lock shared with the executor. The S3 object-lock legal-hold backstop (executor :446-462) only reacts to object-level holds, which application holds do not set.
- **Expected:** A hold committed before bytes are deleted must block destruction (re-evaluate effective hold inside/after the claim, or serialize hold placement against PENDING_DESTRUCTION).
- **Data flow:** orchestrator reads holds -> executeEvidenceDestruction(legalHold=false) -> claim -> computeEvidenceDestructionEligibility(input.legalHold) -> S3 list/delete all versions -> tombstone + EVIDENCE_PURGED + certificate
- **Root cause:** TOCTOU: hold is an input parameter rather than re-read under the claim.
- **Blast radius:** Every destruction entry point (4 callers) for WORKSPACE evidence.
- **Impact:** Original evidence under an active legal hold is irreversibly destroyed and a destruction certificate is issued.
- **Reproduction:** 1) Evidence E trashed with grace expired. 2) Pause orchestrator after gatherDestructionFacts. 3) Place EVIDENCE hold on E (succeeds 200). 4) Resume: executor deletes all versions and tombstones E.
- **Runtime evidence:** RT-TENANCY/SEC-01 (rt-tenancy-sec01.json): TRASHED record past grace; 0 active holds when facts were gathered, 1 ACTIVE hold (placed through the production service) when executeEvidenceDestruction ran with the pre-hold verdict; result ok:true outcome DESTROYED, the original's only version deleted, destroyedAtUtc set, certificate issued. Storage was an honest in-memory port; the DB decision path is the production executor.
- **Recommended remediation:** Inside the executor, after the claim and immediately before the first delete, call evaluateEffectiveLegalHold(tx) and release the claim if held; make placeCanonicalLegalHold refuse (or flag) when lifecycleState='PENDING_DESTRUCTION' with a live claim, under the same pg_advisory_xact_lock(evidenceId).
- **Acceptance proof:** Concurrency test above returns BLOCKED/LEGAL_HOLD_ACTIVE and bytes remain.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read executor.ts:289-400 (claim, reload, eligibility with input.legalHold) and destruction-orchestrator.worker.ts:169/244 (facts gathered before the call). Then runtime-reproduced.

```text
services/worker/src/governance/destruction-orchestrator.worker.ts:169  const facts = await gatherDestructionFacts(review.evidenceId);
services/worker/src/governance/destruction-orchestrator.worker.ts:244  legalHold: facts.hasActiveDirectHold || facts.hasActiveCaseHold,
packages/shared-runtime/src/evidence-destruction/executor.ts:318  const claim = await prisma.evidence.updateMany({ where: { id: input.evidenceId, OR: [ { lifecycleState: "TRASHED" }, ...
packages/shared-runtime/src/evidence-destruction/executor.ts:400  legalHold: input.legalHold,
packages/shared-runtime/src/evidence-destruction/executor.ts:471  const res = await storage.deleteObjectVersion({ ...target, versionId: v.versionId });
packages/shared-runtime/src/evidence-destruction/executor.ts:608  await tx.evidence.update({ where: { id: evidence.id }, data: { lifecycleState: "DESTROYED", destroyedAtUtc: now,
services/api/src/services/governance/legal-hold.service.ts:295  const hold = (await client.evidenceLegalHold.create({ data: { teamId: input.teamId, scope, evidenceId, caseId,
```

### ET-SEC-02

**P0 · tenancy/custody · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Detaching evidence from its last case sets Evidence.teamId=NULL, moving workspace evidence into the creator's personal scope (escapes workspace/case holds, admins lose access, creator keeps bytes after revocation)

- **Affected:** routes: POST /v1/evidence/bulk (REMOVE_FROM_CASE), DELETE /v1/cases/:id/evidence/:evidenceId; tables: evidence, case_evidence_links; roles: MEMBER, CONTRIBUTOR, case owner (even SUSPENDED)
- **Evidence:** `services/api/src/routes/evidence.routes.ts:7254`, `services/api/src/routes/cases.routes.ts:1637`, `services/api/src/services/cases/case-evidence-link.service.ts:242`, `services/api/src/routes/cases.routes.ts:1565`, `services/api/src/services/evidence/artifact-download-gate.service.ts:127`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** createEvidence never writes a null teamId (evidence.service.ts:433-439) but both detach paths reset it when the last case link is removed. Bulk REMOVE_FROM_CASE needs only update_metadata on the evidence and performs no case-level authorization (evidence.routes.ts:7236-7262); the single route admits the case owner without re-proving membership (cases.routes.ts:1565). Neither path evaluates an effective legal hold. After the reset, resolveEvidenceRecordAccess applies the personal-owner rule (only ownerUserId), the download gate treats the creator as personal owner (enforceSensitiveAction allows via personalOwnerVerified), and effective-legal-hold.ts:254-275 skips WORKSPACE/CASE holds when teamId is null. The case-workspace detach (case-lifecycle.service.ts:676-697 removeEvidenceLink) does NOT clear teamId: two detach authorities disagree.
- **Expected:** Workspace-bound evidence is never re-scoped to a person by an unlink; tenancy is immutable after creation (or re-scoping requires an explicit, hold-checked, admin-only transfer).
- **Data flow:** bulk ADD_TO_CASE E->C (ACTIVE member suffices, :7134-7141) -> bulk REMOVE_FROM_CASE -> detachEvidenceFromCase -> evidence.teamId=null -> personal-owner authority
- **Root cause:** Legacy 'return to personal pool' UI semantics retained on canonical detach service.
- **Blast radius:** Any workspace evidence reachable by a member holding evidence.update_metadata, or any case owner (including suspended).
- **Impact:** Custody/tenancy corruption: workspace admins get 404 on their own evidence; WORKSPACE/CASE legal holds cease to apply; the creator (possibly a departing/revoked member) retains original/report/package download.
- **Reproduction:** As CONTRIBUTOR U in org workspace T: POST /v1/evidence/bulk {action:ADD_TO_CASE, caseId:C, evidenceIds:[E]} then {action:REMOVE_FROM_CASE, evidenceIds:[E]}; SELECT team_id FROM evidence WHERE id=E -> NULL; admin GET /v1/evidence/E -> 404.
- **Runtime evidence:** RT-TENANCY/SEC-02 (rt-tenancy-sec02.json): POST /v1/cases/:id/evidence (200) then DELETE /v1/cases/:id/evidence/:evidenceId (200) -> Evidence.teamId NULL; the workspace ADMIN's GET /v1/evidence/:id went 200 -> 404 while the creator still reads 200.
- **Recommended remediation:** Remove clearEvidenceTeamIdWhenUnlinked from both routes (delete the option); if personal re-scoping is a product need, make it an explicit owner-decision flow with hold evaluation and admin authority.
- **Acceptance proof:** Detach leaves teamId unchanged; test asserting admin still reads E and holds still apply.
- **Migration/backfill:** Identify evidence with team_id NULL whose owner's personal team exists and custody/audit shows a prior workspace binding (cases.evidence_unlinked audit rows) and restore team binding.
- **Dependency:** none
- **Lead verification:** Lead re-read case-evidence-link.service.ts:236-256 (teamId set NULL when the last link goes). Then runtime-reproduced.

```text
services/api/src/routes/evidence.routes.ts:7254  await detachEvidenceFromCase({ caseId: link.caseId, evidenceId, actorUserId: userId, clearEvidenceTeamIdWhenUnlinked: true,
services/api/src/routes/cases.routes.ts:1637  clearEvidenceTeamIdWhenUnlinked: true,
services/api/src/services/cases/case-evidence-link.service.ts:242  if (input.clearEvidenceTeamIdWhenUnlinked === true) { ... if (!remaining) { await tx.evidence.update({ where: { id: evidence.id }, data: { teamId: null } });
services/api/src/routes/cases.routes.ts:1565  let hasPermission = caseItem.ownerUserId === userId;
services/api/src/services/evidence/artifact-download-gate.service.ts:127  const personalOwner = !teamId && evidenceForGate.ownerUserId === actorUserId;
```

### ET-SEC-09

**P0 · tenancy/data-exposure · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — NULL-team case can link another user's NULL-team evidence via /v1/cases/:id/evidence-links (no ownership check), and matter workspace then reads it without tenant predicate

- **Affected:** routes: POST /v1/cases/:id/evidence-links, GET /v1/cases/:id/matter-workspace, case export; tables: cases, case_evidence_links, evidence
- **Evidence:** `services/api/src/services/cases/case-lifecycle.service.ts:638`, `services/api/src/services/cases/case-permission.service.ts:390`, `services/api/src/services/cases/matter-workspace.service.ts:708`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** case-workspace addEvidenceLink has no evidence-ownership check (cases.routes.ts:1415 has one). NULL-team cases arise when a team is deleted (teams.routes.ts:1378-1381); NULL-team evidence arises from legacy personal rows or SEC-02. Evidence ids appear in public verify URLs.
- **Expected:** Linking requires record access to the evidence (resolveEvidenceRecordAccess) regardless of case team.
- **Data flow:** POST /v1/cases/:id/evidence-links -> requireCaseAccess(owner) -> addEvidenceLink (team check skipped when case.teamId null; NULL===NULL passes) -> case_evidence_links insert -> GET /v1/cases/:id/matter-workspace -> evidence.findMany {id in linked ids} -> title/status returned.
- **Root cause:** addEvidenceLink treats a null case team as 'no constraint' and never checks that the actor can access the evidence; cross-team equality treats null==null as same tenant.
- **Blast radius:** Owners of NULL-team cases (teams deleted) against any user's NULL-team evidence (legacy personal rows or rows produced by SEC-02) whose UUID is known, e.g. from a shared verify URL.
- **Impact:** Metadata (title/status/id) of a victim's personal evidence exposed to an attacker's matter workspace/export; report bytes still gated.
- **Reproduction:** Attacker owns NULL-team case C; POST /v1/cases/C/evidence-links {evidenceId: victim E from verify URL}; GET matter-workspace.
- **Runtime evidence:** RT-TENANCY/SEC-09 (rt-tenancy-sec09.json): attacker (teamB member) GET victim's record 404; POST /v1/cases/:legacyNullTeamCase/evidence-links {victim evidence} 200 (link row created); GET again 200 with the victim's private title. Legacy NULL-team case and evidence rows were seeded (the API no longer mints NULL-team cases).
- **Recommended remediation:** Call resolveEvidenceRecordAccess(actor, evidenceId, 'evidence.update_metadata') in addEvidenceLink.
- **Acceptance proof:** Link attempt returns 404.
- **Migration/backfill:** none
- **Dependency:** Preconditions: NULL-team case and NULL-team evidence exist.
- **Lead verification:** Lead re-read case-lifecycle.service.ts:620-640 (no check when case.teamId is null), case-permission.service.ts:386-396 (null === null allowed), evidence.routes.ts:3018-3045 (legacy read gate grants on linked-case ownership). Then runtime-reproduced. Severity P1 -> P0: Runtime proof RT-TENANCY/SEC-09: a user read another user's private record (404 -> link 200 -> read 200). Cross-tenant access is P0 by the audit's definition; the precondition (legacy NULL-team rows) is stated in the finding.

```text
services/api/src/services/cases/case-lifecycle.service.ts:638  if (existing.teamId && evidence.teamId !== existing.teamId) {
services/api/src/services/cases/case-permission.service.ts:390  if (input.caseTeamId === input.evidenceTeamId) { return { allowed: true }; }
services/api/src/services/cases/matter-workspace.service.ts:708  where: { id: { in: evidenceIds }, deletedAt: null },
```

### ET-SEC-10

**P0 · duplicate-authority/verification · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Public verify headline says 'Core Integrity Verified' from stored flag + materials even when live recompute (hash/signature/custody) fails; snapshot trust decision wins over live checks

- **Affected:** routes: GET /public/verify/:id; pages: web verify/[token], mobile verify
- **Evidence:** `services/api/src/routes/evidence.routes.ts:1698`, `services/api/src/routes/evidence.routes.ts:13122`, `services/api/src/routes/evidence.routes.ts:13133`, `packages/shared/src/trust-decision.ts:655`, `apps/mobile/app/verify.tsx:300`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** mapIntegrityHeadline's second branch ignores overallIntegrity; buildEvidenceTrustDecision takes no live check inputs; the sibling summary (mapIntegritySummaryText :1752) does say checks failed, so the same payload contradicts itself. trust-decision-consistency.service.ts:95 compares snapshot vs live decision only, neither carrying live results.
- **Expected:** Any live check false => headline/verdict REVIEW_REQUIRED, never 'Verified'.
- **Data flow:** GET /public/verify/:id -> live recompute (canonicalHashMatches, signatureValid, custodyChain.valid -> overallIntegrity :13133) -> trustDecision = snapshotTrustDecision ?? liveTrustDecision (:13122) -> mapIntegrityHeadline (branch at :1698 ignores overallIntegrity) -> humanSummary.integrityHeadline -> web/mobile verify render.
- **Root cause:** The headline and the shared trust decision derive 'passed' from the stored verificationStatus flag plus material presence, not from the live cryptographic results, and the stored report snapshot is preferred over the live decision.
- **Blast radius:** Every RECORDED_INTEGRITY_VERIFIED record on the public verify endpoint and the web/mobile verify pages, i.e. every third-party verifier of a tampered record.
- **Impact:** False verification display on the public verify surface after DB tampering of fingerprint/custody (exactly what verify must detect). Borders P0 'false cryptographic verification'; kept P1 because sibling summary and client verdicts show review-required.
- **Reproduction:** Alter fingerprint_canonical_json or a custody event on a RECORDED_INTEGRITY_VERIFIED record; GET /public/verify/:id -> integrityHeadline 'Core Integrity Verified', summary 'did not pass'.
- **Runtime evidence:** RT-VERIFY/SEC-10 (rt-verify-sec10.json): genuine record, live decision core_integrity 'passed', persisted as reports.trust_decision_snapshot; signature then replaced; anonymous verify answered signatureValid:false, overallIntegrity:false, source REPORT_SNAPSHOT, headline 'Core Integrity Verified' (the pre-tamper headline carried a 'Trusted Timestamp Unavailable' qualifier that disappeared).
- **Recommended remediation:** Pass overallIntegrity into mapIntegrityHeadline branch 2 and into buildEvidenceTrustDecision; live failure overrides snapshot.
- **Acceptance proof:** Test with tampered row returns non-verified headline and verdict.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read evidence.routes.ts:1680-1700 (headline from core signal + stored verificationStatus only) and :13124-13137 (snapshot decision wins; overallIntegrity computed separately). Then runtime-reproduced. Severity P1 -> P0: Runtime proof RT-VERIFY/SEC-10: signatureValid:false and overallIntegrity:false while the public headline reads 'Core Integrity Verified'. False cryptographic verification is P0 by the audit's definition.
- **Owner decision:** Lead to decide P0 vs P1 per brief definition of false cryptographic verification.

```text
services/api/src/routes/evidence.routes.ts:1698  if (coreSignal?.status === "passed" && explicitlyVerified) { return "Core Integrity Verified"; }
services/api/src/routes/evidence.routes.ts:13122  const trustDecision = snapshotTrustDecision ?? liveTrustDecision;
services/api/src/routes/evidence.routes.ts:13133  const overallIntegrity = canonicalHashMatches && signatureValid && custodyChain.valid && !timestampLayerBlocksIntegrity && otsHashMatches !== false;
packages/shared/src/trust-decision.ts:655  if (explicitVerified && hasSignatureMaterial) { ... status: "passed"
apps/mobile/app/verify.tsx:300  {v.integrityHeadline ? <ProovraText ...>{v.integrityHeadline}
```

### ET-UPL-01

**P0 · integrity-custody-corruption · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Resumable-upload bridge attaches a new EvidencePart to any same-team evidence — including SIGNED/REPORTED or another member's in-flight record — and the next report run then declares sealed evidence FAILED_HASH_MISMATCH

- **Affected:** routes: POST /v1/uploads/sessions, POST /v1/uploads/sessions/:id/multipart/complete, integrations-uploads multipart routes; jobs: report generation (processor.ts multipart branch); tables: evidence_upload_sessions, evidence_parts, evidences, custody_events; roles: CONTRIBUTOR, REVIEWER, ADMIN, API key with integration.evidence.upload; plans: all with a shared workspace or integrations
- **Evidence:** `services/api/src/services/uploads/upload-session.service.ts:360`, `services/api/src/services/uploads/upload-session.service.ts:1885`, `services/api/src/routes/evidence.routes.ts:5975`, `services/worker/src/processor.ts:2061`, `services/worker/src/processor.ts:2367`, `services/worker/src/integrity-rejection.service.ts:67`
- **Citations:** 4/6 resolve in the audited tree
- **Merged candidates:** uploads:UPL-01, statemachine:STATEMACHINE-01, security:SEC-08
- **Observed:** Session creation proves only that the evidence id exists in the caller's team. The multipart-complete bridge never re-reads the evidence and inserts an EvidencePart (uploadedAtUtc NULL) at the session's targetPartIndex. No DB trigger forbids parts on sealed evidence; the (evidenceId, partIndex) unique key is dodged by an unused index. The report worker enumerates ALL parts unfiltered and recomputes the composite; the extra part makes it differ from evidence.fileSha256 and rejectEvidenceIntegrity moves the record to FAILED_HASH_MISMATCH with a custody rejection event.
- **Expected:** Parts may be added only by the evidence owner (or intake uploader) while the record is CREATED/UPLOADING, not locked, not held, not deleted — the same guards the legacy /v1/evidence/:id/parts route applies — re-checked inside the bridge transaction.
- **Data flow:** POST /v1/uploads/sessions {teamId,evidenceId:E(SIGNED),targetPartIndex:9999} -> initiate -> presign -> PUT -> multipart/complete {verifyHash:true} -> evidence_parts INSERT -> (report/recovery/updated-report run) -> processor multipart rehash mismatch -> evidences.status=FAILED_HASH_MISMATCH + custody INTEGRITY rejection
- **Root cause:** The Phase 30.12 bridge was added as a second EvidencePart writer without the legacy route's state/owner/lock guards; the worker treats every EvidencePart as original material.
- **Blast radius:** Every evidence record in any workspace where a second member holds evidence.create, plus any workspace with an integration key holding integration.evidence.upload. Scenario B: injection into another member's UPLOADING record gets the attacker's bytes signed into the victim's custody with uploadedByUserId NULL.
- **Impact:** A sealed evidence record can be made to read as tampered (FAILED_HASH_MISMATCH is terminal and suppresses verify/report), and foreign bytes can be sealed into another custodian's record — custody/integrity corruption.
- **Reproduction:** As CONTRIBUTOR in team T with SIGNED evidence E owned by another member: create an upload session targeting E with an unused targetPartIndex, complete the multipart upload with verifyHash:true, then trigger any report run for E (updated report / lifecycle recovery).
- **Runtime evidence:** RT-UPL/UPL-01 (runtime/results/rt-upl-01.json): a teamA MEMBER who does not own a SIGNED record drove POST /v1/uploads/sessions (201) -> initiate (200) -> presign (200) -> PUT to loopback MinIO (200) -> parts/1/uploaded (200) -> multipart/complete verifyHash (200). evidence_parts went 1 -> 2 (partIndex 9999, uploadedAtUtc NULL, attacker bytes). The worker composite rule (processor.ts:2367) over the stored parts no longer equals evidence.fileSha256, so the next report run takes the rejectEvidenceIntegrity branch. The report job itself was not executed (see blocked item B6).
- **Recommended remediation:** Route every EvidencePart write through one guarded writer: require owner (or intake principal), status IN (CREATED, UPLOADING), lockedAt NULL, deletedAt NULL, no active legal hold — asserted in the same transaction as the insert with a row lock; refuse session creation on the same predicate; make the worker ignore parts whose uploadedAtUtc is NULL.
- **Acceptance proof:** Integration test: session creation and bridge both refuse for SIGNED/REPORTED/locked/held/other-owner evidence; a report run over a record with a stray NULL-uploadedAt part does not reject integrity.
- **Migration/backfill:** Scan production for evidence_parts with uploaded_at_utc NULL on evidences whose status is SIGNED/REPORTED, and for FAILED_HASH_MISMATCH rows whose extra part came from a bridged session.
- **Dependency:** none
- **Lead verification:** Lead re-read upload-session.service.ts:350-366 (team-only guard), :1860-1916 (bridge insert, no re-read), processor.ts:2061 (unfiltered findMany), :2270-2312 (all parts hashed), :2355-2385 (mismatch -> rejectEvidenceIntegrity); grep found no trigger on evidence_parts. Then runtime-reproduced.

```text
services/api/src/services/uploads/upload-session.service.ts:360  const owningEvidence = await client.evidence.findFirst({ where: { id: input.evidenceId, teamId: input.teamId }, select: { id: true } });
services/api/src/services/uploads/upload-session.service.ts:1885  const partRow = await client.evidencePart.create({ data: { evidenceId: session.evidence_id, partIndex: session.target_part_index, ... sha256: serverSha256 } })
services/api/src/routes/evidence.routes.ts:5975  legacy parts route: owner-only (403) and SIGNED/REPORTED/lockedAt -> 409, advisory lock, validateUploadedFile
services/worker/src/processor.ts:2061  prisma.evidencePart.findMany({ where: { evidenceId: evidence.id }, orderBy: { partIndex: "asc" } ... }) — no artifactClass/uploadedAtUtc filter
services/worker/src/processor.ts:2367  fileSha256 = hashes.length === 1 ? hashes[0] : sha256HexFromStrings(hashes); if (fileSha256 !== evidence.fileSha256 ...) await rejectEvidenceIntegrity({...})
services/worker/src/integrity-rejection.service.ts:67  transition to FAILED_HASH_MISMATCH + custody rejection event
```

### ET-COM-01

**P1 · subscription-ordering / stale entitlement · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Billing reconciliation stamps a Stripe subscription's ordering clock with its FUTURE current_period_end, after which cancellation/past-due webhooks are refused as 'older' and the account can stay PRO indefinitely

- **Affected:** routes: POST /v1/webhooks/stripe, billing re-check route (billing.routes.ts:1240); pages: Billing; jobs: billing-reconciliation.job; tables: subscriptions, entitlements; roles: personal subscriber; plans: PRO, TEAM
- **Evidence:** `services/api/src/services/billing/reconciliation/stripe.provider.ts:386`, `services/api/src/services/billing/reconciliation/reconciliation.service.ts:641`, `services/api/src/services/billing/reconciliation/reconciliation.service.ts:680`, `services/api/src/routes/webhooks.routes.ts:320`, `services/api/src/services/billing/subscription-status.ts:89`, `services/api/src/services/billing/subscription-status.ts:93`, `packages/shared-runtime/src/billing/commercial-lifecycle.ts:95`
- **Citations:** 7/7 resolve in the audited tree
- **Observed:** The Stripe reconciliation adapter uses current_period_end (a future instant) as the observation time, and reconciliation writes it to subscriptions.providerStateAtUtc even when nothing changed. Stripe webhooks use event.created (now). Any later webhook in the same period (customer.subscription.updated -> past_due, customer.subscription.deleted for an immediate cancel) has created < providerStateAtUtc and is refused OBSERVATION_IS_OLDER. The next reconciliation observes the canceled subscription with the SAME current_period_end, so incoming === recorded with a different status -> OBSERVATION_IS_NOT_NEWER, also refused. A period-end cancellation whose deleted event has created == period end (same second) is refused the same way.
- **Expected:** A provider cancellation or past-due transition is always applied; the ordering clock stores only when a state was observed, never a future period boundary.
- **Data flow:** reconcileSubscriptions -> StripeProvider.observeSubscription (observedAt=period end) -> stampProviderState -> webhook deleted(created=now) -> syncPlanForSubscription -> upsertSubscription -> decideSubscriptionStatusWrite refuses -> subscription.status stays ACTIVE -> setPersonalPlan(FREE) never runs -> readCommercialLifecycle sees one ACTIVE row -> ACTIVE/PAID_SUBSCRIPTION.
- **Root cause:** Two incompatible clocks (event creation time vs period end) share one monotonic ordering column.
- **Blast radius:** Every Stripe personal subscription that the reconciliation job or the user's billing re-check touched in the current period.
- **Impact:** A cancelled or unpaid subscriber keeps PRO/TEAM: evidence creation up to 100/500, reports/packages issued (new and historical first issuance), intake, AI. The plan then processes evidence under an entitlement nobody paid for. Or a past_due transition is missed, so the grace/lapsed rules never apply.
- **Reproduction:** Local Stripe-mode fixture: subscription row ACTIVE, currentPeriodEnd = now+20d. Run reconcileBillingAccount with a stubbed StripeProvider returning ACTIVE, same period end (providerStateAtUtc becomes now+20d). POST a signed customer.subscription.deleted with created=now, status=canceled, same current_period_end. Observe subscription stays ACTIVE and entitlements.plan stays PRO. Re-run reconciliation with state CANCELED: still refused (NOT_NEWER).
- **Runtime evidence:** RT-COMMERCIAL/COMMERCIAL-01 (rt-commercial-01.json): production decideSubscriptionStatusWrite with the stamp reconciliation writes (current_period_end, +20d): a CANCELED webhook at +3d and a PAST_DUE at +5d both -> {apply:false, reason:OBSERVATION_IS_OLDER}; control with an honest stamp applies CANCELED. The provider round trip itself is blocked (B5).
- **Recommended remediation:** Do not store period end as providerStateAtUtc. Use the reconciliation's own observation time (now) for polls, or keep a separate periodEnd ordering and let a CANCELED/PAST_DUE observation from the provider always apply when the provider's current status differs. Terminal CANCELED observed by an authenticated provider read should never be refused by a clock comparison.
- **Acceptance proof:** Test: reconciliation stamp followed by an earlier-created deleted webhook moves the row to CANCELED and the entitlement to FREE; reconciliation observing CANCELED with an unchanged period end applies it.
- **Migration/backfill:** Reset providerStateAtUtc where it is later than now(); re-run reconciliation over ACTIVE/PAST_DUE Stripe rows.
- **Dependency:** none
- **Lead verification:** Lead re-read stripe.provider.ts:374-388 (observedAtUtc = current_period_end), reconciliation.service.ts:613-650 (stampProviderState on agreement), billing.service.ts:658 + subscription-status.ts:89 (older observation refused first). Then runtime-reproduced on the decision function.

```text
services/api/src/services/billing/reconciliation/stripe.provider.ts:386  observedAtUtc: utcFromUnix(sub["current_period_end"]) ?? utcFromUnix(sub["created"]),
services/api/src/services/billing/reconciliation/reconciliation.service.ts:641  await stampProviderState(binding.id, observation.observedAtUtc);
services/api/src/services/billing/reconciliation/reconciliation.service.ts:680  data: { providerStateAtUtc: observedAtUtc },
services/api/src/routes/webhooks.routes.ts:320  const stripeObservedAt = dateFromUnixSeconds( (event as { created?: unknown }).created,
services/api/src/services/billing/subscription-status.ts:89  if (incoming !== null && recorded !== null && incoming < recorded) { return { apply: false, reason: "OBSERVATION_IS_OLDER" };
services/api/src/services/billing/subscription-status.ts:93  if (incoming !== null && recorded !== null && incoming === recorded) { return { apply: false, reason: "OBSERVATION_IS_NOT_NEWER" };
packages/shared-runtime/src/billing/commercial-lifecycle.ts:95  if (live.length === 1) { return { state: "ACTIVE", paidActive: true,
```

### ET-DC-01

**P1 · custody-consistency-race · SOURCE_PROVEN_DEFECT** — Discard racing direct-capture completion signs a soft-deleted record, writes DELETED-then-SIGNED custody, and answers bound:true

- **Affected:** routes: POST /v1/capture/direct/:id/complete, continuous-complete, POST /v1/capture/direct/:id/discard; tables: evidences, capture_sessions, custody_events; roles: capture owner; plans: all
- **Evidence:** `services/api/src/services/capture-trust/direct-capture-ingest.service.ts:928`, `services/api/src/services/evidence-complete.service.ts:1098`, `services/api/src/services/capture-trust/direct-capture-ingest.service.ts:844`
- **Citations:** 3/3 resolve in the audited tree
- **Merged candidates:** directcapture:DC-01, statemachine:STATEMACHINE-09
- **Observed:** Completion serialises on the evidence lock and checks session ACTIVE/deletedAt only at entry; discard serialises on a different (capture-session) lock, sets deletedAt and appends EVIDENCE_DELETED while status is still UPLOADING. Completion's final claim does not test deletedAt, so it signs, timestamps and enqueues the deleted record; completeDirectCapture returns bound:true regardless of the session claim count.
- **Expected:** Discard and completion must exclude each other (same lock) and the finalize claim must require deletedAt IS NULL; a failed session claim must not report bound:true.
- **Data flow:** client /complete (long rehash) -> network drop -> user Discard -> deletedAt set + EVIDENCE_DELETED -> completion claim succeeds -> SIGNED record with deletedAt, custody DELETED then SIGNED, session DISCARDED not BOUND
- **Root cause:** Two different advisory-lock keys guard the same record; the finalize claim predicate omits deletedAt.
- **Blast radius:** Direct-capture records (mobile, extension, screen, continuous) whose completion request outlives the client.
- **Impact:** A signed evidence record hidden from both the active list and the trash, with a self-contradicting custody chain and a false API answer. Bytes and hash are intact.
- **Reproduction:** Start a large continuous completion, drop the client connection, press Discard while the server is hashing.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Needs a deterministic interleave point inside completeEvidence after the entry checks (no injection hook exists).
- **Recommended remediation:** Take the capture-session lock in completeDirectCapture before completeEvidence (or the evidence lock in discard); add deletedAt: null to the finalize claim; derive bound from the session claim.
- **Acceptance proof:** Interleaved integration test: discard after entry check -> completion refuses, no SIGNED+deleted row.
- **Migration/backfill:** Query evidences with status SIGNED/REPORTED AND deleted_at NOT NULL AND lifecycle_state <> TRASHED.
- **Dependency:** none
- **Lead verification:** Lead re-read direct-capture-ingest.service.ts:920-990 (discard lock key capture-session:*), evidence-complete.service.ts:1098 (claim without deletedAt), :840-846 (bound:true regardless).

```text
services/api/src/services/capture-trust/direct-capture-ingest.service.ts:928  pg_advisory_xact_lock(hashtext(`capture-session:${session.id}`)) — comment: a discard can never race a binding
services/api/src/services/evidence-complete.service.ts:1098  tx.evidence.updateMany({ where: { id: evidence.id, status: { in: [CREATED, UPLOADING] } } }) — no deletedAt predicate
services/api/src/services/capture-trust/direct-capture-ingest.service.ts:844  bound: true, alreadyBound: claim.count !== 1
```

### ET-DC-02

**P1 · false-provenance-claim · SOURCE_PROVEN_DEFECT** — Acquisition statement says the capture session was 'started before the capture'; UC-1 and UC-2 open it after the capture and the server never checks

- **Affected:** pages: report, Verify, verification package; tables: capture_sessions; plans: all
- **Evidence:** `packages/shared/src/evidence-acquisition.ts:254`, `apps/extension/src/background.ts:48`, `apps/mobile/src/screen-capture.ts:126`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The extension captures the page, then opens the session; Android single screen capture opens it after frames exist. Manifest captureStartedAtUtc is never compared with CaptureSession.startedAtUtc.
- **Expected:** Either open the session before capture and enforce manifest window ⊆ session window, or change the statement.
- **Data flow:** resolver statement -> report/Verify/package acquisition section
- **Root cause:** Statement written for the mobile path and reused for modes that do not satisfy it.
- **Blast radius:** Every UC-1 and UC-2 record.
- **Impact:** An untrue evidentiary statement about acquisition timing on customer-facing outputs.
- **Reproduction:** Source order in background.ts:46-55.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Reorder clients and enforce the window server-side, or reword per mode.
- **Acceptance proof:** Server refuses a manifest whose captureStartedAtUtc precedes session start; statement test per mode.
- **Migration/backfill:** Existing UC-1/UC-2 outputs carry the statement; decide whether to annotate.
- **Dependency:** none
- **Lead verification:** Lead re-read apps/extension/src/background.ts:44-56 (capture before openWebSession) and evidence-acquisition.ts:250-258 (statement).

```text
packages/shared/src/evidence-acquisition.ts:254  in a server-issued capture session started before the capture
apps/extension/src/background.ts:48  const startedAtUtc = ...; capture = await captureFullPage(...); ... openWebSession(token, req.teamId) at :55
apps/mobile/src/screen-capture.ts:126  const session: DirectCaptureSession = await openDirectCaptureSession("DIRECT_SCREEN_CAPTURE_ANDROID");
```

### ET-DC-03

**P1 · false-provenance-claim · SOURCE_PROVEN_DEFECT** — 'Direct capture' provenance (e.g. 'PROOVRA's own adapter produced the bytes') is selected by the caller's mode string with no client proof

- **Affected:** routes: POST /v1/capture/direct/sessions; pages: report, Verify, package; roles: any authenticated user; plans: all
- **Evidence:** `services/api/src/routes/capture-trust.routes.ts:157`, `packages/shared/src/evidence-acquisition.ts:253`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Any bearer (web JWT, script) can open a DIRECT_WEB_CAPTURE_EXTENSION or DIRECT_SCREEN_CAPTURE_IOS session, upload arbitrary files plus a self-written manifest, and seal; outputs then say PROOVRA captured them. No limitation code discloses that the capturing client was unverified.
- **Expected:** Direct-capture statements only when the client is authenticated as that adapter (extension-scoped token for UC-1, device binding for native), or a limitation disclosing unverified client.
- **Data flow:** open(mode) -> reserve -> declare -> complete -> acquisitionMode -> statement
- **Root cause:** Mode is a caller-supplied enum; no binding between token audience/device and mode.
- **Blast radius:** All direct-capture modes.
- **Impact:** Fabricated material presented as platform-captured.
- **Reproduction:** curl open with mode DIRECT_SCREEN_CAPTURE_IOS using a web session token, upload PNGs + manifest, complete.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Bind mode to token scope/audience (extension token only for UC-1; native app attestation or at least app-scoped token for UC-2..UC-5); add a CLIENT_NOT_VERIFIED limitation otherwise.
- **Acceptance proof:** Web JWT opening a DIRECT_* session is refused or labelled.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read capture-trust.routes.ts:156-163 (mode is a caller-supplied enum).
- **Owner decision:** How strong must the client binding be (scoped token vs attestation)?

```text
services/api/src/routes/capture-trust.routes.ts:157  mode: z.enum(DIRECT_CAPTURE_SESSION_MODES)
packages/shared/src/evidence-acquisition.ts:253  statement ... isDirectCapture: true
```

### ET-INT-01

**P1 · false-success · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Public /transition lets a token holder mark an intake session SUBMITTED without finalizing: link use is consumed, one-time link expires, Evidence stays CREATED

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/routes/external-intake.routes.ts:1406`, `services/api/src/services/workflow-intake-session.service.ts:546`, `packages/shared/src/workflow-intake-link.ts:99`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** SUBMITTED is allowed over the public route; transitionIntakeSession increments usedCount and expires one-time links but never calls completeEvidence, emits no EXTERNAL_INTAKE_SUBMITTED and links no request response. The web page never calls /transition.
- **Expected:** Only /submit (which finalizes) may reach SUBMITTED; the public transition route should not allow it.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** SUBMITTED is allowed over the public route; transitionIntakeSession increments usedCount and expires one-time links but never calls completeEvidence, emits no EXTERNAL_INTAKE_SUBMITTED and links no request response. The web page never calls /transition.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Link and submission list show SUBMITTED while nothing was finalized; the real contributor gets LINK_ALREADY_SUBMITTED; Evidence stranded CREATED.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** RT-INTAKE (rt-intake.json): one-time link, anonymous open + consent, POST …/transition {to:SUBMITTED} 200 -> session SUBMITTED with evidenceId null, link EXPIRED usedCount 1; the real contributor's next GET -> 410 LINK_NO_LONGER_AVAILABLE.
- **Recommended remediation:** Remove SUBMITTED (and evidence-stranding ABANDONED) from the public transition route; SUBMITTED only from submitExternalIntake after completeEvidence.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read external-intake.routes.ts:1395-1425 and workflow-intake-session.service.ts:536-558. Then runtime-reproduced.

```text
services/api/src/routes/external-intake.routes.ts:1406  if (to === "REVOKED" || to === "EXPIRED" || to === "CREATED") { 403 }
services/api/src/services/workflow-intake-session.service.ts:546  if (input.to === "SUBMITTED") { usedCount: { increment: 1 }, one-time -> status EXPIRED }
packages/shared/src/workflow-intake-link.ts:99  OPENED->SUBMITTED and UPLOAD_STARTED->SUBMITTED allowed
```

### ET-INT-02

**P1 · stuck-state · SOURCE_PROVEN_DEFECT** — A failed part PUT permanently blocks the intake session and the contributor is told the workspace refused

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/external-intake-orchestration.service.ts:511`, `services/api/src/services/evidence-complete.service.ts:762`, `services/api/src/errors.ts:387`, `services/api/src/routes/external-intake.routes.ts:1340`
- **Citations:** 3/4 resolve in the audited tree
- **Observed:** A part row whose object was never written makes every submit 404 at completion, which is classified as an expected denial and rendered as a workspace refusal plus a tenant audit 'evidence.create denied'. Re-posting the index returns PART_INDEX_TAKEN.
- **Expected:** Missing-part completion failures are distinguished and the contributor can re-upload or remove the part.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** A part row whose object was never written makes every submit 404 at completion, which is classified as an expected denial and rendered as a workspace refusal plus a tenant audit 'evidence.create denied'. Re-posting the index returns PART_INDEX_TAKEN.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Intake submissions with any interrupted upload can never be submitted; misleading message and audit.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add part replace/remove for unsubmitted sessions; classify OBJECT_NOT_FOUND at completion as contributor-recoverable.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted on the cited completion/denial classification chain (evidence-complete.service.ts:762, errors.ts:387, external-intake.routes.ts:1340); not runtime-exercised.

```text
services/api/src/services/external-intake-orchestration.service.ts:511  EvidencePart row created before the PUT; no delete-part route
services/api/src/services/evidence-complete.service.ts:762  OBJECT_NOT_FOUND with statusCode 404
services/api/src/errors.ts:387  any 4xx classified EXPECTED_DENIAL
services/api/src/routes/external-intake.routes.ts:1340  intakeBoundedDenial: this intake cannot accept evidence right now
```

### ET-INT-03

**P1 · commercial-dos · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Any intake link holder can exhaust the workspace's evidence-record allowance with never-submitted records

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/routes/external-intake.routes.ts:788`, `services/api/src/services/external-intake-orchestration.service.ts:295`, `services/api/src/services/billing-enforcement.service.ts:225`, `services/worker/src/orphan-scan.ts:107`
- **Citations:** 2/4 resolve in the audited tree
- **Observed:** Each GET opens a new session; the first part creates a durable Evidence row that counts against the rolling cap regardless of status; nothing reaps it. About 3 requests per row within the per-token rate limit.
- **Expected:** Unfinalized intake records must not consume the allowance (count finalized only, or reserve and release), and abandoned intake records are reaped.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** Each GET opens a new session; the first part creates a durable Evidence row that counts against the rolling cap regardless of status; nothing reaps it. About 3 requests per row within the per-token rate limit.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** An anonymous party (or accidental reloads) blocks the workspace's own members with EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED; Object-Lock-retained orphan bytes.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** RT-INTAKE (rt-intake.json): FREE owner at 2/3; anonymous open + consent + one part (201), never submitted -> owner count 3, record UPLOADING; owner's own POST /v1/evidence -> 409 FREE_LIMIT_REACHED.
- **Recommended remediation:** Count only finalized records toward caps (or reserve with expiry); reap abandoned intake evidence; resume sessions client-side.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read external-intake.routes.ts:783-795 (session per GET) and billing-enforcement.service.ts:218-235 (count without status filter). Then runtime-reproduced.

```text
services/api/src/routes/external-intake.routes.ts:788  a fresh session per GET; usedCount only at SUBMITTED
services/api/src/services/external-intake-orchestration.service.ts:295  first POST /parts per session calls createEvidence
services/api/src/services/billing-enforcement.service.ts:225  prisma.evidence.count({ where: { teamId, deletedAt: null, createdAt: { gte: since } } }) - status not filtered
services/worker/src/orphan-scan.ts:107  read-only, deletes nothing
```

### ET-INT-04

**P1 · workflow-broken · SOURCE_PROVEN_DEFECT** — 'Request more' follow-up submissions never reach the evidence request

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/evidence-request.service.ts:1223`, `services/api/src/services/evidence-request.service.ts:869`
- **Citations:** 1/2 resolve in the audited tree
- **Observed:** The follow-up link is never written to evidenceRequest.intakeLinkId, so linkResponseFromIntakeSession finds no request.
- **Expected:** Follow-up submissions attach a response to the originating request.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** The follow-up link is never written to evidenceRequest.intakeLinkId, so linkResponseFromIntakeSession finds no request.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Reviewer sees NEEDS_MORE_INFO forever while evidence was submitted and finalized.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Record follow-up links in a link->request relation and resolve through it.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted on evidence-request.service.ts:1223/1259 and :869 (follow-up link never recorded on the request); not runtime-exercised.

```text
services/api/src/services/evidence-request.service.ts:1223  new link created; only followUpIntakeLinkId in an event payload (:1259)
services/api/src/services/evidence-request.service.ts:869  findFirst({ where: { intakeLinkId: params.intakeLinkId } }) returns if none
```

### ET-INT-05

**P1 · integrity · SOURCE_PROVEN_DEFECT** — Parts can be added to an intake record while it is being signed or after it is signed; the worker then includes them

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/routes/external-intake.routes.ts:990`, `services/api/src/services/external-intake-orchestration.service.ts:461`, `services/worker/src/processor.ts:2061`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** submitExternalIntake runs completeEvidence before moving the session to SUBMITTED; a POST /parts in that window inserts an unhashed part on a SIGNED record and returns a PUT URL. The next report run rehashes all parts -> integrity rejection (same mechanism as UPL-01).
- **Expected:** Part creation holds the evidence lock and requires status CREATED/UPLOADING.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** submitExternalIntake runs completeEvidence before moving the session to SUBMITTED; a POST /parts in that window inserts an unhashed part on a SIGNED record and returns a PUT URL. The next report run rehashes all parts -> integrity rejection (same mechanism as UPL-01).
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Signed intake evidence can be driven to FAILED_HASH_MISMATCH by the contributor.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Check evidence status under the completion advisory lock; move session to a SUBMITTING state before completion.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted on the same mechanism as UPL-01 (worker hashes every part) plus addExternalEvidencePart taking no completion lock; not runtime-exercised.

```text
services/api/src/routes/external-intake.routes.ts:990  const session = await getIntakeSession(params.sid); if (!session || session.intakeLinkId !== link.id) {
services/api/src/services/external-intake-orchestration.service.ts:461  export async function addExternalEvidencePart( input: AddExternalPartInput, client: PrismaClient = defaultPrisma,
services/worker/src/processor.ts:2061  prisma.evidencePart.findMany({ where: { evidenceId: evidence.id }, orderBy: { partIndex: "asc" },
```

### ET-OTS-01

**P1 · stuck-pipeline / lost follow-up · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — After initialization the upgrade follow-up collapses onto the running job itself, so no newly stamped proof is ever upgraded

- **Affected:** pages: /verify/[id], /evidence/[id]; jobs: ots-upgrade (UpgradeOts); tables: Evidence.ots*; plans: all
- **Evidence:** `services/worker/src/ots-upgrade.processor.ts:350`, `services/worker/src/queue.ts:500`, `packages/shared/src/queue-integrity/enqueue.ts:146`, `packages/shared/src/queue-integrity/enqueue.ts:161`, `services/api/src/services/integrity/ots-anchoring-authority.service.ts:85`
- **Citations:** 5/5 resolve in the audited tree
- **Merged candidates:** ots:OTS-01, queues:QUEUES-01
- **Observed:** The first ots-upgrade job for a record (id `ots-upgrade-<evidenceId>`, enqueued by finalize or the reconciler) stamps the proof, then calls enqueueOtsUpgradeJob WITHOUT selfJobId. enqueueCanonicalJob looks up the canonical id, finds the caller itself in state 'active', and returns {enqueued:true, collapsed:true} without adding anything. The job completes; no follow-up exists.
- **Expected:** The init branch passes selfJobId: job.id (as the upgrade branch at line 703-707 does) so a delayed follow-up is scheduled.
- **Data flow:** evidence-complete.service.ts:1454 requestEvidenceOtsAnchoring -> enqueueCanonicalJob(id=ots-upgrade-<id>) -> processOtsUpgrade (no proof) -> ensureEvidenceOtsInitialized writes PENDING -> enqueueOtsUpgradeJob (collapse onto self) -> job completes -> row PENDING with no job.
- **Root cause:** The selfJobId escape hatch added for the production 'stuck PENDING' incident was applied only to the upgrade branch, not to the init branch that runs under the same canonical id.
- **Blast radius:** Every record finalized since initialization moved into the ots-upgrade queue (all plans). Records stamped through any path that runs init inside a canonical-id job.
- **Impact:** OTS proofs never progress from PENDING to anchored automatically; 30-day budget never fires (no observation), so rows stay PENDING indefinitely; ops shows HIGH pending_aged with guidance saying the ladder is still running (OTS-03). Public anchoring promise silently unmet.
- **Reproduction:** Finalize a record with OTS_ENABLED=true; after the init job completes, inspect BullMQ: no delayed `ots-upgrade-<id>` or `-next-` job exists; Evidence.otsStatus stays PENDING and otsUpgradedAtUtc never changes.
- **Runtime evidence:** RT-OTS-QUEUE (rt-ots-queue.json): production enqueueCanonicalJob + UPGRADE_OTS registry entry on real BullMQ/Redis (loopback): called from inside the running job without selfJobId -> {enqueued:true, collapsed:true}; hops processed 1, jobs still scheduled 0.
- **Recommended remediation:** Pass `selfJobId: job.id` and an explicit upgrade delay in the init branch (ots-upgrade.processor.ts:351); add a behaviour test that does not mock queue.js collapse semantics.
- **Acceptance proof:** Processor probe against real BullMQ shows a delayed follow-up job after initialization; end-to-end a fresh record reaches an upgrade attempt within the delay.
- **Migration/backfill:** Re-enqueue every Evidence with otsStatus='PENDING' and no live ots-upgrade job (one-off script using enqueueOtsUpgradeJob).
- **Dependency:** none
- **Lead verification:** Lead re-read ots-upgrade.processor.ts:342-362 (no selfJobId) and enqueue.ts:145-195 (collapse onto a live job). Then runtime-reproduced on BullMQ.

```text
services/worker/src/ots-upgrade.processor.ts:350  if (init.initialized && init.needsUpgrade) { await enqueueOtsUpgradeJob(evidenceId, { traceId: requestId }).catch(
services/worker/src/queue.ts:500  delayMs: options.delayMs ?? 5 * 60 * 1000, traceparent: currentTraceparent(), selfJobId: options.selfJobId,
packages/shared/src/queue-integrity/enqueue.ts:146  const existing = await queue.getJob(jobId); if (existing) { const isSelfReference = input.selfJobId != null && ...
packages/shared/src/queue-integrity/enqueue.ts:161  if (isLiveQueueJobState(state)) { return { enqueued: true, jobId, collapsed: true };
services/api/src/services/integrity/ots-anchoring-authority.service.ts:85  const outcome = await enqueueCanonicalWork({ workName: JOB_NAMES.UPGRADE_OTS, commandId: input.evidenceId,
```

### ET-OTS-02

**P1 · stuck-pipeline / silent enqueue no-op · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Self follow-up job id `-next-` is deterministic and collides with its own retained completed job, so the ladder dies silently on the third hop

- **Affected:** jobs: ots-upgrade; tables: Evidence.ots*; plans: all
- **Evidence:** `packages/shared/src/queue-integrity/enqueue.ts:156`, `packages/shared/src/queue-integrity/enqueue.ts:174`, `packages/shared/src/queue-integrity/enqueue.ts:72`, `services/worker/src/ots-upgrade.processor.ts:703`
- **Citations:** 4/4 resolve in the audited tree
- **Merged candidates:** ots:OTS-02, queues:QUEUES-02
- **Observed:** Hop 1: job A=`ots-upgrade-<id>` schedules B=`ots-upgrade-<id>-next-<last8>-<n>` (deterministic). Hop 2: B finds A completed, removes it, re-adds A. Hop 3: A is self, computes the SAME B id; B is still in the completed set (removeOnComplete keeps the last 100 completions queue-wide), so the self-reference branch skips the existence check and queue.add is ignored while returning enqueued:true.
- **Expected:** The self-reference branch must also release/validate an existing job under the discriminated id (or alternate between two ids with remove-if-spent), and must never report a schedule it did not make.
- **Data flow:** processOtsUpgrade PENDING -> enqueueOtsUpgradeJob(selfJobId) -> enqueueCanonicalJob self-reference branch -> queue.add(duplicate id) ignored -> no future job.
- **Root cause:** The discriminated id contains no nonce and the self-reference branch bypasses the spent-job release that the normal branch performs.
- **Blast radius:** Any PENDING record once its ladder is running (after an operator RESUME, or after OTS-01 is fixed), in any deployment with fewer than ~100 ots-upgrade completions per follow-up interval.
- **Impact:** PENDING proofs stop being upgraded after ~2 hours with no log or error; budget never fires; row stays PENDING indefinitely.
- **Reproduction:** Against local Redis: enqueue A, run it (PENDING observation), let B run, let A run again; inspect getDelayed(): empty, while logs report the follow-up enqueued.
- **Runtime evidence:** RT-OTS-QUEUE (rt-ots-queue.json): with selfJobId the ladder ran 3 hops; hop 3's enqueue returned {enqueued:true, collapsed:false, jobId '…-next-ab794fde-84'} — the same id as hop 1's retained completed job — and nothing further was scheduled.
- **Recommended remediation:** In the self-reference branch, getJob(discriminatedId) and remove it when not live (or include a monotonic nonce and dedupe via a durable row); report enqueued:false when add is a no-op (check returned job.timestamp).
- **Acceptance proof:** Real-BullMQ test runs >=4 hops for one evidence id and observes a delayed job after each hop.
- **Migration/backfill:** Same re-enqueue of PENDING rows as OTS-01.
- **Dependency:** none
- **Lead verification:** Lead re-read enqueue.ts:150-160 (deterministic -next- id) and removeOnComplete 100. Then runtime-reproduced on BullMQ.

```text
packages/shared/src/queue-integrity/enqueue.ts:156  jobId = `${jobId}-next-${(existing.id ?? "self").toString().slice(-8)}-${ (payload.commandId.length + jobId.length) % 997 }`;
packages/shared/src/queue-integrity/enqueue.ts:174  await queue.add(entry.workName, payload, { jobId, ... removeOnComplete: input.removeOnComplete ?? 100,
packages/shared/src/queue-integrity/enqueue.ts:72  BullMQ IGNORES an `add` whose jobId already exists — INCLUDING a retained completed or failed job — and still returns a Job object.
services/worker/src/ots-upgrade.processor.ts:703  await enqueueOtsUpgradeJob(evidenceId, { delayMs: 60 * 60 * 1000, traceId: "ots_followup", selfJobId: job.id,
```

### ET-PKG-01

**P1 · integrity/verifiability · SOURCE_PROVEN_DEFECT** — Package custody.json payloads are rewritten after hashing, so the included hash chain cannot be recomputed (reads as tampered)

- **Affected:** jobs: report-generation (processor.ts package branch); tables: custody_events; roles: external recipient
- **Evidence:** `services/worker/src/processor.ts:4435`, `services/worker/src/report-v2/normalizers.ts:98`, `packages/shared/src/custody-hash.ts:55`, `services/worker/src/verification-package.ts:2062`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** custody.json / forensic-custody.json carry eventHash values computed over the ORIGINAL payload, but the payload written is a presentation copy: captureMethodSnapshot/captureMethod replaced by a display label, evidenceStructureSnapshot added, uploadKind relabelled. REPORT_GENERATED always has captureMethodSnapshot (processor.ts:3994) and UPLOAD_AUTHORIZED has captureMethod (evidence.service.ts:560).
- **Expected:** The exported chain must contain the exact hashed payloads (presentation labels in a separate field/file) and document the hash formula so a third party can recompute every link.
- **Data flow:** tx.custodyEvent.findMany -> finalizedCustodyEvents -> map(normalizeCustodyEventPayloadForPresentation) -> createVerificationPackage.custody -> custody.json/forensic-custody.json
- **Root cause:** Role-safe relabelling applied to the forensic export instead of only to display surfaces.
- **Blast radius:** Every verification package produced by the processor (all records have REPORT_GENERATED).
- **Impact:** A recipient who recomputes buildCustodyEventHash (sha256 of canonical {v,evidenceId,sequence,eventType,atUtc,payload,prevEventHash}) gets mismatches and may conclude the custody chain was tampered; the README claims it is the complete immutable sequence. The formula itself is not documented in the package.
- **Reproduction:** Generate a package for any record; for the REPORT_GENERATED row in custody.json compute sha256(canonicalJsonValue({v:1,evidenceId,sequence,eventType,atUtc,payload,prevEventHash})) and compare with eventHash.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit fixture: run normalizeCustodyEventPayloadForPresentation on a payload {captureMethodSnapshot:"UPLOADED_FILE"} with acquisitionMode PROOVRA_WEB_UPLOAD and compare buildCustodyEventHash before/after; or integration: build a package in the point5 suite and recompute chain from custody.json.
- **Recommended remediation:** Emit the raw stored payload in custody.json/forensic-custody.json; put presentation labels in a sibling field (e.g. presentation) excluded from hashing, and document the event-hash formula in the package.
- **Acceptance proof:** Test that recomputes every eventHash from the extracted custody.json of a real built package and gets 100% matches.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read processor.ts:4425-4440 (payload normalized for presentation, 'immutable event hash is preserved') and normalizers.ts:90-105.

```text
services/worker/src/processor.ts:4435  payload: normalizeCustodyEventPayloadForPresentation(e.payload, {
services/worker/src/report-v2/normalizers.ts:98  if (hasSnapshot) next.captureMethodSnapshot = method;
packages/shared/src/custody-hash.ts:55  payload: normalizePayload(params.payload),
services/worker/src/verification-package.ts:2062  custody.json contains the complete immutable sequence of all recorded system events.
```

### ET-PKG-02

**P1 · cryptographic trust anchor · SOURCE_PROVEN_DEFECT** — Package seal/manifest signing key is only self-asserted inside the ZIP; PROOVRA publishes no fingerprint, yet UI and seal docs claim a bound, checkable seal

- **Affected:** routes: GET /public/verify/:id; pages: /verify/[token]; jobs: report-generation; tables: verification_packages; roles: external recipient
- **Evidence:** `packages/shared/src/package-seal.ts:33`, `packages/shared/src/package-seal.ts:35`, `packages/shared/src/package-seal.ts:199`, `apps/web/app/verify/[token]/BasicVerificationView.tsx:152`, `services/api/src/routes/evidence.routes.ts:13707`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** package-seal.sig names publicKeyFile package-manifest-public-key.pem inside the same ZIP; the reference verifier trusts whatever key file is present. Public Verify (BASIC and RICH) never returns the package signer key or its fingerprint, the report pdfSha256, or packageSha256; the only signer listing is the authenticated /v1/operations/signers.
- **Expected:** A recipient must be able to anchor the seal key (or the report/package digest) to PROOVRA through a public channel; UI must not describe a seal as binding without that anchor.
- **Data flow:** signPackageManifestDigest -> publicKeyPem -> package-manifest-public-key.pem (in-ZIP); no public exposure path
- **Root cause:** Seal designed with an external trust-anchor step that was never implemented on Public Verify.
- **Blast radius:** All format-5 packages; all recipients.
- **Impact:** Anyone who alters the report PDF or any file can regenerate checksums, seal and signature with their own Ed25519 key, replace the PEM, and the package verifies. The page tells reviewers the package is sealed.
- **Reproduction:** Take a package, replace reports/*.pdf, rebuild package-checksums.json, re-sign a new package-seal.json with a fresh key, replace package-manifest-public-key.pem; run verifySealedPackageEntries -> ok:true.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Extend packages/shared/tests/package-seal.test.mjs with an attacker-key re-seal case; and assert GET /public/verify response contains no signer fingerprint/report digest.
- **Recommended remediation:** Expose the package signer SPKI fingerprint (and the report pdfSha256 + packageSha256 for the paired version) on Public Verify BASIC and RICH, and/or publish a static signer registry; include the expected fingerprint in README; correct BASIC copy until then.
- **Acceptance proof:** Public Verify response contains signingKeyFingerprint equal to package-seal.sig.signingKeyFingerprint; test that a re-sealed package with a foreign key is reported as untrusted.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted on the seal/key provenance citations (public key only inside the ZIP, no published fingerprint); consistent with package answer 10.12.

```text
packages/shared/src/package-seal.ts:33  What the seal does NOT establish: that the signing key belongs to PROOVRA.
packages/shared/src/package-seal.ts:35  with the signer registry published by PROOVRA (Public Verify shows it) —
packages/shared/src/package-seal.ts:199  const keyBytes = input.entries.get(signature.publicKeyFile);
apps/web/app/verify/[token]/BasicVerificationView.tsx:152  sealed (every file, including the report, is bound by one signature).
services/api/src/routes/evidence.routes.ts:13707  select: { version: true, reportVersion: true, generatedAtUtc: true, packageFormatVersion: true },
```

### ET-SEC-03

**P1 · tenancy/authz · SOURCE_PROVEN_DEFECT** — Legacy read gate and the byte-release gate's membership lookup ignore access expiry and organization lifecycle: expired members and members of SUSPENDED/ARCHIVED organizations can read, write collaboration content and download originals/reports/packages

- **Affected:** routes: GET /v1/evidence/:id, GET /v1/evidence/:id/original, GET /v1/evidence/:id/report/latest, GET /v1/evidence/:id/reports/:version, GET /v1/evidence/:id/verification-package(s), GET /v1/evidence/:id/parts, comments/legal-notes/annotations routes, ~30 LEGACY-gated routes; tables: team_members, evidence; roles: time-bound members, members of suspended orgs
- **Evidence:** `services/api/src/routes/evidence.routes.ts:3079`, `services/api/src/services/evidence/artifact-download-gate.service.ts:150`, `services/api/src/services/identity/access-policy.service.ts:216`, `services/api/src/services/identity/access-policy.service.ts:234`, `services/api/src/routes/evidence.routes.ts:2993`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** The canonical evaluateMember denies expired access and non-ACTIVE organizations; getEvidenceWithReadAccess (evidence.routes.ts:3003-3100) and evaluateArtifactDownload's role lookup check only teamMember.status==='ACTIVE'. No sweep flips expired rows' status (sub-agent grep of accessExpiresAtUtc writers). Same status-only pattern in getTeamMembershipRole (:3143), list membership (:6812-6816), createEvidence (evidence.service.ts:282-309), GET /v1/reports (reports.routes.ts:176-179), capture session create (capture.routes.ts:269-279).
- **Expected:** Every evidence read/write/byte release uses evaluateMemberAccess (status + expiry + workspace kind + org lifecycle + role).
- **Data flow:** GET /original -> getEvidenceWithReadAccess (status only) -> evaluateArtifactDownload -> enforceSensitiveAction(role from status-only lookup) -> checkExportEligibility -> presigned GET 600s
- **Root cause:** Two read gates: canonical getEvidenceWithRecordAccess vs legacy getEvidenceWithReadAccess; download gate re-implements membership lookup.
- **Blast radius:** All read/collab/download routes in evidence.routes.ts on LEGACY gate (~30) plus list/summary.
- **Impact:** Customer data exposure after access should have ended (contractor expiry, org suspension for non-payment/offboarding).
- **Reproduction:** Set team_members.access_expires_at_utc to past for user X (status ACTIVE); GET /v1/evidence/:id/original as X -> 200 with presigned URL; canonical routes (e.g. /reports/regenerate) -> 404.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local fixture: expired member + suspended-org member; call /original, /report/latest, /legal-notes; expect 200 (defect).
- **Recommended remediation:** Replace getEvidenceWithReadAccess with getEvidenceWithRecordAccess(userId,id,'evidence.read') and have evaluateArtifactDownload obtain role via evaluateMemberAccess.
- **Acceptance proof:** Route-matrix test: expired/suspended-org actor gets 404 on every evidence route.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read evidence.routes.ts:3079 and artifact-download-gate.service.ts:150 (status === ACTIVE only) against access-policy.service.ts:216/234 (the canonical rule also checks expiry and org status). Severity P0 -> P1: Within-tenant stale authority (expired members / suspended orgs), not cross-tenant access; aligned with SEC-04/SEC-05 (P1).

```text
services/api/src/routes/evidence.routes.ts:3079  if (member?.status === "ACTIVE") { return evidence; }
services/api/src/services/evidence/artifact-download-gate.service.ts:150  role: membership?.status === "ACTIVE" ? membership.role : undefined,
services/api/src/services/identity/access-policy.service.ts:216  actor.accessExpiresAtUtc !== null && actor.accessExpiresAtUtc.getTime() <= now.getTime() ) { return { allowed: false, reason: "member_access_expired" };
services/api/src/services/identity/access-policy.service.ts:234  if (actor.organizationStatus !== "ACTIVE") { return { allowed: false, reason: "organization_not_active",
services/api/src/routes/evidence.routes.ts:2993  readAccess: getEvidenceWithReadAccess
```

### ET-SEC-04

**P1 · tenancy/authz · SOURCE_PROVEN_DEFECT** — Stale standing authority: CaseAccess grants and case ownership survive suspension/revocation and are honored without membership re-proof (legacy read gate, case-workspace requireCaseAccess, bulk case status, attach/detach)

- **Affected:** routes: LEGACY evidence reads/collab writes, GET /v1/cases/:id/linkable-evidence, case-workspace mutations, POST /v1/cases/bulk, DELETE /v1/cases/:id/evidence/:evidenceId; tables: case_access, cases, team_members; roles: suspended/revoked members, VIEWER with CaseAccess
- **Evidence:** `services/api/src/routes/evidence.routes.ts:3042`, `services/api/src/routes/evidence.routes.ts:3038`, `services/api/src/routes/case-workspace.routes.ts:159`, `services/api/src/routes/case-workspace.routes.ts:164`, `services/api/src/routes/cases.routes.ts:2221`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** suspendWorkspaceMembership (membership-provisioning.service.ts:507-515) only updates team_members; caseAccess rows are deleted only on explicit ungrant/case delete. The legacy gate, requireCaseAccess, bulk case status and attach/detach owner arms return access before any membership check. linkable-evidence then lists all team evidence titles/status (case-workspace.routes.ts:820-845). A VIEWER granted CaseAccess is promoted to role MEMBER in case-workspace, passing EVIDENCE_LINK/STATUS_CHANGE that cases.routes.ts denies.
- **Expected:** CaseAccess/case ownership are additive only for ACTIVE, non-expired members of the case's workspace.
- **Data flow:** GET /v1/evidence/:id/* (legacy routes) -> getEvidenceWithReadAccess -> case_evidence_links -> cases.include(access) -> returns on caseItem.ownerUserId/access match before any team_members check; case-workspace routes -> requireCaseAccess returns OWNER/MEMBER from case row -> linkable-evidence/mutations.
- **Root cause:** Case-level grants treated as independent authority.
- **Blast radius:** Every workspace with cases that has ever granted CaseAccess or had a case owner later suspended/revoked; affects ~30 legacy evidence routes, case-workspace read/mutation routes, bulk case status and case attach/detach.
- **Impact:** Suspended/revoked members keep reading evidence metadata, legal notes, INTERNAL comments, enumerating the team's evidence, and mutating cases (close/archive/link/unlink -> SEC-02). Bytes are blocked by the download gate's ACTIVE-role check.
- **Reproduction:** Grant CaseAccess to M on case C; suspend M; as M GET /v1/evidence/:id/legal-notes for evidence linked to C -> 200; GET /v1/cases/C/linkable-evidence -> team evidence list.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local fixture with suspended member holding case_access row; hit the listed routes.
- **Recommended remediation:** Re-prove membership via evaluateMemberAccess before honoring case owner/CaseAccess; delete or disable caseAccess on suspension/removal.
- **Acceptance proof:** Suspended member receives 404 on all listed routes.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read evidence.routes.ts:3035-3045 (case owner / CaseAccess grant without membership re-proof).

```text
services/api/src/routes/evidence.routes.ts:3042  if (caseItem.access.some((a) => a.userId === userId)) { return evidence; }
services/api/src/routes/evidence.routes.ts:3038  if (caseItem.ownerUserId === userId) { return evidence; }
services/api/src/routes/case-workspace.routes.ts:159  if (caseRow.ownerUserId === userId) { return { userId, role: "OWNER" }; }
services/api/src/routes/case-workspace.routes.ts:164  if (caseRow.access.length > 0) { return { userId, role: "MEMBER" }; }
services/api/src/routes/cases.routes.ts:2221  { ownerUserId: userId }, { access: { some: { userId } } }
```

### ET-SEC-05

**P1 · tenancy/authz · SOURCE_PROVEN_DEFECT** — Creator identity alone grants read, write and moderation on workspace-bound evidence after the creator leaves the workspace (contradicts canonical 'creator grants nothing')

- **Affected:** routes: ~30 LEGACY-gated evidence routes, DELETE/PATCH comments/legal-notes/annotations of others, GET /v1/evidence list
- **Evidence:** `services/api/src/routes/evidence.routes.ts:3018`, `services/api/src/routes/evidence.routes.ts:3157`, `services/api/src/services/evidence/evidence-record-access.service.ts:79`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Legacy gate returns before any membership check for the creator; canManageEvidenceCollaborativeContent lets the creator edit/delete any team member's comment, legal note or annotation. List includes {ownerUserId:userId} (:2488).
- **Expected:** Workspace evidence requires live membership regardless of creator identity.
- **Data flow:** GET/DELETE /v1/evidence/:id/legal-notes|comments|annotations -> getEvidenceWithReadAccess (returns at ownerUserId===userId, :3018) -> canManageEvidenceCollaborativeContent (creator true, :3157) -> evidence_legal_notes/comments/annotations read or soft-delete.
- **Root cause:** The legacy gate predates the Phase-1 canonical rule and keeps a creator shortcut; the routes were never migrated to getEvidenceWithRecordAccess.
- **Blast radius:** All workspace evidence created by users who later left or were suspended/revoked; all LEGACY-gated read/collaboration routes and the evidence list (ownerUserId arm, :2488).
- **Impact:** Removed member reads all legal notes (with author emails) and can soft-delete colleagues' work product on records they created. Bytes blocked by the download gate.
- **Reproduction:** Remove U from T; as U GET /v1/evidence/E/legal-notes (E created by U) -> 200; DELETE /v1/evidence/E/legal-notes/:noteId -> 200.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local fixture: revoke creator membership, call legal-notes GET/DELETE.
- **Recommended remediation:** Same as SEC-03: migrate to getEvidenceWithRecordAccess; drop the creator arm in canManageEvidenceCollaborativeContent for workspace rows.
- **Acceptance proof:** Revoked creator gets 404.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read evidence.routes.ts:3018 (creator short-circuit) against evidence-record-access.service.ts:79.
- **Owner decision:** Confirm creator access after leaving workspace is not an intended product rule.

```text
services/api/src/routes/evidence.routes.ts:3018  if (evidence.ownerUserId === userId) { return evidence; }
services/api/src/routes/evidence.routes.ts:3157  if (evidence.ownerUserId === userId) return true;
services/api/src/services/evidence/evidence-record-access.service.ts:79  row.teamId === null -> row.ownerUserId === input.userId (personal rule only); workspace rows -> evaluateMemberAccess
```

### ET-SEC-06

**P1 · concurrency/lifecycle · SOURCE_PROVEN_DEFECT** — Restore-from-trash 'succeeds' (200 + EVIDENCE_RESTORED custody) while the destruction executor holds its claim; executor then tombstones the restored record

- **Affected:** routes: POST /v1/evidence/:id/restore; jobs: destruction executor; tables: evidence, custody_events
- **Evidence:** `packages/shared-runtime/src/evidence-destruction/executor.ts:346`, `packages/shared/src/evidence-retention-lifecycle.ts:189`, `packages/shared/src/evidence-retention-lifecycle.ts:450`, `services/api/src/services/evidence/evidence-lifecycle.service.ts:360`, `packages/shared-runtime/src/evidence-destruction/executor.ts:608`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** PENDING_DESTRUCTION is not a product state, so resolveEvidenceProductState falls back to deletedAt -> TRASHED and restore is allowed; both restore and tombstone write by id only with no state predicate and no shared lock.
- **Expected:** Restore must fail (409) while a destruction claim is live, or the tombstone must be conditional on lifecycleState='PENDING_DESTRUCTION' with the claim timestamp.
- **Data flow:** Worker executor claim (evidence.lifecycleState=PENDING_DESTRUCTION, deletedAt still set) -> user POST /v1/evidence/:id/restore -> applyEvidenceLifecycleAction -> resolveEvidenceProductState falls back to trashedAt => TRASHED -> canRestoreFromTrash -> tx.evidence.update by id (ACTIVE) + EVIDENCE_RESTORED custody -> executor deletes S3 versions -> tx.evidence.update by id (DESTROYED).
- **Root cause:** PENDING_DESTRUCTION is not a product state, so the capability model sees a trashed record; both the restore write and the tombstone write are unconditional by id with no shared lock.
- **Blast radius:** Any trashed workspace or personal evidence whose grace has expired and is being destroyed by any of the 4 executor callers; affects the restoring user and the custody ledger.
- **Impact:** User told evidence is restored (custody says restored) but it is destroyed with a certificate: false success + evidence loss.
- **Reproduction:** Block executor after claim; POST /restore -> 200; resume; row DESTROYED.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration test with blocking storage stub as in SEC-01.
- **Recommended remediation:** Restore/lifecycle writes use updateMany with lifecycleState predicate excluding PENDING_DESTRUCTION + count check; tombstone updateMany where {id, lifecycleState:'PENDING_DESTRUCTION', destructionClaimedAtUtc: now}.
- **Acceptance proof:** Concurrent test returns 409 for restore or executor aborts.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted on the cited executor claim (PENDING_DESTRUCTION set in the claim) and the lifecycle restore write by id; the interleave was not runtime-exercised.

```text
packages/shared-runtime/src/evidence-destruction/executor.ts:346  data: { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: now, },
packages/shared/src/evidence-retention-lifecycle.ts:189  if (toDate(input.trashedAt)) return "TRASHED";
packages/shared/src/evidence-retention-lifecycle.ts:450  canRestoreFromTrash: trashed && !locked,
services/api/src/services/evidence/evidence-lifecycle.service.ts:360  await tx.evidence.update({ where: { id: evidence.id }, data: patch.data });
packages/shared-runtime/src/evidence-destruction/executor.ts:608  await tx.evidence.update({ where: { id: evidence.id }, data: { lifecycleState: "DESTROYED",
```

### ET-SEC-07

**P1 · tenancy/data-exposure · SOURCE_PROVEN_DEFECT** — Evidence relationships link records across workspaces; target metadata leaks to the source workspace's readers

- **Affected:** routes: POST /v1/evidence/:id/relationships, GET /v1/evidence/:id/relationships; tables: evidence_relationships
- **Evidence:** `services/api/src/routes/evidence.routes.ts:8404`, `services/api/src/routes/evidence.routes.ts:8405`, `services/api/src/routes/evidence.routes.ts:8413`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** No same-workspace equality (unlike evaluateCrossTeamAttach). listEvidenceRelationships returns the linked record's title, filename, status, caseId, teamId (relationship-summary.service.ts:84-127) to anyone with read on the source.
- **Expected:** Relationship target must be in the same workspace (or relationship listing must re-authorize the target per viewer).
- **Data flow:** POST /v1/evidence/:id/relationships -> getEvidenceWithRecordAccess(source) + getEvidenceWithReadAccess(target) -> evidence_relationships.create(teamId = source ?? target) -> GET /v1/evidence/:id/relationships -> listEvidenceRelationships returns target title/filename/status/caseId/teamId.
- **Root cause:** The relationship route authorizes source and target independently and never applies the evaluateCrossTeamAttach equality used for case links; the listing does not re-authorize the target per viewer.
- **Blast radius:** Any user who can read records in two workspaces (multi-workspace members, or legacy-gate admits such as revoked creators/CaseAccess holders); exposes target metadata to every reader of the source record.
- **Impact:** A user in two workspaces (or a revoked creator per SEC-05) exposes T2 record metadata to all T1 readers.
- **Reproduction:** User in T1 and T2 POST relationship S(T1)->X(T2); T1-only user GET /v1/evidence/S/relationships sees X filename.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local fixture with dual-membership user.
- **Recommended remediation:** Require target.teamId === evidence.teamId via evaluateCrossTeamAttach; filter listing by viewer access.
- **Acceptance proof:** Cross-workspace link returns 404; listing omits inaccessible targets.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Lead re-read evidence.routes.ts:8395-8430: the actor needs read access to both records, so exposure requires a dual-workspace member; kept P1.

```text
services/api/src/routes/evidence.routes.ts:8404  const evidence = await getEvidenceWithRecordAccess(userId, id, "evidence.update_metadata");
services/api/src/routes/evidence.routes.ts:8405  const target = await getEvidenceWithReadAccess(userId, body.targetEvidenceId);
services/api/src/routes/evidence.routes.ts:8413  teamId: evidence.teamId ?? target.teamId ?? null,
```

### ET-TSA-01

**P1 · TSA false-success / missing cryptographic validation · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — RFC3161 responses are accepted as STAMPED without signature, certificate-chain, trust-anchor, nonce or policy validation

- **Affected:** routes: POST /v1/evidence/:id/complete, GET /public/verify/:id; pages: /verify/[token], evidence detail; jobs: report generation, verification package; tables: evidence
- **Evidence:** `services/api/src/services/timestamp.service.ts:253`, `services/api/src/services/timestamp.service.ts:293`, `packages/shared/src/evidence-digest-policy.ts:204`, `services/worker/src/report-v2/normalizers.ts:360`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** The only acceptance test is a regex over `openssl ts -reply -text` output: status line Granted and (if present) a hexdump equal to the sent digest. No `openssl ts -verify`, no CMS signature check, no TSA cert chain / validity / EKU timeStamping check, no configured trust root, no nonce comparison, no policy OID check. TSA_URL scheme is not enforced (http allowed) and Basic credentials travel with it.
- **Expected:** A token is STAMPED only after `openssl ts -verify -queryfile request.tsq -in response.tsr -CAfile <pinned TSA roots>` (or equivalent CMS validation) succeeds: signature valid, signer cert chains to a configured root, EKU id-kp-timeStamping, cert valid at genTime, nonce equals request nonce, imprint+algorithm equal request, policy in allow-list.
- **Data flow:** fileSha256 -> openssl ts -query (nonce) -> curl POST TSA_URL -> response.tsr -> openssl -text -> parseTsaReply regex -> STAMPED -> Evidence.tsaStatus -> report 'Trusted timestamp token recorded' / public verify 'trusted timestamp linkage consistent' / package timestamp.tsr
- **Root cause:** Timestamp service treats openssl's human-readable print as validation; verification step was never implemented (the 'verify' OTel span wraps only the regex parse).
- **Blast radius:** Every TSA-stamped record platform-wide since TSA was enabled; all report, package and public-verify surfaces.
- **Impact:** Anyone able to answer the TSA HTTP request (misconfigured/test TSA_URL, DNS hijack, MITM on http URL, a proxy returning a cached/replayed reply) can make PROOVRA certify a record as having a trusted RFC3161 timestamp with an arbitrary genTime. External reviewers who run openssl ts -verify themselves would catch it; PROOVRA's own surfaces would not.
- **Reproduction:** Run a local HTTP server that answers any TimeStampReq with a response produced by `openssl ts -reply -queryfile - -signer selfsigned.crt -inkey selfsigned.key -config tsa.cnf` (self-signed, no trusted root), set TSA_ENABLED=true TSA_URL=http://127.0.0.1:PORT TSA_USERNAME=x TSA_PASSWORD=x, call createEvidenceTimestamp({digestHex}) -> status STAMPED.
- **Runtime evidence:** RT-TSA (rt-tsa.json): a token minted by a throwaway self-signed TSA over the correct digest -> `openssl ts -reply -text` + production parseTsaReply -> granted:true -> STAMPED; `openssl ts -verify` against the system CA bundle REFUSED it (self-signed certificate).
- **Recommended remediation:** Keep request.tsq; after reply run `openssl ts -verify -queryfile request.tsq -in response.tsr -CAfile $TSA_CA_BUNDLE [-untrusted chain]` (verifies signature, chain, imprint, nonce); require https TSA_URL; add TSA_CA_BUNDLE/TSA_POLICY_OIDS to the secrets/env authority with boot validation when TSA_ENABLED=true; FAILED with code tsa_signature_invalid on verification failure. Consider a read-time verifier for public verify.
- **Acceptance proof:** Probe above returns FAILED(tsa_signature_invalid) for self-signed TSA and STAMPED for the configured production root; nonce-replay probe returns FAILED.
- **Migration/backfill:** Offline re-verification of existing STAMPED rows from stored tsaTokenBase64 against the provider's root (report-only; do not mutate tsaStatus without owner decision).
- **Dependency:** Provider CA certificate(s) for the production TSA (GLOBALTRUST per incident notes).
- **Lead verification:** Lead re-read timestamp.service.ts:201-354 (only `openssl ts -reply -text`, no -verify). Then runtime-reproduced with a forged self-signed TSA token.
- **Owner decision:** Which TSA roots/policies are trusted in production; whether existing unverifiable rows get a new 'UNVERIFIED' presentation.

```text
services/api/src/services/timestamp.service.ts:253  const { stdout } = await execFileAsync("openssl", ["ts", "-reply", "-in", responseFile, "-text"], { timeout: timeoutMs() });
services/api/src/services/timestamp.service.ts:293  if (parsed.granted) { return { ... status: "STAMPED",
packages/shared/src/evidence-digest-policy.ts:204  it does not verify the token's signature or certificate chain, which nothing in the platform does.
services/worker/src/report-v2/normalizers.ts:360  return "Trusted timestamp token recorded";
```

### ET-TSA-03

**P1 · false verification claim (tautological comparison) · SOURCE_PROVEN_DEFECT** — Every read-side 'timestamp digest matches' check compares the sent digest to itself

- **Affected:** routes: GET /public/verify/:id, authenticated verify/review workspace; pages: /verify/[token]; jobs: worker recorded-integrity promotion, integrity snapshot; tables: evidence, evidence_integrity_snapshot
- **Evidence:** `services/api/src/services/timestamp.service.ts:306`, `services/api/src/services/evidence-complete.service.ts:1051`, `services/api/src/services/evidence-complete.service.ts:1074`, `packages/shared/src/evidence-digest-policy.ts:230`, `services/api/src/routes/evidence.routes.ts:1741`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** tsaMessageImprint (documented as 'the imprint the timestamping authority stamped') and tsaInputDigestHex are both written from tsaResult.messageImprint = the request digest; the parser's messageImprintHex is discarded. compareTimestampDigest therefore returns true for every STAMPED row, and public verify says the timestamp linkage is 'consistent', the web page counts it as a passed signal, basic verification reports basis IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED, and the worker promotion gate and integrity snapshot record timestampDigestMatches=true — including for rows from TSA-02 where no imprint was ever read, and for rows whose tsaTokenBase64 was later altered.
- **Expected:** Persist the imprint extracted from the token (or decode it at read time from tsaTokenBase64) and compare that to the sent digest; if not extracted, report null/unknown.
- **Data flow:** request digest -> both columns -> compareTimestampDigest -> timestampDigestMatches=true -> verify headline/summary, confidence score, promotion
- **Root cause:** timestamp.service returns messageImprint: digestHex instead of parsed.messageImprintHex.
- **Blast radius:** All STAMPED records; all verify surfaces.
- **Impact:** An affirmative verification claim ('imprint matches token') is made without reading the token; it can never detect a mismatch. Basis string is materially false for TSA-02 rows.
- **Reproduction:** For any STAMPED row: tsa_message_imprint = tsa_input_digest_hex by construction (SELECT count(*) FROM evidence WHERE tsa_status='STAMPED' AND tsa_message_imprint <> tsa_input_digest_hex -> 0).
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Store parsed.messageImprintHex in tsaMessageImprint (null when unparsed) and keep tsaInputDigestHex as the sent digest; or decode the imprint from tsaTokenBase64 at verify time.
- **Acceptance proof:** Unit: a Granted reply without an imprint block persists tsaMessageImprint=null and compareTimestampDigest returns null; mutating stored token to a different imprint yields false.
- **Migration/backfill:** Re-derive tsaMessageImprint for existing STAMPED rows by offline re-parse of tsaTokenBase64 (repair-style script, dry-run first).
- **Dependency:** none
- **Lead verification:** Lead re-read timestamp.service.ts:306 (messageImprint: digestHex — the REQUEST digest is persisted, the parsed imprint is discarded) and evidence-complete.service.ts:1051/1074.

```text
services/api/src/services/timestamp.service.ts:306  messageImprint: digestHex,
services/api/src/services/evidence-complete.service.ts:1051  tsaMessageImprint: tsaResult?.messageImprint ?? null,
services/api/src/services/evidence-complete.service.ts:1074  tsaInputDigestHex: tsaResult ? tsaResult.messageImprint : null,
packages/shared/src/evidence-digest-policy.ts:230  const imprint = normalizeHex(input.tsaMessageImprint); const sent = normalizeHex(input.tsaInputDigestHex) ?? ...; return imprint === sent;
services/api/src/routes/evidence.routes.ts:1741  trusted timestamp linkage, and OpenTimestamps linkage are available and consistent for this evidence record.
```

### ET-ACQ-01

**P2 · authorization / role inconsistency · SOURCE_PROVEN_DEFECT** — POST /v1/evidence authorizes by membership status only, so VIEWERs, members with expired access and members of SUSPENDED orgs can create workspace Evidence

- **Affected:** routes: POST /v1/evidence; pages: /capture; jobs: automation EVIDENCE_CREATED, webhook evidence.created; tables: evidence, custody_events; roles: VIEWER; plans: TEAM, ENTERPRISE
- **Evidence:** `services/api/src/services/evidence.service.ts:282`, `services/api/src/routes/evidence.routes.ts:5284`, `packages/shared/src/permissions.ts:533`, `services/api/src/services/identity/access-policy.service.ts:229`
- **Citations:** 3/4 resolve in the audited tree
- **Observed:** createEvidence accepts any ACTIVE TeamMember row for the caller-supplied teamId. It never runs evaluateMemberAccess or authorizeOrFail with evidence.create, so role, accessExpiresAtUtc and organization status are all ignored. The direct-capture door does run authorizeOrFail (capture-trust.routes.ts:711). The same bug was fixed for POST /v1/cases (plan-matrix test p7.team.direct_api.ui_locked_action_denied) but not for this route.
- **Expected:** Creation should go through the canonical evidence.create decision for the target workspace.
- **Data flow:** body.teamId -> createEvidence -> teamMember status check -> tx.evidence.create + custody + automation trigger + webhook
- **Root cause:** createEvidence uses a hand-rolled membership check instead of the canonical access engine.
- **Blast radius:** Every workspace that has VIEWER members, time-boxed members, or a suspended parent org.
- **Impact:** A VIEWER can create UPLOADING rows, custody events, automation runs and evidence.created webhooks. Those rows use up the TEAM rolling cap, and the viewer can PUT bytes to the root presigned URL. Completion is refused because parts and complete need evidence.update_metadata, so the rows stay orphaned permanently.
- **Reproduction:** Seed a TEAM workspace with a VIEWER member. POST /v1/evidence {type:'PHOTO', teamId} using the VIEWER's token. The expected answer is 403; the actual answer is 201.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Copy plan-matrix p7.team.direct_api.ui_locked_action_denied, point it at POST /v1/evidence, and assert with the denyWithoutSideEffects fingerprint.
- **Recommended remediation:** For non-personal captures, have createEvidence call evaluateMemberAccess with permission evidence.create, or have the route call authorizeOrFail first.
- **Acceptance proof:** VIEWER, expired-access and suspended-org requests get 403 and leave zero evidence, custody or automation rows.
- **Migration/backfill:** optional: find UPLOADING rows whose owner lacked evidence.create
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/evidence.service.ts:282  const activeMembership = membership?.status === "ACTIVE" ? membership : null;
services/api/src/routes/evidence.routes.ts:5284  app.post("/v1/evidence", { preHandler: requireAuthAndLegal }, async (req, reply) => {
packages/shared/src/permissions.ts:533  VIEWER: [ "evidence.read", ... (no evidence.create)
services/api/src/services/identity/access-policy.service.ts:229  if (organizationLifecycleApplies(actor.workspaceKind)) {
```

### ET-ACQ-02

**P2 · stuck state / plan counts wrong evidence · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Interrupted web captures leave Evidence in UPLOADING permanently; these rows count against record caps and are never reaped

- **Affected:** routes: POST /v1/evidence; pages: /capture; jobs: orphan-scan (count only); tables: evidence; plans: FREE, PRO, TEAM
- **Evidence:** `apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts:671`, `services/api/src/services/billing-enforcement.service.ts:460`, `services/worker/src/orphan-scan.ts:107`
- **Citations:** 3/3 resolve in the audited tree
- **Merged candidates:** acquisition:ACQ-02, commercial:COMMERCIAL-05, statemachine:STATEMACHINE-10
- **Observed:** The web client creates the Evidence row before any bytes are uploaded. If a part presign or PUT fails, the client throws and the row stays UPLOADING. A retry creates a new row. The cap counts include rows in every status, and orphan-scan only logs counts.
- **Expected:** Abandoned reservations should not use up plan capacity, and they should be reaped or resumed.
- **Data flow:** create row -> upload fails -> row stays UPLOADING -> retry creates a new row -> cap counts both
- **Root cause:** The row is reserved before upload, the cap predicate ignores status, and nothing reaps stale rows.
- **Blast radius:** All web captures. FREE has a lifetime cap of 3.
- **Impact:** A FREE user with a few failed uploads is refused new records while holding no signed evidence.
- **Reproduction:** As a FREE user, create 3 records via POST /v1/evidence without completing them. The 4th POST returns 409 FREE_LIMIT_REACHED.
- **Runtime evidence:** RT-COMMERCIAL/FREE: every counted row was CREATED/UPLOADING (3 UPLOADING + 1 CREATED, none completed) and the 4th attempt was refused 409 FREE_LIMIT_REACHED on their account. RT-INTAKE/INT-03 shows the same for an anonymous intake row.
- **Recommended remediation:** Count only finalized rows, or reuse the UPLOADING row on retry. Add a reaper that closes stale reservations with a custody event.
- **Acceptance proof:** The 4th capture is admitted, and the reaper closes stale rows with custody events.
- **Migration/backfill:** optional cleanup of stale UPLOADING rows
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Should abandoned reservations count toward caps?

```text
apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts:671  const created = await apiFetch("/v1/evidence", {
services/api/src/services/billing-enforcement.service.ts:460  return db.evidence.count({ where: { ownerUserId, deletedAt: null, lifecycleState: { not: "DESTROYED" },
services/worker/src/orphan-scan.ts:107  // Read-only first pass. ... NO destructive action is taken.
```

### ET-ACQ-03

**P2 · pipeline recovery / missing scan · SOURCE_PROVEN_DEFECT** — Malware scan, the evidence.completed webhook and finalization fanout fire once after commit; a retention or lock-snapshot failure or a crash skips them permanently

- **Affected:** routes: POST /v1/evidence/:id/complete, direct-capture complete; jobs: file security scan, finalization fanout, graph reconcile, webhook evidence.completed; tables: evidence
- **Evidence:** `services/api/src/services/evidence-complete.service.ts:1408`, `services/api/src/services/evidence-complete.service.ts:1483`, `services/api/src/services/evidence-complete.service.ts:1538`
- **Citations:** 3/3 resolve in the audited tree
- **Merged candidates:** acquisition:ACQ-03, statemachine:STATEMACHINE-05
- **Observed:** The SIGNED status is committed first. If retention or the lock snapshot then throws, everything after it is skipped. A retry takes the alreadyFinalized path, which re-requests OTS and the report but returns before the webhook, scan and fanout. grep shows enqueueScan and runEvidenceFinalizationFanout each have exactly one caller.
- **Expected:** These side effects should be durable (an outbox) or re-driven when the record is already finalized.
- **Data flow:** commit SIGNED -> retention throws -> 500 -> retry -> alreadyFinalized early return
- **Root cause:** Fire-once work runs after the commit with no outbox.
- **Blast radius:** Every completion that hits a transient Object Lock or HEAD failure, or a crash in that window.
- **Impact:** A signed original is never malware-scanned or indexed, and no evidence.completed webhook is sent.
- **Reproduction:** Make PutObjectRetention fail once, then call complete twice. No scan row is ever created.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration test with a storage double whose retention call fails the first time.
- **Recommended remediation:** Write outbox rows inside the finalize transaction, or run these side effects idempotently on the alreadyFinalized path.
- **Acceptance proof:** After the retry, a scan row and a fanout exist.
- **Migration/backfill:** Enqueue scans for SIGNED evidence that has no scan record.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/evidence-complete.service.ts:1408  `EVIDENCE_OBJECT_LOCK_SNAPSHOT_FAILED:${final.result.id}:${reason}`
services/api/src/services/evidence-complete.service.ts:1483  if (final.alreadyFinalized) return final.result;
services/api/src/services/evidence-complete.service.ts:1538  await enqueueScan({ evidenceId: ev.id, teamId: ev.teamId! });
```

### ET-ACQ-04

**P2 · pipeline capacity · SOURCE_PROVEN_DEFECT** — The size limit is checked only after every part has been streamed and hashed inside a 120s interactive DB transaction, and the presigned PUT does not limit Content-Length

- **Affected:** routes: POST /v1/evidence/:id/complete; pages: /capture; tables: evidence
- **Evidence:** `services/api/src/services/evidence-complete.service.ts:823`, `services/api/src/services/evidence-complete.service.ts:1264`
- **Citations:** 2/2 resolve in the audited tree
- **Merged candidates:** acquisition:ACQ-04, statemachine:STATEMACHINE-06
- **Observed:** Every part is downloaded and hashed before the total is compared with MAX_EVIDENCE_SIZE (default 1 GiB). Hashing, signing and the TSA call all run inside the transaction.
- **Expected:** Reject oversize uploads using the HEAD sizes first, and hash outside the interactive transaction.
- **Data flow:** PUT of any size -> complete -> full stream -> timeout or 413
- **Root cause:** The size check runs after the streaming loop, and the I/O runs inside the DB transaction.
- **Blast radius:** Large uploads.
- **Impact:** A large legitimate upload can time out on every attempt and stay UPLOADING. Oversize uploads waste server bandwidth and DB connections.
- **Reproduction:** Upload about 1 GiB over a throttled S3 connection and call complete.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Latency rig with a throttled storage double.
- **Recommended remediation:** Sum the HEAD sizes before streaming, and hash before the transaction, bound to versionId.
- **Acceptance proof:** An oversize upload gets 413 without any GET, and a large upload completes.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/evidence-complete.service.ts:823  const maxBytes = readMaxEvidenceSizeBytes();
services/api/src/services/evidence-complete.service.ts:1264  timeout: 120_000,
```

### ET-COM-02

**P2 · plan limit bypass · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Trash releases a FREE record slot but Restore-from-trash re-admits the record with no cap check, so FREE (and the frozen downgrade cap) can be exceeded without limit

- **Affected:** routes: POST /v1/evidence/:id restore (RESTORE_FROM_TRASH), POST /v1/evidence; pages: Evidence library / Trash; tables: evidence; roles: owner; plans: FREE, PRO (lifetime cap), downgraded accounts with legacyRecordCapOverride
- **Evidence:** `services/api/src/services/billing-enforcement.service.ts:464`, `services/api/src/services/evidence/evidence-lifecycle.service.ts:482`, `services/api/src/services/evidence/evidence-lifecycle.service.ts:325`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The count excludes trashed rows. The lifecycle service's restore path runs only the capability gate (and the governance gate for ARCHIVE/TRASH); nothing calls assertWorkspaceAllowsEvidenceCreation or countPersonalEvidenceRecords on restore.
- **Expected:** Restoring a record into the counted population is admission and must pass the same allowance (or be refused / require a credit), or trashed records must keep their slot.
- **Data flow:** FREE 3/3 -> TRASH #1 (count 2) -> create #4 admitted and settled PLAN -> RESTORE #1 -> 4 active PLAN-funded records; repeat indefinitely during the 90-day trash grace.
- **Root cause:** Slot release was designed (comment at billing-enforcement.service.ts:409) without a matching re-admission check on the reverse transition.
- **Blast radius:** All lifetime-capped personal accounts.
- **Impact:** The published FREE 3-record limit (and PRO 100 / frozen downgrade caps) is not enforced; storage cap still applies.
- **Reproduction:** FREE account with 3 SIGNED records: trash one, create+complete a new one, restore the trashed one; GET billing usage shows 4 of 3 and creation of a 5th is refused only then.
- **Runtime evidence:** RT-COMMERCIAL/FREE (rt-commercial-free.json): FREE user at 4 active (after the race), trash -> 3, create refused 409 FREE_LIMIT_REACHED, POST /v1/evidence/:id/restore 200 -> 4 active records on a 3-record plan.
- **Recommended remediation:** Run the admission policy (under the evidence-capacity advisory lock) before RESTORE_FROM_TRASH for personal records; refuse with FREE_LIMIT_REACHED or spend a credit, per owner decision.
- **Acceptance proof:** Restore at 3/3 on FREE returns 409 FREE_LIMIT_REACHED and leaves the record TRASHED.
- **Migration/backfill:** none (existing over-cap accounts are handled like downgrade grandfathering)
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Should restore be refused, credit-funded, or should trashed records keep occupying their slot?

```text
services/api/src/services/billing-enforcement.service.ts:464  deletedAt: null, lifecycleState: { not: "DESTROYED" },
services/api/src/services/evidence/evidence-lifecycle.service.ts:482  case "RESTORE_FROM_TRASH": return { data: { lifecycleState: "ACTIVE", deletedAt: null,
services/api/src/services/evidence/evidence-lifecycle.service.ts:325  if (input.action === "ARCHIVE" || input.action === "TRASH") { const { runDestructiveActionGate } = await import(
```

### ET-COM-03

**P2 · credit refund / chargeback · SOURCE_PROVEN_DEFECT** — Stripe credit refunds and chargebacks never reverse evidence credits (only PayPal is handled)

- **Affected:** routes: POST /v1/webhooks/stripe; pages: Billing; jobs: billing-reconciliation; tables: entitlements, evidence_credit_ledger_entries, payments; roles: personal payer; plans: FREE + credits
- **Evidence:** `services/api/src/services/billing/evidence-credits.service.ts:338`, `services/api/src/services/billing/paypal-settlement.service.ts:771`, `services/api/src/routes/webhooks.routes.ts:253`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The Stripe webhook handles checkout.session.completed/expired, customer.subscription.*, invoice.paid/payment_failed only; grep finds no charge.refunded / charge.dispute.* handling and no Stripe caller of reverseEvidenceCreditPurchase. Stripe reconciliation observes subscriptions/sessions, not refunds.
- **Expected:** One refund/reversal policy for both providers: unspent credits removed, shortfall to review.
- **Data flow:** Stripe refund -> no event consumed -> entitlements.credits unchanged -> credit still spendable -> a later record settles EVIDENCE_CREDIT and earns report+package.
- **Root cause:** The 2026-09-28 refund work was PayPal-only.
- **Blast radius:** Every Stripe evidence-credit purchase.
- **Impact:** Refunded or charged-back credits keep funding paid records and outputs; the wallet's PURCHASE history overstates money received.
- **Reproduction:** Buy a credit via Stripe test mode, refund it in the dashboard, observe wallet balance unchanged and a new record consuming it.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Post a signed charge.refunded fixture to the local webhook route; assert no ledger REVERSAL row is written (currently not handled).
- **Recommended remediation:** Handle charge.refunded / charge.dispute.closed(lost) for EVIDENCE_CREDIT payments by calling reverseEvidenceCreditPurchase with the same providerRef used at grant.
- **Acceptance proof:** Stripe refund fixture produces one REVERSAL entry and decrements unspent credits; duplicate delivery is a no-op.
- **Migration/backfill:** Reconcile historic Stripe refunds against PURCHASE rows.
- **Dependency:** Stripe provider access for refund listing
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/billing/evidence-credits.service.ts:338  export async function reverseEvidenceCreditPurchase(params: {
services/api/src/services/billing/paypal-settlement.service.ts:771  const reversal = await reverseEvidenceCreditPurchase({
services/api/src/routes/webhooks.routes.ts:253  if (event.type === "checkout.session.completed") {
```

### ET-COM-04

**P2 · plan/role inconsistency · SOURCE_PROVEN_DEFECT** — A lapsed (PAST_DUE beyond grace) or ambiguous (two live subscriptions) paid account cannot create ANY evidence — worse than FREE and unable to spend purchased credits

- **Affected:** routes: POST /v1/evidence, direct-capture reserve, external intake submission; pages: Capture; tables: subscriptions; roles: personal subscriber, intake contributors of that owner; plans: PRO, TEAM
- **Evidence:** `services/api/src/services/billing-enforcement.service.ts:171`, `packages/shared-runtime/src/billing/commercial-lifecycle.ts:86`, `packages/shared-runtime/src/billing/commercial-lifecycle.ts:112`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The lifecycle gate throws 402 COMMERCIAL_LIFECYCLE_RESTRICTED before the cap/credit logic. The plan stays PRO until the provider sends CANCELED, so the FREE allowance never applies in between; a PAST_DUE row with unknown period end is immediately EXPIRED; two live same-plan subscriptions (e.g. supersession cancel failed) read CANCELLED.
- **Expected:** Losing paid status should degrade to FREE-equivalent admission (and still allow wallet credits), not a total capture lockout.
- **Data flow:** PAST_DUE row -> readCommercialLifecycle PAST_DUE_EXPIRED -> scope.commercialLifecycle.mutationsAllowed=false -> every createEvidence refused.
- **Root cause:** The lifecycle gate is plan-agnostic and precedes the funding policy.
- **Blast radius:** Any paid personal account in dunning after period end + 7 days, or with a failed supersession cancel.
- **Impact:** Customer (and their intake contributors) cannot preserve new evidence at all, including with credits they bought.
- **Reproduction:** Set entitlement PRO and one PAST_DUE subscription with currentPeriodEnd = now-8d; POST /v1/evidence -> 402 COMMERCIAL_LIFECYCLE_RESTRICTED even with credits>0 and 0 records.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration test on local PG with the rows above calling createEvidence.
- **Recommended remediation:** Owner decision; e.g. when mutationsAllowed=false evaluate admission as FREE (cap 3 / frozen override) plus wallet instead of refusing outright.
- **Acceptance proof:** Lapsed account with 1 record and 0 credits can create records up to the FREE-equivalent cap; with credits, beyond it.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Is total capture lockout intended for lapsed paid accounts?

```text
services/api/src/services/billing-enforcement.service.ts:171  assertCommercialLifecycleAllowsPaidMutation(scope);
packages/shared-runtime/src/billing/commercial-lifecycle.ts:86  if (live.length > 1) { return { state: "CANCELLED", paidActive: false, mutationsAllowed: false,
packages/shared-runtime/src/billing/commercial-lifecycle.ts:112  if (periodEnd === null) { return { state: "PAST_DUE_EXPIRED",
```

### ET-CUS-02

**P2 · missing custody event · SOURCE_PROVEN_DEFECT** — Chain-of-custody transfers never write a custody event: the event type does not exist in the enum and the failure is swallowed

- **Affected:** routes: POST /v1/exchange/chain-transfers, POST /v1/exchange/chain-transfers/:id/accept, POST /v1/exchange/chain-transfers/:id/complete; tables: custody_events, chain_transfers; roles: ORG_ADMIN, REVIEWER_LEAD; plans: FEATURE_CHAIN_TRANSFER
- **Evidence:** `services/api/src/services/exchange/chain-transfer.service.ts:87`, `services/api/src/services/exchange/chain-transfer.service.ts:96`, `services/api/prisma/schema.prisma:3057`, `services/api/src/routes/product-and-lifecycle.routes.ts:813`
- **Citations:** 3/4 resolve in the audited tree
- **Observed:** emitTransferCustodyEvents is called on initiate, accept and complete (chain-transfer.service.ts:176, 237, 365) with an eventType missing from the Prisma/Postgres enum, cast through `as any`. Every append fails enum validation and the empty .catch swallows it, with no log.
- **Expected:** A custody transfer (the I4 'custody continuity on transfer' promise) should appear in each transferred record's chain.
- **Data flow:** route -> initiateChainTransfer -> void emitTransferCustodyEvents -> appendCustodyEvent -> Prisma enum validation error -> swallowed.
- **Root cause:** Enum value never added; `as any` hides the type error; silent catch hides the runtime error.
- **Blast radius:** Every chain transfer ever made.
- **Impact:** Custody timelines omit the most custody-relevant event, the hand-off between organisations. Latent risk: evidenceIds and fromOrganizationId come from the request body and are not bound to ctx.teamId, so simply adding the enum value would let a caller append events into other tenants' chains.
- **Reproduction:** POST /v1/exchange/chain-transfers with one evidence id, then read custody for that evidence: there is no transfer event.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local fixture with FEATURE_CHAIN_TRANSFER: initiate a transfer and count custody_events for the id before and after.
- **Recommended remediation:** Add the enum value by migration. Validate that every evidenceId belongs to ctx.teamId before creating the transfer. Append in the same tx as the transfer state change, or at least log failures through noteCustodyFailure.
- **Acceptance proof:** Integration test: initiate/accept/complete each append exactly one event per evidence; a foreign evidenceId is rejected with 4xx.
- **Migration/backfill:** optional: backfill transfer events from chain_transfers history with a 'backfilled' payload flag
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/exchange/chain-transfer.service.ts:87  eventType: "CHAIN_TRANSFER_CUSTODY_EXTENDED" as any,
services/api/src/services/exchange/chain-transfer.service.ts:96  }).catch(() => { /* fire-and-forget — audit fan-out must never break the operational write */
services/api/prisma/schema.prisma:3057  enum CustodyEventType { ... INVESTIGATION_DUPLICATES_EXPORTED } // no CHAIN_TRANSFER_CUSTODY_EXTENDED; zero migrations add it
services/api/src/routes/product-and-lifecycle.routes.ts:813  evidenceIds: z.array(z.string().uuid()).min(1).max(500),
```

### ET-CUS-03

**P2 · missing custody event / best-effort · SOURCE_PROVEN_DEFECT** — Legal hold place/release reach the custody chain only best-effort: silent failure, CASE scope capped at 1000 in one Promise.all burst, WORKSPACE scope and later-linked evidence never recorded

- **Affected:** routes: legal hold place/release routes (product-and-lifecycle / governance-lifecycle); pages: Evidence custody tab, Public verify; tables: custody_events, evidence_legal_holds; plans: FEATURE_LEGAL_HOLD
- **Evidence:** `services/api/src/services/governance/legal-hold.service.ts:563`, `services/api/src/services/governance/legal-hold.service.ts:581`, `services/api/src/services/governance/legal-hold.service.ts:598`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The hold row commits first. fanOutCustodyEvents then launches up to 1000 concurrent appendCustodyEvent transactions (each takes an advisory lock and a pool connection), swallowing every failure with no log or metric. Case members beyond 1000 get nothing. WORKSPACE holds write nothing per evidence. Evidence linked to a held case later gets no CASE_LEGAL_HOLD_APPLIED.
- **Expected:** Every record whose export or destruction is blocked by a hold should show that hold in its custody chain, or the timeline should state explicitly that holds are recorded elsewhere.
- **Data flow:** placeLegalHold -> evidenceLegalHold.create -> fanOutCustodyEvents -> Promise.all(appendCustodyEvent...catch(()=>null))
- **Root cause:** Custody treated as a notification fan-out rather than part of the hold mutation.
- **Blast radius:** All CASE holds over 1000 records (and smaller ones under pool pressure), every WORKSPACE hold, and all post-hold case links.
- **Impact:** The custody timeline and public verify can show no hold on held evidence. With a 1000-way burst against a finite pool, many appends time out and are silently missing.
- **Reproduction:** Place a CASE hold on a case with 1500 linked records; count LEGAL_HOLD events. At most 1000, and likely fewer with a small pool.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local PG with connection_limit=5: case with 200 linked evidence, place hold, count CASE_LEGAL_HOLD_APPLIED rows.
- **Recommended remediation:** Write per-evidence events in bounded, paginated batches through a durable job (outbox) with observable failure. Record case-link-after-hold. Show 'covered by workspace hold' in projections from the hold table.
- **Acceptance proof:** Test: a 1500-member case hold yields 1500 events; an injected failure surfaces in custody_event_append_failed_total.
- **Migration/backfill:** backfill events for active holds from evidence_legal_holds
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/governance/legal-hold.service.ts:563  * WORKSPACE scope intentionally does NOT fan out per-evidence
services/api/src/services/governance/legal-hold.service.ts:581  take: 1000,
services/api/src/services/governance/legal-hold.service.ts:598  }).catch(() => null),
```

### ET-CUS-04

**P2 · append-only enforcement · SOURCE_PROVEN_DEFECT** — custody_events and admin_audit_logs are append-only only by convention: no trigger or REVOKE, unkeyed hash, and a fully hash-stripped chain verifies as 'legacy' valid

- **Affected:** pages: Public verify, Evidence detail; tables: custody_events, admin_audit_logs; roles: any DB principal used by API/worker/scripts
- **Evidence:** `services/api/prisma/migrations/20280601000000_uc0_acquisition_provenance_foundation/migration.sql:128`, `services/api/scripts/seed-home-personas.ts:133`, `services/api/src/services/custody-events.service.ts:134`, `services/api/src/services/custody-events.service.ts:179`, `packages/shared/src/custody-hash.ts:59`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** No DB mechanism prevents UPDATE or DELETE on custody_events or admin_audit_logs, and the app role can do both (a repo script deletes custody rows; destruction used to deleteMany the chain, per the processor.ts:5606 comment). The custody hash is plain sha256, so any writer can rewrite a self-consistent chain. Setting every row's hashes to NULL makes the verifier report valid:true, mode 'legacy'. ip/userAgent sit outside the hash. The admin chain's anchoredAt column is never written, so there is no external anchor.
- **Expected:** An evidentiary custody log should resist in-band modification: a BEFORE UPDATE OR DELETE trigger raising an exception (with a controlled break-glass role), plus periodic external anchoring of chain heads. The verifier should not accept a hash-less chain for records created after hashing shipped.
- **Data flow:** n/a
- **Root cause:** Integrity relies on application discipline only.
- **Blast radius:** All custody and audit history.
- **Impact:** An insider, a compromised credential, or a mis-pointed dev script (see the memory note that services/api/.env points at production) can alter or erase custody undetectably.
- **Reproduction:** UPDATE custody_events SET event_hash=NULL, prev_event_hash=NULL WHERE evidence_id=E; GET /v1/public/verify/E then reports custodyChainValid:true, custodyChainMode:'legacy'.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local PG: finalize evidence, null its hashes, call public verify.
- **Recommended remediation:** Migration adding BEFORE UPDATE OR DELETE triggers on both tables (allowing only the destruction tombstone path, if any). Treat mode 'legacy' as valid only when every row predates the hashing cutover (compare created_at). Anchor chain heads (e.g. per-report custodyThroughSequence + head hash in the signed report, plus periodic TSA/OTS of the admin chain head).
- **Acceptance proof:** Integration test: UPDATE/DELETE on custody_events raises; stripping hashes on a post-cutover record yields valid:false.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Break-glass policy for legitimate corrections.

```text
services/api/prisma/migrations/20280601000000_uc0_acquisition_provenance_foundation/migration.sql:128  CREATE OR REPLACE FUNCTION "evidence_acquisition_set_once"() RETURNS trigger // the only trigger in the migration set
services/api/scripts/seed-home-personas.ts:133  await prisma.custodyEvent.deleteMany({
services/api/src/services/custody-events.service.ts:134  const hasAnyHashes = records.some((r) => r.eventHash || r.prevEventHash);
services/api/src/services/custody-events.service.ts:179  return { valid: true, mode: hasAnyHashes ? ("hashed" as const) : ("legacy" as const),
packages/shared/src/custody-hash.ts:59  return sha256Hex(canonical);
```

### ET-CUS-05

**P2 · audit chain integrity / false tamper alarm · SOURCE_PROVEN_DEFECT** — Admin audit hash chain can fork under API/worker clock skew or same-millisecond writes, so the verifier reports a break with no tampering

- **Affected:** routes: GET /v1/admin/audit-log/verify; pages: Admin audit; jobs: all worker audit writes; tables: admin_audit_logs; roles: platform admin
- **Evidence:** `services/api/src/services/platform-audit-log.service.ts:296`, `services/api/src/services/platform-audit-log.service.ts:300`, `services/worker/src/platform-audit-append.ts:123`, `services/api/prisma/schema.prisma:2667`, `services/api/src/services/platform-audit-log.service.ts:550`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** The advisory lock serialises commits, but each writer picks its predecessor as MAX(createdAt, id), where createdAt is the writer's own host clock and id is a random UUIDv4. If the worker's clock trails the API's, or two consecutive rows share a millisecond and the later row gets a smaller UUID, the newest row is not the MAX. The next writer links to the older row, two rows share one prevHash, and verifyOrderedRows (in createdAt, id order) hits prevHash !== previousHash and returns brokenAt.
- **Expected:** Predecessor selection and verification order should use a DB-assigned monotonic key (bigserial or sequence) captured under the lock, with the timestamp from DB now().
- **Data flow:** API appendPlatformAuditLog / worker appendWorkerAuditLog -> same global chain -> verifyAdminAuditChain
- **Root cause:** Ordering key is app-clock time plus a random UUID rather than commit order.
- **Blast radius:** Whole platform audit chain. Once forked, every later verification of the full chain reports broken.
- **Impact:** False 'chain broken' alarms erode trust in the tamper-evidence claim and mask genuine tampering.
- **Reproduction:** Run the worker with a clock 50 ms behind the API; interleave worker and API audit writes; call /v1/admin/audit-log/verify.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit harness against local PG: write row A with createdAt T, row B with T-1ms (simulated worker), row C via appendPlatformAuditLog, then verifyAdminAuditChain -> brokenAt.
- **Recommended remediation:** Add a bigserial chain_seq column; under the advisory lock select the predecessor by chain_seq desc and set createdAt from SELECT now() (or clock_timestamp()); verify by chain_seq. Bump chainVersion.
- **Acceptance proof:** Test with skewed createdAt inputs verifies clean.
- **Migration/backfill:** assign chain_seq to historical rows by walking prevHash links
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/platform-audit-log.service.ts:296  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
services/api/src/services/platform-audit-log.service.ts:300  const createdAt = new Date();
services/worker/src/platform-audit-append.ts:123  const createdAt = new Date();
services/api/prisma/schema.prisma:2667  id             String    @id @default(uuid())
services/api/src/services/platform-audit-log.service.ts:550  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
```

### ET-CUS-06

**P2 · package integrity / contradictory timestamps · SOURCE_PROVEN_DEFECT** — A retried package build (PACKAGE_FOR_VERSION) selects custody by atUtc instead of sequence, so custody.json can contain a sequence gap and broken prevHash links while claiming to be complete

- **Affected:** pages: Verification package custody.json; jobs: report-v2 / package generation retry; tables: custody_events, verification_packages
- **Evidence:** `services/worker/src/processor.ts:3226`, `services/worker/src/processor.ts:3298`, `services/worker/src/processor.ts:3982`, `services/worker/src/processor.ts:2591`, `services/worker/src/verification-package.ts:2062`
- **Citations:** 5/5 resolve in the audited tree
- **Merged candidates:** custody:CUSTODY-06, reports:REPORTS-08
- **Observed:** Report issuance events (REPORT_IDENTITY_CONTEXT_RECORDED, REPORT_GENERATED, REVIEW_READY, REPORT_PDF_*) are appended at commit with atUtc = prepared.now, captured before rendering. Any event the API appends during rendering (EVIDENCE_VIEWED, REPORT_DOWNLOADED of a prior version, legal hold, VERIFY_VIEWED) gets a LOWER sequence but a LATER atUtc. When the package stage is retried via loadCommittedReportForPackage (processor.ts:3521), the atUtc <= generatedAtUtc filter drops those events and keeps the higher-sequence issuance events. custody.json then has a gap, the first issuance event's prevEventHash points at an omitted row, and custodyThroughSequence claims coverage it lacks.
- **Expected:** Select by sequence <= report.custodyThroughSequence, the value the report recorded. Issuance events should carry commit-time atUtc, or the timeline should sort and label by sequence.
- **Data flow:** prepareReportArtifacts (now) -> render -> tx appends events at prepared.now -> package fails -> retry PACKAGE_FOR_VERSION -> loadCommittedReportForPackage atUtc filter -> custody.json
- **Root cause:** Time-based cut-off on an app-clock field instead of the recorded sequence cut-off.
- **Blast radius:** Packages rebuilt on retry for reports during whose rendering any custody event landed. The customer-visible timeline also shows non-monotonic times.
- **Impact:** A third party verifying custody.json link-by-link sees a broken chain on an untampered record. The package README's completeness claim is false.
- **Reproduction:** Start report generation; while it renders, GET /v1/evidence/:id/original (EVIDENCE_VIEWED); force the package stage to fail once; on retry inspect custody.json sequences.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Worker integration test: seed evidence, set prepared.now, append an API event with atUtc = now+1s, commit report tx, invoke loadCommittedReportForPackage, assert contiguous sequences.
- **Recommended remediation:** Use `sequence: { lte: report.custodyThroughSequence }` (fall back to the atUtc filter only for legacy rows without it). Stamp issuance events with the commit-time clock.
- **Acceptance proof:** The test above passes; custody.json for retried packages equals the first-attempt chain prefix.
- **Migration/backfill:** none (affected historical packages could be flagged by checking for sequence gaps)
- **Dependency:** reports domain (package stage)
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/processor.ts:3226  where: { evidenceId, atUtc: { lte: report.generatedAtUtc } },
services/worker/src/processor.ts:3298  custodyThroughSequence: custodyEvents.at(-1)?.sequence ?? null,
services/worker/src/processor.ts:3982  atUtc: prepared.now,
services/worker/src/processor.ts:2591  const now = new Date();
services/worker/src/verification-package.ts:2062  custody.json contains the complete immutable sequence of all recorded system events.
```

### ET-CUS-07

**P2 · missing custody event (external access) · SOURCE_PROVEN_DEFECT** — Presigned ORIGINAL URLs issued by the parts listing, record views and public verify leave no custody event; only /original is recorded, and EVIDENCE_DOWNLOADED is never emitted

- **Affected:** routes: GET /v1/evidence/:id/parts, record views (evidence.routes.ts:9196, 10029, 10382), GET /v1/public/verify/:id (12963); pages: Evidence detail, Public verify; tables: custody_events; roles: workspace readers, anonymous public viewers
- **Evidence:** `services/api/src/routes/evidence.routes.ts:6216`, `services/api/src/routes/evidence.routes.ts:12963`, `services/api/src/routes/evidence.routes.ts:11549`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The code comments call a part URL 'AN ORIGINAL DOWNLOAD', yet only /original appends EVIDENCE_VIEWED. The parts listing, three record views and public verify mint 10-minute presigned GETs of original objects. Public verify writes only a 24h-debounced VERIFY_VIEWED. The EVIDENCE_DOWNLOADED enum value has zero writers.
- **Expected:** Every release of original-byte access, and at least each distinct authenticated actor per surface, should append an access custody event.
- **Data flow:** view -> presignGetObject(original) -> URL returned -> no custody row
- **Root cause:** Custody recording is tied to one route rather than to the presign authority.
- **Blast radius:** All original-byte access except the /original route.
- **Impact:** The access timeline understates who obtained original bytes; the 'access events' section on Verify is incomplete.
- **Reproduction:** GET /v1/evidence/:id/parts as a workspace member; access custody count is unchanged although part URLs are returned.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Count access custody events before and after /parts on a local fixture.
- **Recommended remediation:** Record access at the presign authority: one event per request that returns original URLs (actor, surface, part count), debounced per actor.
- **Acceptance proof:** Test that each surface returning original URLs appends one access event.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Whether a URL issuance (vs a confirmed download) is the recorded fact.

```text
services/api/src/routes/evidence.routes.ts:6216  await evaluateArtifactDownload({ evidenceId: id, actorUserId: ownerUserId, kind: "original", ... // A listing is not a download attempt: no custody event.
services/api/src/routes/evidence.routes.ts:12963  originalReleaseAllowed: await originalReleaseForPublic(evidence.id),
services/api/src/routes/evidence.routes.ts:11549  eventType: prismaPkg.CustodyEventType.EVIDENCE_VIEWED, ... accessMode: "authenticated_original_access",
```

### ET-CUS-08

**P2 · missing custody event / misleading timeline · SOURCE_PROVEN_DEFECT** — Unlock writes no custody event and EVIDENCE_LOCKED serves two meanings, so the timeline says 'Evidence record locked' after the record is unlocked

- **Affected:** routes: POST /v1/evidence/:id/lock, POST /v1/evidence/:id/unlock; pages: Custody tab, Public verify; tables: custody_events
- **Evidence:** `services/api/src/routes/evidence.routes.ts:6553`, `services/api/src/routes/evidence.routes.ts:6445`, `services/api/src/services/evidence-complete.service.ts:1364`, `services/api/src/routes/evidence.routes.ts:2069`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** Unlock clears lockedAt with only a fire-and-forget tenant audit, and no unlock custody type exists. Lock appends EVIDENCE_LOCKED best-effort after the update. The same type marks storage Object Lock at completion. Both render as 'Evidence record locked.'
- **Expected:** Lock and unlock as distinct custody facts written in the mutation's tx; storage protection under its own type.
- **Data flow:** unlock route -> evidence.update -> audit only
- **Root cause:** Unlock never added to the custody model.
- **Blast radius:** Every unlocked record.
- **Impact:** The custody chain and Verify imply the record is locked when it is not.
- **Reproduction:** Lock, then unlock, then view the custody tab: it still shows EVIDENCE LOCKED and nothing after it.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add EVIDENCE_UNLOCKED (with reason) and write lock and unlock inside a tx with the update. Rename or relabel the storage-lock event.
- **Acceptance proof:** Test: lock -> unlock produces two ordered custody events with distinct labels.
- **Migration/backfill:** optional backfill from audit rows action=evidence.unlock
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:6553  data: { lockedAt: null, lockedByUserId: null },
services/api/src/routes/evidence.routes.ts:6445  eventType: prismaPkg.CustodyEventType.EVIDENCE_LOCKED, payload: { lockedByUserId: ownerUserId },
services/api/src/services/evidence-complete.service.ts:1364  eventType: prismaPkg.CustodyEventType.EVIDENCE_LOCKED, ... retentionApplied: true,
services/api/src/routes/evidence.routes.ts:2069  case prismaPkg.CustodyEventType.EVIDENCE_LOCKED: return "Evidence record locked.";
```

### ET-CUS-09

**P2 · package claims completeness when incomplete · SOURCE_PROVEN_DEFECT** — Exchange package custody-chain.json omits payloads (hashes cannot be recomputed), truncates at 500 events, and turns a DB error into an empty chain

- **Affected:** jobs: pollExchangePackageBuilds (worker index.ts:1523); tables: custody_events; roles: external package recipients
- **Evidence:** `services/worker/src/exchange-package-builder.ts:366`, `services/worker/src/exchange-package-builder.ts:375`
- **Citations:** 2/2 resolve in the audited tree
- **Merged candidates:** custody:CUSTODY-09, package-verify:PKGV-16
- **Observed:** The per-evidence custody-chain.json in exchange packages lacks payload, so a recipient cannot recompute eventHash. It is capped at the first 500 events, and a query failure writes events: [] with no degraded flag.
- **Expected:** The full chain with payloads (or explicit truncation and degraded markers), and a build failure rather than a silently empty chain.
- **Data flow:** worker build -> custodyEvent.findMany(take 500, no payload).catch(()=>[]) -> zip
- **Root cause:** Best-effort export design.
- **Blast radius:** All EVIDENCE-kind exchange packages.
- **Impact:** External recipients receive a custody chain they cannot verify, which may be silently empty or truncated.
- **Reproduction:** Build an exchange package for evidence with more than 500 events and inspect custody-chain.json.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local worker run with a 600-event fixture.
- **Recommended remediation:** Include payload, drop the cap (or paginate and record totals), fail the build (or mark it degraded) on query error.
- **Acceptance proof:** The recipient-side verifier recomputes the chain from the file.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/exchange-package-builder.ts:366  take: 500, select: { sequence: true, eventType: true, atUtc: true, eventHash: true, prevEventHash: true },
services/worker/src/exchange-package-builder.ts:375  .catch(() => []);
```

### ET-CUS-10

**P2 · governance driven by access events · SOURCE_PROVEN_DEFECT** — Retention auto-extension fires on ANY recent custody event, including anonymous public VERIFY_VIEWED, and the extension itself is not recorded in custody

- **Affected:** jobs: retention-reconciliation.worker; tables: evidence, custody_events, evidence_lifecycle_events; roles: anonymous public viewer; plans: retention policies with autoExtensionEnabled
- **Evidence:** `services/worker/src/governance/retention-reconciliation.worker.ts:206`, `services/worker/src/governance/retention-reconciliation.worker.ts:215`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** The auto-extension check counts any custody row in the last 7 days, including VERIFY_VIEWED written by anonymous public page loads (one per 24h), EVIDENCE_VIEWED, and repeating DELETE_BLOCKED/OTS_ATTEMPT_ERROR rows. Retention is then extended with a lifecycle event (a separate statement, not in a tx) and no custody event.
- **Expected:** Extension should key on material forensic activity (or an explicit policy list). The retention change should be recorded in custody.
- **Data flow:** public verify -> VERIFY_VIEWED -> reconciliation finds recentCustody -> retentionUntilUtc extended
- **Root cause:** An unfiltered 'any custody event' predicate.
- **Blast radius:** Published records under auto-extending policies.
- **Impact:** Any outsider holding the verify link can keep a record from ever reaching retention expiry and destruction, defeating the retention schedule.
- **Reproduction:** Auto-extend policy, published evidence past retention; load public verify daily; the reconciliation run extends instead of queuing destruction.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Worker test: seed a VERIFY_VIEWED within 7 days, run reconciliation, assert extension happened.
- **Recommended remediation:** Filter to classifyCustodyEventType === 'forensic' and exclude system-generated types. Write RETENTION_EXTENDED custody in a tx with the update.
- **Acceptance proof:** Test: access-only activity does not extend.
- **Migration/backfill:** none
- **Dependency:** governance domain
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Which activity legitimately extends retention.

```text
services/worker/src/governance/retention-reconciliation.worker.ts:206  const recentCustody = await prisma.custodyEvent.findFirst({ where: { evidenceId: ev.id, atUtc: { gte: windowStart } },
services/worker/src/governance/retention-reconciliation.worker.ts:215  await prisma.evidence.update({ where: { id: ev.id }, data: { retentionUntilUtc: nextRetention },
```

### ET-CUS-11

**P2 · best-effort custody after mutation · SOURCE_PROVEN_DEFECT** — Many material governance mutations commit first and append custody in a separate transaction with a SILENT catch, so a failure leaves the mutation done and the chain missing it with no signal

- **Affected:** routes: publication routes, destructive gate, finalization governance, case export, certifications; pages: Custody tab, Public verify; tables: custody_events
- **Evidence:** `services/api/src/services/governance/publication.service.ts:145`, `services/api/src/services/governance/destructive-action-gate.service.ts:149`, `services/api/src/services/governance/finalization-governance.service.ts:95`, `services/api/src/routes/cases.routes.ts:1034`, `services/api/src/routes/evidence.routes.ts:12107`, `services/api/src/services/custody-events-observability.ts:8`
- **Citations:** 6/6 resolve in the audited tree
- **Observed:** The observability helper (noteCustodyFailure) exists and names the silent-catch pattern as a defect, yet publication, legal hold, destructive gate, finalization refusal, retention sweeper, case export and chain transfer still use silent catches. Publish/suspend state changes commit before, and independently of, their custody event.
- **Expected:** Governance state changes that customers and reviewers rely on should append custody in the same tx (appendCustodyEventTx), or at minimum through noteCustodyFailure with a metric.
- **Data flow:** mutation commit -> appendCustodyEvent (new tx) -> catch(()=>null)
- **Root cause:** Incomplete migration to the observable pattern.
- **Blast radius:** Publication, hold, block, export and certification history.
- **Impact:** Missing custody facts cannot be detected or reconciled.
- **Reproduction:** Inject a DB error on custody insert during suspendPublicVerify: the state is SUSPENDED, no event exists, and no log or metric fires.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit test with a failing custody client double; assert the metric bump is absent today.
- **Recommended remediation:** Move to appendCustodyEventTx inside the mutation's tx for state changes; use noteCustodyFailure everywhere else.
- **Acceptance proof:** Grep for `appendCustodyEvent(` followed by `.catch(() =>` returns 0; tests cover the atomicity.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 6/6 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/governance/publication.service.ts:145  }).catch(() => null);
services/api/src/services/governance/destructive-action-gate.service.ts:149  }).catch(() => null);
services/api/src/services/governance/finalization-governance.service.ts:95  }).catch(() => undefined);
services/api/src/routes/cases.routes.ts:1034  }).catch(() => null);
services/api/src/routes/evidence.routes.ts:12107  void appendCustodyEvent({ evidenceId: id, eventType: prismaPkg.CustodyEventType.CERTIFICATION_REQUESTED,
services/api/src/services/custody-events-observability.ts:8  `appendCustodyEvent(...).catch(() => null)` pattern, which broke the tamper-evident promise
```

### ET-DC-04

**P2 · authentication · SOURCE_PROVEN_DEFECT** — Extension OAuth accepts any chromiumapp.org extension id when EXTENSION_OAUTH_REDIRECT_ALLOW is unset, with no consent step

- **Affected:** routes: GET /v1/oauth/extension/authorize; roles: any signed-in user; plans: all
- **Evidence:** `services/api/src/services/auth/extension-oauth.service.ts:37`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** Fail-open allow-list; authorize issues a code using the ambient session and redirects immediately. A third-party extension can silently obtain a capture.direct token able to create evidence and presign parts on the user's unsealed evidence.
- **Expected:** Fail closed without a configured extension id; show consent.
- **Data flow:** launchWebAuthFlow(any id) -> authorize -> code -> token
- **Root cause:** Permissive default for unset config.
- **Blast radius:** Users with a hostile browser extension installed.
- **Impact:** Silent token issuance to arbitrary extensions.
- **Reproduction:** Call authorize with redirect https://<32 a-p>.chromiumapp.org/ while signed in.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Fail closed when unset; add a consent screen.
- **Acceptance proof:** Unset env refuses every redirect.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Confirm EXTENSION_OAUTH_REDIRECT_ALLOW is set in production (the audit never reads production configuration).

```text
services/api/src/services/auth/extension-oauth.service.ts:37  if (explicit.length > 0) return explicit.includes(redirectUri); return CHROMIUMAPP_REDIRECT.test(redirectUri);
```

### ET-DC-05

**P2 · stuck-state · SOURCE_PROVEN_DEFECT** — No reaper for ACTIVE/INTERRUPTED direct-capture sessions; the extension never discards, so failed captures leave permanent empty Evidence rows and orphan objects

- **Affected:** jobs: capture-reaper (DRAFT only); tables: capture_sessions, evidences; plans: all
- **Evidence:** `services/worker/src/capture-reaper.ts:77`, `apps/extension/src/lib/api-client.ts:57`
- **Citations:** 1/2 resolve in the audited tree
- **Observed:** Sessions expire lazily only when the owner calls again; reserved CREATED evidence and S3 parts remain forever after a failure.
- **Expected:** A reaper expires sessions and releases reserved records.
- **Data flow:** reserve -> failure -> nothing
- **Root cause:** Reaper scoped to drafts.
- **Blast radius:** Every abandoned direct capture.
- **Impact:** Orphan records (counted against FREE cap per commercial findings) and storage.
- **Reproduction:** Close the extension popup mid-upload.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Extend the reaper to ACTIVE/INTERRUPTED sessions past TTL; release reserved records.
- **Acceptance proof:** Reaper test.
- **Migration/backfill:** Clean existing orphans.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/capture-reaper.ts:77  only status DRAFT
apps/extension/src/lib/api-client.ts:57  no discard call exists in apps/extension/src
```

### ET-DC-06

**P2 · stuck-state · SOURCE_PROVEN_DEFECT** — Fixed 1h session TTL strands continuous captures finalized late; local segments are already deleted so the recording is unrecoverable

- **Affected:** routes: continuous-complete; plans: all
- **Evidence:** `services/api/src/services/capture-trust/direct-capture-ingest.service.ts:155`, `apps/mobile/src/continuous-capture.ts:216`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** A 50-minute recording sealed >~10 minutes after stopping hits SESSION_EXPIRED, goes INTERRUPTED and can never seal.
- **Expected:** TTL covers max session + finalize window, or seal is independent of TTL once all parts are declared.
- **Data flow:** record -> stop -> later Finish & Sign -> requireActive -> INTERRUPTED
- **Root cause:** TTL not sized for the continuous mode.
- **Blast radius:** Long continuous captures.
- **Impact:** Lost recording.
- **Reproduction:** Seal a 50-min recording 15 minutes after stop.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Mode-aware TTL; extend on activity.
- **Acceptance proof:** Test with late seal.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/capture-trust/direct-capture-ingest.service.ts:155  const DEFAULT_TTL_SECONDS = 60 * 60; const MAX_TTL_SECONDS = 4 * 60 * 60;
apps/mobile/src/continuous-capture.ts:216  // Bytes are now durably in storage; drop the only-on-device copy so a long session cannot accumulate unbounded temp mp4s.
```

### ET-DC-07

**P2 · atomicity · SOURCE_PROVEN_DEFECT** — reserveDirectCaptureEvidence runs createEvidence on the global client inside an outer transaction, so a failed reserve leaves an unbound committed Evidence row and a retry mints a second

- **Affected:** routes: reserve; tables: evidences, custody_events; plans: all
- **Evidence:** `services/api/src/services/capture-trust/direct-capture-ingest.service.ts:374`, `services/api/src/services/evidence.service.ts:427`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Evidence + EVIDENCE_CREATED commit independently of the session binding.
- **Expected:** One transaction.
- **Data flow:** reserve -> createEvidence commit -> outer tx fails -> orphan
- **Root cause:** createEvidence does not accept a tx client.
- **Blast radius:** Reserve failures.
- **Impact:** Orphan records consuming allowance.
- **Reproduction:** Force tx.captureSession.update failure.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Pass tx into createEvidence.
- **Acceptance proof:** Failure-injection test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/capture-trust/direct-capture-ingest.service.ts:374  return db.$transaction( async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${input.sessionId}`}))`;
services/api/src/services/evidence.service.ts:427  const created = await prisma.$transaction(async (tx) => { const evidence = await tx.evidence.create({
```

### ET-DC-08

**P2 · workspace-binding · SOURCE_PROVEN_DEFECT** — UC-2/UC-3/UC-5 screen captures always open in the personal workspace (no teamId), misfiling team work and refusing managed identities

- **Affected:** routes: open; roles: team members, managed identities; plans: TEAM, ENTERPRISE
- **Evidence:** `apps/mobile/src/screen-capture.ts:126`, `apps/mobile/src/continuous-capture.ts:186`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Only capture.tsx:1398 passes teamId.
- **Expected:** Screen capture uses the active workspace.
- **Data flow:** mobile -> open (no teamId) -> personal team
- **Root cause:** D13 fix applied to one caller only.
- **Blast radius:** All native screen captures.
- **Impact:** Evidence in the wrong workspace/billing subject.
- **Reproduction:** Switch to a team workspace, record screen.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Pass active teamId.
- **Acceptance proof:** Mobile test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/mobile/src/screen-capture.ts:126  const session: DirectCaptureSession = await openDirectCaptureSession("DIRECT_SCREEN_CAPTURE_ANDROID");
apps/mobile/src/continuous-capture.ts:186  const session = await openDirectCaptureSession(mode); const evidenceId = await reserveDirectCaptureEvidence(session, {
```

### ET-DC-09

**P2 · integrity-claim · SOURCE_PROVEN_DEFECT** — Continuous-capture continuity/completeness is client-asserted; the only downstream completeness check reads session status, which is always BOUND for sealed records

- **Affected:** jobs: screen intelligence; plans: all
- **Evidence:** `packages/shared/src/screen-continuous-manifest.ts:310`, `services/worker/src/screen-intelligence.handler.ts:144`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Offsets/durations/gaps, window vs session, sizes vs server, platform vs mode and sessionCompleteness are never checked.
- **Expected:** Server validates timing and sizes; completeness read from the manifest.
- **Data flow:** manifest -> validator -> seal -> worker
- **Root cause:** Validator scope minimal.
- **Blast radius:** Continuous captures.
- **Impact:** Derived reconstruction may call an interrupted recording complete.
- **Reproduction:** Seal a manifest with a gap and sessionCompleteness=INTERRUPTED.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Validate timings/sizes/platform; propagate sessionCompleteness.
- **Acceptance proof:** Validator tests.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
packages/shared/src/screen-continuous-manifest.ts:310  only 0..N-1 sequence contiguity and orientation checked
services/worker/src/screen-intelligence.handler.ts:144  acquisitionComplete derived from CaptureSession.status === 'INTERRUPTED'
```

### ET-INT-06

**P2 · control-not-enforced · SOURCE_PROVEN_DEFECT** — maxBytesPerSession and ipAllowlistCidrs are stored but never enforced

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/workflow-intake-link.service.ts:289`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** Operator-configured restrictions have no effect.
- **Expected:** Enforce or remove.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** Operator-configured restrictions have no effect.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** False sense of control.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Enforce in validateIntakeToken/presign or remove from the API.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/workflow-intake-link.service.ts:289  maxBytesPerSession: input.maxBytesPerSession ?? null,
```

### ET-INT-07

**P2 · gate-bypass · SOURCE_PROVEN_DEFECT** — Evidence-request send and request-more mint intake links without the plan and governance gates

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/evidence-request.service.ts:672`, `services/api/src/routes/evidence-requests.routes.ts:223`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** canCreateIntakeLink (allowAnonymousIntake etc.) is skipped; a post-downgrade send still mints links.
- **Expected:** Same gates as the link route at mint time.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** canCreateIntakeLink (allowAnonymousIntake etc.) is skipped; a post-downgrade send still mints links.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Governance policy and plan bypass.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Call canCreateIntakeLink + assertWorkspaceAllowsIntake inside createWorkflowIntakeLink.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/evidence-request.service.ts:672  createWorkflowIntakeLink directly
services/api/src/routes/evidence-requests.routes.ts:223  assertWorkspaceAllowsIntake only at create
```

### ET-INT-08

**P2 · lifecycle · SOURCE_PROVEN_DEFECT** — Cancelling/closing an evidence request does not revoke its link; submissions keep finalizing and attach responses to the cancelled request

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/routes/workflow-intake-links.routes.ts:904`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** transitionEvidenceRequest does not revoke.
- **Expected:** Terminal request revokes its links.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** transitionEvidenceRequest does not revoke.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Unwanted evidence and allowance use after cancel.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Revoke on request terminal transitions.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/workflow-intake-links.routes.ts:904  only caller of revokeWorkflowIntakeLink
```

### ET-INT-09

**P2 · concurrency · SOURCE_PROVEN_DEFECT** — ONE_TIME link use and per-session Evidence creation are check-then-write races

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/workflow-intake-session.service.ts:136`, `services/api/src/services/workflow-intake-session.service.ts:546`, `services/api/src/services/external-intake-orchestration.service.ts:283`
- **Citations:** 1/3 resolve in the audited tree
- **Observed:** Concurrent submits on a one-time link finalize N records; concurrent first-part POSTs create two Evidence rows, one orphaned; maxFileCountPerSession not atomic; duplicate EXTERNAL_INTAKE_SUBMITTED custody.
- **Expected:** Conditional updates / locks.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** Concurrent submits on a one-time link finalize N records; concurrent first-part POSTs create two Evidence rows, one orphaned; maxFileCountPerSession not atomic; duplicate EXTERNAL_INTAKE_SUBMITTED custody.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Over-use of one-time links; orphan records; duplicate custody.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Conditional updateMany on usedCount < maxUses; session row lock for evidence creation.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/workflow-intake-session.service.ts:136  validateIntakeToken reads usedCount
services/api/src/services/workflow-intake-session.service.ts:546  unconditional increment after completion
services/api/src/services/external-intake-orchestration.service.ts:283  read session.evidenceId then create - no lock
```

### ET-INT-10

**P2 · broken-route · SOURCE_PROVEN_DEFECT** — Integrations-API intake-link and evidence-request routes pass an API-credential id as a User id

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/routes/integrations-api.routes.ts:249`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** FK to User makes create fail P2003, returned as 400 with raw e.message; also skips assertWorkspaceAllowsIntake.
- **Expected:** Resolve a service principal or refuse.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** FK to User makes create fail P2003, returned as 400 with raw e.message; also skips assertWorkspaceAllowsIntake.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Advertised integration route always fails and leaks DB error text.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Bind to credential owner user; add plan gate; map errors.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/integrations-api.routes.ts:249  { actorUserId: cred.credentialId }
```

### ET-INT-11

**P2 · custody-truth · SOURCE_PROVEN_DEFECT** — Intake consent is client-asserted: acceptedAtUtc taken from the body, termsAcknowledged/disclosure hash never checked, consent re-postable

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/workflow-intake-session.service.ts:445`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** Custody records 'consent accepted' for termsAcknowledged:false with a backdated timestamp.
- **Expected:** Server time; require termsAcknowledged; one-shot.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** Custody records 'consent accepted' for termsAcknowledged:false with a backdated timestamp.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Custody asserts consent that was not given.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Server-stamp and validate consent; refuse re-post.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/workflow-intake-session.service.ts:445  consentAcceptedAtUtc: new Date(consent.acceptedAtUtc)
```

### ET-INT-12

**P2 · custody-truth · SOURCE_PROVEN_DEFECT** — Intake submitter attribution: identity snapshot and public Verify name the link creator, not the contributor; surfaces disagree

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/routes/evidence.routes.ts:2013`, `services/worker/src/report-v2/custody-model.ts:100`
- **Citations:** 2/2 resolve in the audited tree
- **Merged candidates:** intake:INT-12, custody:CUSTODY-15
- **Observed:** IDENTITY_SNAPSHOT_RECORDED carries the creator's email/provider/level; Verify shows it with no intake branch; report and package relabel.
- **Expected:** One attribution rule across surfaces.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** IDENTITY_SNAPSHOT_RECORDED carries the creator's email/provider/level; Verify shows it with no intake branch; report and package relabel.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Public Verify misattributes who submitted the evidence.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add intake branch to the Verify summarizer and legacy renderer.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:2013  case prismaPkg.CustodyEventType.IDENTITY_SNAPSHOT_RECORDED: { const identityLevel = normalizePublicPayloadValue( obj.identityLevelSnapshot
services/worker/src/report-v2/custody-model.ts:100  summary = isIntake ? INTAKE_IDENTITY_SNAPSHOT_SUMMARY : [CAPTURE_IDENTITY_SNAPSHOT_SUMMARY, flowAwareSummary]
```

### ET-INT-13

**P2 · atomicity · SOURCE_PROVEN_DEFECT** — Intake submit can report failure after finalization; governance-denied retries append EXPORT_BLOCKED_BY_POLICY custody per anonymous retry

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/external-intake-orchestration.service.ts:928`, `services/api/src/services/external-intake-orchestration.service.ts:945`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Contributor sees 500 'try again' while record is SIGNED; anonymous retries grow custody.
- **Expected:** Idempotent post-commit steps; bounded denial events.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** Contributor sees 500 'try again' while record is SIGNED; anonymous retries grow custody.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Misleading failure; custody noise.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Make post-commit steps idempotent/retried; dedupe denial events.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/external-intake-orchestration.service.ts:928  await appendCustodyEvent({ evidenceId: evidence.id, eventType: prismaPkg.CustodyEventType.EXTERNAL_INTAKE_SUBMITTED,
services/api/src/services/external-intake-orchestration.service.ts:945  const submitted = await transitionIntakeSession({ sessionId: input.session.id, expectedLinkId: input.link.id, to: "SUBMITTED",
```

### ET-INT-14

**P2 · deleted-reuse · SOURCE_PROVEN_DEFECT** — Soft-deleted in-progress intake Evidence is reused for new parts

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/services/external-intake-orchestration.service.ts:284`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** Parts attach to a deleted record; completion then 404s as a workspace refusal.
- **Expected:** Refuse or re-create.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** Parts attach to a deleted record; completion then 404s as a workspace refusal.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Stuck session.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Filter deletedAt.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/external-intake-orchestration.service.ts:284  findUnique by session.evidenceId with no deletedAt filter
```

### ET-OTS-03

**P2 · missing recovery / misleading operator guidance · SOURCE_PROVEN_DEFECT** — No automatic or operator recovery exists for a PENDING (or FAILED) row whose job is gone; pending_aged guidance falsely says the ladder is still running

- **Affected:** routes: Operations remediation; pages: /operations; jobs: lifecycle-recovery, ots-upgrade; tables: Evidence, OperationalIncident; roles: operator; plans: all
- **Evidence:** `services/worker/src/ots-initialization-reconciler.ts:119`, `services/api/src/services/operations/remediation-registry.ts:296`, `services/api/src/services/operations/evidence-integrity-conditions.service.ts:847`, `services/worker/src/ots-upgrade.processor.ts:548`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** The only OTS reconciler scans otsStatus NULL. A PENDING row with no live job (OTS-01, OTS-02, exhausted 20 retries, Redis loss) is never re-enqueued; the budget cannot fire without a running job; the operator condition offers no action and states the opposite of the truth.
- **Expected:** A reconciler re-enqueues PENDING rows with no live job (e.g. otsUpgradedAtUtc older than 2x the follow-up interval), and ots_pending_aged offers RESUME.
- **Data flow:** PENDING row -> no job -> reconciler skips (status not null) -> ops discovery opens ots_pending_aged -> remediation registry READ_ONLY_GUIDANCE -> nothing.
- **Root cause:** Recovery modelled only the finalize->enqueue handoff; the ladder was assumed self-sustaining.
- **Blast radius:** All PENDING rows whose ladder broke; combined with OTS-01 this is every new record.
- **Impact:** Unrecoverable stuck PENDING except via admin queue replay (only for FAILED jobs, step-up) or manual scripts; operators told nothing is needed.
- **Reproduction:** Set a row to PENDING with no job; run runLifecycleRecovery; no enqueue; ops shows HIGH after 72h with no action.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration: seed Evidence(otsStatus='PENDING', otsProofBase64=<MAGIC+bytes>, createdAt=now-2d) in TEST_DATABASE_URL; call runOtsInitializationReconciler({minAgeMs:0}) from services/worker/src/ots-initialization-reconciler.ts -> scanned=0; call entryForIncident({category:'EVIDENCE_INTEGRITY', fingerprint:'ots_pending_aged:<id>'}) from remediation-registry.ts -> no action.
- **Recommended remediation:** Add a PENDING-without-live-job arm to the reconciler (via enqueueOtsUpgradeJob, collapse-safe), give ots_pending_aged the RESUME action, and correct both guidance strings.
- **Acceptance proof:** Reconciler test re-enqueues a stale PENDING row and skips one with a live job; ops entry exposes ots.resume_anchoring.
- **Migration/backfill:** none (the reconciler itself drains the backlog)
- **Dependency:** OTS-01, OTS-02
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/ots-initialization-reconciler.ts:119  export function neverAttemptedOtsWhere(...) { return { deletedAt: null, fingerprintCanonicalJson: { not: null }, otsStatus: null, otsProofBase64: null,
services/api/src/services/operations/remediation-registry.ts:296  ots_pending_aged: { disposition: "READ_ONLY_GUIDANCE", guidance: "... the upgrade ladder is still running inside its budget, so this resolves on its own. No manual action is available"
services/api/src/services/operations/evidence-integrity-conditions.service.ts:847  "The platform continues its own anchoring attempts on their existing schedule; nothing here retries, re-anchors or alters a proof."
services/worker/src/ots-upgrade.processor.ts:548  if (observation.kind === "PENDING" && effectiveStatus !== "ANCHORED") { const budgetStart = await loadOtsBudgetStart(evidenceId);
```

### ET-OTS-04

**P2 · transient failure persisted as integrity failure · SOURCE_PROVEN_DEFECT** — A calendar/network failure during `ots stamp` is persisted as per-record FAILED (no proof), never retried automatically, and its raw error text is shown publicly

- **Affected:** routes: GET /public/verify/:id, GET /v1/evidence/:id/review-workspace; pages: /verify/[id]; jobs: ots-upgrade; tables: Evidence.otsStatus, Evidence.otsFailureReason; roles: public; plans: all
- **Evidence:** `services/worker/src/ots.service.ts:348`, `services/worker/src/ots-lifecycle.ts:266`, `services/api/src/routes/evidence.routes.ts:13893`, `services/worker/src/report-v2/truth-model.ts:245`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** createOpenTimestamp converts every error from execFile('ots stamp') (timeout, DNS, calendar 5xx) into a returned FAILED with proof NULL and failureReason = raw error message (e.g. 'Command failed: ots stamp -c ... /tmp/ots-XXXX/fingerprint-<id>.json ...'). The initializer persists it, emits OTS_FAILED, and the job completes. The reconciler skips non-NULL status.
- **Expected:** Stamp-call failures that are not about the record are thrown (OtsInitializationTransientError) so the 20-attempt retry budget applies and the row stays NULL; failureReason shown to users is a bounded code.
- **Data flow:** processOtsUpgrade -> ensureEvidenceOtsInitialized -> createOpenTimestamp catch -> FAILED -> Evidence.otsStatus=FAILED -> public verify FAILED badge + raw reason; ops ots_failure.
- **Root cause:** The failure-vocabulary split described in ots-lifecycle.ts:495-535 is implemented on the wrong side of the try in ots.service.ts.
- **Blast radius:** Every record finalized during a calendar outage.
- **Impact:** Records publicly display 'OpenTimestamps anchoring failed' for a transient outage; each needs a manual operator RESUME; internal temp paths/command lines exposed on public verify and in PDFs.
- **Reproduction:** Set OTS_CALENDAR_URL to an unreachable host locally, finalize a record: Evidence.otsStatus=FAILED, otsProofBase64 NULL, no retry job.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Call createOpenTimestamp({content: Buffer.from('x')}) from services/worker/src/ots.service.ts with OTS_ENABLED=true and OTS_BIN pointing to a script that exits 1 with 'Connection timed out' -> returns status FAILED with raw failureReason (no network contact).
- **Recommended remediation:** Throw on stamp execFile failures (keep structured FAILED only for record-specific outcomes), map otsFailureReason to a bounded code for public surfaces.
- **Acceptance proof:** Unit test: stamp error -> OtsInitializationTransientError, row stays NULL; public verify never returns free-form failure text.
- **Migration/backfill:** Rows with otsStatus=FAILED AND otsProofBase64 IS NULL and a non-code failureReason: reset to NULL (via ots-state writer) so the reconciler re-stamps; owner to confirm.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/ots.service.ts:348  } catch (error) { const message = normalizeErrorMessage(error); ... return { status: "FAILED", proofBase64: null, ... failureReason: message,
services/worker/src/ots-lifecycle.ts:266  data: buildOtsEvidenceUpdateData({ ...stamp, existingBitcoinTxid: evidence.otsBitcoinTxid ?? null, })
services/api/src/routes/evidence.routes.ts:13893  failureReason: evidence.otsFailureReason ?? null,
services/worker/src/report-v2/truth-model.ts:245  body: `OpenTimestamps processing reported a failure state.${safe(failureReason, "") ? ` ${safe(failureReason)}` : ""}`.trim(),
```

### ET-PKG-03

**P2 · misleading verification instructions · SOURCE_PROVEN_DEFECT** — README HOW TO VERIFY ignores the format-5 seal and points recipients at the manifest signature that does not cover the report or checksum index

- **Affected:** jobs: report-generation; roles: external recipient
- **Evidence:** `services/worker/src/verification-package.ts:2069`, `services/worker/src/verification-package.ts:2073`, `services/worker/src/verification-package.ts:2082`, `services/worker/src/verification-package.ts:2318`, `services/worker/src/verification-package.ts:887`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** README never mentions package-seal.json/package-seal.sig; step 2 tells the reader to check files against package-checksums.json (unsigned on its own) and validate package-manifest.sig (manifest built before the report and index). Step 6 does not state what is signed (raw 32-byte SHA-256 of fingerprint.json). OTS hint omits the target file. The qualified-person template asserts verification without reliance on PROOVRA.
- **Expected:** Instructions must lead with the seal verification order, state exact signing inputs, the key-anchoring step, and the OTS command `ots verify -f fingerprint.json opentimestamps-proof.ots`.
- **Data flow:** buildReadme / buildQualifiedPersonTemplate -> README.txt / certifications/*.md
- **Root cause:** Format 5 added without updating buildReadme.
- **Blast radius:** All packages.
- **Impact:** A reviewer following the included instructions performs exactly the format-4 check the seal was introduced to fix; report substitution with an edited checksum line goes unnoticed.
- **Reproduction:** Read README.txt of a generated package.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Rewrite HOW TO VERIFY around the seal; document signature inputs; fix OTS hint; soften template statement 6 until a public key anchor exists.
- **Acceptance proof:** README snapshot contains seal steps and exact commands.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/verification-package.ts:2069  HOW TO VERIFY
services/worker/src/verification-package.ts:2073  validate package-manifest.sig over package-manifest.json with standard
services/worker/src/verification-package.ts:2082  6) Verify the Ed25519 signature using public-key.pem and the platform signing rules.
services/worker/src/verification-package.ts:2318  6. Independent verification of the integrity materials can be performed using the contents of the verification package without reliance on the PROOVRA platform.
services/worker/src/verification-package.ts:887  ? "Verify with: ots verify opentimestamps-proof.ots"
```

### ET-PKG-04

**P2 · false signed claim · SOURCE_PROVEN_DEFECT** — Signed package-manifest.json asserts contents.verifyHtml and verificationScript = true but no such files are emitted

- **Affected:** jobs: report-generation; roles: external recipient
- **Evidence:** `services/worker/src/verification-package.ts:1852`, `services/worker/src/verification-package.ts:1858`, `services/worker/src/verification-package.ts:3142`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The manifest (signed via package-manifest.sig) claims a verify HTML and a verification script are included; grep finds no entry appended for either.
- **Expected:** Manifest contents flags must reflect actual appends.
- **Data flow:** buildPackageManifest -> package-manifest.json -> signed
- **Root cause:** Removal of local inspection tool did not update hard-coded flags.
- **Blast radius:** All packages.
- **Impact:** A signed statement of package contents is false; a reviewer looking for the promised verifier finds none.
- **Reproduction:** List ZIP entries of any package vs package-manifest.json contents.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Set both to false (or remove) and derive every contents flag from actual appends.
- **Acceptance proof:** Test asserting each true flag maps to an existing entry.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/verification-package.ts:1852  verifyHtml: true,
services/worker/src/verification-package.ts:1858  verificationScript: true,
services/worker/src/verification-package.ts:3142  // The embedded local package-inspection materials were removed with the
```

### ET-PKG-05

**P2 · false all-clear (presentation) · SOURCE_PROVEN_DEFECT** — Public Verify "Package Integrity Complete / Independent Review Enabled" is derived from file-name presence, never from seal or signature verification

- **Affected:** routes: GET /public/verify/:id; pages: /verify/[token] Package Integrity tab; tables: evidence.verification_package_metadata; roles: public
- **Evidence:** `apps/web/app/verify/[token]/page.tsx:2267`, `apps/web/app/verify/[token]/page.tsx:2414`, `services/api/src/routes/evidence.routes.ts:802`, `apps/web/app/verify/[token]/page.tsx:2460`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** complete = available && manifestPresent && signedManifestPresent && checksumIndexPresent && auditExportIncluded, values come from DB flags written at generation or ZIP central-directory names. Seal presence/format is ignored, so unsealed format-4 legacy packages get the same success badge. When a package exists but is partial, the text still says no downloadable package is available.
- **Expected:** Badge should reflect whether the package is sealed (format>=5) and ideally a server-side seal verification; partial text must not contradict availability.
- **Data flow:** evidence.verificationPackageMetadata | listZipEntryNames -> verificationPackageIntegrity -> VerificationPackageIntegrityCard
- **Root cause:** Presence booleans used as integrity verdict.
- **Blast radius:** All RICH verify views with packages.
- **Impact:** Misleading success state for legacy packages whose report is not bound by any signature.
- **Reproduction:** Record with a format-4 package: RICH tab shows Package Integrity Complete.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Fixture verification_packages row with package_format_version NULL and metadata flags true; render page.
- **Recommended remediation:** Return packageFormatVersion/sealed and a server-side verifySealedPackageEntries result; gate the success badge on it; fix the partial branch text.
- **Acceptance proof:** Legacy package renders non-success; sealed verified package renders success.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/app/verify/[token]/page.tsx:2267  const complete =
apps/web/app/verify/[token]/page.tsx:2414  label={complete ? "Independent Review Enabled" : integrity.available ? "Partial Package" : "Unavailable"}
services/api/src/routes/evidence.routes.ts:802  manifestPresent: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.packageManifest),
apps/web/app/verify/[token]/page.tsx:2460  "No downloadable package is available for this record, and its integrity assessment does not depend on one.
```

### ET-PKG-06

**P2 · unavailable rendered as verified · SOURCE_PROVEN_DEFECT** — Public Verify storage "verified/Immutable Storage Locked" comes from a DB snapshot (no expiry check, no object check); integrity verdict is DB self-consistency only

- **Affected:** routes: GET /public/verify/:id; pages: /verify/[token]; tables: evidence; roles: public
- **Evidence:** `services/api/src/routes/evidence.routes.ts:2280`, `services/api/src/routes/evidence.routes.ts:2285`, `apps/web/app/verify/[token]/page.tsx:412`, `services/api/src/routes/evidence.routes.ts:13133`, `packages/shared/src/basic-verification.ts:192`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** When any storage lock column is set, getStorageProtectionSummary returns verified:true and immutable without HEAD and without comparing retainUntil to now; page says protected objects cannot be altered or deleted and counts storage as a passed signal. overallIntegrity / BASIC original "Verified" = sha256(DB fingerprint JSON) == DB fingerprintHash, signature over it with DB key, DB custody chain — original bytes are never re-read, so a missing/expired object still reads Verified.
- **Expected:** Storage should be labelled as recorded (not verified) unless observed, retention expiry considered; integrity copy should say it checks the recorded fingerprint/signature/chain, not the stored original.
- **Data flow:** evidence.storage_object_lock_* -> getStorageProtectionSummary -> storageAndTimestamping.storage -> buildStoragePresentation / verdict passedSignals
- **Root cause:** Snapshot fallback labelled verified.
- **Blast radius:** All RICH views; BASIC "Original evidence: Verified".
- **Impact:** Viewers are told storage is locked/verified and original integrity verified when neither was observed.
- **Reproduction:** Record with COMPLIANCE + retainUntil in the past, or original object deleted (non-locked env): page still shows Immutable Storage Locked and Verified.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local fixture: set storage_object_lock_retain_until_utc to 2020-01-01 and delete the object in MinIO, call GET /public/verify/:id.
- **Recommended remediation:** Return verified:false/source:"RECORDED" for snapshot path, check retainUntil > now, optionally HEAD the object (cached); reword BASIC detail to name the checks.
- **Acceptance proof:** Fixture above renders "recorded"/expired and not verified.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:2280  immutable: snapshotMode === "COMPLIANCE" && Boolean(snapshotRetainUntil),
services/api/src/routes/evidence.routes.ts:2285  verified: true,
apps/web/app/verify/[token]/page.tsx:412  badgeLabel: "Immutable Storage Locked",
services/api/src/routes/evidence.routes.ts:13133  const overallIntegrity =
packages/shared/src/basic-verification.ts:192  state: anyFalse ? "failed" : allTrue ? "verified" : "not_checked",
```

### ET-PKG-07

**P2 · capability design · SOURCE_PROVEN_DEFECT** — Public verify capability is the permanent evidence UUID: published by default, no expiry, no rotation, no per-recipient revocation

- **Affected:** routes: GET /public/verify/:id; pages: /verify/[token]; tables: evidence; roles: any past holder of the id
- **Evidence:** `services/api/prisma/schema.prisma:185`, `services/api/src/routes/evidence.routes.ts:12317`, `services/api/src/services/governance/publication.service.ts:53`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The URL segment is the evidence PK, which also appears in reports/QR, packages, S3 keys, internal links and audit data. Every finalized record is public unless the workspace opted into approval. Revoking one recipient requires unpublishing the record for everyone; re-publishing reactivates the identical URL.
- **Expected:** Owner decision: a separate random share token (hashed at rest) per publication/recipient, rotatable and expirable, or at minimum explicit opt-in publication.
- **Data flow:** evidence.id -> buildVerifyUrl -> QR/report -> /verify/<id> -> findFirst({id})
- **Root cause:** Verify URL reuses the primary key.
- **Blast radius:** All records.
- **Impact:** Former collaborators or anyone who saw an id keeps permanent access to RICH content (title, previews, GPS, custody) while published.
- **Reproduction:** Copy any evidence id from an internal URL; open /verify/<id>.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Introduce verify_tokens table (hashed), default NOT_PUBLISHED or explicit publish, rotation and expiry.
- **Acceptance proof:** Evidence id alone returns 404; token rotation invalidates the old URL.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Keep id-as-token model vs introduce rotatable share tokens; default publication state.

```text
services/api/prisma/schema.prisma:185  publicVerifyState             PublicVerifyState @default(PUBLISHED)
services/api/src/routes/evidence.routes.ts:12317  const idParse = z.string().uuid().safeParse((req.params as ParamsId).id);
services/api/src/services/governance/publication.service.ts:53  UNPUBLISHED: ["PUBLISHED"],
```

### ET-PKG-08

**P2 · governance bypass · SOURCE_PROVEN_DEFECT** — Package eligibility gate (hold / lifecycle / destruction review / immutable drift) is skipped for personal workspaces and when the Team row resolves isPersonal=null

- **Affected:** jobs: report-generation; tables: evidence_legal_holds, operational_incidents; plans: personal
- **Evidence:** `services/worker/src/verification-package.ts:2573`, `services/worker/src/verification-package.ts:2577`, `services/worker/src/processor.ts:2636`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** packageMode is team_governed only when isPersonalTeam === false; null (Team not loaded) and personal both skip assertPackageEligibleOrDeny, including BLOCKED_BY_IMMUTABLE_DRIFT and pending-destruction lifecycle checks that are not team concepts.
- **Expected:** Lifecycle and immutable-drift blockers apply to every record; unresolved workspace should fail closed.
- **Data flow:** identitySnapshot.workspaceIsPersonal -> createVerificationPackage.isPersonalTeam -> packageMode
- **Root cause:** Gate scoped to team mode.
- **Blast radius:** Personal-workspace records (and any record whose team lookup fails).
- **Impact:** A package can be generated and published for a personal record with an open immutable-drift incident or destruction-bound lifecycle; a transient team lookup miss fails open.
- **Reproduction:** Personal record with open immutable-drift OperationalIncident; trigger report generation; package is produced.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration fixture in point5 suite with isPersonal team + drift incident.
- **Recommended remediation:** Always run the lifecycle/drift half of the gate; treat isPersonalTeam null as deny.
- **Acceptance proof:** Fixture above yields PackageGateDeniedError.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Whether holds apply to personal workspaces.

```text
services/worker/src/verification-package.ts:2573  data.teamId && data.isPersonalTeam === false
services/worker/src/verification-package.ts:2577  if (packageMode === "team_governed") {
services/worker/src/processor.ts:2636  workspaceIsPersonal: workspaceTeam?.isPersonal ?? null,
```

### ET-Q-03

**P2 · infinite recovery loop / misleading status · SOURCE_PROVEN_DEFECT** — MediaIntelligenceRun rows for perceptual hashes, technical metadata, text-similarity and deferred kinds never leave PENDING, so the intelligence-run reconciler re-runs them every 10 minutes forever and starves genuinely stranded runs

- **Affected:** routes: GET /v1/evidence/:id/media-intelligence; pages: media intelligence run list, Operations intelligence health; jobs: RunMediaIntelligence, IntelligenceRunStrandedReconciler; tables: media_intelligence_runs, evidence_parts.technical_metadata
- **Evidence:** `services/worker/src/media-intelligence.processor.ts:331`, `services/worker/src/media-intelligence.processor.ts:345`, `services/worker/src/media-intelligence.processor.ts:439`, `services/api/src/services/evidence-finalization-fanout.service.ts:514`, `services/worker/src/intelligence-run-reconciler.ts:201`, `services/worker/src/intelligence-run-reconciler.ts:212`
- **Citations:** 6/6 resolve in the audited tree
- **Observed:** The API inserts a PENDING run and enqueues its id for compute_perceptual_hashes (fanout :318) and extract_technical_metadata (fanout :514); the worker adds reconcile_*_similarity runs. The dispatcher hands these kinds to handlers that never call markRunProcessing/markRunCompleted/markRunFailed (markRun* appear only at lines 475-531, 599-755, 1594-1702, 1761-1832). Same for evidence_scope_mismatch (:295) and deferred kinds. attempt_count therefore stays 0, so the >=5 abandonment check never fires. Every 10 min the reconciler selects the 50 oldest PENDING rows by updatedAtUtc (never updated) and re-enqueues them; the completed job id is removed and a fresh job re-downloads object ranges from S3 and rewrites technical_metadata.
- **Expected:** Every run kind that has a durable run row must drive it to a terminal state; recovery must be bounded.
- **Data flow:** fanout -> run INSERT PENDING -> job -> handler (no run write) -> PENDING > 15m -> reconciler re-enqueue -> repeat
- **Root cause:** Run-state writes live in individual handlers and three handlers plus the early-return branches were never wired to the tracker.
- **Blast radius:** Every PHOTO/VIDEO record (pHash) and every finalized record (technical metadata) since the fanout was added.
- **Impact:** Unbounded repeated S3 reads and CPU work; runs displayed PENDING forever; oldestPendingAgeMs grows without bound; with >50 such rows, real stranded OCR/transcript runs (paid providers) are never recovered.
- **Reproduction:** Finalize a PHOTO; after 15 min media_intelligence_runs has a compute_perceptual_hashes row in PENDING with attempt_count 0 and a new mi-run job appears every reconciler tick.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local PG+Redis: insert one run of kind extract_technical_metadata, run processMediaIntelligenceJob then runIntelligenceRunReconciler twice with a clock 16 min ahead; assert run still PENDING and strandedReEnqueued increments both times.
- **Recommended remediation:** Wrap all kinds in one claim/terminal envelope in processMediaIntelligenceJob (markRunProcessing before dispatch, markRunCompleted/Failed after), mark scope-mismatch and deferred kinds FAILED/DISMISSED, and order the reconciler by attempt/age with a per-row backoff.
- **Acceptance proof:** Test per kind: after one job, the run is COMPLETED or FAILED; reconciler selects zero rows.
- **Migration/backfill:** Mark existing PENDING rows of these kinds COMPLETED when their output exists (technical_meta_parsed_at / hash rows), else FAILED.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 6/6 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/media-intelligence.processor.ts:331  if (kind === "compute_perceptual_hashes") { return processComputePerceptualHashesJob({ jobId: job.id, teamId, evidenceId, evidencePartId,
services/worker/src/media-intelligence.processor.ts:345  if (kind === "extract_technical_metadata") { return processExtractTechnicalMetadataJob({
services/worker/src/media-intelligence.processor.ts:439  "media_intelligence.kind_reserved_for_future_phase",
services/api/src/services/evidence-finalization-fanout.service.ts:514  const enqueueResult = await enqueueMediaIntelligenceAnalysis({ ... kind: "extract_technical_metadata",
services/worker/src/intelligence-run-reconciler.ts:201  status: "PENDING", updatedAtUtc: { lt: pendingCutoff },
services/worker/src/intelligence-run-reconciler.ts:212  if (run.attemptCount >= MAX_RECOVERY_ATTEMPTS) {
```

### ET-Q-04

**P2 · stuck_state / no lease recovery · SOURCE_PROVEN_DEFECT** — A redaction derivative that hits a transient storage error or a worker crash after its claim is stuck in RENDERING forever; retries, the reconciler and a user re-request all skip it

- **Affected:** routes: POST redaction derivative request, GET /v1/redaction/derivatives/:id; pages: redaction workspace; jobs: RenderRedactionDerivative, RedactionStrandedReconciler; tables: redaction_derivatives
- **Evidence:** `services/worker/src/redaction/redaction-derivative-writer.ts:36`, `services/worker/src/redaction/redaction-derivative.processor.ts:261`, `services/worker/src/redaction/redaction-derivative.processor.ts:386`, `services/api/src/services/redaction/redaction-derivative.service.ts:117`, `packages/shared/src/queue-integrity/registry.ts:177`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** The claim moves QUEUED->RENDERING. A transient error rethrows for BullMQ retry, but the retry's claim requires QUEUED, returns not_queued, and the job completes as a no-op. A crash mid-render has the same outcome via stall re-delivery. Nothing ever moves RENDERING back: the reconciler scans QUEUED, the API re-request only resets FAILED/PENDING, and versionId is UNIQUE so no new derivative can be created. The registry declares a 20-minute renderStartedAtUtc lease that no code implements.
- **Expected:** RENDERING older than the lease must be reclaimable (by the retry and by the reconciler) or failed with a reason.
- **Data flow:** API create QUEUED -> job claim RENDERING -> S3 5xx throw -> retry claim_skipped -> job completed -> row RENDERING forever
- **Root cause:** Claim predicate has no expired-lease arm; reconciler population excludes RENDERING.
- **Blast radius:** Any redaction render hitting a transient S3/network error or worker restart.
- **Impact:** The redacted deliverable can never be produced for that version; the UI shows rendering indefinitely.
- **Reproduction:** Make putObject fail with ETIMEDOUT once; derivative remains RENDERING after all retries.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local PG+Redis with a storage double failing the first PUT with ETIMEDOUT: run the job with attempts=3 and assert final state RENDERING and job completed.
- **Recommended remediation:** Allow claim from RENDERING when renderStartedAt < now-20m; add RENDERING-lease arm to the reconciler (reset to QUEUED or FAILED); on retryable throw, reset to QUEUED before rethrowing.
- **Acceptance proof:** Test: transient failure then retry produces READY; crashed claim older than lease is recovered by the reconciler.
- **Migration/backfill:** Reset RENDERING rows with renderStartedAt older than 20 min to QUEUED.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/redaction/redaction-derivative-writer.ts:36  where: { id: derivativeId, state: "QUEUED" }, data: { state: "RENDERING", renderStartedAt: new Date() },
services/worker/src/redaction/redaction-derivative.processor.ts:261  if (/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|5\d\d|SlowDown|InternalError/i.test(msg)) { throw err; }
services/worker/src/redaction/redaction-derivative.processor.ts:386  where: { state: "QUEUED", updatedAt: { lt: cutoff } },
services/api/src/services/redaction/redaction-derivative.service.ts:117  // Reset for a fresh render attempt. RENDERING/QUEUED rows are left untouched
packages/shared/src/queue-integrity/registry.ts:177  leaseField: "renderStartedAtUtc", leaseMs: 20 * 60 * 1000,
```

### ET-Q-05

**P2 · starvation / retention promise unmet · SOURCE_PROVEN_DEFECT** — Trash-grace reconciler re-reads the same oldest 200 TRASHED rows every hour; once 200 of them are blocked (hold, retention, object lock, approval pending) eligible records are never purged, and the purge job's own BLOCKED reschedule is a no-op

- **Affected:** pages: trash / retention; jobs: TrashGraceReconciliationSweep, PurgeDeletedEvidenceJob; tables: evidence
- **Evidence:** `services/worker/src/governance/trash-grace-reconciler.ts:196`, `services/worker/src/governance/trash-grace-reconciler.ts:202`, `services/worker/src/governance/trash-grace-reconciler.ts:267`, `services/worker/src/processor.ts:5751`
- **Citations:** 3/4 resolve in the audited tree
- **Observed:** The candidate query has no cursor and does not exclude rows that stay blocked; blocked rows keep lifecycleState TRASHED and past-due deleteScheduledForUtc, so they sort first on every tick. DEFAULT_BATCH_SIZE=200. The purge processor's BLOCKED path enqueues the same deterministic id while that job is active, which collapses (enqueue.ts:161) and schedules nothing, so trash-grace is the only producer.
- **Expected:** Each tick must make progress past blocked rows (cursor or exclusion of rows re-evaluated recently) and report actual enqueue outcomes.
- **Data flow:** trash-grace tick -> 200 oldest (blocked) -> BLOCKED dispositions -> eligible rows beyond 200 never reached
- **Root cause:** Head-of-line ordering on a population that contains permanently or long-blocked members.
- **Blast radius:** Workspaces with many trashed records under hold/retention; affects every tenant because the query is global.
- **Impact:** Trashed evidence past its grace period is retained indefinitely although eligible for destruction; enqueued metric over-reports.
- **Reproduction:** Seed 200 TRASHED past-grace rows under legal hold and 1 eligible row; run the reconciler with auto destruction on; the eligible row is never enqueued.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local PG: seed as above and call runTrashGraceReconciliation({batchSize:200}); assert eligible=0 for the extra row.
- **Recommended remediation:** Add a keyset cursor across ticks (like first-issuance) or record a next-evaluation timestamp for blocked rows; use selfJobId (or a distinct id) for the purge recheck; count enqueued only on outcome.enqueued.
- **Acceptance proof:** Test with >batch blocked rows still enqueues eligible ones within N ticks.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/governance/trash-grace-reconciler.ts:196  const rows = await prisma.evidence.findMany({ where: { lifecycleState: "TRASHED", deleteScheduledForUtc: { lte: now },
services/worker/src/governance/trash-grace-reconciler.ts:202  orderBy: { deleteScheduledForUtc: "asc" }, take: batchSize,
services/worker/src/governance/trash-grace-reconciler.ts:267  enqueued += 1;   // counted regardless of enqueue outcome
services/worker/src/processor.ts:5751  await enqueueEvidencePurgeJob(evidence.id, recheckAt.toISOString());   // from inside the running evidence-purge-<id> job
```

### ET-Q-06

**P2 · startup ordering / fail-closed claim false · SOURCE_PROVEN_DEFECT** — 14 of 15 BullMQ workers and 4 sweeps start claiming work at module import, before secrets hydration, package-signer validation and object-lock bootstrap

- **Affected:** jobs: UpgradeOts, PurgeDeletedEvidenceJob, EmbedSemanticChunks, RenderRedactionDerivative, GenerateDerivedAsset, RunMediaIntelligence, RebuildSearchDocument
- **Evidence:** `services/worker/src/index.ts:2073`, `services/worker/src/index.ts:2093`, `services/worker/src/index.ts:1051`, `services/worker/src/index.ts:2628`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** BullMQ Worker defaults to autorun; only the report worker sets autorun:false and is started after validatePackageSignerAtStartup. All other workers begin fetching jobs as soon as the module evaluates, and redaction/trash-grace/search-index/intelligence-run schedulers are started at top level. The SEC-004 block comment claims required-mode secrets fail closed 'before any job is claimed', and object-lock bootstrap failure calls shutdown(1) only after jobs may already have run (including destructive purge).
- **Expected:** No consumer claims work until the secret authority, signer and storage bootstrap have succeeded.
- **Data flow:** process start -> module eval -> new Worker(...) autorun -> jobs processed with un-hydrated process.env -> later initSecretsAuthority
- **Root cause:** autorun default and top-level scheduler starts.
- **Blast radius:** Every worker restart with a backlog.
- **Impact:** Jobs can execute with configuration read from the raw environment (e.g. mi-embed resolveProvider reads process.env at job time and completes as provider_disabled), and destructive purge runs even when the process will then abort on object-lock verification.
- **Reproduction:** Start the worker with a backlog and a secret store that takes seconds to respond; observe job logs preceding worker.package_signer.validated.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Local Redis with queued ots-upgrade and mi-embed jobs; stub initSecretsAuthority with a delayed promise; assert job processing logs appear before hydration completes.
- **Recommended remediation:** Set autorun:false on all workers and call worker.run() after bootstrap succeeds; move the four top-level scheduler starts into the post-bootstrap block.
- **Acceptance proof:** Boot-order test asserting no processor invocation before bootstrap resolves.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/index.ts:2073  autorun: false,   // report worker only
services/worker/src/index.ts:2093  const evidencePurgeWorker = safeRegisterWorker("evidence-purge", () => new Worker(... { connection: redisConnection, concurrency: 1 }
services/worker/src/index.ts:1051  startTrashGraceReconcilerScheduler();   // top-level, at import
services/worker/src/index.ts:2628  initSecretsAuthority(logger)
```

### ET-REC-02

**P2 · stuck state / misleading status · SOURCE_PROVEN_DEFECT** — OTS budget-exhausted incident (WORKER, OTS:<id>:GLOBAL_BUDGET_EXHAUSTED) can never auto-resolve and tells operators the record will recover on its own

- **Affected:** routes: GET /v1/ops/incidents, POST /v1/ops/incidents/:id/remediate; pages: /operations, /admin/operations; jobs: UpgradeOtsJob, workspace-operations-reconciliation; tables: operational_incidents; roles: workspace operator
- **Evidence:** `services/worker/src/ots-upgrade.processor.ts:678`, `packages/shared-runtime/src/ops/source-lifecycle.ts:663`, `services/api/src/services/operations/operations-source-probes.ts:1230`, `services/api/src/services/operations/evidence-integrity-conditions.service.ts:185`, `services/api/src/services/operations/operations-source-probes.ts:605`, `services/api/src/services/operations/source-truth-recovery.service.ts:250`, `services/api/src/services/operations/remediation-registry.ts:425`
- **Citations:** 7/7 resolve in the audited tree
- **Observed:** The probe for this source parses fingerprints with parseIntegrityFingerprint, which only accepts 'tsa_failure:'/'ots_failure:' heads, so 'OTS:<id>:GLOBAL_BUDGET_EXHAUSTED' is NOT_APPLICABLE forever; the sweep only closes RECOVERED. The incident is category WORKER, whose registry entry is READ_ONLY_GUIDANCE stating records 'recover when it does' - false for a terminal state - and offers no Resume action even though the source lifecycle declares SAFE_REMEDIATION. A second EVIDENCE_INTEGRITY 'ots_failure:<id>' condition for the same fact carries the Resume action.
- **Expected:** The budget-exhausted source resolves when otsStatus leaves FAILED (probe must parse the OTS:<id>:... shape) and its guidance/action matches the terminal state; or the WORKER duplicate is not emitted.
- **Data flow:** processOtsUpgrade BUDGET_EXHAUSTED -> recordWorkerIncident(WORKER) -> sweep probeSource(evidence.ots_status) -> NOT_APPLICABLE -> stays OPEN
- **Root cause:** Probe/fingerprint shape mismatch plus category-level remediation mapping.
- **Blast radius:** Every record whose OTS proof exhausted its 30-day budget; CRITICAL severity keeps the workspace/inbox red after a successful Resume anchors it.
- **Impact:** Permanent false CRITICAL condition after recovery; misleading guidance; duplicate condition for one fact.
- **Reproduction:** Seed evidence otsStatus PENDING with budget start > budget days, run processOtsUpgrade with a pending calendar reply; later set otsStatus ANCHORED; run the workspace operations sweep; the OTS:... incident stays OPEN.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration: insert operational_incident {sourceId evidence_integrity.ots_budget_exhausted, fingerprint OTS:<uuid>:GLOBAL_BUDGET_EXHAUSTED}, evidence otsStatus ANCHORED; call probeSource('evidence.ots_status', ctx) -> expect NOT_APPLICABLE today.
- **Recommended remediation:** Teach observeIntegrity (or a dedicated probe) to parse OTS:<id>:<reason>, and route category/remediation for this source to the ots_failure entry; or stop emitting the WORKER duplicate.
- **Acceptance proof:** Probe returns RECOVERED for an anchored record; sweep resolves the incident; inspector shows Resume, not the WORKER guidance.
- **Migration/backfill:** Resolve or re-probe existing OPEN rows with this sourceId after the fix.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 7/7 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/ots-upgrade.processor.ts:678  category: "WORKER", severity: "CRITICAL", fingerprint: `OTS:${evidenceId}:GLOBAL_BUDGET_EXHAUSTED`,
packages/shared-runtime/src/ops/source-lifecycle.ts:663  sourceId: "evidence_integrity.ots_budget_exhausted", ... activityProbeKey: "evidence.ots_status",
services/api/src/services/operations/operations-source-probes.ts:1230  "evidence.ots_status": (ctx) => observeIntegrity(ctx, "ots"),
services/api/src/services/operations/evidence-integrity-conditions.service.ts:185  if (!INTEGRITY_CLASSES.includes(head as IntegrityClass)) return null;
services/api/src/services/operations/operations-source-probes.ts:605  if (!parts) return { ...base, activity: "NOT_APPLICABLE" };
services/api/src/services/operations/source-truth-recovery.service.ts:250  if (observation.activity !== "RECOVERED") continue;
services/api/src/services/operations/remediation-registry.ts:425  "Background processing reported a fault. The platform owns the queue; the affected records recover when it does.",
```

### ET-REC-03

**P2 · duplicate authority / workflow unusable · SOURCE_PROVEN_DEFECT** — Recovery decision refuses team_id-NULL Personal records (WORKSPACE_UNRESOLVED) that the durable writer and worker now accept

- **Affected:** routes: POST /v1/evidence/:id/reports/regenerate, POST /v1/ops/incidents/:id/remediate, POST /v1/admin/incidents/:id/remediate; pages: /evidence/[id], /reports, /admin/operations; jobs: GenerateReportJob; tables: evidence, report_generation_requests; roles: owner; plans: PERSONAL paid, credit-funded
- **Evidence:** `services/api/src/services/reports/output-recovery.service.ts:330`, `packages/shared/src/evidence-output-lifecycle.ts:1078`, `services/api/src/services/reports/output-recovery.service.ts:535`, `packages/shared-runtime/src/reports/report-generation-request.ts:253`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** The writer (and the worker claim) resolve a Personal record with team_id NULL to its owner's personal workspace, and the worker first-issuance sweep issues for such records. But the facts used by every surface and by requestOutputRecovery set workspaceResolved from team_id alone, so Generate/Recover/Retry are withdrawn (WORKSPACE_UNRESOLVED) and a POST is declined 409. Only the platform packageForReportVersion branch was patched; the platform REPORT-component path (packageForReportVersion null) and legacy PACKAGE:<id>:<class> fingerprints still go through the unpatched gate, so the admin route's own RECORD_WORKSPACE_UNRESOLVED check passes and then the recovery answers NOT_ELIGIBLE.
- **Expected:** One workspace-resolution rule for projection and execution.
- **Data flow:** loadEvidenceOutputFacts -> resolveEvidenceOutputActions.gate -> blockingRestriction -> WORKSPACE_UNRESOLVED
- **Root cause:** The 2026-09-29 writer change was applied to the writer and one executor branch, not to the facts loader.
- **Blast radius:** Any remaining team_id NULL records (see memory: personal evidence historically written team_id NULL).
- **Impact:** Customer cannot recover a failed report/package for such records; platform REPORT recovery refuses; only the automatic sweep (and, for packages, only with OUTPUT_PACKAGE_RECOVERY_ENABLED) can.
- **Reproduction:** Evidence SIGNED, team_id NULL, owner with personal team and paid plan, failed technical report request; GET artifacts/status shows action NONE reason WORKSPACE_UNRESOLVED; POST regenerate -> 409.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration test with TEST_DATABASE_URL: seed the record above; call requestOutputRecovery({intent:'RECOVER'}) and createReportGenerationRequest directly; first declines WORKSPACE_UNRESOLVED, second creates a row.
- **Recommended remediation:** Compute workspaceResolved in loadEvidenceOutputFacts with resolveEvidenceWorkspaceId (batch-safe variant).
- **Acceptance proof:** Same fixture offers RECOVER/GENERATE and POST returns 202.
- **Migration/backfill:** none (or backfill team_id)
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/reports/output-recovery.service.ts:330  workspaceResolved: Boolean(ev.teamId),
packages/shared/src/evidence-output-lifecycle.ts:1078  if (!r.workspaceResolved) return "WORKSPACE_UNRESOLVED";
services/api/src/services/reports/output-recovery.service.ts:535  const workspaceResolved = facts.restrictions.workspaceResolved || (await resolveEvidenceWorkspaceId(
packages/shared-runtime/src/reports/report-generation-request.ts:253  const workspaceId = await resolveEvidenceWorkspaceId(evidence, prisma);
```

### ET-REC-04

**P2 · important workflow unusable · SOURCE_PROVEN_DEFECT** — Mobile Operations shows 'Retry after exhausted failure' but never sends the required reason, so it always fails with 400

- **Affected:** routes: POST /v1/ops/incidents/:id/remediate; pages: mobile /operations; roles: workspace operator with operations.resolve
- **Evidence:** `apps/mobile/src/product/ops-console.ts:763`, `apps/mobile/app/(stack)/operations/index.tsx:1164`, `services/api/src/routes/ops.routes.ts:1576`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The mobile parser discards requiresReason and the remediate call sends no reason. The server refuses requiresReason actions without one (400 remediation_reason_required).
- **Expected:** Mobile collects a reason for requiresReason actions (as web IncidentInspector does) or hides them.
- **Data flow:** mobile inspector button -> confirm sheet -> remediate() -> 400
- **Root cause:** Projection field dropped in mobile parser.
- **Blast radius:** Every exhausted report/package failure viewed on mobile.
- **Impact:** The only operator escalation path is dead on mobile; operator sees a generic error.
- **Reproduction:** On mobile open a REPORT/PACKAGE incident whose request is FAILED_TERMINAL retry_budget_exhausted; press 'Retry after exhausted failure'.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Carry requiresReason and prompt for a reason.
- **Acceptance proof:** Mobile test posts {teamId, actionId, reason} and gets 202.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/mobile/src/product/ops-console.ts:763  ? { actionId, label, description: str(o["description"]) ?? "", confirm: o["confirm"] === true, async: o["async"] === true }
apps/mobile/app/(stack)/operations/index.tsx:1164  body: JSON.stringify({ teamId, actionId: a.actionId })
services/api/src/routes/ops.routes.ts:1576  if (action.requiresReason && !(body.reason ?? "").trim()) {
```

### ET-RPT-01

**P2 · incorrect KPI / hidden failure · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — A failed or retryable request on a record that already has a report is invisible to every Reports card and filter while the row shows Retry / 'Escalated to operators'

- **Affected:** routes: GET /v1/reports/artifacts; pages: /reports; jobs: GENERATE_REPORT; tables: report_generation_requests, reports; roles: all workspace members; plans: plans with reports
- **Evidence:** `packages/shared/src/evidence-output-lifecycle.ts:494`, `services/api/src/services/reports/reports-aggregator.service.ts:1203`, `services/api/src/services/reports/output-recovery.service.ts:158`, `packages/shared/src/evidence-output-lifecycle.ts:1170`, `packages/shared/src/evidence-output-lifecycle.ts:1116`, `apps/web/components/reports-experience/ReportsIndex.tsx:1255`
- **Citations:** 6/6 resolve in the audited tree
- **Observed:** For an evidence record with report v1, a later REPORT request (updated report / NEW_VERSION, or any forced regeneration) that ends FAILED_RETRYABLE or FAILED_TERMINAL is classified READY by deriveEvidenceOutputState, so it is counted in 'Reports ready', excluded from 'Reports failed' and from the report_failed filter. The same row's action projection (resolveEvidenceOutputActions) does see the failure (afterLatestReport) and renders a 'Retry' button or an 'Escalated to operators' badge beside green 'Report ready · v1'.
- **Expected:** A failed issuance attempt that still needs attention is counted by a card/filter (e.g. 'Updated report failed') or the row does not signal a failure the summary cannot find.
- **Data flow:** report_generation_requests(latest REPORT row) -> projectReportRequestState -> deriveEvidenceOutputState (READY precedence) -> classifyWorkspaceOutputs buckets -> cards; same facts -> resolveEvidenceOutputActions -> row verbs/badges.
- **Root cause:** Two consumers of the same facts: the state derivation ranks artifact availability above generation failure; the action resolver consults afterLatestReport failures. The page's card set is built only from the state.
- **Blast radius:** Every record with an existing report whose later issuance failed; operators triaging via 'Reports failed' miss them.
- **Impact:** Card-vs-row disagreement; a technical terminal escalated to operators is discoverable only by scanning rows.
- **Reproduction:** Evidence with Report v1; create REPORT request forceRegenerate=true (NEW_VERSION) and let the worker mark it FAILED_TERMINAL (non-retriable error) -> /reports shows 'Reports failed 0', row shows 'Report ready v1' + 'Escalated to operators'.
- **Runtime evidence:** RT-REPORTS (rt-reports-01.json): two records each with a FAILED_TERMINAL REPORT request; listWorkspaceArtifacts summary reportsFailed:1 (first-issuance only) and reportsReady:1; the record with v1 + failed updated-report request rows as report.state READY with actionUnavailableReason ESCALATED_TO_OPERATOR.
- **Recommended remediation:** Add a distinct canonical bucket/card+filter for 'latest issuance attempt failed' (report READY + afterLatestReport failure) computed in classifyWorkspaceOutputs from the same facts the action resolver uses, or project the row's status from the same predicate.
- **Acceptance proof:** Card count equals filter total equals number of rows showing a failure badge/Retry for the seeded fixture.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 6/6 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Whether an updated-report failure belongs on the Reports summary or only in Evidence Detail/Operations.

```text
packages/shared/src/evidence-output-lifecycle.ts:494  if (axes.availability === "READY") return "READY";
services/api/src/services/reports/reports-aggregator.service.ts:1203  if (reportState === "READY") out.reportReady.push(row.id);
services/api/src/services/reports/output-recovery.service.ts:158  afterLatestReport: latestReport != null && row.createdAtUtc > latestReport.generatedAtUtc,
packages/shared/src/evidence-output-lifecycle.ts:1170  if (f.reportRequest?.afterLatestReport) { const failed = failedRequestDecision(...)
packages/shared/src/evidence-output-lifecycle.ts:1116  return { action: "NONE", reason: "ESCALATED_TO_OPERATOR", operation: null };
apps/web/components/reports-experience/ReportsIndex.tsx:1255  const reportReady = row.report.state === "ready";
```

### ET-RPT-02

**P2 · incorrect KPI / misleading status · SOURCE_PROVEN_DEFECT** — Request-level BLOCKED (stale policy / policy block) is uncounted for reports and mislabelled 'not requested' in rows, while 'Packages blocked' counts rows that say 'Package not requested'

- **Affected:** routes: GET /v1/reports/artifacts; pages: /reports; jobs: GENERATE_REPORT; tables: report_generation_requests
- **Evidence:** `services/worker/src/report-generation-authority.ts:253`, `services/api/src/services/reports/reports-aggregator.service.ts:361`, `services/api/src/services/reports/reports-aggregator.service.ts:379`, `services/api/src/services/reports/reports-aggregator.service.ts:1212`, `apps/web/components/reports-experience/ReportsIndex.tsx:1349`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** When the latest request is BLOCKED_STALE/BLOCKED_POLICY and no report exists (e.g. any governance policy edit between completion and worker claim, org suspended), the report canonical state BLOCKED is pushed into no report bucket (no card, no filter) and the row reads 'Report not requested / not generated yet'. For the package, canonical BLOCKED is counted in 'Packages blocked' and returned by package_blocked, but toPackageLifecycle returns 'blocked' only when verificationPackageMetadata.blocked is set, so those rows read 'Package not requested'.
- **Expected:** Blocked requests have one label and one count: a 'blocked' row state for both outputs and a report-blocked card/filter; clicking 'Packages blocked' shows rows that say blocked.
- **Data flow:** worker claim refusal -> state BLOCKED_* -> projectReportRequestState BLOCKED -> deriveEvidenceOutputState BLOCKED -> classify (package only) / row mapper (metadata-only 'blocked').
- **Root cause:** Legacy five-value vocabulary maps request-level BLOCKED to not_requested; the package 'blocked' label is keyed on governance metadata, not on the canonical state the card counts.
- **Blast radius:** All workspaces after a governance policy version bump with queued first-issuance requests; suspended orgs.
- **Impact:** Card/filter and row text disagree; a blocked first issuance looks like it was never requested.
- **Reproduction:** Queue a first-issuance request, bump workspace_governance_policy.version before the worker claims -> BLOCKED_STALE; /reports: report counted nowhere, 'Packages blocked' +1, row 'Report not generated yet' / 'Package not generated yet'.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Seed SIGNED evidence (eligible plan), request row state BLOCKED_STALE terminalReasonCode 'policy_version_changed', no report; assert summary.packagesBlocked=1, no report bucket contains the id, items[0].report.state==='not_requested' and package.state==='not_requested'.
- **Recommended remediation:** Map canonical BLOCKED to 'blocked' in both lifecycle mappers (server and client), add a report_blocked bucket/card, and derive the package 'blocked' label from the canonical state.
- **Acceptance proof:** For every lifecycle filter, every returned row's rendered status matches the filter's card label.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/report-generation-authority.ts:253  terminalReasonCode: "policy_version_changed",
services/api/src/services/reports/reports-aggregator.service.ts:361  case "BLOCKED": return "not_requested";
services/api/src/services/reports/reports-aggregator.service.ts:379  if (blocked && state === "BLOCKED") return "blocked";
services/api/src/services/reports/reports-aggregator.service.ts:1212  else if (packageState === "BLOCKED") out.packageBlocked.push(row.id);
apps/web/components/reports-experience/ReportsIndex.tsx:1349  : row.report.state === "not_requested" ? "Report not generated yet"
```

### ET-RPT-03

**P2 · misleading legal statement in report PDF · SOURCE_PROVEN_DEFECT** — Report PDF prints 'Legal Hold: OFF' from the inert S3 object-lock flag even when a canonical evidence legal hold is ACTIVE

- **Affected:** jobs: GENERATE_REPORT; tables: evidence_legal_holds, reports
- **Evidence:** `services/worker/src/report-v2/build-view-model.ts:813`, `services/worker/src/config.ts:78`, `services/worker/src/report-v2/sections/lifecycle-summary.ts:111`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The only legal-hold line in the evidence report is the storage row sourced from the object's S3 legal-hold header, which is never set in production, so it defaults to 'OFF'. The canonical-hold section (loadLifecycleSummary) has zero production callers (only a test), and runReportGeneration/buildReportPdfV2 never read evidence_legal_holds.
- **Expected:** The report either states the canonical preservation hold status for this record (evaluateEffectiveLegalHold) or labels the row as the storage-layer flag ('Storage object-lock legal hold: not used').
- **Data flow:** S3 HEAD objectLockLegalHoldStatus (null) -> resolveEvidenceStorageSnapshot -> buildStorageRows 'Legal Hold' = 'OFF'.
- **Root cause:** Storage-layer field reused as the legal-hold statement after S3 legal hold was retired; canonical section never wired.
- **Blast radius:** Every report issued for held evidence.
- **Impact:** A forensic document asserts no legal hold on evidence that is under hold.
- **Reproduction:** Place ACTIVE EvidenceLegalHold on an evidence record, generate report; storage section reads 'Legal Hold OFF'.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Render buildReportPdfV2 HTML (render-html) for a fixture with storageObjectLockLegalHoldStatus=null and an active hold in DB; grep output for 'Legal Hold' row value 'OFF' and absence of any hold section.
- **Recommended remediation:** Relabel the row as storage object-lock and add a canonical 'Preservation (legal) hold at issuance' row from evaluateEffectiveLegalHold; wire or delete loadLifecycleSummary.
- **Acceptance proof:** Report for held evidence states the hold as active; unit test on build-view-model.
- **Migration/backfill:** none (historical PDFs immutable; document the limitation)
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/report-v2/build-view-model.ts:813  label: "Legal Hold", value: safe(evidence.storageObjectLockLegalHoldStatus, "OFF"),
services/worker/src/config.ts:78  "S3_OBJECT_LOCK_LEGAL_HOLD=ON is not supported: native S3 Object Lock legal hold is not implemented. " +
services/worker/src/report-v2/sections/lifecycle-summary.ts:111  export async function loadLifecycleSummary(input: {
```

### ET-SEC-11

**P2 · concurrency/idempotency · SOURCE_PROVEN_DEFECT** — Repeat /complete on a REPORTED record returns without alreadyFinalized, re-running the one-time fan-out (duplicate EVIDENCE_COMPLETED custody event, evidence.completed webhook, malware scan, post-finalize)

- **Affected:** routes: POST /v1/evidence/:id/complete; tables: custody_events
- **Evidence:** `services/api/src/services/evidence-complete.service.ts:516`, `services/api/src/services/evidence-complete.service.ts:1483`, `services/api/src/routes/evidence.routes.ts:10244`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** SIGNED short-circuit sets alreadyFinalized:true (:580/589); REPORTED branch does not.
- **Expected:** REPORTED branch returns alreadyFinalized:true.
- **Data flow:** POST /v1/evidence/:id/complete -> completeEvidence -> advisory lock -> REPORTED early return without alreadyFinalized (:516) -> post-commit guard (:1483) not taken -> evidence.completed webhook, malware scan, runEvidenceCompletePostFinalize -> route appends EVIDENCE_COMPLETED custody (:10244).
- **Root cause:** The REPORTED short-circuit was written before the alreadyFinalized flag existed and was never updated to set it, unlike the SIGNED branch.
- **Blast radius:** Every record that reaches REPORTED and then receives another complete call (client retry, double click, mobile resend); affects the custody ledger and every subscribed webhook endpoint.
- **Impact:** Duplicate custody events and external webhooks on client retry/double-click after the report exists.
- **Reproduction:** Complete E; wait until REPORTED; POST /complete again; count EVIDENCE_COMPLETED custody events = 2.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration test calling completeEvidence twice around a REPORTED status update.
- **Recommended remediation:** Add alreadyFinalized:true to the REPORTED return.
- **Acceptance proof:** Second complete appends nothing.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/evidence-complete.service.ts:516  if (evidence.status === EvidenceStatus.REPORTED) { return { result: {...}, shouldEnqueueReport: false, retentionTargets: [], };
services/api/src/services/evidence-complete.service.ts:1483  if (final.alreadyFinalized) return final.result;
services/api/src/routes/evidence.routes.ts:10244  if (!result.alreadyFinalized) { await appendCustodyEvent({ evidenceId: id, eventType: prismaPkg.CustodyEventType.EVIDENCE_COMPLETED,
```

### ET-SEC-12

**P2 · concurrency/lifecycle · SOURCE_PROVEN_DEFECT** — Archive/trash/restore/unarchive are check-then-write: read + hold evaluation outside the transaction, write by id only, no lock

- **Affected:** routes: POST /v1/evidence/:id/archive, DELETE /v1/evidence/:id, POST /v1/evidence/:id/restore, POST /v1/evidence/:id/unarchive
- **Evidence:** `services/api/src/services/evidence/evidence-lifecycle.service.ts:212`, `services/api/src/services/evidence/evidence-lifecycle.service.ts:360`
- **Citations:** 2/2 resolve in the audited tree
- **Merged candidates:** security:SEC-12, statemachine:STATEMACHINE-04
- **Observed:** Double trash writes two EVIDENCE_DELETE_SCHEDULED custody events; archive vs trash can leave lifecycleState ARCHIVED with deletedAt set; hold placed after the read does not block trash/archive; trash does not take the evidence advisory lock that finalize uses so a concurrent finalize still signs and charges a credit for a trashed record (evidence-complete.service.ts:1099-1104 claim lacks deletedAt:null).
- **Expected:** Conditional updateMany on current lifecycleState + count, hold re-evaluated inside the tx under pg_advisory_xact_lock(evidenceId).
- **Data flow:** POST archive / DELETE / POST restore / unarchive -> applyEvidenceLifecycleAction -> evidence.findUnique + evaluateEffectiveLegalHold + capability check outside tx -> tx.evidence.update where {id} + custody append.
- **Root cause:** Lifecycle transitions are decided in JS on a snapshot read and written unconditionally by id, with no lock shared with finalize or the destruction executor.
- **Blast radius:** All evidence lifecycle actions in every workspace; concurrent UI/bulk actions, hold placement and finalize on the same record.
- **Impact:** Duplicate custody, inconsistent state pointer, hold bypass in a race window, paid signed record in trash with no report.
- **Reproduction:** Send two parallel DELETE /v1/evidence/:id for one ACTIVE record; count EVIDENCE_DELETE_SCHEDULED custody events (2). Separately, send DELETE and POST /archive in parallel and check lifecycle_state=ARCHIVED with deleted_at set.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Two parallel TRASH calls against local API; count custody events.
- **Recommended remediation:** Take the same advisory lock as finalize; use conditional updateMany; include deletedAt:null in finalize claim.
- **Acceptance proof:** Parallel test yields one transition and one custody event.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/evidence/evidence-lifecycle.service.ts:212  const evidence = await client.evidence.findUnique({ where: { id: input.evidenceId }, select: LIFECYCLE_SELECT });
services/api/src/services/evidence/evidence-lifecycle.service.ts:360  await tx.evidence.update({ where: { id: evidence.id }, data: patch.data });
```

### ET-SEC-13

**P2 · concurrency/state · SOURCE_PROVEN_DEFECT** — completeUploadSession can move an ABORTED session to COMPLETED (write guard only excludes COMPLETED)

- **Affected:** routes: POST /v1/uploads/sessions/:id/complete, POST /v1/uploads/sessions/:id/abort; tables: evidence_upload_sessions
- **Evidence:** `services/api/src/services/uploads/upload-session.service.ts:808`, `services/api/src/services/uploads/upload-session.service.ts:938`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Complete checks terminal state in JS (:781-787) then updates with a predicate that admits ABORTED/EXPIRED/FAILED.
- **Expected:** WHERE state = 'ACTIVE' (or NOT IN terminal set).
- **Data flow:** POST /v1/uploads/sessions/:id/complete -> completeUploadSession reads state (:781) -> verifies parts -> UPDATE evidence_upload_sessions SET state='COMPLETED' WHERE state <> 'COMPLETED' (:808); concurrent POST .../abort sets ABORTED (:938).
- **Root cause:** The complete write predicate only excludes COMPLETED instead of requiring a non-terminal state, so an abort committed after the read is overwritten.
- **Blast radius:** Any upload session where the user cancels while completion is in flight (user and integration upload paths share the service).
- **Impact:** User's cancel silently overridden; on multipart path the S3 upload was aborted so finalize fails at HEAD (stuck).
- **Reproduction:** Open a session and upload all parts; hold complete after its state read (debugger/breakpoint); POST /abort (commits ABORTED); release complete; SELECT state FROM evidence_upload_sessions -> COMPLETED.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Parallel abort/complete against local PG.
- **Recommended remediation:** Use the abort predicate set on complete.
- **Acceptance proof:** Complete after abort returns session_already_terminal.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/uploads/upload-session.service.ts:808  WHERE "id" = $1 AND "team_id" = $2 AND "state" <> 'COMPLETED'
services/api/src/services/uploads/upload-session.service.ts:938  AND "state" NOT IN ('COMPLETED', 'ABORTED', 'EXPIRED')
```

### ET-SEC-14

**P2 · authz/governance · SOURCE_PROVEN_DEFECT** — Report regeneration / NEW_VERSION bypasses workspace governance policy (requireReviewBeforeReport, allowReportDownload, template overlay)

- **Affected:** routes: POST /v1/evidence/:id/reports/regenerate
- **Evidence:** `services/api/src/routes/evidence.routes.ts:10757`, `services/api/src/services/governance.service.ts:893`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** No call to enforceSensitiveAction('generate_report') in the route or services/reports (sub-agent grep); governance is enforced only at finalization (finalization-governance.service.ts:53-70).
- **Expected:** Regenerate runs the same sensitive-action policy as first issuance.
- **Data flow:** POST /v1/evidence/:id/reports/regenerate -> resolveEvidenceOperationAccess(evidence.generate_report) -> requestOutputRecovery -> requestReportGeneration -> report_generation_requests -> worker renders new report version.
- **Root cause:** Workspace governance (enforceSensitiveAction/finalization-governance) was wired only into finalization, and the recovery/regenerate path was added later using the capability check alone.
- **Blast radius:** All workspaces that configure requireReviewBeforeReport, allowReportDownload or template policy overlays; any member holding evidence.generate_report.
- **Impact:** Updated reports issued on unreviewed records contrary to workspace policy.
- **Reproduction:** Set workspace policy requireReviewBeforeReport=true; leave record E unreviewed; as a member with generate_report POST /v1/evidence/E/reports/regenerate {mode:NEW_VERSION}; observe accepted request and a new report version.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Workspace policy requireReviewBeforeReport=true; regenerate as member -> 202 (defect).
- **Recommended remediation:** Call enforceSensitiveAction('generate_report', ctx) before requestOutputRecovery.
- **Acceptance proof:** Policy-blocked regenerate returns 403 with policy reason.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:10757  resolveEvidenceOperationAccess(... "evidence.generate_report")
services/api/src/services/governance.service.ts:893  export async function enforceSensitiveAction(
```

### ET-SEC-15

**P2 · authz/billing · SOURCE_PROVEN_DEFECT** — AI categorization run (paid, budget-consuming mutation) gated by legacy READ access only; AI policy evaluated without role/plan inputs

- **Affected:** routes: POST /v1/evidence/:id/ai-categorization/run; roles: VIEWER, stale CaseAccess holders, expired members
- **Evidence:** `services/api/src/routes/evidence.routes.ts:8603`, `services/api/src/routes/evidence.routes.ts:8686`
- **Citations:** 1/2 resolve in the audited tree
- **Observed:** evaluateWorkspaceAiPolicy({teamId, feature, dataClass}) passes no userRole/planAllowed (:8649-8653); decideAiPolicy skips plan check when planAllowed undefined (workspace-ai-policy.service.ts:192).
- **Expected:** Canonical record access with a mutation permission, and full AI policy inputs.
- **Data flow:** POST /v1/evidence/:id/ai-categorization/run -> getEvidenceWithReadAccess -> evaluateWorkspaceAiPolicy({teamId, feature, dataClass}) -> tryReserveAiBudget(teamId) -> AI provider call -> evidenceAiCategorization insert.
- **Root cause:** The route reused the read gate for a mutating, budget-consuming action and omitted role and plan inputs to the AI policy.
- **Blast radius:** Every workspace with AI enabled; any VIEWER, stale CaseAccess holder, expired member or revoked creator can spend the workspace AI budget.
- **Impact:** Viewers/stale actors spend the workspace AI budget and write categorization rows.
- **Reproduction:** As a VIEWER of workspace T, POST /v1/evidence/E/ai-categorization/run for E in T; observe 200, a new evidence_ai_categorizations row and increased AI budget usage for T.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: VIEWER calls the route in local fixture.
- **Recommended remediation:** Use getEvidenceWithRecordAccess(..., 'evidence.update_metadata' or ai permission) and pass role + plan.
- **Acceptance proof:** VIEWER receives 403/404.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:8603  const evidence = await getEvidenceWithReadAccess(userId, id);
services/api/src/routes/evidence.routes.ts:8686  tryReserveAiBudget({ teamId: evidence.teamId
```

### ET-SEC-16

**P2 · duplicate-authority/authz · SOURCE_PROVEN_DEFECT** — Two case-link authorities: bulk ADD/REMOVE_FROM_CASE use a weaker case check than the single routes; case-workspace detach vs cases detach disagree on teamId reset

- **Affected:** routes: POST /v1/evidence/bulk, POST/DELETE /v1/cases/:id/evidence, /v1/cases/:id/evidence-links
- **Evidence:** `services/api/src/routes/evidence.routes.ts:7134`, `services/api/src/routes/cases.routes.ts:1370`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Bulk ignores the case permission matrix and CaseAccess restrictions; REMOVE_FROM_CASE performs no case check at all. removeEvidenceLink (case-lifecycle.service.ts:676-697) does not clear teamId while detachEvidenceFromCase does.
- **Expected:** One case-link authority with one permission rule.
- **Data flow:** POST /v1/evidence/bulk {ADD_TO_CASE|REMOVE_FROM_CASE} -> case check owner OR ACTIVE member (:7134) / none for remove -> attachEvidenceToCase / detachEvidenceFromCase; vs POST/DELETE /v1/cases/:id/evidence -> evaluateCaseMutationPermission; vs case-workspace evidence-links -> removeEvidenceLink (no teamId reset).
- **Root cause:** Bulk actions and case-workspace routes each implemented their own case authorization and detach semantics instead of calling one case-link authority.
- **Blast radius:** All cases with restricted CaseAccess lists and all evidence linked to cases; any ACTIVE member with update_metadata on the evidence.
- **Impact:** Members attach/detach restricted cases; feeds SEC-02.
- **Reproduction:** Create case C with a CaseAccess list excluding member M; as M POST /v1/evidence/bulk {action:ADD_TO_CASE, caseId:C, evidenceIds:[E]} -> link created, while POST /v1/cases/C/evidence as M is denied.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Restricted case with CaseAccess list excluding member; bulk ADD_TO_CASE succeeds (defect).
- **Recommended remediation:** Route bulk through evaluateCaseMutationPermission; unify detach services.
- **Acceptance proof:** Bulk call by non-permitted member -> 404.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:7134  let canAccessCase = caseItem.ownerUserId === userId; ... canAccessCase = caseTeamMember?.status === "ACTIVE";
services/api/src/routes/cases.routes.ts:1370  evaluateCaseMutationPermission({ mutation: "EVIDENCE_LINK", accessRole ...
```

### ET-SEC-17

**P2 · custody/legal-hold · SOURCE_PROVEN_DEFECT** — Case-delete legal-hold check fails OPEN on DB error before hard-deleting the case and detaching all evidence

- **Affected:** routes: DELETE /v1/cases/:id; tables: cases, case_evidence_links, case_access
- **Evidence:** `services/api/src/routes/cases.routes.ts:79`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** The code comment above says 'an unresolvable ACTIVE hold must still block — fail closed' but the catch returns ok:true.
- **Expected:** catch => { ok:false } (503).
- **Data flow:** DELETE /v1/cases/:id -> hold check helper (evidenceLegalHold.findMany in try) -> catch returns {ok:true} -> detachAllEvidenceFromCase -> caseAccess.deleteMany -> prisma.case.delete.
- **Root cause:** The catch block returns the success value instead of failing closed, contradicting the helper's own fail-closed intent.
- **Blast radius:** Any case under CASE or WORKSPACE legal hold, whenever the hold query errors (DB blip, timeout, schema drift).
- **Impact:** Transient DB error allows deleting a case under CASE/WORKSPACE hold.
- **Reproduction:** In a test using the real route, make prisma.evidenceLegalHold.findMany throw; place an ACTIVE CASE hold on C; DELETE /v1/cases/C -> case deleted and evidence detached.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Fail closed.
- **Acceptance proof:** Error injection returns 503 and case remains.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/cases.routes.ts:79  return { ok: true, holdIds: [] }; } catch { return { ok: true, holdIds: [] };
```

### ET-SEC-18

**P2 · tenancy/authz · SOURCE_PROVEN_DEFECT** — GET /v1/reports skips authorizeOrFail (bare ACTIVE-status membership, no permission/expiry/org-lifecycle); fallback query drops deletedAt/lifecycle filters

- **Affected:** routes: GET /v1/reports
- **Evidence:** `services/api/src/routes/reports.routes.ts:176`, `services/api/src/routes/reports.routes.ts:310`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Primary query filters deletedAt null and lifecycleState (:245-257); fallback on any primary error does not; unscoped arm includes ownerUserId across all teams (:225-229).
- **Expected:** Canonical authorization; fallback preserves filters.
- **Data flow:** GET /v1/reports -> teamMember.findMany status ACTIVE (:176) -> accessClause (team ids + ownerUserId) -> evidence.findMany primary (deletedAt null, lifecycle filter) -> on error fallbackWhere (:310) without those filters -> report rows.
- **Root cause:** The route predates authorizeOrFail and hand-rolls membership; the fallback query was written as a separate where object rather than reusing the primary builder.
- **Blast radius:** All users listing reports: expired members and members of suspended orgs see report metadata; on primary-query errors every caller sees trashed/destroyed records.
- **Impact:** Suspended-org/expired members list report metadata; trashed/destroyed rows appear on error.
- **Reproduction:** Set access_expires_at_utc in the past for an ACTIVE member X; GET /v1/reports as X -> team records listed. For the fallback, force the primary query to throw and observe TRASHED records in the response.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Expired member fixture call.
- **Recommended remediation:** Use authorizeOrFail/evaluateMemberAccess; share the where builder.
- **Acceptance proof:** Route test with expired member -> empty/404.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/reports.routes.ts:176  bare teamMember status ACTIVE lookup
services/api/src/routes/reports.routes.ts:310  fallbackWhere = { AND: [accessClause, { status: { in: ["SIGNED","REPORTED"] } }, ...cursor] }
```

### ET-SEC-19

**P2 · authz/signed-url · SOURCE_PROVEN_DEFECT** — Exchange package signed URL (issued behind generate_package + step-up) is persisted and returned to any evidence.read member by list

- **Affected:** routes: GET /v1/exchange/packages, POST /v1/exchange/packages; tables: evidence_exchange_packages; roles: VIEWER
- **Evidence:** `services/api/src/services/exchange/evidence-exchange.service.ts:277`, `services/api/src/services/exchange/evidence-exchange.service.ts:593`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** List route requires only evidence.read (product-and-lifecycle.routes.ts:282-290); TTL up to 7 days. No in-repo route consumes verifySignedManifest, so byte impact unproven.
- **Expected:** Never persist/return bearer tokens to lower-privileged roles.
- **Data flow:** POST /v1/exchange/packages (generate_package + step-up) -> evidence-exchange.service signs token -> row.signedUrl persisted (:277) -> GET /v1/exchange/packages (evidence.read) -> listPackages returns signedUrl (:593).
- **Root cause:** The bearer URL is stored as a column and serialized by the list projection instead of being minted on demand behind the privileged action.
- **Blast radius:** Every exchange package in a workspace; every member with evidence.read (including VIEWER) for up to the 7-day token TTL.
- **Impact:** Step-up protection bypass if the URL is redeemable.
- **Reproduction:** As an admin create an exchange package with step-up; as a VIEWER GET /v1/exchange/packages and read signedUrl with ?token= in the response.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Determine whether any deployed service redeems ?token=.
- **Recommended remediation:** Do not store the token; mint on demand behind generate_package.
- **Acceptance proof:** List response has no token.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/exchange/evidence-exchange.service.ts:277  signedUrl = `${base}${row.id}?token=${signed.token}`
services/api/src/services/exchange/evidence-exchange.service.ts:593  signedUrl: r.signedUrl,
```

### ET-SEC-20

**P2 · duplicate-authority/status · SOURCE_PROVEN_DEFECT** — Report/package backlog computed by five aggregators with three rules (entitlement-narrowed relation test, column test, un-narrowed); dashboard 'entitled' ignores subscription lifecycle while worker issuance honors it

- **Affected:** pages: Home, Operations, Org health, Case risk, Matter queue; jobs: report worker, first-issuance-reconciliation
- **Evidence:** `services/api/src/services/dashboard/command-center-counters.ts:283`, `services/api/src/services/operations/operations-source-probes.ts:246`, `services/api/src/services/cases/case-risk-engine.service.ts:148`, `services/api/src/services/billing/evidence-output-eligibility.service.ts:488`, `services/worker/src/report-generation-authority.ts:749`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** FREE workspace: Home backlog 0 while org-health/case-risk penalize; lapsed PRO: Operations backlog counts records the worker refuses (processor.ts:2185) => never clears.
- **Expected:** One owed-output predicate (resolveOutputIssuanceEntitlement) used by every aggregator.
- **Data flow:** Home/Operations counters (command-center-counters.ts:283, operations-source-probes.ts:246), org-health, case-risk, matter-queue each query evidence with their own 'missing report' predicate; worker processor.ts:2185 and first-issuance-reconciliation decide via resolveOutputIssuanceEntitlement (lifecycle-aware).
- **Root cause:** Each dashboard implemented its own owed-output predicate; evidence-output-eligibility uses plan capabilities only while the worker uses the lifecycle-aware shared resolver.
- **Blast radius:** All workspace dashboards (Home, Operations, org health, case risk, matter queue) for FREE workspaces and lapsed/cancelled paid subscriptions.
- **Impact:** Incorrect KPIs, permanent phantom backlog.
- **Reproduction:** Fixture: PRO workspace with subscription status CANCELLED and SIGNED records without reports; compare Operations pipeline.report_backlog (>0) with worker decision REPORT_NOT_INCLUDED_IN_PLAN and first-issuance skip; backlog never drains.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Fixture with lapsed subscription; compare Operations vs worker decision.
- **Recommended remediation:** Centralize owed-output predicate in shared and use it everywhere.
- **Acceptance proof:** All aggregators agree on fixture workspaces (FREE, lapsed PRO).
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Confirm resolveCommercialPlan returns paid plan under lapsed lifecycle.

```text
services/api/src/services/dashboard/command-center-counters.ts:283  reports: { none: {} }
services/api/src/services/operations/operations-source-probes.ts:246  { status: "SIGNED", latestReportVersion: null }
services/api/src/services/cases/case-risk-engine.service.ts:148  un-narrowed missing-report count
services/api/src/services/billing/evidence-output-eligibility.service.ts:488  if (getPlanCapabilities(ctx.plan).reportsIncluded) return null;
services/worker/src/report-generation-authority.ts:749  verificationPackageOwed uses resolveEvidenceOutputEntitlements (plan+funding only)
```

### ET-SEC-21

**P2 · duplicate-authority/integrity · SOURCE_PROVEN_DEFECT** — Case risk 'integrity' signal reads evidence_integrity_snapshots, which is backfilled once for SIGNED/REPORTED only and never refreshed, so it cannot report FAILED rows

- **Affected:** pages: case risk
- **Evidence:** `services/api/src/services/cases/case-risk-engine.service.ts:180`, `services/api/src/services/dashboard/integrity-snapshot.service.ts:439`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Integrity rejection sets status FAILED_HASH_MISMATCH (worker integrity-rejection.service.ts:163-164) so the row is never snapshotted; matter workspace groupBy on live verificationStatus shows FAILED.
- **Expected:** Risk engine reads live verificationStatus.
- **Data flow:** Case risk engine -> evidenceIntegritySnapshot.overallStatus count (:180) <- snapshots written once by command-center lazy backfill (status SIGNED/REPORTED only, :439); worker integrity rejection sets evidence.status FAILED_HASH_MISMATCH.
- **Root cause:** The risk engine reads a denormalized snapshot table whose only writer is a one-time backfill that excludes failed rows and is never refreshed.
- **Blast radius:** Every case's risk score/integrity card in every workspace once any snapshot row exists.
- **Impact:** Case risk shows 0 integrity concerns while evidence failed (false all-clear on that card).
- **Reproduction:** Fixture case with one evidence moved to FAILED_HASH_MISMATCH by integrity rejection; open case risk -> integrity concerns 0 while matter workspace groupBy shows FAILED.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Fixture case with one FAILED_HASH_MISMATCH evidence.
- **Recommended remediation:** Read evidence.verificationStatus directly; retire the snapshot or refresh on every transition.
- **Acceptance proof:** Fixture with FAILED evidence raises case risk integrity count.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/cases/case-risk-engine.service.ts:180  counts integrityFailed from evidenceIntegritySnapshot.overallStatus
services/api/src/services/dashboard/integrity-snapshot.service.ts:439  status: { in: ["SIGNED", "REPORTED"] }
```

### ET-SEC-22

**P2 · duplicate-authority/quota · SOURCE_PROVEN_DEFECT** — Storage-used population differs between evidence creation (includes legacy NULL-team rows) and completion/worker (strict team) for personal workspaces

- **Affected:** routes: POST /v1/evidence, POST /v1/evidence/:id/complete; jobs: worker storage gate
- **Evidence:** `services/api/src/services/workspace-usage.service.ts:340`, `services/api/src/services/workspace-usage.service.ts:347`, `packages/shared-runtime/src/workspace-scope.ts:151`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Creation passes teamId:null (evidence.service.ts:352-355); completion passes the personal team id (evidence-complete.service.ts:507-510).
- **Expected:** Both use the canonical shared workspace-scope population.
- **Data flow:** POST /v1/evidence -> createEvidence passes teamId:null -> getWorkspaceUsage personal branch (OR teamId null + personal team, :340); POST /complete -> scope from evidence.teamId -> strict branch (teamId only, :347); worker workspace-billing matches completion.
- **Root cause:** getWorkspaceUsage branches on whether the caller passed null or the personal team id instead of using the shared workspace-scope population.
- **Blast radius:** Personal-workspace users who own legacy NULL-team rows; quota admission and remaining-storage display.
- **Impact:** Two quota answers for the same payer; admission at create, different remaining at complete.
- **Reproduction:** Personal user with legacy NULL-team evidence near the storage limit: POST /v1/evidence passes the check with usage including legacy rows, then /complete computes a different (lower) used figure; compare the two usage values logged/returned.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Personal user with legacy NULL-team rows near quota.
- **Recommended remediation:** Use shared workspace-scope in getWorkspaceUsage.
- **Acceptance proof:** Unit test on fixture with legacy rows shows equal usage at both phases.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/workspace-usage.service.ts:340  OR: [{ teamId: null }, ...personalTeamForUsage...]
services/api/src/services/workspace-usage.service.ts:347  teamId: scope.teamId
packages/shared-runtime/src/workspace-scope.ts:151  OR: [{ teamId: physicalWorkspaceId }, { AND: [{ ownerUserId: owner }, { teamId: null }] }]
```

### ET-SEC-23

**P2 · duplicate-authority/pricing · SOURCE_PROVEN_DEFECT** — Pricing page says FREE storage add-ons 'Not available' while shared commercial policy and API allow FREE storage add-on purchase

- **Affected:** pages: /pricing; plans: FREE
- **Evidence:** `apps/web/app/pricing/page.tsx:558`, `packages/shared-billing/src/plan-catalog.ts:1049`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** API enforces the shared policy (billing.routes.ts:465, workspace-usage.service.ts:144).
- **Expected:** Web reads the catalog.
- **Data flow:** apps/web/app/pricing/page.tsx renders hard-coded 'Not available' for FREE storage add-ons; API billing.routes.ts:465 / workspace-usage.service.ts:144 consult plan-catalog.ts:1049 which returns storageAddonsPurchasable true for FREE.
- **Root cause:** The pricing page hard-codes the add-on row instead of reading the shared commercial policy.
- **Blast radius:** All visitors comparing plans on /pricing; FREE-plan customers.
- **Impact:** Customer-facing pricing contradicts purchasable product.
- **Reproduction:** Open /pricing and read the FREE 'Storage add-ons' cell ('Not available'); as a FREE user call the storage add-on purchase endpoint and observe it is permitted.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Render from catalog.
- **Acceptance proof:** Pricing page row derived from storageAddonsPurchasable.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/app/pricing/page.tsx:558  "Not available"
packages/shared-billing/src/plan-catalog.ts:1049  if (input.plan === "FREE") { return { storageAddonsPurchasable: true, source: "FREE_STORAGE" }; }
```

### ET-SEC-24

**P2 · duplicate-authority/consumer · SOURCE_PROVEN_DEFECT** — Two reapers expire the same capture drafts; the API sweep writes EXPIRED events for all selected rows, not only those it transitioned

- **Affected:** jobs: capture-draft-expiry (API, CAPTURE_DRAFT_SWEEP_INPROCESS), capture-reaper (worker, default on); tables: capture_sessions
- **Evidence:** `services/api/src/jobs/capture-draft-expiry.job.ts:87`, `services/api/src/jobs/capture-draft-expiry.job.ts:111`, `services/worker/src/capture-reaper.ts:129`
- **Citations:** 2/3 resolve in the audited tree
- **Observed:** Worker reaper enabled by default (index.ts:597-600); API sweep when env flag set or CLI script.
- **Expected:** One reaper; events only for rows actually transitioned.
- **Data flow:** API capture-draft-expiry job selects expired DRAFT rows -> updateMany status DRAFT->EXPIRED -> createMany events for all selected rows; worker capture-reaper claims each row conditionally and writes one event per claim.
- **Root cause:** Two reapers exist for the same rows and the API sweep builds events from the selected set, not from rows it actually transitioned.
- **Blast radius:** All expired capture drafts in deployments where CAPTURE_DRAFT_SWEEP_INPROCESS=true or the sweep CLI runs alongside the default-on worker reaper.
- **Impact:** Duplicate EXPIRED ledger rows with different reasons.
- **Reproduction:** Enable both reapers; create an expired DRAFT capture session; let the worker expire it just before the API sweep's updateMany; observe two EXPIRED events with reasons 'expiresAtUtc elapsed' and 'expires_at_utc_passed'.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Check whether CAPTURE_DRAFT_SWEEP_INPROCESS is set in any environment.
- **Recommended remediation:** Delete the API sweep or build events from updateMany-returned ids.
- **Acceptance proof:** Both running produce one event per row.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Confirm the in-process API sweep is enabled anywhere.

```text
services/api/src/jobs/capture-draft-expiry.job.ts:87  updateMany({ where: { id: { in: ids }, status: "DRAFT" } ...})
services/api/src/jobs/capture-draft-expiry.job.ts:111  createMany (events built from all selected rows)
services/worker/src/capture-reaper.ts:129  per-row conditional claim + one event per claim
```

### ET-SEC-25

**P2 · tenancy/authz · SOURCE_PROVEN_DEFECT** — API-key upload path bypasses organization-lifecycle denial enforced on the user upload path

- **Affected:** routes: /v1/integrations/api/uploads/sessions/*
- **Evidence:** `services/api/src/routes/upload-sessions.routes.ts:536`, `services/api/src/routes/integrations-uploads.routes.ts:310`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** gateEvidenceForUpload (:268-297) checks team, archived, legal hold only; verifyApiKeyDetailed checks key status/expiry only (negative grep finding).
- **Expected:** Suspended/terminated organization cannot ingest via API keys.
- **Data flow:** /v1/integrations/api/uploads/sessions/* -> requireApiKey/requireApiScope (verifyApiKeyDetailed: key status/expiry) -> gateEvidenceForUpload (team, archived, hold) -> upload-session.service; vs user path authorizeOrFail (org lifecycle).
- **Root cause:** The integration auth path was built on API-key validity alone and never calls the organization-lifecycle check embedded in authorizeOrFail.
- **Blast radius:** All organizations with active API keys whose organization is SUSPENDED/TERMINATED/ARCHIVED.
- **Impact:** Suspended org continues writing evidence via API.
- **Reproduction:** Create an API key for workspace T; set T's organization status SUSPENDED; POST /v1/integrations/api/uploads/sessions with the key -> session created, while POST /v1/uploads/sessions as a member returns 404/403.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Suspend org in fixture; call integration upload create.
- **Recommended remediation:** Check organization lifecycle in integrations auth.
- **Acceptance proof:** Suspended org API key -> 403.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/upload-sessions.routes.ts:536  authorizeOrFail(...)
services/api/src/routes/integrations-uploads.routes.ts:310  requireApiKey + requireApiScope
```

### ET-SEC-26

**P2 · byte-release · SOURCE_PROVEN_DEFECT** — Redaction derivative download presigns bytes outside the canonical byte-release gate (no legal-hold/export-eligibility evaluation)

- **Affected:** routes: redaction derivative download
- **Evidence:** `services/api/src/routes/redaction.routes.ts:1614`, `services/api/src/services/evidence/artifact-download-gate.service.ts:37`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Second byte-release path not covered by evaluateArtifactDownload.
- **Expected:** All byte releases through one gate.
- **Data flow:** Redaction derivative download route -> load derivative row -> presignGetObject(d.storageBucket, d.storageKey) (redaction.routes.ts:1614) -> presigned URL, bypassing evaluateArtifactDownload (kinds report|package|original only).
- **Root cause:** The byte-release gate's ArtifactKind union never included redaction derivatives, so the redaction route presigns directly.
- **Blast radius:** All redaction derivatives in workspaces with download-restricting governance policies or legal holds.
- **Impact:** Policy (download restrictions / holds) not applied to redacted copies.
- **Reproduction:** Workspace policy disallowing downloads (or active hold on E); create a redaction derivative of E; call the derivative download route -> presigned URL returned, while GET /v1/evidence/E/original is denied.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Workspace with download policy disallowing export; download redaction derivative.
- **Recommended remediation:** Add 'redaction' kind to the gate.
- **Acceptance proof:** Gate test covers redaction downloads.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Should a legal hold / download policy block redacted derivatives?

```text
services/api/src/routes/redaction.routes.ts:1614  presignGetObject({ bucket: d.storageBucket, key: d.storageKey ...
services/api/src/services/evidence/artifact-download-gate.service.ts:37  ArtifactKind = "report" | "package" | "original"
```

### ET-SEC-27

**P2 · concurrency/package · SOURCE_PROVEN_DEFECT** — Exchange-package build race after 30-min lease expiry: late builder overwrites fixed object key after the winner committed READY with its sha; failure path unconditionally marks build FAILED

- **Affected:** jobs: exchange-package-builder; tables: evidence_exchange_packages, evidence_exchange_package_builds
- **Evidence:** `services/worker/src/exchange-package-builder.ts:944`, `services/worker/src/exchange-package-builder.ts:237`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Upload precedes the conditional READY transition (:968-978).
- **Expected:** Per-attempt key or conditional upload; FAILED write fenced by attempt token.
- **Data flow:** exchange build job -> INSERT ... ON CONFLICT claim (30-min lease) -> build ZIP -> putObjectBuffer(exchange-packages/<team>/<package>.zip) -> updateMany state BUILDING->READY with sha -> on error UPDATE builds SET state='FAILED' by package_id.
- **Root cause:** The object upload happens before the conditional READY transition at a fixed key, and the FAILED write is not fenced by the attempt.
- **Blast radius:** Exchange package builds exceeding the 30-minute lease (large packages / slow storage).
- **Impact:** READY package sha may not match stored object (if ZIP is non-deterministic); build tracker says FAILED.
- **Reproduction:** Unit test with the lease shortened: start build W1, let the lease expire, start W2; W1 commits READY with sha1; W2 overwrites the object and marks the build FAILED; compare stored object sha with package_sha256.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit test with shortened lease.
- **Recommended remediation:** Write to attempt-scoped key and switch pointer in the conditional transition.
- **Acceptance proof:** Simulated lease expiry test keeps sha/object consistent.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/exchange-package-builder.ts:944  const storageKey = `exchange-packages/${teamId}/${packageId}.zip`;
services/worker/src/exchange-package-builder.ts:237  UPDATE evidence_exchange_package_builds SET state = 'FAILED' ... WHERE package_id = ${packageId}
```

### ET-SM-02

**P2 · terminal state re-opened / check-then-write · SOURCE_PROVEN_DEFECT** — Report commit (phase C) writes status=REPORTED with WHERE id only, so it can overwrite FAILED_HASH_MISMATCH and commit a Report on a trashed/destroyed record

- **Affected:** pages: /evidence/[id], /verify/[token]; jobs: report-v2 generation; tables: evidence, reports, custody_events
- **Evidence:** `services/worker/src/processor.ts:3570`, `services/worker/src/processor.ts:3947`, `services/worker/src/processor.ts:4010`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Status is validated in phase A (reserve) only. Phase B renders and publishes the PDF outside any lock (seconds to minutes). Phase C re-checks only the reservation row and the version slot, then unconditionally writes status REPORTED and verificationStatus, and appends custody events. A concurrent report job for the same evidence that detects a hash mismatch (integrity-rejection) or a destruction executor tombstoning the record during B is not observed.
- **Expected:** Phase C re-reads evidence under the advisory lock and refuses unless status IN (SIGNED, REPORTED), deletedAt null and lifecycleState not DESTROYED/PENDING_DESTRUCTION; the update uses updateMany with that predicate.
- **Data flow:** job X reserve (SIGNED) -> render -> [job Y prepare: re-hash mismatch -> FAILED_HASH_MISMATCH + verificationStatus FAILED] -> job X commit -> status REPORTED, verificationStatus reset, REPORT_GENERATED custody after INTEGRITY_REJECTED.
- **Root cause:** The 2026-09 reserve/render/commit split moved the status guard to phase A and left the phase-C write unconditional.
- **Blast radius:** Requires two report jobs for one evidence (first-issue + forceRegenerate / package recovery) with differing re-hash results (legacy rows without storageVersionId, or storage corruption), or destruction during render. Low frequency, high consequence.
- **Impact:** A record the platform declared integrity-failed returns to REPORTED with a fresh report; a destroyed record regains a Report row and a reports/{id}/ object after its destruction certificate claimed all versions absent.
- **Reproduction:** Hold job X in phase B (breakpoint after publishImmutableArtifact), run rejectEvidenceIntegrity for the same id, release X; observe status REPORTED.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Worker integration test with an injected hook between B and C that calls rejectEvidenceIntegrity; assert final status.
- **Recommended remediation:** In phase C: SELECT status, deletedAt, lifecycleState under the advisory lock; throw non-retriable when not eligible; convert the update to updateMany WHERE status IN (SIGNED,REPORTED) AND deletedAt IS NULL AND lifecycleState NOT IN (DESTROYED, PENDING_DESTRUCTION) and assert count=1.
- **Acceptance proof:** Race test above ends in FAILED_HASH_MISMATCH with no REPORT_GENERATED after INTEGRITY_REJECTED_HASH_MISMATCH.
- **Migration/backfill:** Query custody_events for REPORT_GENERATED with sequence after INTEGRITY_REJECTED_HASH_MISMATCH, and reports created after destroyed_at_utc.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/processor.ts:3570  const lockedEvidence = await tx.evidence.findFirst({ where: { id: prepared.evidenceId, deletedAt: null },
services/worker/src/processor.ts:3947  if ( taken || stillReserved?.stage !== "REPORT_RESERVED" || stillReserved.reportVersion !== prepared.version ) {
services/worker/src/processor.ts:4010  await tx.evidence.update({ where: { id: prepared.evidenceId }, data: { status: EvidenceStatus.REPORTED, verificationStatus: effectiveVerificationStatus,
```

### ET-SM-03

**P2 · storage version binding incomplete · SOURCE_PROVEN_DEFECT** — Several original-byte paths still address latest-at-key instead of the signed storageVersionId (verify-content viewUrl, retention apply + lock snapshot, archive tier), while the owner can still write new versions at the key

- **Affected:** routes: GET /public/verify/:id, authenticated verify/content routes using buildPublicEvidenceContent, POST /v1/evidence/:id/complete, archive-tier transitions; pages: /verify/[token]; tables: evidence, evidence_parts, archive_tier_transitions; roles: owner
- **Evidence:** `services/api/src/routes/evidence.routes.ts:3767`, `services/api/src/routes/evidence.routes.ts:3906`, `services/api/src/storage.ts:476`, `services/api/src/services/evidence-complete.service.ts:1276`, `services/api/src/storage.ts:752`, `services/api/src/services/evidence.service.ts:612`, `services/api/src/routes/evidence.routes.ts:6019`
- **Citations:** 7/7 resolve in the audited tree
- **Observed:** D14 (2026-09-29) persisted storageVersionId and pinned the worker re-hash and the two download routes, but buildPublicEvidenceContent's params carry no version, so the direct viewUrl of the ORIGINAL returns whatever version is latest at the key while the page prints the signed sha256. Retention is applied to, and the lock snapshot/EVIDENCE_LOCKED event describe, the latest version by key. Archive-tier CopyObject creates a NEW latest version in the cold class; the signed version stays STANDARD and remains what downloads read, while the transition is recorded COMPLETED. New versions at the key remain possible after signing: the createEvidence PUT URL is valid 600s (<=900s) regardless of finalization, and the part-presign route re-issues a PUT to an existing part key for FAILED_HASH_MISMATCH rows (it excludes only SIGNED/REPORTED/lockedAt), overwriting the 'preserved for forensic inspection' latest bytes.
- **Expected:** Every read, retention write, snapshot and storage-class operation on an original addresses the recorded VersionId; no PUT capability survives finalization.
- **Data flow:** owner PUTs V1 -> /complete hashes+signs V1 (storageVersionId=V1) -> owner re-uses still-valid PUT URL to write V2 -> PutObjectRetention/HEAD by key hit V2 -> public verify viewUrl serves V2 beside V1's hash.
- **Root cause:** Version pinning was retrofitted to selected readers; key-addressed helpers (presignGetObject without versionId, applyObjectRetention, headObject, copyObjectStorageClass, restoreObject) were not converted.
- **Blast radius:** Records finalized within the PUT URL lifetime of their creation (i.e., almost all), exploitable only by the uploader (or holder of the URL); archive-tier affects every archived record.
- **Impact:** Verify page can serve bytes that differ from the displayed signed hash (a careful verifier would detect the mismatch, a casual viewer would not); lock metadata may describe a different version than the one signed; archive tier claims a move that did not happen to the signed bytes.
- **Reproduction:** Create evidence, PUT file A, /complete, PUT file B with the same URL within 10 minutes, open /verify/:id with download allowed: viewUrl returns B.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: MinIO with versioning enabled: run the reproduction and compare GET(viewUrl) bytes hash with evidence.file_sha256.
- **Recommended remediation:** Thread storageVersionId through buildPublicEvidenceContent and all presignGetObject callers; add VersionId to PutObjectRetention and the post-commit HEAD; make copyObjectStorageClass/restoreObject version-aware (or refuse archive tier for versioned originals); after finalization refuse re-presign for any status other than CREATED/UPLOADING and consider a bucket policy denying PutObject on evidence/{id}/ once signed.
- **Acceptance proof:** Test that every presignGetObject call for an original includes versionId when the row has one (AST check) + MinIO test of the reproduction serving V1.
- **Migration/backfill:** none (legacy rows without VersionId continue to read latest-at-key)
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 7/7 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:3767  const viewUrl = canExposeDirectUrl ? await presignGetObject({ bucket: part.storageBucket, key: part.storageKey, expiresInSeconds: 600, })
services/api/src/routes/evidence.routes.ts:3906  ? await presignGetObject({ bucket, key, expiresInSeconds: 600, })
services/api/src/storage.ts:476  new PutObjectRetentionCommand({ Bucket: bucket, Key: key, Retention: {
services/api/src/services/evidence-complete.service.ts:1276  const lockedMeta = await headObject({ bucket: primaryTarget.bucket, key: primaryTarget.key, });
services/api/src/storage.ts:752  new CopyObjectCommand({ Bucket: params.bucket, Key: params.key, CopySource: `${params.bucket}/${params.key}`, StorageClass: ...
services/api/src/services/evidence.service.ts:612  expiresInSeconds: 600,
services/api/src/routes/evidence.routes.ts:6019  evidence.status === EvidenceStatus.SIGNED || evidence.status === EvidenceStatus.REPORTED || evidence.lockedAt
```

### ET-SM-07

**P2 · missing integrity re-verification · SOURCE_PROVEN_DEFECT** — Integrity re-hash (FAILED_HASH_MISMATCH gate) runs only inside report generation; records without report entitlement are never re-verified, and the declared reconciler/completion sources are dead

- **Affected:** jobs: report-v2 generation; tables: evidence; plans: plans/funding without reports (e.g. FREE non-credit)
- **Evidence:** `services/worker/src/integrity-rejection.service.ts:64`, `services/worker/src/processor.ts:2423`, `services/api/src/services/evidence-complete.service.ts:1459`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** grep for rejectEvidenceIntegrity finds exactly two callers, both in prepareReportArtifacts. No periodic or on-demand integrity re-hash exists; 'worker.reconciler' and 'api.completion' have zero callers.
- **Expected:** An entitlement-independent integrity re-verification (sampled or scheduled) so that storage drift on any record reaches FAILED_HASH_MISMATCH and the verify page.
- **Data flow:** FREE record -> SIGNED -> no report job -> bytes never re-hashed -> verify page keeps showing 'Signed' + stored hash.
- **Root cause:** Hard gate was attached to the report pipeline, which is commercially gated.
- **Blast radius:** All records that never generate a report.
- **Impact:** Integrity status is only as fresh as the last report; unverified drift is invisible.
- **Reproduction:** Finalize a record without report entitlement, overwrite the object version out of band (legacy row without VersionId), observe status stays SIGNED indefinitely.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add an integrity reconciler (bounded batch, VersionId-pinned re-hash) that calls rejectEvidenceIntegrity with source worker.reconciler; remove dead source labels otherwise.
- **Acceptance proof:** Reconciler test flips a drifted non-reported record to FAILED_HASH_MISMATCH.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Whether integrity re-verification of non-reported records is a product commitment.

```text
services/worker/src/integrity-rejection.service.ts:64  export type IntegrityRejectionSource = | "worker.report.single_file" | "worker.report.multipart" | "worker.reconciler" | "api.completion";
services/worker/src/processor.ts:2423  await rejectEvidenceIntegrity({
services/api/src/services/evidence-complete.service.ts:1459  if (final.shouldEnqueueReport) {
```

### ET-SM-08

**P2 · misleading status / duplicate authority · SOURCE_PROVEN_DEFECT** — Evidence library status maps (web + mobile mirror) render FAILED_HASH_MISMATCH as a neutral 'Status not recorded'; UPLOADED is a dead enum still driving UI copy and probes

- **Affected:** pages: /evidence (library rows, queue preview), mobile evidence library
- **Evidence:** `apps/web/app/(app)/evidence/lib/evidence-library-status.ts:181`, `apps/web/app/(app)/evidence/lib/evidence-library-status.ts:280`, `apps/mobile/src/product/evidence-library.ts:137`, `apps/mobile/src/product/domain-display.ts:60`, `services/api/src/services/operations/operations-source-probes.ts:301`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** The canonical library label/tone functions (used by EvidenceLibraryRow and QueueSelectionPreview) have no FAILED_HASH_MISMATCH case; the mobile mirror copies that gap while another mobile module labels it 'Integrity failed'. Multiple modules compute 'ready/needs report' independently (home-view-model.ts:3109, evidence-library-alerts.ts:61, mobile evidence-library.ts:329). UPLOADED is never written yet is filterable and labelled 'Needs report' on Home.
- **Expected:** One shared status-presentation authority (e.g. packages/shared-evidence-presentation) covering every enum value, with FAILED_HASH_MISMATCH as danger.
- **Data flow:** API status FAILED_HASH_MISMATCH -> getRecordStatusLabel default branch -> neutral chip.
- **Root cause:** Enum value added (Phase A0) without updating the frontend switch statements; mirrors hand-copied.
- **Blast radius:** Every integrity-failed record in library/queue views.
- **Impact:** Integrity failure presented as a missing value; reviewers can miss it in lists.
- **Reproduction:** Set a record to FAILED_HASH_MISMATCH and open /evidence.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add the case to the shared map, delete mirrors in favour of the shared module, drop UPLOADED from filters/probes (or document it as legacy).
- **Acceptance proof:** Exhaustive-switch type test over Prisma EvidenceStatus in the shared map.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/app/(app)/evidence/lib/evidence-library-status.ts:181  default: return "Status not recorded";
apps/web/app/(app)/evidence/lib/evidence-library-status.ts:280  default: return "neutral";
apps/mobile/src/product/evidence-library.ts:137  export const STATUS_FILTERS = ["CREATED", "UPLOADING", "UPLOADED", "SIGNED", "REPORTED"] as const;
apps/mobile/src/product/domain-display.ts:60  FAILED_HASH_MISMATCH: { label: "Integrity failed", tone: "risk" },
services/api/src/services/operations/operations-source-probes.ts:301  status: "UPLOADED",
```

### ET-TSA-02

**P2 · TSA false-success / fail-open parser · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — Granted reply without a parseable imprint (incl. granted status with no timeStampToken) is persisted as STAMPED

- **Affected:** routes: POST /v1/evidence/:id/complete; pages: /verify/[token]; jobs: report, package; tables: evidence
- **Evidence:** `services/api/src/services/timestamp/parse-tsa-reply.ts:289`, `services/api/src/services/timestamp/parse-tsa-reply.ts:329`, `services/api/src/services/timestamp/parse-tsa-reply.ts:353`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Only an explicit mismatch disqualifies. When the 'Message data:' hexdump is absent or unparseable, imprintMatchesRequest=null and the reply is granted=true -> STAMPED with warnings. A DER TimeStampResp `30 05 30 03 02 01 00` (PKIStatus granted, timeStampToken omitted — valid ASN.1, since the token is OPTIONAL) prints 'Status: Granted.' and 'TST info: Not included.', so it would be STAMPED with no serial, no genTime and no certified imprint. The same holds if a future openssl changes the hexdump layout. Warnings go only to a custody payload; tsaStatus, report and verify show success.
- **Expected:** Absence of a verifiable imprint (or of a token) on a granted reply is a hard failure (INVALID_TOKEN), never STAMPED.
- **Data flow:** parseTsaReply granted=true -> timestamp.service STAMPED -> finalizeData.tsaStatus -> compareTimestampDigest(true, tautology) -> public verify 'consistent'
- **Root cause:** The 'hard invariant' was written to stop false FAILED after a parser bug, and over-corrected into fail-open for missing imprint.
- **Blast radius:** Any record whose TSA reply lacks the Message data block; unknowable today because warnings are not queryable columns.
- **Impact:** A record can claim an RFC3161 timestamp for which no token exists or no imprint was ever compared.
- **Reproduction:** node probe: parseTsaReply('Status info:\nStatus: Granted.\nStatus description: unspecified\nFailure info: unspecified\n\nTST info:\nNot included.\n', '<64hex>') -> granted:true, failureCode:null, warnings contain tsa_message_imprint_not_present_in_reply.
- **Runtime evidence:** RT-TSA (rt-tsa.json): granted-without-token DER is rejected by OpenSSL 3.5.4 before the parser runs -> FAILED. Concrete exploit refuted on this openssl; severity lowered.
- **Recommended remediation:** Make imprintMatchesRequest !== true a failure (tsa_message_imprint_not_present_in_reply -> failure code) and require a TST info block; better, replace text parsing with `ts -verify -queryfile` (TSA-01).
- **Acceptance proof:** Probe cases (1)(2) return granted:false with a bounded failure code; existing Granted fixtures still pass.
- **Migration/backfill:** Query STAMPED rows and re-parse stored bytes offline to find any with no imprint block (report only).
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead. Severity P1 -> P2: Runtime proof RT-TSA refuted the concrete exploit: OpenSSL 3.5.4 refuses to decode a granted reply without a token ('token not present'), so it takes the subprocess-failure branch (FAILED). The parser still fails open on an unparseable imprint dump, which is a latent dependency on openssl's text format, not a demonstrated false success.

```text
services/api/src/services/timestamp/parse-tsa-reply.ts:289  if (!expected || !messageImprintHex) { imprintMatchesRequest = null;
services/api/src/services/timestamp/parse-tsa-reply.ts:329  if (imprintMatchesRequest === false) {
services/api/src/services/timestamp/parse-tsa-reply.ts:353  if (messageImprintHex === null) { warnings.push("tsa_message_imprint_not_present_in_reply"); }
```

### ET-TSA-04

**P2 · package honesty · SOURCE_PROVEN_DEFECT** — Verification package ships FAILED (rejected / imprint-mismatched) replies as timestamp.tsr and the README says 'Included' without the FAILED status

- **Affected:** jobs: verification package; tables: evidence
- **Evidence:** `services/api/src/services/timestamp.service.ts:326`, `services/worker/src/processor.ts:4427`, `services/worker/src/verification-package.ts:2792`, `services/worker/src/verification-package.ts:1937`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** Parser-side FAILED rows (not granted, imprint mismatch) keep token bytes. The package gate is Boolean(tsaTokenBase64), not tsaStatus, so these bytes are emitted as timestamp.tsr, integritySummary.containsTimestamp/contents.timestampIncluded=true, and the README omits the status line (only printed when absent). The report's timestampReferenceNote similarly says the 'Full RFC 3161 token remains available' whenever bytes exist.
- **Expected:** Emit the token only when tsaStatus is STAMPED, or emit it under a clearly failed name with the README stating the FAILED status and reason.
- **Data flow:** FAILED+bytes -> processor timestampToken -> package timestamp.tsr + 'Included'
- **Root cause:** Bytes preserved for the repair tool are reused as a presence signal downstream.
- **Blast radius:** Records with tsaFailureReason tsa_response_not_granted / tsa_message_imprint_mismatch / parse_failed-with-bytes.
- **Impact:** A package reader sees a timestamp artifact advertised as included; metadata elsewhere carries tsaStatus FAILED, so this is misleading rather than a false verification.
- **Reproduction:** Evidence row tsaStatus='FAILED', tsaTokenBase64 non-empty -> build package -> timestamp.tsr present, README 'Included'.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Call the pure README/manifest builders in services/worker/src/verification-package.ts with hasTimestampToken=true and timestampStatus='FAILED' and inspect output; or a package build fixture with such a row.
- **Recommended remediation:** hasTimestampToken = Boolean(token) && isPositiveTimestamp(tsaStatus); for FAILED-with-bytes either omit or add 'timestamp-failed.tsr' plus status text.
- **Acceptance proof:** Package for a FAILED row contains no timestamp.tsr (or a clearly-labelled failed artifact) and README states FAILED.
- **Migration/backfill:** none (future packages); previously issued packages remain as issued
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/timestamp.service.ts:326  tokenBase64, ... status: "FAILED",
services/worker/src/processor.ts:4427  timestampToken: evidence.tsaTokenBase64 ?? null,
services/worker/src/verification-package.ts:2792  if (data.timestampToken) { appendPackageEntry(archive, packageEntries, "timestamp.tsr",
services/worker/src/verification-package.ts:1937  params.hasTimestampToken ? `timestamp.tsr\nIncluded in this package as RFC 3161 DER-encoded timestamp data.
```

### ET-TSA-05

**P2 · independent verifiability (multipart) · SOURCE_PROVEN_DEFECT** — Multipart TSA imprint is the undocumented '|'-joined composite, while the package tells reviewers the reproducible digest is the LF-joined manifest hash

- **Affected:** pages: /verify/[token]; jobs: verification package, report; tables: evidence
- **Evidence:** `services/api/src/services/evidence-complete.service.ts:853`, `services/api/src/services/evidence-complete.service.ts:861`, `services/worker/src/verification-package.ts:1807`, `services/worker/src/report-v2/technical-model.ts:44`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** For >1 part, the TSA certifies sha256(parts.join('|')) (tsaInputKind CANONICAL_PACKAGE_SHA256). The package documents only the LF-joined multipartManifestSha256 recomputation method and calls fileSha256 a 'synthetic composite'; the report calls the TSA'd value the 'Canonical Package Digest'. A reviewer following the package instructions and running `openssl ts -verify -digest <multipartManifestSha256>` gets a mismatch.
- **Expected:** The TSA-certified digest is one whose recomputation recipe is stated in the package (either timestamp the manifest digest, or document the '|' recipe next to timestamp.tsr).
- **Data flow:** parts sha256 -> '|' composite -> TSA; parts sha256 -> '\n' manifest -> package instructions
- **Root cause:** Two composite definitions coexist; the TSA uses the legacy one.
- **Blast radius:** All multipart / continuous-capture / multi-part intake records with TSA.
- **Impact:** RFC3161 layer of multipart evidence is not independently verifiable from package instructions; naming collision 'canonical package digest'.
- **Reproduction:** Take any multipart package: compute LF manifest hash per instructions, compare to `openssl ts -reply -in timestamp.tsr -text` Message data -> differs; '|' join matches.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Pure computation over two known part hashes: sha256(a+'|'+b) vs sha256(a+'\n'+b) differ; confirm package README/metadata text contains no '|' recipe (grep of verification-package.ts shows only the LF method).
- **Recommended remediation:** Add a tsaInputDigestRecomputationMethod ('SHA-256 of per-part lowercase hex digests in partIndex order joined by "|"') to package metadata and README next to timestamp.tsr; rename the report label. Changing the TSA'd digest for new records is an owner decision.
- **Acceptance proof:** Package for a multipart record states the exact recipe that reproduces the TSA imprint; a scripted reviewer check passes.
- **Migration/backfill:** none (documentation of existing digests)
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Whether new multipart records should timestamp multipartManifestSha256 instead.

```text
services/api/src/services/evidence-complete.service.ts:853  ? sha256Hex(updatedParts.map((p) => p.sha256).join("|"))
services/api/src/services/evidence-complete.service.ts:861  sortedPartsForManifest.map((p) => p.sha256).join("\n")
services/worker/src/verification-package.ts:1807  "Synthetic composite SHA-256 of per-part SHA-256s. The reproducible canonical multipart digest is multipartManifestSha256."
services/worker/src/report-v2/technical-model.ts:44  ? "Timestamped Digest / Canonical Package Digest"
```

### ET-TSA-06

**P2 · state collision · SOURCE_PROVEN_DEFECT** — Provider-unavailable, rejected and invalid-token outcomes all collapse to tsaStatus=FAILED; failureCode is not persisted

- **Affected:** pages: /admin/evidence-ops; tables: evidence
- **Evidence:** `services/api/src/services/timestamp.service.ts:146`, `services/api/src/services/evidence-complete.service.ts:1078`, `packages/shared/src/evidence-lifecycle-contract.ts:171`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** A TSA-certified-different-digest response (possible tampering/provider fault, INVALID_TOKEN) and an outage (PROVIDER_UNAVAILABLE) have the same status and the same 'Trusted timestamp attempt failed' presentation; only free-text reason differs, and TimestampResult.failureCode is written to neither the row nor the custody payload. The lifecycle contract's TSA_* codes are emitted nowhere.
- **Expected:** Bounded persisted failure code distinguishing INVALID_TOKEN from PROVIDER_UNAVAILABLE/REJECTED; contract codes either emitted or removed.
- **Data flow:** failureCode -> dropped; failureReason text -> tsaFailureReason
- **Root cause:** Two-value status column; code field never mapped to persistence.
- **Blast radius:** Operations triage, incident classification (classifyIntegrityFailure parses reason text).
- **Impact:** An imprint mismatch — a security-relevant event — is triaged as an ordinary provider failure.
- **Reproduction:** Source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Persist failureCode (new column or custody payload field) and surface INVALID_TOKEN distinctly.
- **Acceptance proof:** Mismatch row shows code tsa_message_imprint_mismatch in DB and ops UI.
- **Migration/backfill:** Derive code from existing tsaFailureReason strings (bounded mapping).
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/timestamp.service.ts:146  status: "STAMPED" | "FAILED";
services/api/src/services/evidence-complete.service.ts:1078  tsaFailureReason: tsaResult?.failureReason ?? null,
packages/shared/src/evidence-lifecycle-contract.ts:171  "TSA_PROVIDER_UNAVAILABLE", "TSA_REJECTED", "TSA_TIMEOUT",
```

### ET-UPL-02

**P2 · stuck-state · SOURCE_PROVEN_DEFECT** — One aborted or expired upload session blocks finalization of its evidence forever; the idempotency key returns the terminal session on retry

- **Affected:** routes: POST /v1/evidence/:id/complete, POST /v1/uploads/sessions; tables: evidence_upload_sessions, evidences; roles: any evidence.create member; plans: all
- **Evidence:** `services/api/src/services/uploads/upload-session.service.ts:1234`, `services/api/src/services/uploads/upload-session.service.ts:370`, `apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts:95`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Any non-COMPLETED session on an evidence id denies finalization; nothing deletes/supersedes sessions; the retry reuses the same key and gets the ABORTED/EXPIRED session back, whose initiate fails session_already_terminal. Any team member with evidence.create can create or abort a session on another member's evidence.
- **Expected:** A terminal session must not block finalization, and a retry must mint a fresh session; session mutation limited to the session actor/evidence owner.
- **Data flow:** cancel/expire session -> completeEvidence -> evaluateUploadSessionFinalizeGate -> 409 session_aborted/session_expired forever; evidence stays UPLOADING (no Evidence reaper)
- **Root cause:** Finalize gate treats ABORTED/EXPIRED the same as in-flight; idempotency lookup ignores state.
- **Blast radius:** Every resumable (large-file) web capture that is cancelled or left idle ~1h.
- **Impact:** Evidence permanently stuck UPLOADING and (per ACQ-02) counted against the FREE record cap; teammate griefing possible.
- **Reproduction:** Start a resumable capture, abort it (or let reapStaleUploadSessions expire it), retry: complete returns 409 indefinitely.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Ignore terminal sessions in the finalize gate (or require only that no ACTIVE session exists), filter the idempotency lookup to non-terminal rows, and restrict session mutations to the session actor/evidence owner.
- **Acceptance proof:** Test: abort then retry completes; teammate cannot abort another member's session.
- **Migration/backfill:** Identify evidences stuck UPLOADING with only terminal sessions.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/uploads/upload-session.service.ts:1234  evaluateUploadSessionFinalizeGate denies for ANY session not COMPLETED
services/api/src/services/uploads/upload-session.service.ts:370  WHERE "team_id" = $1 AND "idempotency_key" = $2 LIMIT 1 — no state filter despite 'non-terminal' comment
apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts:95  idempotency key capture:${evidenceId}:${index}
```

### ET-UPL-04

**P2 · operator-safety · SOURCE_PROVEN_DEFECT** — seed-home-personas.ts writes fabricated SIGNED evidence and custody into whatever DATABASE_URL dotenv loads, guarded only by NODE_ENV

- **Affected:** tables: evidences, custody_events; roles: operator
- **Evidence:** `services/api/scripts/seed-home-personas.ts:50`, `services/api/scripts/seed-home-personas.ts:36`, `services/api/scripts/seed-admin-fixture.ts:114`
- **Citations:** 2/3 resolve in the audited tree
- **Observed:** The script loads services/api/.env (which, per standing project knowledge, carries live production credentials) and has no database-name guard, so running it without NODE_ENV=production writes fabricated trust rows to whatever DB that file names.
- **Expected:** Same DB-name/loopback guard as seed-admin-fixture.ts and no implicit dotenv load.
- **Data flow:** pnpm seed:home-personas -> dotenv -> DATABASE_URL -> raw prisma.evidence.create + custodyEvent.createMany
- **Root cause:** Guard copied inconsistently across seed scripts.
- **Blast radius:** Operator workstation only; not remotely reachable.
- **Impact:** Fabricated custody records in a real database if misrun.
- **Reproduction:** Not executed (would contact the configured DB).
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add the seed-admin-fixture DB-name/loopback guard and drop dotenv/config.
- **Acceptance proof:** Script refuses a non-loopback DATABASE_URL.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/scripts/seed-home-personas.ts:50  if (process.env.NODE_ENV === "production") — only guard
services/api/scripts/seed-home-personas.ts:36  import "dotenv/config"
services/api/scripts/seed-admin-fixture.ts:114  sibling script has a DB-name guard this one lacks
```

### ET-ACQ-05

**P3 · client authority · SOURCE_PROVEN_DEFECT** — The required-checklist gate enforces a plan the client wrote (intakePlanJson), and the template identity stamp does not check who owns the capture session

- **Affected:** routes: POST /v1/evidence, POST /v1/evidence/:id/complete; pages: /capture; tables: evidence
- **Evidence:** `services/api/src/services/capture-checklist-gate.ts:1`, `services/api/src/services/templates/identity-resolver.service.ts:157`
- **Citations:** 1/2 resolve in the audited tree
- **Observed:** A raw API caller can omit intakePlanJson, which skips the checklist gate, while templateSlug is still copied from any captureSessionId without an owner check.
- **Expected:** Required steps come from the template on the server side, and the session lookup is scoped to its owner.
- **Data flow:** body.intakePlanJson -> evidence.intakePlanJson -> validateRequiredChecklistMapping
- **Root cause:** The server trusts the client's plan.
- **Blast radius:** Template captures made through the raw API.
- **Impact:** A record can carry a template identity without meeting that template's required steps.
- **Reproduction:** POST /v1/evidence with a template draft's captureSessionId and no plan, then complete it with one part. It is accepted.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration test running the reproduction above.
- **Recommended remediation:** Derive the required steps from the template row, and filter the session lookup by owner.
- **Acceptance proof:** The gate refuses the completion.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Is checklist completion a product guarantee?

```text
services/api/src/services/capture-checklist-gate.ts:1  if (mode !== "CHECKLIST_REQUIRED") { return { missing: [], enforced: false }; }
services/api/src/services/templates/identity-resolver.service.ts:157  const session = await client.captureSession.findUnique({ where: { id: params.captureSessionId },
```

### ET-ACQ-06

**P3 · commercial race · SOURCE_AND_RUNTIME_PROVEN_DEFECT** — The record-cap count is read without a lock, and SHARED workspaces are not re-checked at completion

- **Affected:** routes: POST /v1/evidence; tables: evidence; plans: TEAM, ENTERPRISE
- **Evidence:** `services/api/src/services/billing-enforcement.service.ts:216`, `services/api/src/services/billing-enforcement.service.ts:669`
- **Citations:** 1/2 resolve in the audited tree
- **Observed:** Concurrent creates at cap-1 all pass. Personal records are settled again under a lock at completion; SHARED records are not.
- **Expected:** Cap admission should be serialized.
- **Data flow:** parallel POST /v1/evidence
- **Root cause:** Check-then-write with no lock.
- **Blast radius:** Shared workspaces at their cap.
- **Impact:** The contracted monthly cap can be exceeded by a small margin.
- **Reproduction:** Send 10 parallel creates at 499/500.
- **Runtime evidence:** RT-COMMERCIAL/FREE: two concurrent POST /v1/evidence at 2/3 both returned 201 (4 active FREE records). Completion settlement (per-subject advisory lock) is the backstop per commercial answer 14.3; not exercised here (no bytes uploaded).
- **Recommended remediation:** Lock the capacity subject for SHARED workspaces too.
- **Acceptance proof:** Exactly one request is admitted.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/billing-enforcement.service.ts:216  const monthlyCount = scope.teamId ? await prisma.evidence.count({
services/api/src/services/billing-enforcement.service.ts:669  if (scope.billingShape === "SHARED") { return { funding: "PLAN" }; }
```

### ET-ACQ-07

**P3 · input bounds · SOURCE_PROVEN_DEFECT** — POST /v1/evidence/:id/parts has no upper bound on partIndex, no cap on part count, and no rate limit

- **Affected:** routes: POST /v1/evidence/:id/parts; tables: evidence_parts
- **Evidence:** `services/api/src/routes/evidence.routes.ts:430`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** The owner can create any number of part rows and presigned URLs. Gaps and out-of-order indexes are accepted, and completion seals whatever parts exist.
- **Expected:** The number of parts should be bounded.
- **Data flow:** n/a
- **Root cause:** No bound is defined.
- **Blast radius:** Only the owner's own record.
- **Impact:** Amplifies DB and completion cost.
- **Reproduction:** Loop POST parts over partIndex 0..100000.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add a maximum part count and a rate limit.
- **Acceptance proof:** Requests above the cap get 400.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:430  partIndex: z.number().int().min(0),
```

### ET-COM-06

**P3 · Decision A consistency · SOURCE_PROVEN_DEFECT** — Historical FREE records are not issued automatically after upgrade unless a default-OFF flag is set; customer-initiated Generate bypasses the 'confirmed payment' rule during grace

- **Affected:** routes: report generation request (report-generation-authority.service.ts); pages: Evidence detail; jobs: first-issuance-reconciliation; tables: report_generation_requests; roles: owner; plans: FREE->PRO
- **Evidence:** `services/worker/src/first-issuance-reconciliation.ts:169`, `services/api/src/services/reports/report-generation-authority.service.ts:199`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Automatic first issuance covers only records signed within 7 days unless OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED=true (default OFF, absent from env examples). The API precheck for a user click only needs decision ENTITLED (includes PAYMENT_GRACE), ignoring mayIssueHistoricalFirstOutputs.
- **Expected:** One rule for historical first issuance on both automatic and manual paths, and a documented rollout state for the flag.
- **Data flow:** upgrade -> activation pass -> record signed 10 days ago -> firstIssueSkippedHistoricalGate.
- **Root cause:** Rollout gate left off by default; manual path not aligned with mayIssueHistoricalFirstOutputs.
- **Blast radius:** Upgraders with records older than a week.
- **Impact:** Upgrade silently leaves older records without reports until the customer clicks each one.
- **Reproduction:** Upgrade a FREE account whose records are 8+ days old; run runFirstIssuanceReconciliation; no requests created.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Owner decision on enabling the flag in production and aligning the manual path.
- **Acceptance proof:** Documented flag state; manual path uses the same historical rule.
- **Migration/backfill:** Run the dry-run script then enable the flag.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Enable historical first issuance in production?

```text
services/worker/src/first-issuance-reconciliation.ts:169  if (!recent && !historicalEnabled) {
services/api/src/services/reports/report-generation-authority.service.ts:199  if (!eligibility || eligibility.issuance.decision === "UNRESOLVED") {
```

### ET-CUS-12

**P3 · missing custody event / unhashed audit · SOURCE_PROVEN_DEFECT** — Redaction publication and derivatives, and reviewer workflow decisions, never reach the evidence custody chain; they live in unhashed, mutable side tables

- **Affected:** routes: POST /v1/redaction/versions/:id/publish, POST /v1/redaction/versions/:id/derivative, PATCH /v1/evidence/:id/reviewer-workflow; jobs: redaction-derivative-writer; tables: redaction_activity, evidence_reviewer_audit_events
- **Evidence:** `services/api/src/services/redaction/redaction-activity.service.ts:13`, `services/api/src/services/redaction/redaction-activity.service.ts:46`, `services/api/src/services/evidence-review/reviewer-audit.service.ts:11`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The only writers of redaction_activity are this service and services/worker/src/redaction/redaction-derivative-writer.ts:144. No replicator exists (grep redactionActivity. gives 4 hits: create, list, audit-transparency read, worker create). Reviewer decisions write an unhashed row.
- **Expected:** Disclosure of a derivative of the evidence, and adjudication that gates finalization (evidenceIsReviewed), should be linked from the evidence custody chain, or the comment should not claim mirroring.
- **Data flow:** n/a
- **Root cause:** Separate activity logs for these domains.
- **Blast radius:** All redaction and review history.
- **Impact:** The custody timeline omits the release of redacted renderings and review outcomes; the comment claims a mirror that does not exist.
- **Reproduction:** Publish a redaction version; the evidence custody chain is unchanged.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Append REDACTION_PUBLISHED / REDACTION_DERIVATIVE_RENDERED / REVIEW_DECISION_RECORDED custody events (bounded payload), or correct the comment and surface these logs.
- **Acceptance proof:** Test that publish appends one custody event.
- **Migration/backfill:** optional
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Which redaction and review facts belong in the evidentiary chain.

```text
services/api/src/services/redaction/redaction-activity.service.ts:13  *     redaction_activity table; downstream replicators mirror into the platform audit chain
services/api/src/services/redaction/redaction-activity.service.ts:46  const row = await prisma.redactionActivity.create({
services/api/src/services/evidence-review/reviewer-audit.service.ts:11  return prisma.evidenceReviewerAuditEvent.create({
```

### ET-CUS-13

**P3 · customer-visible wording · SOURCE_PROVEN_DEFECT** — Customer timelines render raw event codes and misleading or duplicate events

- **Affected:** pages: apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx, Public verify
- **Evidence:** `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx:154`, `services/api/src/services/governance.service.ts:1265`, `services/api/src/services/governance/retention-sweeper.service.ts:104`, `services/api/src/services/governance/finalization-governance.service.ts:91`, `services/api/src/routes/evidence.routes.ts:12756`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** The custody tab shows codes such as 'REPORT IDENTITY CONTEXT RECORDED' and 'EXPORT BLOCKED BY POLICY'. Retention application writes a second EVIDENCE_CREATED ('Evidence record created.' twice). The retention sweeper writes DELETE_BLOCKED_BY_LEGAL_HOLD on every run for held records although no deletion was attempted. A finalization refusal is labelled an export block. Unarchive and trash-restore both use EVIDENCE_RESTORED, while EVIDENCE_DELETE_RESTORED is never written. Public verify and the record view display only the OLDEST 500 events, so the newest events disappear on long chains. No actor is shown.
- **Expected:** Human labels per type, one creation event, accurate verbs, newest-first or paginated timelines.
- **Data flow:** n/a
- **Root cause:** Event-type reuse and presentation shortcuts.
- **Blast radius:** All custody timelines.
- **Impact:** Reviewers can misread history (a second creation, deletion attempts that never happened).
- **Reproduction:** Create evidence under a retention policy; the custody tab shows two EVIDENCE CREATED rows.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add RETENTION_POLICY_APPLIED and FINALIZATION_BLOCKED_BY_POLICY types; the sweeper should flag held records once; add a label map in the web tab; paginate newest-first.
- **Acceptance proof:** Snapshot tests of labels.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx:154  {row.type.replace(/_/g, " ")}
services/api/src/services/governance.service.ts:1265  eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED, payload: { retentionPolicyApplied: true,
services/api/src/services/governance/retention-sweeper.service.ts:104  eventType: "DELETE_BLOCKED_BY_LEGAL_HOLD", payload: { reason: "retention_expired_but_under_legal_hold",
services/api/src/services/governance/finalization-governance.service.ts:91  eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
services/api/src/routes/evidence.routes.ts:12756  take: 500,
```

### ET-CUS-14

**P3 · audit PII / correlation · SOURCE_PROVEN_DEFECT** — Tenant audit seals raw client IP and User-Agent into hashed metadata (bypassing the masking the column path applies), and never fills the requestId column

- **Affected:** routes: ~38 call sites with ipAddress: req.ip; pages: Admin audit; tables: admin_audit_logs
- **Evidence:** `services/api/src/routes/evidence.routes.ts:1331`, `services/api/src/services/audit/tenant-audit.service.ts:369`, `services/api/src/services/platform-audit-log.service.ts:369`
- **Citations:** 2/3 resolve in the audited tree
- **Observed:** Phase-5 masking applies only to the ipAddress/userAgent columns, and emitTenantAudit never fills those; callers put raw values in metadata, which is hashed and therefore cannot be redacted later. The requestId column stays null for tenant and platform audit rows, so the admin requestId filter misses them.
- **Expected:** Pass ip/UA through the masked columns; map correlationId to requestId.
- **Data flow:** auditEvidenceAction -> emitTenantAudit metadata -> appendPlatformAuditLog
- **Root cause:** The facade envelope lacks ip/UA/requestId fields.
- **Blast radius:** All tenant audit rows.
- **Impact:** Raw personal data is sealed in an immutable log; investigators cannot correlate by request id.
- **Reproduction:** Trigger any evidence action and read admin_audit_logs.metadata.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Extend the envelope with ipAddress/userAgent/requestId and remove them from metadata.
- **Acceptance proof:** Test that no row written after the fix contains a raw IP in metadata.
- **Migration/backfill:** none (historical rows stay sealed; mask on read)
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:1331  ipAddress: req.ip, ⏎       userAgent: readUserAgent(req),
services/api/src/services/audit/tenant-audit.service.ts:369  await appendPlatformAuditLog({ // no requestId passed; correlationId only in metadata
services/api/src/services/platform-audit-log.service.ts:369  ipAddress: safeIpPreview(params.ipAddress ?? undefined),
```

### ET-DC-10

**P3 · concurrency · SOURCE_PROVEN_DEFECT** — Capture trust-event sub-chain read-then-insert with no lock and no unique (session, sequence) — concurrent declarations fork the chain

- **Affected:** tables: capture_trust_events
- **Evidence:** `services/api/src/services/capture-trust/trust-event.service.ts:115`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** Duplicate sequence numbers possible; first-by-sequence resolution nondeterministic.
- **Expected:** Lock or unique constraint.
- **Data flow:** declare x2 concurrently
- **Root cause:** No serialization.
- **Blast radius:** Owner-only concurrency.
- **Impact:** Forked trust chain.
- **Reproduction:** Parallel declares.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Unique (session_id, sequence) + advisory lock.
- **Acceptance proof:** Concurrency test.
- **Migration/backfill:** Detect duplicates first.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/capture-trust/trust-event.service.ts:115  orderBy: { sequence: "desc" }, select: { sequence: true, eventHash: true },
```

### ET-DC-11

**P3 · hygiene · SOURCE_PROVEN_DEFECT** — CAPTURE_MANIFEST relabel happens after the seal outside the signed fingerprint; extension token can presign parts on any owned unsealed evidence; draft route uses a hand-rolled membership check; dead device-identity code

- **Affected:** routes: POST /v1/evidence/:id/parts, POST /v1/capture/sessions
- **Evidence:** `services/api/src/services/auth/extension-scope.ts:43`, `services/api/src/routes/capture.routes.ts:269`, `services/api/src/services/capture-trust/device-identity.service.ts:229`
- **Citations:** 2/3 resolve in the audited tree
- **Observed:** Several low-risk scope/atomicity/dead-code gaps.
- **Expected:** Atomic relabel, narrower scope, canonical authorizer.
- **Data flow:** n/a
- **Root cause:** Incremental UC work.
- **Blast radius:** Low.
- **Impact:** Low.
- **Reproduction:** Source.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Tidy.
- **Acceptance proof:** Unit tests.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/auth/extension-scope.ts:43  parts presign allowed for extension scope
services/api/src/routes/capture.routes.ts:269  hand-rolled ACTIVE-membership check
services/api/src/services/capture-trust/device-identity.service.ts:229  findDeviceByPubkey — 0 callers
```

### ET-INT-15

**P3 · hygiene · SOURCE_PROVEN_DEFECT** — Intake P3s: dead first-part capture-environment write, false magic-byte comment, UPLOAD_AUTHORIZED for an original URL never issued, swallowed LINK_USED/CONSENT custody failures, unvalidated caseId/evidenceId, stale citizen-capture comment

- **Affected:** routes: /v1/external-intake/*; tables: workflow_intake_links, workflow_intake_sessions, evidences; roles: intake token holder; plans: plans with intake
- **Evidence:** `services/api/src/routes/external-intake.routes.ts:1088`, `services/api/src/services/external-intake-orchestration.service.ts:436`
- **Citations:** 1/2 resolve in the audited tree
- **Observed:** Low-risk inconsistencies.
- **Expected:** Tidy.
- **Data flow:** public intake token -> external-intake.routes.ts -> external-intake-orchestration.service.ts -> createEvidence/completeEvidence
- **Root cause:** Low-risk inconsistencies.
- **Blast radius:** Workspaces that issue intake links / evidence requests.
- **Impact:** Low.
- **Reproduction:** See observed; source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Tidy each.
- **Acceptance proof:** Integration test covering the scenario.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/external-intake.routes.ts:1088  if (body.partIndex === 0 && session.evidenceId) - always null on a fresh session
services/api/src/services/external-intake-orchestration.service.ts:436  custody emission failures swallowed
```

### ET-OTS-05

**P3 · latent false-success heuristic · SOURCE_PROVEN_DEFECT** — Initializer still promotes to ANCHORED from `ots upgrade` text alone (heuristic removed elsewhere); such an anchor is never re-checked when a txid is present

- **Affected:** pages: /verify/[id]; jobs: ots-upgrade; tables: Evidence.ots*
- **Evidence:** `services/worker/src/ots.service.ts:250`, `services/worker/src/ots-upgrade-output.ts:50`, `services/worker/src/ots-lifecycle.ts:339`, `services/worker/src/ots-upgrade.processor.ts:399`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** createOpenTimestamp returns ANCHORED when upgrade output contains 'timestamp complete' or 'bitcoin transaction' and no pending phrase, with no hash check and no block attestation check; persisted with anchorCheck NULL; if a txid was parsed (generic 64-hex fallback in parseTxid) no follow-up runs and the processor skips it forever.
- **Expected:** Initialization never writes ANCHORED; it writes PENDING and lets the upgrade classifier (verify/info) establish the anchor.
- **Data flow:** stamp -> immediate upgrade -> text heuristic -> ANCHORED (anchorCheck NULL) -> claim ANCHORED_NOT_CHECKED.
- **Root cause:** The 2026-09-29 removal of the text-only promotion covered classifyOtsResult but not createOpenTimestamp.
- **Blast radius:** Practically unreachable with real calendars for a seconds-old stamp; latent.
- **Impact:** Would display 'anchored to a Bitcoin block' without any attestation evidence; never VERIFIED (claim is honest about the chain check).
- **Reproduction:** OTS_BIN stub printing 'Success! Timestamp complete' on upgrade.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: createOpenTimestamp with OTS_BIN stub: `stamp` writes <file>.ots with MAGIC bytes, `upgrade` prints 'Success! Timestamp complete' -> status ANCHORED.
- **Recommended remediation:** Drop the anchored branch from createOpenTimestamp (return PENDING, needsUpgrade true).
- **Acceptance proof:** Unit test: any upgrade text at init yields PENDING.
- **Migration/backfill:** Rows ANCHORED with otsAnchorCheck NULL and first custody otsPhase 'anchored' at initialization: re-check via processor.
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/ots.service.ts:250  const ok = shouldTreatOtsAsAnchored(parsedUpgrade);
services/worker/src/ots-upgrade-output.ts:50  lower.includes("success! timestamp complete") || lower.includes("timestamp complete") || lower.includes("bitcoin transaction")
services/worker/src/ots-lifecycle.ts:339  return stamp.status === "ANCHORED" && !stamp.bitcoinTxid;
services/worker/src/ots-upgrade.processor.ts:399  (effectiveStatus === "ANCHORED" && hasDefensibleTxid) ||
```

### ET-OTS-06

**P3 · stuck state · SOURCE_PROVEN_DEFECT** — A header-valid but unparseable proof (or block attestation without readable txid) is treated as transient forever and never reaches a terminal state

- **Affected:** jobs: ots-upgrade; tables: Evidence.ots*
- **Evidence:** `services/worker/src/ots-upgrade.processor.ts:532`, `services/worker/src/ots-upgrade.processor.ts:249`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Deterministic parse failures are routed to TRANSIENT_ERROR; after 20 BullMQ attempts the job fails and the row stays PENDING (then OTS-03 applies).
- **Expected:** Repeated deterministic `ots info` parse failure -> MALFORMED_PROOF; attested-without-txid -> anchor recorded as PROOF_STRUCTURE (txid optional for the not-checked claim).
- **Data flow:** info ERROR -> TRANSIENT -> throw -> retries -> failed job.
- **Root cause:** No distinction between network-transient and deterministic proof-read failures.
- **Blast radius:** Corrupt stored proofs; proofs whose ots info output lacks a txid line.
- **Impact:** Stuck PENDING with HIGH ops condition and no action.
- **Reproduction:** Store MAGIC + garbage as otsProofBase64 and run processOtsUpgrade with a real `ots` binary.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Behaviour-test harness (ots-upgrade-processor.behaviour.test.ts) with h.info = {status:'ERROR', info:null} repeated -> each run throws OTS_UPGRADE_ATTEMPT_FAILED, row unchanged.
- **Recommended remediation:** Classify deterministic info failures as MALFORMED_PROOF after N consecutive identical results; accept attested proofs without txid as PROOF_STRUCTURE.
- **Acceptance proof:** Behaviour test reaches terminal FAILED MALFORMED_PROOF.
- **Migration/backfill:** none
- **Dependency:** OTS-03
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/ots-upgrade.processor.ts:532  observation = { kind: "TRANSIENT_ERROR", reason: inconclusiveCheckReason({ infoStatus: infoResult.status, info, expectedHash }),
services/worker/src/ots-upgrade.processor.ts:249  the proof carries a Bitcoin block attestation but no transaction id could be read; the anchor is neither recorded nor withdrawn.
```

### ET-OTS-07

**P3 · package wording · SOURCE_PROVEN_DEFECT** — Package verification hint `ots verify opentimestamps-proof.ots` cannot succeed; the stamped file is fingerprint.json

- **Affected:** jobs: verification package; roles: external reviewer
- **Evidence:** `services/worker/src/verification-package.ts:887`, `services/worker/src/verification-package.ts:2776`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** `ots verify X.ots` looks for target file X (`opentimestamps-proof`), which is not in the package; the committed bytes are fingerprint.json.
- **Expected:** `ots verify -f fingerprint.json opentimestamps-proof.ots` (or -d <fingerprintHash>).
- **Data flow:** package companion -> reviewer instruction.
- **Root cause:** Proof renamed without adjusting the hint.
- **Blast radius:** Every package with a proof.
- **Impact:** Independent verification instruction fails for reviewers.
- **Reproduction:** Unzip a package and run the hint with the ots client.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Change hint to reference fingerprint.json.
- **Acceptance proof:** Hint string test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/verification-package.ts:887  ? "Verify with: ots verify opentimestamps-proof.ots"
services/worker/src/verification-package.ts:2776  "fingerprint.json", textBuffer(data.fingerprint),
```

### ET-PKG-09

**P3 · GET side effects / privacy · SOURCE_PROVEN_DEFECT** — Anonymous GET writes audit + verification_views (raw IP/UA, no retention) + evidence row + debounced custody event

- **Affected:** routes: GET /public/verify/:id; tables: verification_views, custody_events, evidence, platform audit; roles: public
- **Evidence:** `services/api/src/routes/evidence.routes.ts:13224`, `services/api/src/routes/evidence.routes.ts:13232`, `services/api/src/routes/evidence.routes.ts:13270`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Each successful view persists viewer IP and user agent; no deleteMany of verification_views exists in api/worker. VERIFY_VIEWED debounce reads a stale lastPublicVerifyViewAtUtc so concurrent first views can append twice; each append takes the evidence advisory lock.
- **Expected:** Bounded retention or hashing of viewer IP; atomic debounce.
- **Data flow:** GET -> fire-and-forget writes
- **Root cause:** Analytics stored as raw PII.
- **Blast radius:** All public views.
- **Impact:** Indefinite PII retention of anonymous viewers; minor duplicate custody events.
- **Reproduction:** Open verify page; inspect verification_views.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Retention sweep / truncate IP; conditional update for debounce.
- **Acceptance proof:** Retention job test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:13224  data: { lastPublicVerifyViewAtUtc: verifiedAt },
services/api/src/routes/evidence.routes.ts:13232  ipAddress: viewerIp,
services/api/src/routes/evidence.routes.ts:13270  eventType: prismaPkg.CustodyEventType.VERIFY_VIEWED,
```

### ET-PKG-11

**P3 · infra disclosure / misleading material · SOURCE_PROVEN_DEFECT** — historical-verification-material.json leaks key path or KMS key id and lists SIGNING_PUBLIC_KEY_PATH for every purpose including the package signer

- **Affected:** jobs: report-generation; roles: external recipient
- **Evidence:** `services/worker/src/verification-package-historical-material.ts:250`, `services/worker/src/verification-package-historical-material.ts:271`, `services/worker/src/verification-package-historical-material.ts:315`, `services/worker/src/signing/package-signer.ts:68`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** The file ships the server filesystem path or the KMS key identifier (an ARN embeds account id/region) to every recipient, and extracts one public key for all four purposes while the package signer prefers PACKAGE_SIGNING_PUBLIC_KEY_PATH; also reflects current env, not the key version that signed the evidence.
- **Expected:** No infra identifiers; per-purpose key material matching the actual signer.
- **Data flow:** env -> extractPublicMaterial -> package
- **Root cause:** Single extraction reused for all purposes.
- **Blast radius:** All packages.
- **Impact:** Info disclosure; possible wrong key listed for the package signer after split/rotation.
- **Reproduction:** Open signers/historical-verification-material.json.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Drop publicMaterialRef or replace with SPKI fingerprint; extract per purpose.
- **Acceptance proof:** Unit test with distinct package key.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/verification-package-historical-material.ts:250  const pubPath = envValue("SIGNING_PUBLIC_KEY_PATH");
services/worker/src/verification-package-historical-material.ts:271  publicMaterialRef: pubPath,
services/worker/src/verification-package-historical-material.ts:315  publicMaterialRef: `kms:${keyId}`,
services/worker/src/signing/package-signer.ts:68  "PACKAGE_SIGNING_PUBLIC_KEY_PATH",
```

### ET-PKG-12

**P3 · misleading copy · SOURCE_PROVEN_DEFECT** — BASIC verify says a report copy "can be checked" via its recorded digest, but no digest is returned

- **Affected:** routes: GET /public/verify/:id; pages: /verify/[token] BASIC; tables: reports; roles: public; plans: free/lapsed
- **Evidence:** `apps/web/app/verify/[token]/BasicVerificationView.tsx:142`, `packages/shared/src/basic-verification.ts:231`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Only a boolean is returned; neither tier returns report pdfSha256.
- **Expected:** Return the digest or drop the claim.
- **Data flow:** buildBasicVerification.report
- **Root cause:** Data minimization over-applied vs copy.
- **Blast radius:** BASIC viewers.
- **Impact:** Reviewer cannot check their copy as promised.
- **Reproduction:** Open BASIC page.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Expose pdfSha256 (and package sha) in BASIC.
- **Acceptance proof:** Response contains digest.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/app/verify/[token]/BasicVerificationView.tsx:142  its digest is recorded, so a copy can be checked.
packages/shared/src/basic-verification.ts:231  digestRecorded: Boolean(latest?.pdfSha256),
```

### ET-PKG-13

**P3 · privacy/indexing · SOURCE_PROVEN_DEFECT** — /verify/[token] has no noindex/robots control; web error path sends the token to Sentry

- **Affected:** pages: /verify/[token]; roles: public
- **Evidence:** `apps/web/app/verify/[token]/page.tsx:1`, `apps/web/app/verify/[token]/page.tsx:3374`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** No robots.txt, noindex meta or X-Robots-Tag for verify pages in apps/web.
- **Expected:** noindex on capability URLs.
- **Data flow:** n/a
- **Root cause:** Omission.
- **Blast radius:** Links posted publicly.
- **Impact:** Search indexing of evidence verify pages if a link is published.
- **Reproduction:** curl -I the page.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add layout metadata robots noindex / X-Robots-Tag in middleware; drop token from Sentry context.
- **Acceptance proof:** Header present.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/app/verify/[token]/page.tsx:1  "use client";
apps/web/app/verify/[token]/page.tsx:3374  captureException(err, { feature: "web_verify", token: params.token });
```

### ET-PKG-14

**P3 · zip entry collision · SOURCE_PROVEN_DEFECT** — Single-file evidence entry at ZIP root can collide with a fixed entry name when no capture/upload timestamp exists

- **Affected:** jobs: report-generation
- **Evidence:** `services/worker/src/verification-package.ts:562`, `services/worker/src/verification-package.ts:2761`, `packages/shared/src/package-seal.ts:240`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Title "fingerprint" + application/json + null timestamps -> "fingerprint.json", duplicating the fixed entry; checksum index then lists two rows with one path and Map-based verifiers see only one.
- **Expected:** Evidence stored under a reserved prefix or collision check.
- **Data flow:** buildEvidencePackageFileName
- **Root cause:** Root placement for single file.
- **Blast radius:** Rare (both timestamps null).
- **Impact:** Ambiguous package / verification failure.
- **Reproduction:** Fixture with title fingerprint, JSON mime, null capturedAt/uploadedAt.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit test on buildEvidencePackageFileName + reserved names.
- **Recommended remediation:** Always place originals under evidence-parts/ or reject reserved names.
- **Acceptance proof:** Test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/verification-package.ts:562  baseName = normalizeFileNameSegments([titleBase, timestamp]);
services/worker/src/verification-package.ts:2761  await appendEvidencePart(archive, packageEntries, file.finalName, file);
packages/shared/src/package-seal.ts:240  const bytes = input.entries.get(file.path);
```

### ET-PKG-15

**P3 · availability · SOURCE_PROVEN_DEFECT** — Package streams originals without the pinned storageVersionId used by the integrity pre-read

- **Affected:** jobs: report-generation; tables: evidence_parts
- **Evidence:** `services/worker/src/verification-package.ts:961`, `services/worker/src/processor.ts:2306`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** If a newer object version exists at the key, the package build fails closed with EVIDENCE_PART_DIGEST_MISMATCH (no false package).
- **Expected:** Pass versionId through VerificationEvidenceFile.
- **Data flow:** verificationEvidenceFiles lacks storageVersionId
- **Root cause:** Field not propagated.
- **Blast radius:** Versioned keys with overwrites.
- **Impact:** Package permanently unbuildable for such records.
- **Reproduction:** Overwrite key in versioned bucket after completion.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: MinIO versioned fixture.
- **Recommended remediation:** Propagate and use storageVersionId.
- **Acceptance proof:** Fixture builds.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/verification-package.ts:961  const body = await getObjectStream({ bucket: file.storageBucket, key: file.storageKey });
services/worker/src/processor.ts:2306  versionId: part.storageVersionId ?? null,
```

### ET-PKG-17

**P3 · availability · SOURCE_PROVEN_DEFECT** — Per-evidence public verify bucket (60/min) is shared by all viewers; two IPs can lock a record page out

- **Affected:** routes: GET /public/verify/:id; roles: public
- **Evidence:** `services/api/src/routes/evidence.routes.ts:12329`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** Attacker at 30/min from two IPs exhausts the per-evidence bucket; legitimate viewers get 429 for the window.
- **Expected:** Per-evidence limit tolerant of targeted exhaustion.
- **Data flow:** enforceRateLimit
- **Root cause:** Shared bucket.
- **Blast radius:** Targeted records.
- **Impact:** Denial of verification for a specific record.
- **Reproduction:** Script 60 req/min from 2 IPs.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Serve cached response or higher per-evidence cap.
- **Acceptance proof:** Load test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:12329  key: `ratelimit:verify:evidence:${id}`,
```

### ET-Q-07

**P3 · dead queues / registry untruth · SOURCE_PROVEN_DEFECT** — Five queues have registered consumers but no producer, and the registry asserts reconcilers/claims that do not exist (graph/org-health recovery, derived-asset recovery, OTS tenant fail-closed, timeoutMs)

- **Affected:** pages: Operations queue inventory; jobs: ExtractExif, IndexMediaIntelligence, SyncTeamGraphDomain, SyncTeamGraphTimeline, RefreshOrgHealthProjection, GenerateDerivedAsset, ReconcileTeamGraph; tables: investigation_graph_nodes, evidence_part_derived_assets
- **Evidence:** `services/worker/src/queue.ts:577`, `services/worker/src/subsystem-queue-processors.ts:319`, `packages/shared/src/queue-integrity/registry.ts:436`, `services/worker/src/search-index-reconciler.ts:455`, `packages/shared/src/queue-integrity/registry.ts:691`
- **Citations:** 5/5 resolve in the audited tree
- **Observed:** No api/worker/shared-runtime code enqueues mi-exif, mi-search-index, graph-domain-sync, graph-timeline-sync or org-health-refresh; runDomainStaleSweep/runTimelineSync therefore never run in production. Registry lists search-index-reconciler as the reconciler for 6 graph/projection entries and intelligence-run-reconciler for derived assets; neither module touches those authorities, so a lost derived-asset enqueue leaves the row PENDING forever. Registry header still says 18 sweeps/35 entries (actual 19/34+2).
- **Expected:** Registry entries marked CURRENT_RUNTIME name real producers and real reconcilers; unused queues are removed or wired.
- **Data flow:** n/a
- **Root cause:** Registry maintained by hand; closure gate checks file existence, not behaviour.
- **Blast radius:** Operators and audits rely on the registry to assert recovery coverage.
- **Impact:** False coverage claims; stale graph nodes are never tombstoned by domain sync; idle workers and Redis connections.
- **Reproduction:** grep for enqueue*Job helper callers (zero).
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Delete or wire the five queues; add a derived-asset PENDING reconciler; correct registry reconciler fields; make the closure gate verify reconciler modules reference the authority model.
- **Acceptance proof:** Gate that fails when a CURRENT_RUNTIME job has zero producer call sites.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 5/5 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Keep the five isolated queues (and wire producers) or retire them?

```text
services/worker/src/queue.ts:577  export async function enqueueExifJob(   // 0 callers
services/worker/src/subsystem-queue-processors.ts:319  export async function processGraphDomainSyncJob(
packages/shared/src/queue-integrity/registry.ts:436  reconciler: "services/worker/src/search-index-reconciler.ts",   // graph reconcile; that module only re-enqueues evidence search docs
services/worker/src/search-index-reconciler.ts:455  const outcome = await enqueueSearchIndexingJob({ kind: "evidence",
packages/shared/src/queue-integrity/registry.ts:691  reconciler: "services/worker/src/intelligence-run-reconciler.ts",   // derived assets; reconciler never reads evidencePartDerivedAsset
```

### ET-Q-08

**P3 · misleading DLQ status · SOURCE_PROVEN_DEFECT** — media-intelligence-dlq is a phantom sink (never written) shown as an operator DLQ, and report-dlq entries are written for requests that are still being retried

- **Affected:** routes: GET /v1/operations/queues/*; pages: Operations queues; jobs: RunMediaIntelligence, GenerateReportJob; roles: platform ops
- **Evidence:** `services/worker/src/queue.ts:296`, `services/worker/src/media-intelligence.processor.ts:521`, `services/worker/src/processor.ts:5377`, `services/worker/src/processor.ts:3063`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** Exhausted MI jobs remain in the media-intelligence failed set while the DLQ reads 0. For reports, BullMQ exhaustion writes a DLQ record and a HIGH incident while the durable request is FAILED_RETRYABLE and will be re-driven by lifecycle-recovery (up to 12 claims), so the DLQ is not terminal; the record also stores a raw stack trace.
- **Expected:** DLQ reflects only terminal failures and the MI DLQ is either written or removed from the inventory.
- **Data flow:** n/a
- **Root cause:** Counters and sinks drifted from the durable request model.
- **Blast radius:** Operations triage.
- **Impact:** False all-clear for MI; duplicate/non-terminal DLQ items for reports.
- **Reproduction:** Force an MI job to exhaust retries; media-intelligence-dlq count stays 0.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Remove MI DLQ from the inventory (or write to it on final failure); write report DLQ only on FAILED_TERMINAL; drop errorStack.
- **Acceptance proof:** Inventory test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/queue.ts:296  export const mediaIntelligenceDlqQueue = new Queue(   // no .add anywhere
services/worker/src/media-intelligence.processor.ts:521  await tryBump("media_intelligence_dlq_total");
services/worker/src/processor.ts:5377  if (job.attemptsMade + 1 >= attempts) { await reportDlqQueue.add("ReportDLQ", { evidenceId, jobId: job.id, errorMessage: ..., errorStack: (error as Error).stack ?? null,
services/worker/src/processor.ts:3063  await markRequestRetryable({
```

### ET-Q-09

**P3 · observability · SOURCE_PROVEN_DEFECT** — Worker job events log an evidenceId the canonical payload never carries, OTS pending-retry classification keys on an error string no longer thrown, and malformed payloads are retried for the full budget

- **Affected:** jobs: all BullMQ jobs, UpgradeOts
- **Evidence:** `services/worker/src/index.ts:263`, `services/worker/src/index.ts:200`, `services/worker/src/ots-upgrade.processor.ts:604`, `services/worker/src/canonical-job.ts:61`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** Completed/failed logs and Sentry context always have evidenceId undefined; each transient OTS calendar error raises Sentry + operational alert ots-upgrade_job_failed (up to 20 per job) and appends an OTS_ATTEMPT_ERROR custody event; decode rejections are retried attempts times.
- **Expected:** Log the commandId; classify OTS transient errors as pending retries; throw UnrecoverableError for payload rejections.
- **Data flow:** n/a
- **Root cause:** Payload shape changed in Point 5; handlers not updated.
- **Blast radius:** Alert noise and untraceable job logs.
- **Impact:** Operators cannot correlate failures to records.
- **Reproduction:** Inspect any report.job.failed log line.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Log decoded commandId; match OTS_UPGRADE_ATTEMPT_FAILED; wrap UnprocessableJobPayload in UnrecoverableError.
- **Acceptance proof:** Log snapshot test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/index.ts:263  evidenceId: (job.data as JobData | undefined)?.evidenceId,
services/worker/src/index.ts:200  return getErrorMessage(err).trim() === "NOT_ANCHORED_YET";
services/worker/src/ots-upgrade.processor.ts:604  throw new Error("OTS_UPGRADE_ATTEMPT_FAILED");
services/worker/src/canonical-job.ts:61  export class UnprocessableJobPayload extends Error {   // not bullmq UnrecoverableError
```

### ET-Q-10

**P3 · infinite recovery loop / metric inflation · SOURCE_PROVEN_DEFECT** — The embed-owed reconciler selects chunks by the legacy `embedding` column, which nothing writes, so every chunk aged 30min-30d is 'owed' forever

- **Affected:** pages: Operations intelligence health; jobs: IntelligenceRunStrandedReconciler, EmbedSemanticChunks; tables: evidence_semantic_chunks
- **Evidence:** `services/worker/src/intelligence-run-reconciler.ts:244`, `services/api/src/services/intelligence/semantic.service.ts:82`, `services/worker/src/mi-embed.processor.ts:523`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** semantic.service writes embedding=null; mi-embed writes only embedding_vector. The reconciler therefore treats every chunk in the window as owed, re-enqueues the 50 oldest every 10 min, and reports embedChunksOwed permanently high; those jobs find nothing unembedded in the anchor's workspace while genuinely owed chunks in other workspaces outside the oldest 50 are not selected.
- **Expected:** Owed predicate uses embedding_vector IS NULL (raw SQL) and respects workspace AI policy.
- **Data flow:** n/a
- **Root cause:** Column migration (Bytes -> pgvector) not reflected in the reconciler.
- **Blast radius:** All workspaces with semantic chunks.
- **Impact:** Wasted queue churn, misleading health metric, starvation of real recovery.
- **Reproduction:** Count chunks with embedding IS NULL vs embedding_vector IS NULL.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Switch predicate to embedding_vector IS NULL and exclude policy-disabled workspaces.
- **Acceptance proof:** Reconciler test with an embedded chunk selects zero.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/intelligence-run-reconciler.ts:244  embedding: null,
services/api/src/services/intelligence/semantic.service.ts:82  const embedding: Uint8Array<ArrayBuffer> | null = null;
services/worker/src/mi-embed.processor.ts:523  SET embedding_vector = ${lit}::vector,
```

### ET-REC-01

**P3 · misleading status · SOURCE_PROVEN_DEFECT** — Resume OTS anchoring reports QUEUED (and audits success) when the enqueue collapsed onto a live job; ALREADY_IN_PROGRESS branch is dead

- **Affected:** routes: POST /v1/ops/incidents/:id/remediate; pages: /operations; jobs: UpgradeOtsJob; tables: operational_incident_events, audit; roles: workspace operator
- **Evidence:** `packages/shared/src/queue-integrity/enqueue.ts:162`, `services/api/src/services/integrity/ots-anchoring-authority.service.ts:91`, `services/api/src/services/integrity/ots-anchoring-authority.service.ts:94`, `services/api/src/services/operations/remediation-executor.ts:270`
- **Citations:** 4/4 resolve in the audited tree
- **Merged candidates:** recovery:RECOVERY-01, ots:OTS-08, queues:QUEUES-11
- **Observed:** enqueueCanonicalJob signals a collapse as {enqueued:true, collapsed:true}; requestEvidenceOtsAnchoring ignores `collapsed` and returns requested:true, so the executor answers QUEUED, writes a 'remediation_queued' incident event and a success audit. The 'collapsed' check only inspects enqueued:false reasons, which never contain 'collapsed'.
- **Expected:** A collapse returns ALREADY_IN_PROGRESS with no 'remediation_queued' timeline event.
- **Data flow:** operator click -> executeRemediation -> resumeOtsAnchoring -> requestEvidenceOtsAnchoring -> enqueueCanonicalWork -> enqueueCanonicalJob
- **Root cause:** Adapter reads only `enqueued`, not `collapsed`.
- **Blast radius:** Every OTS resume while a delayed follow-up (1 h ladder) exists - which is the normal PENDING state.
- **Impact:** Operator timeline claims new work was accepted when nothing new was scheduled.
- **Reproduction:** Record with otsStatus FAILED(budget) whose job id ots-upgrade-<id> is still delayed/waiting; click Resume twice; both answers QUEUED.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit test requestEvidenceOtsAnchoring with a QueueHandleLike stub whose getJob returns state 'delayed'; assert result.requested===true today.
- **Recommended remediation:** Map outcome.collapsed to {requested:false, reason:'collapsed'}.
- **Acceptance proof:** Stubbed live job -> executor returns ALREADY_IN_PROGRESS and writes no incident event.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
packages/shared/src/queue-integrity/enqueue.ts:162  return { enqueued: true, jobId, collapsed: true };
services/api/src/services/integrity/ots-anchoring-authority.service.ts:91  if (outcome.enqueued) return { requested: true, jobId: outcome.jobId };
services/api/src/services/integrity/ots-anchoring-authority.service.ts:94  if (reason.includes("collapsed") || reason.includes("duplicate")) {
services/api/src/services/operations/remediation-executor.ts:270  if (requested.requested) return outcome("QUEUED", requested.jobId);
```

### ET-REC-05

**P3 · misleading status · SOURCE_PROVEN_DEFECT** — Web Operations loses the remediation outcome on 409/503; QUEUE_UNAVAILABLE (work recorded) is shown as 'could not be started'

- **Affected:** routes: POST /v1/ops/incidents/:id/remediate; pages: /operations; roles: workspace operator
- **Evidence:** `services/api/src/routes/ops.routes.ts:1624`, `apps/web/app/(app)/operations/page.tsx:1246`, `services/api/src/services/operations/remediation-executor.ts:84`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Non-2xx bodies are {remediation:{result,message}}; apiFetch only lifts top-level message/code or error.code, so the operator sees the generic fallback instead of e.g. 'use Retry after exhausted failure' (NOT_ELIGIBLE) or 'recorded, will be picked up' (QUEUE_UNAVAILABLE, 503). Mobile handles this via remediationMessage(err).
- **Expected:** The server sentence is shown for every answer; QUEUE_UNAVAILABLE is not an error.
- **Data flow:** executeRemediation -> 409/503 -> apiFetch throws -> toSafeUserError generic
- **Root cause:** Error body shape not read by the web page.
- **Blast radius:** All declined operator remediations on web.
- **Impact:** Operator retries or escalates unnecessarily; a durable, recoverable request is reported as not started.
- **Reproduction:** Stop Redis; click 'Recover report or package' on a REPORT incident; row is created QUEUED but UI says it could not be started.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Playwright with the ops API stubbed to 503 {remediation:{result:'QUEUE_UNAVAILABLE',message:'...'}}; assert rendered text.
- **Recommended remediation:** Read err.body.remediation (as mobile does) and treat QUEUE_UNAVAILABLE as info.
- **Acceptance proof:** Stubbed 409/503 renders the server message.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/ops.routes.ts:1624  : result.result === "QUEUE_UNAVAILABLE" ? 503 : 200;
apps/web/app/(app)/operations/page.tsx:1246  setMutationError( toSafeUserError(err, { message: "That action could not be started.",
services/api/src/services/operations/remediation-executor.ts:84  "The work was recorded but could not be scheduled yet. It will be picked up automatically.",
```

### ET-REC-06

**P3 · button that does nothing · SOURCE_PROVEN_DEFECT** — 'Resume OTS anchoring' is offered and answered QUEUED for a permanently invalid proof, which the worker skips

- **Affected:** routes: POST /v1/ops/incidents/:id/remediate; pages: /operations; jobs: UpgradeOtsJob; tables: evidence; roles: workspace operator
- **Evidence:** `services/api/src/services/operations/remediation-executor.ts:246`, `services/worker/src/ots-upgrade.processor.ts:400`, `services/worker/src/ots-state.ts:186`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** For otsFailureReason PROOF_HASH_MISMATCH/MALFORMED_PROOF the ots_failure condition offers Resume; the executor queues the job and records 'remediation_queued'; the processor returns 'proof_invalid_terminal' without any change. For budget-exhausted FAILED the job makes one probe and, if still pending, changes nothing and schedules no follow-up, with no feedback to the operator.
- **Expected:** Permanent proof failures offer no Resume (read-only guidance), and the executor answers NOT_ELIGIBLE.
- **Data flow:** resolveRemediations(ots_failure) -> RESUME_OTS -> resumeOtsAnchoring -> worker no-op
- **Root cause:** Executor precheck only knows ANCHORED/UPGRADED.
- **Blast radius:** Records with invalid OTS proofs.
- **Impact:** Operator believes re-anchoring was attempted; condition stays open.
- **Reproduction:** Evidence otsStatus FAILED otsFailureReason MALFORMED_PROOF; click Resume; 202 QUEUED; worker log proof_invalid_terminal.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit test executeRemediation with such a record and a stub queue; assert QUEUED today.
- **Recommended remediation:** Refuse in the executor and projection when isPermanentOtsProofFailure(otsFailureReason).
- **Acceptance proof:** Executor returns NOT_ELIGIBLE; projection offers no action.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/operations/remediation-executor.ts:246  if (evidence.otsStatus === "ANCHORED" || evidence.otsStatus === "UPGRADED") { return outcome("ALREADY_SATISFIED");
services/worker/src/ots-upgrade.processor.ts:400  (effectiveStatus === "FAILED" && isPermanentOtsProofFailure(evidence.otsFailureReason))
services/worker/src/ots-state.ts:186  export const OTS_PERMANENT_PROOF_FAILURES = [ "PROOF_HASH_MISMATCH", "MALFORMED_PROOF",
```

### ET-REC-07

**P3 · audit accuracy · SOURCE_PROVEN_DEFECT** — Remediation audit outcomes misclassify refusals and no-ops

- **Affected:** routes: POST /v1/admin/incidents/:id/remediate, POST /v1/ops/incidents/:id/remediate; pages: /admin/operations, /operations; tables: platform audit, tenant audit; roles: platform admin, operator
- **Evidence:** `services/api/src/routes/admin-security.routes.ts:719`, `services/api/src/services/operations/remediation-executor.ts:177`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Platform remediation records 'success' for NOT_ELIGIBLE, REFUSED and QUEUE_UNAVAILABLE; workspace remediation records ALREADY_SATISFIED and ALREADY_IN_PROGRESS as 'error'. The result code is in metadata, so the fact is recoverable but the outcome column is wrong.
- **Expected:** Outcome derived from the result the same way on both paths.
- **Data flow:** executor result -> audit outcome
- **Root cause:** Two ad hoc mappings.
- **Blast radius:** Audit reviews filtering by outcome.
- **Impact:** Access/ops reviews over- or under-count successful recoveries.
- **Reproduction:** Platform-remediate a record with nothing missing -> audit success with result ALREADY_SATISFIED; platform-remediate a trashed record -> success with NOT_ELIGIBLE.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Share one result->outcome mapping (QUEUED/ALREADY_* success, REFUSED/NOT_ELIGIBLE denied, others error).
- **Acceptance proof:** Mapping test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/admin-security.routes.ts:719  outcome: result.result === "FAILED" ? "error" : "success",
services/api/src/services/operations/remediation-executor.ts:177  dispatched.result === "QUEUED" ? "success" : dispatched.result === "REFUSED" || dispatched.result === "NOT_ELIGIBLE" ? "denied" : "error",
```

### ET-REC-08

**P3 · misleading status · SOURCE_PROVEN_DEFECT** — Platform queue Retry/Replay of a GenerateReportJob whose request is terminal reports success but the worker no-ops

- **Affected:** routes: POST /v1/operations/queues/:queueName/jobs/:jobId/retry, POST /v1/operations/queues/:queueName/jobs/:jobId/replay; pages: /admin/platform/queues; jobs: GenerateReportJob; tables: report_generation_requests; roles: platform ops
- **Evidence:** `services/api/src/services/operations/queue-replay-action.service.ts:329`, `services/worker/src/report-generation-authority.ts:160`, `services/worker/src/processor.ts:5334`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** A non-retriable failure discards the job (stays in the failed set, removeOnFail false) and writes FAILED_TERMINAL. The queue console lists it as retryable (requires_step_up); job.retry() succeeds and the audit/UI say replay succeeded, but the worker replays onto the terminal row and does nothing. The safety-matrix rationale says so, but the action result does not.
- **Expected:** Queue retry of a report job is refused (or redirected to the Operations supersede action) when its request row is terminal.
- **Data flow:** queues page -> retryFailedJob -> job.retry -> processGenerateReport -> replay_noop
- **Root cause:** Transport-level retry is independent of the durable authority.
- **Blast radius:** Platform ops only.
- **Impact:** Operator believes a report was retried; customer still has no output.
- **Reproduction:** Force a non-retriable report failure; retry the failed job from /admin/platform/queues; request row unchanged.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration with Redis: failed job + FAILED_TERMINAL row; call retryFailedJob; run processGenerateReport; row unchanged and no artifact.
- **Recommended remediation:** Resolve the job's commandId and refuse retry when the row is terminal; point to report.supersede_failed_generation.
- **Acceptance proof:** Retry returns a typed refusal for terminal rows.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/operations/queue-replay-action.service.ts:329  await job.retry();
services/worker/src/report-generation-authority.ts:160  if (isTerminalJobExecutionState(request.state)) { bump("queue_replay_noop_total"); return { outcome: "replay",
services/worker/src/processor.ts:5334  await job.discard();
```

### ET-REC-09

**P3 · missing audit event · SOURCE_PROVEN_DEFECT** — Communications message manual retry writes no audit row and updates without a state predicate

- **Affected:** routes: POST /v1/communications/messages/:id/retry, POST /v1/communications/messages/:id/cancel-retry; pages: /communications; jobs: communications dispatcher; tables: communication_messages; roles: identity.org_policy.manage
- **Evidence:** `services/api/src/routes/communications.routes.ts:307`, `services/api/src/routes/communications.routes.ts:330`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** No emitTenantAudit/audit call anywhere in communications.routes.ts for retry or cancel-retry; the update is read-then-write with where {id} only.
- **Expected:** Manual re-send is audited and conditional on the state that was read.
- **Data flow:** route -> findFirst -> update
- **Root cause:** Route predates audit/claim conventions.
- **Blast radius:** Notification component only; not evidentiary.
- **Impact:** Who re-sent a message cannot be answered; a concurrent dispatcher transition could be overwritten (not proven).
- **Reproduction:** POST retry on a FAILED message; no audit row.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration: call the route, count audit rows before/after; race with dispatcher claim to test overwrite.
- **Recommended remediation:** updateMany with status predicate + emitTenantAudit.
- **Acceptance proof:** Audit row exists; stale update count 0.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/communications.routes.ts:307  const row = await prisma.communicationMessage.findFirst({ where: { id, teamId: body.teamId },
services/api/src/routes/communications.routes.ts:330  const updated = await prisma.communicationMessage.update({ where: { id: row.id }, data: { status: prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
```

### ET-REC-10

**P3 · misleading status · SOURCE_PROVEN_DEFECT** — 'Retry budget exhausted' incident fires at BullMQ attempt 5 while the durable budget (12 claims) keeps retrying

- **Affected:** pages: /operations; jobs: GenerateReportJob, lifecycle-recovery; tables: operational_incidents, report_generation_requests; roles: operator
- **Evidence:** `services/worker/src/processor.ts:5377`, `services/worker/src/processor.ts:5493`, `packages/shared/src/queue-integrity/retry-policy.ts:69`, `services/worker/src/report-generation-authority.ts:88`
- **Citations:** 4/4 resolve in the audited tree
- **Observed:** After 5 BullMQ attempts the job is DLQ'd and a HIGH 'retry budget exhausted' incident opens, but the row stays FAILED_RETRYABLE (attemptCount<12) and the reconciler re-enqueues it; the customer sees RETRY, the operator's supersede action is refused (not terminal).
- **Expected:** One budget; the exhausted incident only when the durable row goes FAILED_TERMINAL (which report-generation-authority.ts already does).
- **Data flow:** processGenerateReport catch -> recordReportFailureIncident(retriable:true)
- **Root cause:** Two retry budgets.
- **Blast radius:** Report (non-package) retryable failures.
- **Impact:** Premature HIGH incident; operator action offered but refused.
- **Reproduction:** Make render fail retryably 5 times; observe incident while row is FAILED_RETRYABLE.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration with a failing renderer stub; inspect incident + row after 5 attempts.
- **Recommended remediation:** Drop the BullMQ-exhaustion incident for request-backed jobs, or word it as 'queue attempts exhausted; automatic retries continue'.
- **Acceptance proof:** Incident only at FAILED_TERMINAL.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 4/4 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/processor.ts:5377  if (job.attemptsMade + 1 >= attempts) {
services/worker/src/processor.ts:5493  title: input.retriable ? `Report generation retry budget exhausted (${evidenceLabel})`
packages/shared/src/queue-integrity/retry-policy.ts:69  attempts: 5,
services/worker/src/report-generation-authority.ts:88  export const REPORT_RECONCILE_MAX_ATTEMPTS = 12;
```

### ET-REC-11

**P3 · duplicate side effect · SOURCE_PROVEN_DEFECT** — Every API-side recovery request fires an EVIDENCE_REPORTED automation trigger, before any report exists

- **Affected:** routes: POST /v1/evidence/:id/reports/regenerate, POST /v1/ops/incidents/:id/remediate; jobs: automation dispatch; tables: automation outbox; plans: plans with automation
- **Evidence:** `services/api/src/services/reports/report-generation-authority.service.ts:353`, `services/api/src/services/automation/automation-triggers.ts:123`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** The trigger is emitted on creation of each new request row, keyed by request id - including package-only recovery, retries that supersede (:s<n>), and requests the worker later refuses. Worker-originated requests (first issuance / package sweep) never emit it.
- **Expected:** EVIDENCE_REPORTED once per issued report (e.g., on report commit), not per recovery request.
- **Data flow:** requestReportGeneration -> createReportGenerationRequest -> triggerEvidenceReported
- **Root cause:** Trigger bound to request creation by design (ARCH-005 comment).
- **Blast radius:** Workspaces with EVIDENCE_REPORTED automation rules.
- **Impact:** Recovery clicks re-fire automations (notifications/webhooks) for an already-reported record; a refused request still announces 'reported'.
- **Reproduction:** Create an EVIDENCE_REPORTED rule; on a REPORTED record missing its package click 'Recover verification package'; a second outbox row appears.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Integration: count automation outbox rows for the evidence before/after a package recovery request.
- **Recommended remediation:** Emit from the worker at report commit (new version only) with sourceEventId report:<reportId>.
- **Acceptance proof:** Package recovery adds no outbox row.
- **Migration/backfill:** none
- **Dependency:** automation domain owner
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Is EVIDENCE_REPORTED meant to mean 'report requested' or 'report issued'?

```text
services/api/src/services/reports/report-generation-authority.service.ts:353  await triggerEvidenceReported(prisma, { teamId: ev.teamId, evidenceId: input.evidenceId, reportId: persisted.requestId,
services/api/src/services/automation/automation-triggers.ts:123  sourceEventId: `report:${input.reportId}`,
```

### ET-RPT-04

**P3 · failure rendered as permission state · SOURCE_PROVEN_DEFECT** — When loadEvidenceOutputFacts fails, every row is given action NONE with reason PERMISSION_DENIED ('Needs permission') while the list section still reports ok

- **Affected:** routes: GET /v1/reports/artifacts; pages: /reports
- **Evidence:** `services/api/src/services/reports/reports-aggregator.service.ts:750`, `services/api/src/services/reports/reports-aggregator.service.ts:912`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** A transient failure of the batched facts read is swallowed; rows fall back to the noAction object whose reason is PERMISSION_DENIED, which the page renders as a 'Needs permission' badge, and polling stops (pollIntervalMs null).
- **Expected:** Section status 'degraded' with an 'actions unavailable' reason, not a permission claim.
- **Data flow:** loadEvidenceOutputFacts throw -> empty map -> noAction -> outputNoteShort -> badge.
- **Root cause:** Fallback constant reuses PERMISSION_DENIED.
- **Blast radius:** Whole page during a partial DB fault.
- **Impact:** Misleading status; no data corruption.
- **Reproduction:** Make organization.findMany throw inside loadEvidenceOutputFacts; every row shows 'Needs permission'.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit test listWorkspaceArtifacts with prisma.organization.findMany mocked to reject; assert items[*].outputs.report.actionUnavailableReason === 'PERMISSION_DENIED' and artifacts.status === 'ok'.
- **Recommended remediation:** Use a dedicated reason (e.g. ACTIONS_UNAVAILABLE) and set artifacts.status 'degraded'.
- **Acceptance proof:** Test above asserts degraded status and non-permission reason.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/reports/reports-aggregator.service.ts:750  }).catch(() => new Map<string, LoadedOutputFacts>());
services/api/src/services/reports/reports-aggregator.service.ts:912  actionUnavailableReason: "PERMISSION_DENIED" as OutputActionUnavailableReason,
```

### ET-RPT-05

**P3 · misleading status · SOURCE_PROVEN_DEFECT** — Summary shows 'temporarily unavailable' during initial load and permanently on the user-scoped fallback path

- **Affected:** routes: GET /v1/reports; pages: /reports
- **Evidence:** `apps/web/components/reports-experience/ReportsIndex.tsx:384`, `apps/web/components/reports-experience/ReportsIndex.tsx:321`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** summarySection starts as 'unavailable' so the list can render before the summary with an outage notice; when the aggregator 404s (missing TeamMember bootstrap) the fallback list renders rows (including failed ones) with no cards at all and a 'temporarily' notice that never clears.
- **Expected:** A loading state for the summary, and on the fallback path a notice that explains the summary is not available for this workspace view.
- **Data flow:** initial state / 404 -> tryUserScopedReports -> summary unavailable.
- **Root cause:** No 'loading' member in the summary section state; fallback has no summary source.
- **Blast radius:** Personal workspaces with bootstrap gap; all users briefly on load.
- **Impact:** Cosmetic/trust; never shows false zeros.
- **Reproduction:** Throttle /v1/reports/artifacts?limit=1; page shows 'Summary is temporarily unavailable' before cards appear.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Add a 'loading' summary state; distinct copy for fallback.
- **Acceptance proof:** Render test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/components/reports-experience/ReportsIndex.tsx:384  >({ status: "unavailable", data: null });
apps/web/components/reports-experience/ReportsIndex.tsx:321  summary: { status: "unavailable", data: null },
```

### ET-RPT-06

**P3 · presentation · SOURCE_PROVEN_DEFECT** — Reports row renders every generation outcome in success green, including TERMINAL, RECOVERABLE_BLOCKED and QUEUE_UNAVAILABLE

- **Affected:** routes: POST /v1/evidence/:id/reports/regenerate; pages: /reports
- **Evidence:** `apps/web/components/reports-experience/ReportsIndex.tsx:1244`, `apps/web/components/reports-experience/ReportsIndex.tsx:1462`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** readGenerationOutcome returns a tone, but the page discards it and styles all 202 outcomes as success.
- **Expected:** Tone follows readGenerationOutcome().tone as on Evidence Detail.
- **Data flow:** 202 body.outcome -> readGenerationOutcome -> message only.
- **Root cause:** tone ignored.
- **Blast radius:** /reports row actions.
- **Impact:** Refusals look like success; list is re-read afterwards so state is still truthful.
- **Reproduction:** Retry a request whose head is TERMINAL; 202 outcome TERMINAL shown in green.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Store {message,tone} and style by tone.
- **Acceptance proof:** Render test asserts non-success styling for TERMINAL.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
apps/web/components/reports-experience/ReportsIndex.tsx:1244  setRegenNotice(readGenerationOutcome(resp).message);
apps/web/components/reports-experience/ReportsIndex.tsx:1462  color: "#167A5B",
```

### ET-RPT-07

**P3 · audit attribution · SOURCE_PROVEN_DEFECT** — SUCCEEDED request records the newest report id, not the report the run produced or targeted

- **Affected:** jobs: GENERATE_REPORT; tables: report_generation_requests
- **Evidence:** `services/worker/src/processor.ts:3079`, `services/worker/src/processor.ts:3088`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** A package-only recovery for v1 (while v2 exists), a pair_complete no-op, or a run racing another issuance is marked SUCCEEDED with resultReportId of the newest version.
- **Expected:** resultReportId = the (evidenceId, command/committed reportVersion) row the run produced or targeted; null for no-op.
- **Data flow:** runReportGeneration returns void -> post-hoc findFirst.
- **Root cause:** Run result not returned to caller.
- **Blast radius:** Request history/replay logs only (consumers only log it).
- **Impact:** Low; misattributed provenance.
- **Reproduction:** VERIFICATION_PACKAGE request reportVersion=1 on evidence with v2 -> resultReportId = v2.id.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Worker integration test with two report versions and package-only request for v1.
- **Recommended remediation:** Return the committed/targeted version from runReportGeneration and resolve the id by (evidenceId, version).
- **Acceptance proof:** Test asserts resultReportId matches v1.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/processor.ts:3079  const latest = await prisma.report.findFirst({ where: { evidenceId: command.evidenceId }, orderBy: { version: "desc" },
services/worker/src/processor.ts:3088  resultReportId: latest?.id ?? null,
```

### ET-RPT-09

**P3 · report wording · SOURCE_PROVEN_DEFECT** — Executive conclusion says 'finalized supporting publication materials' when OTS is anchored but not chain-checked

- **Affected:** jobs: GENERATE_REPORT
- **Evidence:** `packages/shared/src/trust-decision.ts:868`, `packages/shared/src/trust-decision.ts:1315`, `services/worker/src/report-v2/truth-model.ts:122`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** buildAnchoringSignal returns 'passed' (10/10) for ANCHORED_NOT_CHECKED, anchoringState 'finalized', so the conclusion/title read 'Recorded integrity verified' with finalized materials, while the OTS callout in the same PDF says 'Anchored — chain not checked'.
- **Expected:** Conclusion wording consistent with the OTS claim (e.g. 'anchored; chain not checked').
- **Data flow:** otsStatus ANCHORED + txid, otsAnchorCheck null -> passed -> VERIFIED_FINALIZED.
- **Root cause:** Signal status not split by resolveOtsAnchorClaim result.
- **Blast radius:** Most anchored reports.
- **Impact:** Overstatement in summary wording; the detailed callout is truthful.
- **Reproduction:** Fixture with otsStatus ANCHORED, valid txid, otsAnchorCheck null, TSA STAMPED.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Use VERIFIED_FINALIZED only when the claim is VERIFIED; otherwise a 'verified; anchoring not independently checked' variant.
- **Acceptance proof:** Unit test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.
- **Owner decision:** Whether 'finalized' may mean upgraded-but-unchecked.

```text
packages/shared/src/trust-decision.ts:868  status: "passed",
packages/shared/src/trust-decision.ts:1315  presentationState = "VERIFIED_FINALIZED";
services/worker/src/report-v2/truth-model.ts:122  "The preserved evidence record reached a verified recorded-integrity state with finalized supporting publication materials ...
```

### ET-SEC-28

**P3 · concurrency/quota · SOURCE_PROVEN_DEFECT** — Storage capacity check runs outside the capacity advisory lock; two finalizes in one workspace can both pass

- **Affected:** see evidence
- **Evidence:** `services/api/src/services/evidence-complete.service.ts:994`, `services/api/src/services/workspace-usage.service.ts:527`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Capacity lock taken later in settlement (billing-enforcement.service.ts:62-72, :693). Plan snapshot also read before lock (:507-510).
- **Expected:** Check under the capacity lock.
- **Data flow:** POST /complete -> completeEvidence -> resolveEnforcementScopeForRequester (:507, global client) -> assertWorkspaceAllowsStorageGrowth -> getWorkspaceUsage (:994, no lock) -> ... -> settleEvidenceCompletionFunding takes capacity advisory lock (:1238).
- **Root cause:** The storage check and plan read happen before the per-workspace capacity lock; the per-evidence advisory lock does not serialize different records.
- **Blast radius:** Workspaces near their storage limit with concurrent finalizes; finalizes racing a plan webhook.
- **Impact:** Quota overrun by up to N x max evidence size; plan change in-flight funded under old plan.
- **Reproduction:** Workspace with 10 MB remaining; finalize two different 8 MB records concurrently; both succeed and usage exceeds the limit.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Parallel finalizes near limit.
- **Recommended remediation:** Move storage check after capacity lock.
- **Acceptance proof:** Parallel finalize test cannot exceed limit.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/evidence-complete.service.ts:994  await assertWorkspaceAllowsStorageGrowth({ scope, incomingBytes: incomingGrowth });
services/api/src/services/workspace-usage.service.ts:527  const usage = await getWorkspaceUsage(params.scope);
```

### ET-SEC-29

**P3 · concurrency/pointer · SOURCE_PROVEN_DEFECT** — Package commit sets evidence verificationPackageVersion without monotonic guard; package-only recovery of an older version regresses the pointer

- **Affected:** see evidence
- **Evidence:** `services/worker/src/processor.ts:4879`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** output-recovery.service.ts:515-573 supports packageForReportVersion.
- **Expected:** Only advance pointer (version > current).
- **Data flow:** Operator/recovery requestOutputRecovery(packageForReportVersion=v2) -> worker package commit -> tx.evidence.update {verificationPackageVersion: 2} (processor.ts:4879) after v3 already committed.
- **Root cause:** The pointer update is unconditional instead of monotonic.
- **Blast radius:** Records whose older-version package is recovered after a newer package exists.
- **Impact:** Latest-package pointer shows an older version.
- **Reproduction:** Record with report/package v3; trigger package-only recovery for report v2; after the job, evidence.verification_package_version = 2.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Sequential recovery fixture.
- **Recommended remediation:** Conditional update where verificationPackageVersion < version or null.
- **Acceptance proof:** Recovery of v2 after v3 leaves pointer 3.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/processor.ts:4879  await tx.evidence.update({ where: { id: prepared.evidenceId }, data: { verificationPackageGeneratedAtUtc: prepared.now, verificationPackageVersion: prepared.version,
```

### ET-SEC-30

**P3 · concurrency/lease · SOURCE_PROVEN_DEFECT** — Report request lease has no fencing token; a late worker's markRequestRetryable/terminal write overwrites the re-claimer's PROCESSING row

- **Affected:** see evidence
- **Evidence:** `services/worker/src/report-generation-authority.ts:374`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** Artifacts remain single due to reserve/commit + unique version.
- **Expected:** Include claimedAtUtc/attempt in WHERE.
- **Data flow:** Worker W1 claims report request (claimedAtUtc) -> exceeds 15-min lease -> reconciler releases / W2 re-claims -> W1 late markRequestRetryable updateMany where {id, state PROCESSING} -> FAILED_RETRYABLE + re-enqueue.
- **Root cause:** The claim has no fencing token; late writes match on state alone.
- **Blast radius:** Report/package requests whose processing exceeds REPORT_CLAIM_LEASE_MS.
- **Impact:** Duplicate work, state thrash.
- **Reproduction:** Unit test: claim request as W1, advance clock past lease, claim as W2, then call markRequestRetryable as W1; the row flips from W2's PROCESSING to FAILED_RETRYABLE (count 1).
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit test with two claims.
- **Recommended remediation:** Fence with claim token.
- **Acceptance proof:** Late write count 0.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/report-generation-authority.ts:374  updateMany({ where: { id: input.requestId, state: "PROCESSING" }, data: { state: "FAILED_RETRYABLE", ..., claimedAtUtc: null } })
```

### ET-SEC-31

**P3 · tenancy/enumeration · SOURCE_PROVEN_DEFECT** — Existence oracles: 404-vs-403 on case access, capture sessions, cases evidence attach, evidence create with foreign teamId; public verify 409 exposes status of unfinalized records

- **Affected:** see evidence
- **Evidence:** `services/api/src/routes/evidence.routes.ts:2356`, `services/api/src/routes/capture.routes.ts:154`, `services/api/src/routes/evidence.routes.ts:12569`
- **Citations:** 1/3 resolve in the audited tree
- **Merged candidates:** security:SEC-31, package-verify:PKGV-10
- **Observed:** UUIDv4 ids make blind enumeration infeasible; ids leak via verify URLs.
- **Expected:** Uniform 404.
- **Data flow:** GET /v1/evidence?caseId= -> assertCaseAccess (404 missing / 403 foreign); GET /v1/capture/sessions/:id -> loadOwnedDraft (404/403); POST /v1/evidence with foreign teamId -> 403; GET /public/verify/:id unfinalized -> 409 with status.
- **Root cause:** These handlers predate the anti-enumeration convention and return distinct status codes for existing-but-forbidden objects.
- **Blast radius:** Any authenticated user holding a UUID (or anyone with a verify id); existence/status disclosure only.
- **Impact:** Low.
- **Reproduction:** As an outsider GET /v1/evidence?caseId=<existing foreign case> -> 403 vs <random uuid> -> 404; GET /public/verify/<uploading evidence id> -> 409 with status.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Return 404 uniformly.
- **Acceptance proof:** Route tests.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:2356  assertCaseAccess: 404 missing vs 403 foreign
services/api/src/routes/capture.routes.ts:154  404 missing vs 403 not-owner
services/api/src/routes/evidence.routes.ts:12569  409 EVIDENCE_NOT_FINALIZED with status
```

### ET-SEC-32

**P3 · integrity · SOURCE_PROVEN_DEFECT** — Annotation PATCH accepts any evidencePartId (no ownership check, unlike POST)

- **Affected:** see evidence
- **Evidence:** `services/api/src/routes/evidence.routes.ts:7793`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** POST checks part.evidenceId === id (:7707-7711).
- **Expected:** Same check on PATCH.
- **Data flow:** PATCH /v1/evidence/:id/annotations/:aid -> getEvidenceWithReadAccess -> evidence_annotations.update with body.evidencePartId unchecked (:7793).
- **Root cause:** The PATCH schema is AnnotationBody.partial() and the ownership check exists only in the POST handler.
- **Blast radius:** Annotations in any workspace; integrity of annotation-part references only.
- **Impact:** Annotation may reference another tenant's part id; no read-out path found.
- **Reproduction:** PATCH /v1/evidence/E/annotations/A {evidencePartId:<part of another tenant's evidence>} -> 200 and the annotation row references the foreign part.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Validate part ownership.
- **Acceptance proof:** PATCH with foreign part -> 400.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/routes/evidence.routes.ts:7793  ...(body.evidencePartId !== undefined ? { evidencePartId: body.evidencePartId ?? null } : {})
```

### ET-SEC-33

**P3 · integrity · SOURCE_PROVEN_DEFECT** — Caller-supplied caseId/evidenceId on intake links and evidence requests stored without tenant validation (dangling foreign references copied to webhooks)

- **Affected:** see evidence
- **Evidence:** `services/api/src/services/workflow-intake-link.service.ts:272`, `services/api/src/services/evidence-request.service.ts:182`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** No read-out of foreign record follows.
- **Expected:** Validate same workspace.
- **Data flow:** POST intake link / evidence request with body caseId/evidenceId -> workflow-intake-link.service (:272) / evidence-request.service (:182) store ids -> copied to webhooks and follow-up links.
- **Root cause:** The services validate the template/team but not optional reference ids.
- **Blast radius:** Intake links and evidence requests in all workspaces; webhook consumers receive misleading references.
- **Impact:** Misleading references.
- **Reproduction:** POST an evidence request in workspace T with caseId of a case in T2; the row stores it and the webhook payload carries the foreign caseId.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Validate.
- **Acceptance proof:** Foreign id -> 404.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/workflow-intake-link.service.ts:272  caseId: input.caseId ?? null,
services/api/src/services/evidence-request.service.ts:182  evidenceId: parsed.evidenceId ?? null, caseId: parsed.caseId ?? null,
```

### ET-SEC-34

**P3 · dead-legacy · SOURCE_PROVEN_DEFECT** — Dead exported legal-hold query helpers with optional teamId spread (would be unscoped if ever called)

- **Affected:** see evidence
- **Evidence:** `services/api/src/services/governance/legal-hold.service.ts:930`, `services/api/src/services/governance/legal-hold.service.ts:1007`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** grep for listCaseHolds|countLifecycleHolds|countActiveCaseHolds across services/apps/packages returns only their definitions (zero callers).
- **Expected:** Delete or require teamId.
- **Data flow:** None at runtime: listCaseHolds/countLifecycleHolds/countActiveCaseHolds have zero callers; if called without teamId they query evidence_legal_holds across all tenants.
- **Root cause:** Legacy projection helpers kept after hold convergence with optional tenant spread.
- **Blast radius:** Latent only; any future caller omitting teamId.
- **Impact:** Latent only.
- **Reproduction:** grep -rn "listCaseHolds\|countLifecycleHolds\|countActiveCaseHolds" services apps packages returns only the three definitions in legal-hold.service.ts.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Delete.
- **Acceptance proof:** grep zero.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/governance/legal-hold.service.ts:930  ...(input.teamId ? { teamId: input.teamId } : {}),
services/api/src/services/governance/legal-hold.service.ts:1007  ...(input.teamId ? { teamId: input.teamId } : {}),
```

### ET-SEC-35

**P3 · presentation · SOURCE_PROVEN_DEFECT** — Integrity snapshot writes misleading booleans from status (MATERIALS_AVAILABLE => hash/signature/custody true; OTS matches true by status) — no reader; web library labels FAILED_HASH_MISMATCH 'Status not recorded'

- **Affected:** see evidence
- **Evidence:** `services/api/src/services/dashboard/integrity-snapshot.service.ts:128`, `apps/web/app/(app)/evidence/lib/evidence-library-status.ts:168`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** Latent columns; library label neutral for failed evidence.
- **Expected:** Accurate labels.
- **Data flow:** integrity-snapshot.service deriveIntegritySnapshot maps verificationStatus to hash/signature/custody booleans (:128) -> evidence_integrity_snapshots (no reader of those columns); web library getRecordStatusLabel lacks FAILED_HASH_MISMATCH -> 'Status not recorded'.
- **Root cause:** Status-derived booleans stand in for real checks; the web label map was not extended when FAILED_HASH_MISMATCH was added.
- **Blast radius:** Latent snapshot columns; web evidence library users viewing failed records.
- **Impact:** Low.
- **Reproduction:** Open the evidence library for a record with status FAILED_HASH_MISMATCH -> neutral 'Status not recorded' label, while the detail page shows the failure.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Drop columns; add label.
- **Acceptance proof:** Unit test.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/dashboard/integrity-snapshot.service.ts:128  isOk = vs === "RECORDED_INTEGRITY_VERIFIED" || vs === "MATERIALS_AVAILABLE"
apps/web/app/(app)/evidence/lib/evidence-library-status.ts:168  no case for FAILED_HASH_MISMATCH
```

### ET-TSA-07

**P3 · failure classification / secret hygiene · SOURCE_PROVEN_DEFECT** — TSA failure classifier substring-matches the full execFile error (argv incl. URL and user:password, digest, temp path); real timeouts are never classified as timeouts

- **Affected:** tables: evidence
- **Evidence:** `services/api/src/services/timestamp.service.ts:69`, `services/api/src/services/timestamp.service.ts:241`, `services/api/src/services/timestamp.service.ts:232`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** Node's execFile error message is 'Command failed: <file> <args>' + stderr, so digits/words in the TSA URL, password or the 64-hex digest (e.g. '429','403') can select the persisted operator reason; an execFile kill on timeout produces no 'timeout' text so it falls to unknown/other buckets. Password is passed in argv (visible in process listing while curl runs) and TSA_URL http is allowed for Basic auth. The error message is not logged, so no direct leak found.
- **Expected:** Classify from err.killed/err.code/curl exit code/HTTP status (-w '%{http_code}'); pass credentials via -K config file or stdin; require https.
- **Data flow:** execFile error.message -> classifyTsaSubprocessError -> tsaFailureReason
- **Root cause:** Heuristic substring classification over an argv-bearing message.
- **Blast radius:** Operator-facing reason text only.
- **Impact:** Misleading triage; minor credential exposure surface.
- **Reproduction:** Set TSA_TIMEOUT_MS=1 against a slow endpoint; persisted reason is not the timeout reason.
- **Runtime evidence:** Not runtime-exercised. Proposed probe: Unit-call the (non-exported) classifier via a small copy, or run createEvidenceTimestamp against a 127.0.0.1 socket that never responds with TSA_TIMEOUT_MS=200 and inspect failureCode.
- **Recommended remediation:** Structured classification; curl --max-time/--connect-timeout/--proto =https; credentials via --config from a 0600 temp file.
- **Acceptance proof:** Timeout probe yields tsa_provider_timeout.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/timestamp.service.ts:69  if (message.includes("quota") || message.includes("rate limit") || message.includes("rate-limit") || message.includes("429")) {
services/api/src/services/timestamp.service.ts:241  `${tsaUsername}:${tsaPassword}`,
services/api/src/services/timestamp.service.ts:232  { timeout: timeoutMs() }
```

### ET-TSA-08

**P3 · wording / dead claims · SOURCE_PROVEN_DEFECT** — Report claims the token is available via a 'technical verification endpoint' that does not exist; comments claim a worker ASN.1 TSA parser that does not exist

- **Affected:** jobs: report
- **Evidence:** `services/worker/src/report-v2/technical-model.ts:482`, `services/api/src/services/dashboard/integrity-snapshot.service.ts:71`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** rg 'tsaToken|timestamp.tsr' services/api/src/routes -> 0 hits; no asn1/pkijs dependency or parser in services/worker/src. The web verify page reads data.tsaTokenBase64 but the API never sends it.
- **Expected:** Report text references only the package; stale comments removed.
- **Data flow:** n/a
- **Root cause:** Copy/comment drift.
- **Blast radius:** All reports with a token.
- **Impact:** Reviewer is pointed at a non-existent endpoint.
- **Reproduction:** grep as stated.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Change copy; remove comment.
- **Acceptance proof:** Report text updated; grep clean.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/worker/src/report-v2/technical-model.ts:482  "Full RFC 3161 token remains available through the verification package and technical verification endpoint."
services/api/src/services/dashboard/integrity-snapshot.service.ts:71  * parser is intentionally a no-op stub: a real ASN.1 TSA token parser lives in the worker package
```

### ET-TSA-09

**P3 · repair tool contract drift · SOURCE_PROVEN_DEFECT** — Manual TSA repair CLI writes STAMPED without the serial+genTime precondition its docstring states, and contradicts the 'written once inside finalize' authority claim

- **Affected:** jobs: operator CLI repair-tsa-failed-with-token; tables: evidence, custody_event; roles: operator
- **Evidence:** `services/api/src/scripts/repair-tsa-failed-with-token.ts:18`, `services/api/src/scripts/repair-tsa-failed-with-token.ts:248`, `services/api/src/services/operations/remediation-registry.ts:273`
- **Citations:** 3/3 resolve in the audited tree
- **Observed:** The script only gates on parsed.granted (inheriting TSA-02 fail-open) and can therefore promote a FAILED row with no parseable imprint/serial/genTime to STAMPED; comment says the token 'is provably a valid Granted RFC 3161 response' with no signature check.
- **Expected:** Same validation as the fixed live path (TSA-01/02) and explicit serial+genTime requirement.
- **Data flow:** stored bytes -> openssl -text -> parseTsaReply -> CAS FAILED->STAMPED + TIMESTAMP_APPLIED custody event
- **Root cause:** Docstring/implementation drift.
- **Blast radius:** Rows the operator runs it on (dry-run default, --apply required).
- **Impact:** Operator-initiated false STAMPED possible.
- **Reproduction:** Row FAILED with bytes whose -text lacks Message data -> script REPAIRABLE.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Reuse the fixed verifier; require serial && genTime && imprintMatchesRequest===true.
- **Acceptance proof:** Dry-run on such a row reports KEEP-FAILED.
- **Migration/backfill:** Audit custody events with repair_source='tsa_replay_from_token'.
- **Dependency:** TSA-01/TSA-02
- **Lead verification:** Accepted from the tracing pass after machine verification: 3/3 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/scripts/repair-tsa-failed-with-token.ts:18   *   4. On `granted === true` AND `serialNumber` AND `genTimeUtc` AND
services/api/src/scripts/repair-tsa-failed-with-token.ts:248  if (!parsed.granted) {
services/api/src/services/operations/remediation-registry.ts:273  `tsaStatus` is written once, inside the finalize claim
```

### ET-UPL-03

**P3 · idempotency · SOURCE_PROVEN_DEFECT** — Idempotent session reuse does not check the returned session belongs to the requested evidenceId

- **Affected:** routes: POST /v1/uploads/sessions; tables: evidence_upload_sessions; roles: same-team member; plans: all
- **Evidence:** `services/api/src/services/uploads/upload-session.service.ts:370`
- **Citations:** 1/1 resolve in the audited tree
- **Observed:** A same-team member who pre-creates key capture:<X>:<i> bound to their own evidence Y diverts the victim's upload for X to Y's storage key and bridge.
- **Expected:** Reuse only when evidence_id (and actor) match; otherwise 409.
- **Data flow:** POST sessions {evidenceId:X, idempotencyKey:k} -> returns session for Y
- **Root cause:** Idempotency key not bound to its request parameters.
- **Blast radius:** Narrow: attacker needs X's id before the victim's large-item loop.
- **Impact:** Victim's bytes land on another record.
- **Reproduction:** Create session with key capture:X:0 for evidence Y; victim's client reuses it.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Compare evidence_id/actor on reuse; refuse mismatch.
- **Acceptance proof:** Test: mismatched reuse refused.
- **Migration/backfill:** none
- **Dependency:** none
- **Lead verification:** Accepted from the tracing pass after machine verification: 1/1 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/uploads/upload-session.service.ts:370  lookup keyed on (team_id, idempotency_key) only; returns existing[0] regardless of evidence_id
```

### ET-UPL-05

**P3 · integrity-hygiene · SOURCE_PROVEN_DEFECT** — Multipart path never enforces expectedTotalBytes/partSizeBytes, marks parts VERIFIED without a reference hash, and leaves bridged parts without uploadedByUserId

- **Affected:** routes: upload-sessions multipart routes; tables: evidence_upload_session_parts, evidence_parts
- **Evidence:** `services/api/src/services/uploads/upload-session.service.ts:1830`, `services/api/src/services/uploads/upload-session.service.ts:1885`
- **Citations:** 2/2 resolve in the audited tree
- **Observed:** expectedTotalBytes never compared to head.contentLength; VERIFIED set with no reference; attribution missing on bridged parts. Server whole-object hash still reflects real bytes, so this is not tampering.
- **Expected:** Enforce declared size, do not label VERIFIED without a reference, record uploader.
- **Data flow:** multipart/complete -> verifyCompletedObject -> parts VERIFIED
- **Root cause:** Hygiene gaps in the Phase 30.12 path.
- **Blast radius:** Resumable uploads.
- **Impact:** Misleading VERIFIED label; lost uploader attribution in custody.
- **Reproduction:** Source-proven.
- **Runtime evidence:** not required (deterministic code path; source-proven)
- **Recommended remediation:** Enforce sizes; use UNVERIFIED_NO_REFERENCE; set uploadedByUserId from the session actor.
- **Acceptance proof:** Unit tests on completeStorageMultipart.
- **Migration/backfill:** none
- **Dependency:** UPL-01
- **Lead verification:** Accepted from the tracing pass after machine verification: 2/2 cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.

```text
services/api/src/services/uploads/upload-session.service.ts:1830  parts marked VERIFIED when expected_sha256 is NULL
services/api/src/services/uploads/upload-session.service.ts:1885  evidencePart.create data has no uploadedByUserId
```

## Merged and rejected candidates

Candidates raised by a tracing pass that were merged into a finding with the same root cause, or rejected on lead verification — kept so before/after counts stay auditable.

| candidate | proposed | title | reason |
|---|---|---|---|
| commercial:COMMERCIAL-05 | P2 | Abandoned, failed or completion-refused records occupy FREE slots forever; no reservation expiry | merged into ET-ACQ-02: Same root cause: abandoned/uncompleted records occupy allowance and are never reaped. |
| custody:CUSTODY-15 | P3 | External intake: custody attributes the upload to the link owner, EXTERNAL_INTAKE_SUBMITTED is written outside the completion tx before the session transition, and non-web finalizations never emit EVIDENCE_COMPLETED | merged into ET-INT-12: Same intake attribution/post-commit custody defect. |
| ots:OTS-08 | P3 | requestEvidenceOtsAnchoring can never return 'collapsed', so Operations reports QUEUED when it joined (or no-op'd onto) existing work | merged into ET-REC-01: Same defect: the collapsed enqueue outcome is unreachable so Operations reports QUEUED. |
| package-verify:PKGV-10 | P3 | Public verify answers 409 (with status), 404 "Evidence not signed" and 503 for valid UUIDs, distinguishable from the generic 404 | merged into ET-SEC-31: Same existence-oracle class (public verify 409/404/503 distinguishable). |
| package-verify:PKGV-16 | P3 | Exchange package custody-chain.json is truncated at 500 and renders a DB error as an empty chain, unsigned | merged into ET-CUS-09: Same defect: exchange package custody-chain.json truncated/unverifiable. |
| queues:QUEUES-01 | P1 | OTS initialization schedules its follow-up upgrade onto its own active job, so every newly stamped proof stays PENDING with no future upgrade and no automatic recovery | merged into ET-OTS-01: Same defect (init follow-up collapses onto its own job) found independently by the queue pass. |
| queues:QUEUES-02 | P1 | OTS self-reschedule alternates between a fixed id and a fixed '-next-' id; on the third hop the add targets a retained completed job id, BullMQ silently ignores it, and the ladder stops while reporting success | merged into ET-OTS-02: Same defect (deterministic -next- id collision) found independently by the queue pass. |
| queues:QUEUES-11 | P3 | OTS remediation reports QUEUED when the enqueue collapsed onto an existing delayed job; the 'collapsed' branch is unreachable | merged into ET-REC-01: Same defect as RECOVERY-01 / OTS-08. |
| reports:REPORTS-08 | P3 | Package built by recovery uses a time-cut custody chain and CURRENT verification status instead of the report row's custodyThroughSequence | merged into ET-CUS-06: Same defect: recovery package selects custody by time instead of custodyThroughSequence. |
| security:SEC-08 | P1 | Any same-team member (evidence.create) can open an upload session against a colleague's SIGNED/REPORTED evidence and bridge an extra unsigned EvidencePart into it | merged into ET-UPL-01: Same defect found independently by the security pass. |
| statemachine:STATEMACHINE-01 | P0 | Resumable upload-session bridge appends EvidenceParts to already-SIGNED/REPORTED evidence of any team member, injecting content and irreversibly flipping the record to FAILED_HASH_MISMATCH | merged into ET-UPL-01: Same defect (upload-session bridge part injection) found independently by the state-machine pass. |
| statemachine:STATEMACHINE-04 | P2 | Lifecycle writers (orchestrator, trash/restore/archive service) validate fromState on a read and then update WHERE id only; PENDING_DESTRUCTION -> ACTIVE is allowed even while the destruction executor holds its claim | merged into ET-SEC-12: Same defect class: lifecycle writers validate on a read and update WHERE id only. |
| statemachine:STATEMACHINE-05 | P2 | Retention/lock-snapshot failure after the SIGNED commit returns an error to the client and leaves no lock record or custody outcome; nothing reconciles it | merged into ET-ACQ-03: Same root cause: one-shot post-commit steps are skipped permanently when the retention/lock-snapshot step throws. |
| statemachine:STATEMACHINE-06 | P2 | Finalize streams/hashes all originals and calls the TSA inside a 120s DB transaction, and checks the size limit only after hashing parts; large resumable uploads (sessions allow 50 GiB, evidence max 1 GiB) can never finalize and every retry re-reads the whole object | merged into ET-ACQ-04: Same defect: size limit checked after hashing inside the 120s finalize transaction. |
| statemachine:STATEMACHINE-09 | P3 | Direct-capture discard releases a reservation with an unguarded update(WHERE id) after reading status without the evidence lock; it can soft-delete a record that concurrently became SIGNED and append a false 'no content committed' custody event | merged into ET-DC-01: The discard side of the same discard-vs-complete race. |
| statemachine:STATEMACHINE-10 | P3 | Abandoned uploads are never cleaned: stuck CREATED/UPLOADING rows have no terminal state, orphan-scan is read-only, multipart reaper runs only via external cron call, and a lost initiate race leaks an untracked S3 multipart | merged into ET-ACQ-02: Same root cause: no terminal state or reaper for CREATED/UPLOADING rows. |

## Dispositioned questions

| key | disposition | question | answer |
|---|---|---|---|
| acquisition:4.1 | SOURCE_PROVEN_CORRECT | Is client-supplied sha256 trusted as authority? | Not on the web or intake presign paths. The client checksum only signs the S3 PUT precondition. fileSha256 is recomputed on the server from the stored object version at completion. |
| acquisition:4.2 | SOURCE_PROVEN_CORRECT | Can finalize be run twice? | No. Finalize holds an advisory lock, returns early on SIGNED, and claims the row with an updateMany limited to CREATED\|UPLOADING. FAILED_HASH_MISMATCH is refused with 409. The fire-once side effects after commit are a separate problem (see ACQ-03). |
| acquisition:4.3 | SOURCE_PROVEN_CORRECT | What is the scope and lifetime of a presigned URL? | The server builds the key from the evidence id (evidence/<id>/...) and sanitizes the filename. The URL is valid for 600s and ContentType is signed. Content-Length is not signed, so the size limit is only enforced after the object has been hashed (ACQ-04). |
| acquisition:4.4 | SOURCE_PROVEN_CORRECT | Does every Evidence creation write a custody event? | Yes. The single creator writes EVIDENCE_CREATED, IDENTITY_SNAPSHOT_RECORDED and UPLOAD_AUTHORIZED in the same transaction as the insert. The seed scripts are the exception (ACQ-9). |
| acquisition:4.5 | SOURCE_PROVEN_DEFECT | Can a caller-supplied teamId create Evidence without membership proof? | No foreign workspace: createEvidence requires an ACTIVE TeamMember row and returns 403 otherwise. But membership status is the only check. Role, access expiry and org lifecycle are not evaluated (ACQ-01). |
| commercial:14.1 | SOURCE_PROVEN_CORRECT | What exactly does the FREE limit count? | Lifetime count (no window) of the owner's personal Evidence rows where deletedAt IS NULL and lifecycleState != DESTROYED, across teamId NULL and the personal team id. It does NOT filter status, so CREATED/UPLOADING drafts, uploaded-but-never-completed, FAILED_HASH_MISMATCH, ARCHIVED, ON_HOLD rows all count. TRASHED rows do not (TRASH sets deletedAt). It counts records, not reports/credits/finalizations. A multi-file/multipart capture or an intake session is ONE Evidence row with EvidenceParts, so it consumes one slot. |
| commercial:14.2 | SOURCE_PROVEN_DEFECT | When is a slot consumed (create vs finalize)? Reservation/release? | Admission is checked at CREATE (createEvidence -> assertWorkspaceAllowsEvidenceCreation) and the row itself occupies the slot from insert. Funding is SETTLED at COMPLETE (settleEvidenceCompletionFunding) under a per-subject advisory lock, counting only rows created before this one (createdAt,id cursor). No explicit reservation: a draft that is never completed keeps its slot until the user trashes it; nothing auto-releases it (orphan-scan is read-only; capture-reaper expires the CaptureSession but never the reserved Evidence). |
| commercial:14.3 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | Is enforcement transactional or check-then-insert? Concurrent at 2/3? | Creation is check-then-insert with NO lock: two concurrent creates at 2/3 both read count=2 and both insert (4 rows). Completion is serialized: pg_advisory_xact_lock on 'evidence-capacity:personal:<user>' then priorRecordCount over rows created BEFORE the settling row. Deterministic outcome at 2/3 with no credit: the earlier-created record settles PLAN (prior=2); the later-created one gets 402 INSUFFICIENT_EVIDENCE_CREDITS at completion regardless of which completes first, after its bytes were uploaded. It stays UPLOADED/CREATED forever and keeps counting. So the cap holds for FINALIZED records, but the loser's uploaded bytes and slot are stranded. [Runtime: RT-COMMERCIAL: concurrent creates |
| commercial:14.4 | SOURCE_PROVEN_CORRECT | Enforced on every creator path? Intake bypass? Admin bypass? | Yes: createEvidence is the only Evidence insert in api/worker src and every ingress (POST /v1/evidence, direct-capture reserve for extension/Android/iOS/continuous, external intake) calls it. Intake counts against the link CREATOR's personal allowance/wallet (ownerUserId = link.createdByUserId); intake link creation on FREE requires >=1 credit (resolveWorkspaceIntakeEntitlement) but the submission still needs admission+settlement. No email/admin bypass exists in the gate; admins can only grant credits via ADMIN_GRANT. |
| commercial:14.5 | SOURCE_AND_RUNTIME_PROVEN_CORRECT | UI/API message at the 4th record | 409 code FREE_LIMIT_REACHED, publicMessage 'You have reached the record limit included in the Free plan: 3 records. Existing records remain available — buy evidence credits or upgrade to add more.' The evidence route matches on the code and returns it; web has FREE_LIMIT_REACHED in lib/feedback/error-code-registry.ts. If a credit exists the 4th is admitted instead and the credit is spent at completion. [Runtime: RT-COMMERCIAL: 409 FREE_LIMIT_REACHED with the exact public message.] |
| commercial:14.6 | SOURCE_PROVEN_CORRECT | Deterministic examples | 0/3,1/3,2/3: create admitted (count<3), complete settles PLAN; FREE outputs NOT_ENTITLED (no report/package), TSA+OTS still run. 3/3 with no credit: 409 FREE_LIMIT_REACHED at create. Concurrent at 2/3: both created, earlier-createdAt completes PLAN, later gets 402 at completion (stranded upload). Failed third (upload abandoned or FAILED_HASH_MISMATCH): still counts; account reads 3/3 with 2 usable records until the user trashes it. Deleted (trashed): releases the slot immediately; RESTORE_FROM_TRASH performs no cap check, so trash->create->restore yields >3 active FREE records (see COMMERCIAL-02). Archived: still counts. Intake at limit: submission refused at createOrLoadExternalEvidence wit |
| commercial:15.1 | SOURCE_PROVEN_CORRECT | When does PRO become authoritative? Redirect vs webhook? Delayed/duplicate webhooks? | Only when a provider ACTIVE subscription fact is applied through syncPlanForSubscription (verified webhook customer.subscription.*, Stripe checkout.session.completed settlement that re-reads the subscription from Stripe, PayPal server-read, return/re-check routes, reconciliation sweep). PayPal TRIALING (unapproved) grants nothing; client redirect alone grants nothing. Activation serialized per payer with advisory lock; duplicates collapse (status equal -> setPersonalPlan idempotent); older observations refused by decideSubscriptionStatusWrite. BUT the ordering stamp can be poisoned by reconciliation (COMMERCIAL-01). |
| commercial:15.2 | OWNER_DECISION_REQUIRED | Are existing FREE records processed automatically after upgrade? | Partially. The worker first-issuance reconciliation (Decision A) issues FIRST report+package for SIGNED/ACTIVE records with no report only when resolveOutputIssuanceEntitlement returns ENTITLED with mayIssueHistoricalFirstOutputs (confirmed ACTIVE non-trial subscription). An activation pass serves subjects whose Subscription.activatedAtUtc is within 7 days. But records signed more than 7 days ago are skipped unless OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED=true, which defaults OFF (not present in any .env.example). So a FREE user upgrading with records older than a week gets no automatic report for them; the customer can click Generate (API precheck only requires decision ENTITLED) or an oper |
| commercial:15.3 | SOURCE_PROVEN_CORRECT | Retroactive TSA/OTS? New versions? | Not needed: RFC3161 TSA is requested inside every completion and OTS anchoring is requested after commit for every finalized record regardless of plan/funding. Upgrade does not create new report versions; the reconciler never forces regeneration (forceRegenerate:false). |
| commercial:15.4 | SOURCE_PROVEN_CORRECT | Unknown plan state ever substituted with FREE or PRO? Consistent across web/api/worker? | Worker personal scope substitutes FREE when no active entitlement row exists (entitlement?.plan ?? FREE) -> NOT_ENTITLED FREE_PLAN rather than UNRESOLVED; API ensureEntitlement creates a FREE row. Lifecycle reader substitutes ACTIVE (paid) when a paid plan has NO subscription row at all (documented, for contract/webhook lag). Read failures -> UNRESOLVED in both hosts (shared readCommercialLifecycle + shared resolveOutputIssuanceEntitlement). Worker re-resolves plan, funding and lifecycle at job time (processor.ts:2177), never from a payload snapshot. Residual inconsistency: completion decides shouldEnqueueReport with plan+funding only (no lifecycle); the worker then refuses with commercial t |
| commercial:15.5 | OWNER_DECISION_REQUIRED | Race: processing under wrong plan | A record completed under PRO whose report job runs after the CANCELED fact is refused (REPORT_NOT_INCLUDED_IN_PLAN, FAILED_TERMINAL, class COMMERCIAL -> supersedable on re-upgrade). A record completed under FREE and upgraded later is served by first-issuance. Funding is fixed at settlement (ledger row), so a credit-funded record keeps its outputs forever. Whether an output 'earned' at completion under PRO should survive a downgrade before the job runs is policy. |
| commercial:16.1 | SOURCE_AND_RUNTIME_PROVEN_CORRECT | CENTRAL: a FREE user with three evidence records buys one credit — which evidence becomes unlocked/processed? | NONE of the existing three. There is no retroactive application: the only CONSUMPTION writer is settleEvidenceCompletionFunding inside a NEW record's completion transaction, and resolvePersonalEvidenceAdmission spends the plan allowance first (count < cap -> PLAN) and a credit only when the allowance is exhausted. The three existing records keep funding PLAN (no ledger row) and stay NOT_ENTITLED (no report/package). The credit is spent by the 4th record at its completion, which becomes EVIDENCE_CREDIT-funded and earns report+package even on FREE. Allocation is deterministic by (createdAt,id) order of non-trashed rows, not array order. Edge: if one of the 3 is an uncompleted draft, completing |
| commercial:16.2 | SOURCE_PROVEN_DEFECT | Credit purchase semantics: grant idempotency, consumption atomicity, refund | Grant: transaction increments entitlements.credits and writes a PURCHASE ledger row, idempotent on (provider, providerRef). Consumption: conditional updateMany credits>=1 plus UNIQUE evidenceId ledger insert, inside the completion tx (rollback-safe, per-record idempotent). Refund: PayPal refunds/reversals remove unspent credits (REVERSAL row, shortfall to review). Stripe has NO refund/dispute handling for credits (COMMERCIAL-03). Credits never expire. |
| commercial:17.1 | SOURCE_PROVEN_CORRECT | PRO->FREE / cancel / expire: evidence never destroyed? read/download? new captures? | No plan transition deletes or relabels evidence; setPersonalPlan only writes plan/teamSeats/legacyRecordCapOverride. Downgrade to a capped plan freezes legacyRecordCapOverride = existing count when above the plan cap, so a PRO user with 50 records moving to FREE keeps cap 50 (no new free records until below it). /v1/evidence/:id/original and /verification-package downloads have no plan/lifecycle gate. Issued reports are not revoked. Paid jobs are not cancelled but re-check entitlement at run time. |
| commercial:17.2 | OWNER_DECISION_REQUIRED | Failed renewal / grace / past-due-expired | PAST_DUE keeps plan PRO; lifecycle GRACE until currentPeriodEnd+7d (outputs for new records, no historical first issuance), then PAST_DUE_EXPIRED: mutationsAllowed=false. assertCommercialLifecycleAllowsPaidMutation runs FIRST in the creation gate, so the account cannot create ANY evidence — not the FREE-equivalent allowance and not with purchased credits — until the provider finally cancels (plan -> FREE) or pays (COMMERCIAL-04). |
| commercial:17.3 | SOURCE_PROVEN_CORRECT | Pending settlement / chargeback / refund of subscription | Pending (PayPal TRIALING, Stripe open checkout) grants nothing. PayPal subscription refund/chargeback records a review item and re-reads the subscription; entitlement changes only when the provider reports CANCELED. Disputes change nothing. Stripe subscription refunds/disputes are not handled at all (no charge.* events). |
| commercial:17.4 | SOURCE_PROVEN_CORRECT | Worker checks resolved entitlement? Stale snapshot unlock? | Yes. Report and package paths call resolveEvidenceOutputIssuance (live plan + ledger funding + shared lifecycle) at job time; UNRESOLVED is retryable, never granted. No plan snapshot travels on the job. The only stale-state unlock found is at the SUBSCRIPTION ordering layer (COMMERCIAL-01), not in the worker. |
| commercial:17.5 | SOURCE_PROVEN_CORRECT | Workspace transfer | No route moves an evidence record to another workspace: team/org 'transfer-ownership' (teams.routes.ts:3707, organizations.routes.ts:2108) changes the owner, not Evidence.teamId. The one reassignment path is the case-detach side effect that NULLs teamId (SEC-02, P0). Credit funding is keyed by evidenceId (ledger evidence_id UNIQUE) and survives any move; the worker refuses a request whose record's workspace no longer matches (BLOCKED_POLICY, recoverable). Lead-verified by grep of services/api/src/routes for transfer/move routes. |
| custody:5.1 | SOURCE_PROVEN_CORRECT | Is the custody chain cryptographically linked, and at what scope? | Per-evidence chain: sequence + prevEventHash + eventHash, sha256 over canonical JSON of {v:1,evidenceId,sequence,eventType,atUtc,payload,prevEventHash}. Serialised by pg_advisory_xact_lock(hashtext(evidenceId)) and @@unique([evidenceId,sequence]). Unkeyed (no HMAC/signature) so it detects naive edits only; ip and userAgent columns are outside the hash. |
| custody:5.2 | SOURCE_PROVEN_DEFECT | Is append-only enforced by the database? | No. No trigger, rule or REVOKE protects custody_events or admin_audit_logs; append-only is convention. See CUSTODY-04. |
| custody:5.3 | SOURCE_PROVEN_DEFECT | Timestamp authority for custody/audit rows? | App clocks throughout. custody atUtc = caller-supplied or new Date() on the API, worker or shared-runtime host; admin audit createdAt = new Date() on the API or worker host. DB now() only fills custody created_at, which neither the hash nor the timelines read. Report issuance events carry prepared.now, captured before rendering, so a lower sequence can have a later atUtc (CUSTODY-06). |
| custody:5.4 | SOURCE_PROVEN_CORRECT | Are the finalization, report, package, OTS, integrity-rejection, lifecycle and destruction events written in the same transaction as the mutation? | Yes for UPLOAD_COMPLETED/SIGNATURE_APPLIED/TIMESTAMP_* (finalize tx), REPORT_* / REVIEW_READY / VERIFICATION_PACKAGE_GENERATED (worker tx under reservation guard), OTS init/upgrade, INTEGRITY_REJECTED_HASH_MISMATCH, archive/trash/restore (lifecycle tx) and EVIDENCE_PURGED (tombstone tx). Retries are idempotent through state claims (finalize status guard, reservation stage, otsProofBase64-null claim, status claim). |
| custody:5.5 | SOURCE_PROVEN_DEFECT | Which material mutations record custody only best-effort, or not at all? | Best-effort after commit, and silently swallowed: publication state, legal hold place/release, destructive-gate blocks, finalization-policy refusal, case export download, retention sweeper, chain transfer, certification request/attest/revoke, user lock, claim, EVIDENCE_COMPLETED. NOT recorded at all: unlock; original-byte URL issuance in the parts listing, record views and public verify; redaction publish and derivatives; reviewer workflow decisions (kept in separate unhashed tables); retention auto-extension; exchange package creation and delivery; WORKSPACE-scope legal holds; chain transfer (always fails). |
| custody:5.6 | SOURCE_PROVEN_DEFECT | Do reports and packages record which evidence version and hash they were built from? | Partly. REPORT_GENERATED carries pdfSha256 and custodyThroughSequence; VERIFICATION_PACKAGE_GENERATED carries reportVersion and reportSha256; Report rows carry s3VersionId and custodyThroughSequence. Neither the Report row nor REPORT_GENERATED stores the evidence fileSha256 or fingerprintHash; they rely on evidence digest columns never changing, and no DB trigger guards them. The PACKAGE_FOR_VERSION path selects custody by atUtc, not by custodyThroughSequence (CUSTODY-06). |
| custody:5.7 | SOURCE_PROVEN_CORRECT | Is there a custody chain verifier, is it run, and what does Verify show when broken? | Yes. evaluateCustodyChain runs on every authenticated record view and every public verify request over the FULL chain. A broken chain sets overallIntegrity=false and returns custodyChainValid=false with mode and reason; the summary text becomes 'One or more recorded integrity checks did not pass. Manual review is recommended'. A chain where no row carries any hash is reported valid in mode 'legacy', and an empty chain is valid in mode 'empty'. The admin audit chain verifier runs on demand only. |
| custody:5.8 | OWNER_DECISION_REQUIRED | Actor derivation (human vs System) in custody? | Custody rows have no actor column. The actor is an ad-hoc payload key (actorUserId, lockedByUserId, completedByUserId, uploadedByUserId, placedByUserId, releasedByUserId), or absent for worker and sweeper events. Customer projections (custody tab and public verify) show no actor at all. In admin audit, actorType is derived as HUMAN/WORKER/SERVICE/SYSTEM/UNKNOWN_LEGACY, and worker rows are WORKER, not a person. |
| custody:5.9 | SOURCE_PROVEN_DEFECT | requestId / IP / UA policy? | Custody rows have no requestId. They store raw req.ip and raw UA, unhashed and never read back. Admin audit masks ip/UA columns, but auditEvidenceAction puts raw ipAddress/userAgent into hashed metadata (38 call sites). The tenant/platform audit facade never fills the requestId column. See CUSTODY-14. |
| intake:2.B.1 | SOURCE_PROVEN_CORRECT | Are intake tokens high-entropy, hashed at rest, with expiry/revocation/use-limit enforced? | Yes: pwi_v1_ + 32 random bytes, HMAC-SHA256 at rest, constant-time compare, REVOKED/expired/usedCount checked on every public route. The use-count increment is not atomic (INT-09). |
| intake:2.B.2 | SOURCE_PROVEN_CORRECT | Can an intake link be rebound to another workspace/case/evidence by the caller? | No. Team, creator and customer come from the link row; no body field rebinds; sessions must belong to the link and parts to session.evidenceId. |
| intake:2.B.3 | SOURCE_PROVEN_CORRECT | Can an external submitter read other evidence? | No read/download route exists for contributors; portal/review surfaces have no ingestion. |
| ots:7.1 | SOURCE_PROVEN_CORRECT | Digest submitted and identical to intended evidence/version/manifest digest? | The initializer stamps the UTF-8 bytes of Evidence.fingerprintCanonicalJson (the signed canonical fingerprint, which embeds fileSha256/part hashes). `ots stamp` hashes the file with SHA-256, so the committed digest = sha256(fingerprintCanonicalJson) = Evidence.fingerprintHash (API computes sha256Hex(canonical), crypto.ts sha256 of utf8 string). otsHash is stored as that same sha256 (contentHash). It is the fingerprint digest, not the raw file digest; binding to the original is indirect via the signed fingerprint. fingerprintCanonicalJson has a single writer (finalize), so it cannot drift after stamping. |
| ots:7.10 | SOURCE_PROVEN_CORRECT | Worker restart? | Delayed/waiting jobs persist in Redis. A crash mid-job is handled by BullMQ stalled-job recovery; initialization is safe to re-run (proof-null guard; a lost stamp just re-stamps). A crash after the init DB write loses nothing new because the init follow-up is never scheduled anyway (OTS-01). |
| ots:7.11 | SOURCE_PROVEN_DEFECT | Lost queue job? | NULL-status rows: recovered by the init reconciler (30 min..30 days, every 5 min). PENDING rows (and FAILED rows): nothing scans them; a lost/collapsed/dropped follow-up leaves the row PENDING with no job. Only manual: admin queue replay of a FAILED job (step-up) or scripts. |
| ots:7.12 | SOURCE_PROVEN_DEFECT | Can proof remain Pending forever without escalation (incident? max age?) | It can remain PENDING forever: the 30-day budget only fires on a CONCLUSIVE pending observation made by a running job, and with no job (OTS-01/02) no observation happens. Escalation exists but is not a recovery: evidence_integrity.ots_pending_aged opens WARNING at 24h / HIGH at 72h (never CRITICAL), with READ_ONLY_GUIDANCE that claims the ladder is still running and offers no action. |
| ots:7.13 | SOURCE_PROVEN_CORRECT | Is Bitcoin attestation verified LOCALLY (block header lookup) or trusting calendar/library upgrade result? | In the shipped image: NOT verified against block headers. `ots verify -d` needs a Bitcoin node; the worker image installs only opentimestamps-client, so verify errors and the anchor is established from `ots info` offline parsing (BitcoinBlockHeaderAttestation present + file hash match + txid), recorded as anchorCheck=PROOF_STRUCTURE and labelled 'chain not checked'. The text-only upgrade heuristic was removed from the upgrade classifier but still exists in the initializer (OTS-05). BITCOIN_VERIFIED is only reachable with a Bitcoin node. |
| ots:7.14 | SOURCE_PROVEN_CORRECT | Attestation checked against the exact digest? | Yes against Evidence.otsHash: verify is run with `-d <otsHash>`, and the info branch requires `File sha256 hash` == otsHash; a mismatch is terminal PROOF_HASH_MISMATCH. The processor trusts the stored otsHash (does not recompute from fingerprintCanonicalJson); public verify separately compares otsHash to fingerprintHash (hashMatches). |
| ots:7.15 | SOURCE_PROVEN_DEFECT | Malformed proof rejection? | Missing OpenTimestamps magic header -> terminal FAILED MALFORMED_PROOF (offline, before invoking the binary). A proof with a valid header but corrupt body that `ots info` cannot parse is classified TRANSIENT_ERROR, retried 20 times, then the job fails and the row stays PENDING (OTS-06). |
| ots:7.16 | SOURCE_PROVEN_CORRECT | Does Verify page independently validate or trust DB status? | Trusts DB. /public/verify/:id returns ots.status/anchorClaim computed by resolveOtsAnchorClaim over stored columns plus hashMatchesFingerprintHash (DB-to-DB compare); technicalMaterials exposes only otsProofPresent, not the bytes; the web badge renders the server claim (otsTone -> otsClaimBadge). No proof parsing or chain check on the verify path. Claim vocabulary is honest (green only for BITCOIN_VERIFIED+txid). |
| ots:7.17 | SOURCE_PROVEN_CORRECT | Raw proofs included in packages? | Yes: opentimestamps-proof.ots (raw bytes) plus opentimestamps.json companion, and fingerprint.json (the exact stamped bytes). The companion's verificationHint command is wrong (OTS-07). |
| ots:7.18 | SOURCE_PROVEN_CORRECT | Report wording submitted vs anchored? | Report callout derives from resolveOtsAnchorClaim: VERIFIED 'Anchored and verified'; ANCHORED_NOT_CHECKED 'Anchored — chain not checked'; PENDING 'Pending … proof material is present, but Bitcoin anchoring had not completed'; FAILED prints raw failureReason. PENDING rows carrying a txid are not promoted. `buildAnchorPublicationSummary` (which would label any txid as anchored) is dead code (0 callers). |
| ots:7.19 | OWNER_DECISION_REQUIRED | OTS/TSA disagreement presentation? | No code compares OTS anchor time/digest with TSA genTime/imprint; the two are presented as independent layers ('This anchoring layer is independent from RFC 3161 timestamping'). OTS commits to fingerprintHash while TSA may commit to fileSha256 or fingerprint (tsaInputKind), so a digest-level disagreement cannot be represented; no disagreement state exists. |
| ots:7.2 | SOURCE_PROVEN_CORRECT | Initial .ots stored? | Yes. After stamp the proof file is read, base64'd and written to Evidence.otsProofBase64 (plus otsHash/otsCalendar/otsStatus) in a transaction guarded by `otsProofBase64: null`, with an OTS_APPLIED/OTS_FAILED custody event. If `ots stamp` itself fails, FAILED is written with proofBase64 NULL. |
| ots:7.20 | SOURCE_PROVEN_DEFECT | What does Recovery do for OTS? | runLifecycleRecovery (5-min interval, cron lock) calls runOtsInitializationReconciler, which only enqueues rows with otsStatus NULL and proof NULL aged 30 min..30 days. It writes no OTS column. It does nothing for PENDING or FAILED rows. Operator remediation: ots_failure -> RESUME (requestEvidenceOtsAnchoring); ots_pending_aged and ots_initialization_stalled -> READ_ONLY_GUIDANCE only. |
| ots:7.21 | SOURCE_PROVEN_CORRECT | Can Recovery create duplicate jobs/proof rows? | No. Proof lives in Evidence columns (no proof-row table); jobs use the deterministic `ots-upgrade-<id>` id and collapse onto live jobs; the initializer write is proof-null guarded so concurrent reconciler/API/job runs store one proof and one custody event. Worst case is an extra calendar stamp that is discarded ('raced'). |
| ots:7.22 | BLOCKED_FIXTURE_CAPABILITY | Fixture .ots files usable for runtime probes, and exact probes for pending/upgrade/invalid proof | No real .ots fixtures exist in the tree. Probes that need no binary/network: (a) PENDING/UPGRADE/INVALID classification: import { parseOtsInfoOutput, classifyOtsResult, parseOtsUpgradeOutput } from 'services/worker/src/ots-upgrade-output.ts' with synthetic `ots info` text ('File sha256 hash: <otsHash>' + 'PendingAttestation(\'https://a.pool.opentimestamps.org\')' for pending; + 'BitcoinBlockHeaderAttestation(953006)' and '# transaction id <64hex>' for upgraded; a different hash for mismatch). (b) Full processor: reuse the harness in services/worker/test/ots-upgrade-processor.behaviour.test.ts (MAGIC header line 19; PROOF_V1/V2) calling processOtsUpgrade from services/worker/src/ots-upgrade.p |
| ots:7.3 | SOURCE_PROVEN_CORRECT | Bound to evidence version? | Bound to the Evidence row (columns on Evidence), not to a version/report row. Evidence has one fingerprint written once at finalize, so the proof is bound to the finalized record; there is no per-version OTS. Reports/packages snapshot the row's OTS state at issuance and are not re-issued when OTS changes (ots-upgrade.processor.ts:653-660). |
| ots:7.4 | SOURCE_PROVEN_CORRECT | Calendar selection? | Single configured URL OTS_CALENDAR_URL (prod compose: https://a.pool.opentimestamps.org, an aggregator) passed as `-c <url> -m 1`; if unset, the ots client defaults apply. No app-level multi-calendar redundancy or fallback. |
| ots:7.5 | SOURCE_PROVEN_CORRECT | Response merge? | No application-level merge. The ots CLI performs stamp/upgrade in place on the proof file; the worker reads back the whole file and replaces otsProofBase64 wholesale (CAS-guarded). |
| ots:7.6 | SOURCE_PROVEN_CORRECT | Upgrade idempotency? | Yes at the row level: decideOtsTransition returns NO_CHANGE for already-recorded anchors and invalid proofs; the processor early-exits for checked anchors, legacy anchors with txid and permanent failures; every write is compare-and-set against the snapshot (status, txid, anchoredAt, upgradedAt, anchorCheck, failureReason). |
| ots:7.7 | SOURCE_PROVEN_CORRECT | Concurrent upgrades overwriting proof? | Guarded. Initialization uses updateMany WHERE otsProofBase64 IS NULL; upgrades use updateMany WHERE <full OTS snapshot> (otsUpgradedAtUtc changes on every write, so a stale observation loses and is discarded). Job ids are deterministic `ots-upgrade-<evidenceId>` (collapse onto live) plus a deterministic `-next-` id for self follow-ups. Covered by the behaviour test that runs the real processor against an in-memory CAS row (services/worker/test/ots-upgrade-processor.behaviour.test.ts:49-60). |
| ots:7.8 | SOURCE_PROVEN_CORRECT | Retry schedule? | Thrown errors (init transient OtsInitializationTransientError; upgrade TRANSIENT_ERROR -> 'OTS_UPGRADE_ATTEMPT_FAILED') use BullMQ TIMESTAMP_AUTHORITY: 20 attempts, exponential backoff from 60s. Successful PENDING observations re-enqueue a 60-minute follow-up. Budget: 30 days from earliest OTS custody event. |
| ots:7.9 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | Is a 60-minute follow-up actually scheduled? | Only on the upgrade branch after a CAS-won PENDING write (delayMs 60*60*1000, selfJobId). It is NOT scheduled after initialization: the init branch enqueues without selfJobId while running as `ots-upgrade-<id>`, so enqueueCanonicalJob finds its own active job and collapses (OTS-01). The self-follow-up also uses a deterministic `-next-` id that collides with its own retained completed job on the 3rd hop and is silently dropped by BullMQ (OTS-02). [Runtime: RT-OTS-QUEUE: no follow-up is scheduled from the init branch; the ladder dies at hop 3.] |
| package-verify:10.1 | SOURCE_PROVEN_CORRECT | Exact package contents | See inventories.packageContents: ~50 fixed-name entries plus sanitized evidence part names; seal + seal signature appended last and excluded from the index by design. |
| package-verify:10.10 | OWNER_DECISION_REQUIRED | Redaction: which bytes go into the package? | Only ORIGINAL evidence parts (all parts, including private-role parts) plus the report; redaction derivatives are never included (derived-manifest is lineage-only). The package is an owner/authorized download gated by evaluateArtifactDownload. |
| package-verify:10.11 | SOURCE_PROVEN_DEFECT | PII / sensitive leakage in package | Intended owner export carries submitter email (non-intake) or linkCreatorEmail (intake), customerId, ownerUserId, teamId, organizationId, GPS (capture-context.json and the signed fingerprint), certification attestorEmail. Unintended: signers/historical-verification-material.json publicMaterialRef leaks server filesystem path of the public key or kms:<KMS_KEY_ID> (possibly an ARN with account id) (PKGV-11). No custody ip/userAgent (select excludes them). |
| package-verify:10.12 | SOURCE_PROVEN_DEFECT | Can a recipient verify the package WITHOUT trusting PROOVRA DB? | Partially. (a) Original hash: yes - fingerprint.json (signed) + per-file sha in checksums; recompute SHA-256 of evidence files. (b) Signature: verifiable with included public-key.pem, but key authenticity needs PROOVRA (RICH Public Verify shows the evidence key PEM; BASIC does not). (c) Package seal: verifiable only against the self-asserted package-manifest-public-key.pem; PROOVRA publishes no fingerprint anywhere public, so the seal gives no third-party tamper evidence (PKGV-02). (d) TSA: token included, TSA CA chain not included (third-party CA). (e) OTS: proof included when present; verifiable with `ots verify -f fingerprint.json` (hint omits -f). (f) Custody chain: NOT verifiable - payl |
| package-verify:10.2 | SOURCE_PROVEN_CORRECT | Manifest determinism / canonical serialization / ordering | Not deterministic and not canonical: every JSON entry uses JSON.stringify(v,null,2) and embeds new Date() (generatedAtUtc), so rebuilding yields different bytes. Checksum index sorted with locale-sensitive localeCompare. Only package-seal.json uses canonicalize (sorted keys). Verification hashes exact bytes, so non-determinism does not break verification, but two packages for the same report are never byte-identical. |
| package-verify:10.3 | SOURCE_PROVEN_DEFECT | Is the manifest signed, with what key; key provenance, rotation, public key shipped? | package-manifest.json is Ed25519-signed (local PEM via PACKAGE_SIGNING_PRIVATE_KEY_PATH/SIGNING_PRIVATE_KEY_PATH or AWS KMS ED25519_SHA_512 RAW) by signPackageManifestDigest; the same signer signs package-seal.json. The public key is shipped inside the package (package-manifest-public-key.pem) and is self-asserted. Revocation is checked per job via signer_control_state keyed by an env-derived label (assertWorkerSignerUsable). Rotation = env change; no published registry/fingerprint endpoint exists for recipients (only authenticated /v1/operations/signers). |
| package-verify:10.4 | SOURCE_PROVEN_CORRECT | Does the signed manifest cover the report PDF (built before report appended)? | Still TRUE for package-manifest.sig: the manifest is built/signed at 2896-2998 before reports/*.pdf (3315) and package-checksums.json (3555); it covers only hasReportArtifact:true, not the bytes. SUPERSEDED for format-5 packages: package-seal.json binds SHA-256 of package-checksums.json and reportSha256, signed after all entries. Only one caller (processor.ts:4394) and it always passes seal, so new packages are format 5. But README HOW TO VERIFY still points at the weaker package-manifest.sig and never mentions the seal (finding PKGV-03). |
| package-verify:10.5 | SOURCE_PROVEN_CORRECT | Path traversal / duplicate names / unicode in entry names; user filenames as entry names? | Evidence entry names derive from user title/originalFileName but pass sanitizeFileBaseName (NFKD, strip diacritics, [^a-zA-Z0-9]+ -> "-", lowercase) plus a mapped extension and, for multipart, an order prefix: no traversal, no unicode, multipart names unique. Report name is fixed by the worker then normalizeFileName (strips / and \). Residual: single-file names at root can collide with fixed names when no capture/upload timestamp exists (PKGV-15). |
| package-verify:10.6 | SOURCE_PROVEN_CORRECT | Zip safety / partial cleanup | Archive streams to a private mkdtemp file through HashingMeter; any archive/meter/out error calls fail() which removes the temp dir; size-vs-meter mismatch rejects. Streamed parts are re-hashed in-flight and a digest/size mismatch errors the archive. Published-but-unrecorded S3 objects are left as immutable orphans (single-use keys). Minor: succeed() catch path rejects without cleanup. |
| package-verify:10.7 | SOURCE_PROVEN_CORRECT | Package hash / tenant binding / idempotency / regeneration | packageSha256 = incremental SHA-256 of the ZIP, verified by PutObject ChecksumSHA256 + HEAD read-back, stored in verification_packages.package_sha256 but never exposed to recipients (not on Public Verify). Tenant binding: parts come from the evidence row; commit under pg_advisory_xact_lock(evidenceId) with report baseline re-check and @@unique([evidenceId, version]); PackageAlreadyCommittedError on races. |
| package-verify:10.8 | SOURCE_PROVEN_CORRECT | Staging->promote Object Lock checksum path | Staging PUT + CopyObject promote removed. publishImmutableArtifact does one PutObject with ChecksumSHA256, IfNoneMatch *, ObjectLockMode/RetainUntil in the same request, then HEAD by VersionId with ChecksumMode ENABLED comparing size, sha256, lock mode, retain-until. verification-package-staging.ts only survives for HashingMeter/cleanup and a reconcileStaleStaging sweep. |
| package-verify:10.9 | SOURCE_PROVEN_DEFECT | Legal hold / governance gate | Eligibility gate (hold, lifecycle, destruction review, immutable drift) runs ONLY for team_governed (teamId && isPersonalTeam === false). Personal workspaces and records whose Team row is unresolved (isPersonal null) skip it entirely (PKGV-08). Gate denial persists {blocked:true,...} to evidence.verificationPackageMetadata. |
| package-verify:11.1 | SOURCE_PROVEN_DEFECT | Token generation, entropy, storage, hashing | There is no separate token: the public URL segment is the evidence primary key (Postgres gen_random_uuid(), UUIDv4, 122 random bits) generated at row creation, stored raw as the PK, embedded in report QR codes (REPORT_VERIFY_BASE_URL/<id>), packages, S3 keys, audit logs and internal URLs. |
| package-verify:11.10 | SOURCE_PROVEN_CORRECT | QR destination | Report QR encodes REPORT_VERIFY_BASE_URL (default https://app.proovra.com/verify)/<evidenceId>; build-view-model accepts a provided URL if its last segment is >=12 chars. |
| package-verify:11.11 | SOURCE_PROVEN_DEFECT | Paths converting unavailable data into verified/healthy | Yes: storage protection DB snapshot is returned with verified:true and immutable without checking retain-until expiry or object existence, rendered "Immutable Storage Locked" and counted as a passed signal; Package Integrity "Complete / Independent Review Enabled" from filename presence; BASIC "sealed (every file... bound by one signature)" without any key anchor. Pending OTS is correctly rendered pending; TSA failed rendered partial. |
| package-verify:11.2 | SOURCE_PROVEN_DEFECT | Expiry, revocation, rotation, one-time vs reusable, binding | No expiry, reusable forever, no rotation possible (PK). Revocation only by the whole-record publicVerifyState transitions (UNPUBLISHED/SUSPENDED) via governance routes; re-publishing restores the same URL. Default state is PUBLISHED unless workspace requirePublicationApproval. Bound to evidence only; not version- or recipient-bound (PKGV-07). |
| package-verify:11.3 | SOURCE_PROVEN_DEFECT | Anti-enumeration 404 uniformity | Non-UUID, missing, trashed, destroyed, soft-deleted, unpublished and hash-mismatch all return identical 404 {message:"Evidence not found"}. Non-uniform: 409 EVIDENCE_NOT_FINALIZED (with status) for published unfinalized records, 404 "Evidence not signed", 503 for missing signing key. The lifecycleState DESTROYED check at 12541 is dead code (field not selected; where-clause already excludes). [Runtime: RT-VERIFY/ENUM: unknown and malformed ids both 404 with Cache-Control no-store.] |
| package-verify:11.4 | SOURCE_PROVEN_CORRECT | Rate limits | Two Redis buckets (memory fallback): per trusted client IP 30/60s and per evidence 60/60s; per-evidence bucket consumed only after UUID parse. A second-bucket exhaustion by any party locks all viewers of that record out (PKGV-18). |
| package-verify:11.5 | SOURCE_PROVEN_DEFECT | Cache-Control, robots/noindex, referrer | API sets Cache-Control: no-store on every answer (12257, again 13753). Web: client page, no noindex meta, no robots.txt, no X-Robots-Tag anywhere in apps/web for /verify; Referrer-Policy same-origin in middleware. |
| package-verify:11.6 | SOURCE_PROVEN_CORRECT | Does the public GET overwrite evidence.verificationPackageMetadata (erase blocked:true)? | No longer true at this SHA: the backfill was removed; the ZIP inspection result is returned only in the response. When metadata is {blocked:true} isVerificationPackageMetadata() is false and the route inspects the ZIP central directory read-only. |
| package-verify:11.7 | SOURCE_PROVEN_DEFECT | Does GET cause writes / side effects? | Yes: (1) platform audit row verification.page_opened on every outcome incl. 404/429 (with IP/UA); (2) fire-and-forget evidence.update lastPublicVerifyViewAtUtc; (3) verification_views row with raw ipAddress + userAgent per successful view, no retention sweep; (4) VERIFY_VIEWED custody event appended to the hash chain at most once per 24h (debounce read is racy); (5) S3 range reads of the package ZIP when metadata absent; (6) Redis rate-limit counters. None mutate package/governance state. |
| package-verify:11.8 | OWNER_DECISION_REQUIRED | Data minimization / actor-IP privacy / downloads | submittedByEmail always null publicly; workspace/org names hidden unless PUBLIC_VERIFY_EXPOSE_ATTRIBUTION. RICH still exposes title, previews (report embedded data URLs), precise GPS captureContext, attestor names/orgs, custody access timeline. Original presigned URLs only when policy allows download AND export eligibility ALLOWED (preview_only default -> none). Viewer IP/UA are stored, not displayed. |
| package-verify:11.9 | SOURCE_PROVEN_CORRECT | Tabs | Actual tabs: Record, Integrity, Package Integrity, Custody Chain, Access Activity (there is no "Forensic Custody"/"Technical Materials" tab; technical materials are a section fed by technicalMaterials incl. publicKeyPem). Package Integrity badge is presence-derived (PKGV-05); Integrity verdict uses snapshot trust decision + DB self-consistency checks (PKGV-06). |
| queues:8.1 | SOURCE_PROVEN_DEFECT | Does every producer map to a consumer and every consumer to a producer or schedule? | No. 15 BullMQ queues/15 workers are 1:1 registered, but only 10 of 15 jobs have a production producer. mi-exif, mi-search-index, graph-domain-sync, graph-timeline-sync and org-health-refresh have consumers and no producer (6 worker enqueue helpers exported with zero callers). report-dlq has producers and no consumer (by design); media-intelligence-dlq has neither. All 19 registered sweeps are started. |
| queues:8.2 | SOURCE_PROVEN_CORRECT | Do queue payloads carry caller-controlled tenant/authority? | No for canonical jobs. Producers can only set commandId/traceId (buildCanonicalJobPayload); consumers decode via decodeCanonicalJobPayload which rejects unknown keys and flags authority-shaped fields; every consumer re-derives the workspace from the named durable row. Legacy pre-Point-5 payloads are drained with authority fields discarded. report-dlq is a raw diagnostic payload with no consumer. |
| queues:8.3 | SOURCE_PROVEN_CORRECT | Is the durable row committed before enqueue (no ack-before-durable-write)? | Yes for report (ReportGenerationRequest created then enqueued outside tx), redaction (row QUEUED before enqueue), derived asset (row upserted PENDING first), MI (run row inserted first). OTS/purge use the Evidence row itself. Enqueue never throws; failure leaves the row for a reconciler - except derived assets (no reconciler) and OTS PENDING (no reconciler). |
| queues:8.4 | SOURCE_PROVEN_CORRECT | Can a report retry create a second Report row or a second custody event? | No. Version is reserved under pg_advisory_xact_lock on the request row; a retry of a REPORT_COMMITTED request routes to PACKAGE_FOR_VERSION; the custody events, Evidence update and Report.create are in ONE commit transaction that re-checks the reservation and the (evidenceId,version) uniqueness; losing commit throws REPORT_RESERVATION_LOST_RETRY leaving only an unreferenced immutable object. |
| queues:8.5 | SOURCE_PROVEN_DEFECT | Stuck after worker crash - which sweep recovers each family? | Report: lease 15m released by lifecycle-recovery then re-enqueued (recovers ~20m). MI runs: 20m lease released by intelligence-run reconciler. Redaction: NOT recovered (RENDERING has no lease reclaim). OTS: stalled job is re-run by BullMQ, but a PENDING row whose follow-up was lost is never re-enqueued. Derived asset: no reconciler. Purge: trash-grace hourly. Exchange package: 30m ON CONFLICT lease. Redis cron lock TTL fixed 10m, no renewal, fail-open on Redis error. |
| queues:8.6 | SOURCE_PROVEN_CORRECT | Races between report/package/TSA/OTS jobs; stale evidence version? | Report and package share one request and the per-evidence advisory lock; OTS writes are compare-and-set on the full OTS snapshot (a stale observation is discarded). The report renders the Evidence OTS columns as of issuance and is not regenerated when OTS later anchors (the 'ots_upgrade_completed' purpose has no producer). TSA is not queued. Report claim blocks on governance policy-version change (BLOCKED_STALE). |
| queues:8.7 | SOURCE_PROVEN_DEFECT | Infinite retry / infinite recovery loops? | BullMQ attempts are bounded everywhere (max 20 for OTS). But two reconciler loops are unbounded: MI runs of kinds that never write the run row are re-enqueued every 10 min forever (QUEUES-03), and every semantic chunk aged 30min-30d is re-enqueued every 10 min because the owed predicate reads a column nobody writes (QUEUES-10). Report requests are bounded by REPORT_RECONCILE_MAX_ATTEMPTS=12. |
| queues:8.8 | SOURCE_PROVEN_DEFECT | Are workers prevented from claiming jobs until secrets/signer/object-lock are verified? | Only the report worker (autorun:false, started after validatePackageSignerAtStartup). The other 14 workers autorun on construction at module load and 4 sweeps are started at import, before initSecretsAuthority, signer validation and object-lock bootstrap. |
| queues:8.9 | SOURCE_PROVEN_DEFECT | Does the registry's per-job timeoutMs bound a single attempt? | No. RetryPolicy.timeoutMs is declared but never passed to BullMQ nor enforced by any processor; long attempts are bounded only by per-call timeouts (e.g. ots execFile timeout) and by DB leases. |
| recovery:13.1 | SOURCE_PROVEN_CORRECT | Which failure does each recovery control recover? | The ONE customer endpoint POST /v1/evidence/:id/reports/regenerate (and the Operations 'Recover report or package' action, which calls the same requestOutputRecovery) recovers exactly the missing or failed output decided server-side: package only beside an existing report (PACKAGE_RECOVERY), the report+package pair when no report exists (FULL_GENERATION), or re-enqueue of a FAILED_RETRYABLE request as itself. 'Retry after exhausted failure' supersedes a TECHNICAL FAILED_TERMINAL only. 'Resume OTS anchoring' re-runs the OTS upgrade job. TSA has no recovery. Automatic: first-issuance/package sweep, stranded-request reconciler, OTS init reconciler. |
| recovery:13.10 | SOURCE_PROVEN_CORRECT | TSA succeeded but package failed? | TSA is written once at finalize and never touched by the report job. A package failure after the report committed leaves the report (and its TSA-backed content) intact; the request stays non-SUCCEEDED and recovery builds only the package for that version from the stored report bytes. No new TSA token. |
| recovery:13.11 | SOURCE_PROVEN_CORRECT | Package succeeded but UI never saw it? | Handled: the stranded-request reconciler marks a PROCESSING (expired lease) / FAILED_RETRYABLE request SUCCEEDED 'reconciled_artifact_present' only when the report AND the package at the same version exist (or the package is not owed); the UI reads artifact rows, not the request, so a committed package appears on the next /artifacts/status poll regardless. If the final SUCCEEDED write was lost the reconciler records it without re-running. |
| recovery:13.12 | SOURCE_PROVEN_DEFECT | OTS pending vs failed? | Distinct: PENDING continues the self re-enqueue ladder (ots_pending_aged is READ_ONLY guidance); inconclusive checks record OTS_ATTEMPT_ERROR without demotion; FAILED is written only for PROOF_INVALID or BUDGET_EXHAUSTED. 'Resume OTS anchoring' is offered for ots_failure conditions, including permanent proof failures where it does nothing (RECOVERY-06); the budget-exhausted WORKER incident has wrong guidance and never auto-resolves (RECOVERY-02). |
| recovery:13.13 | SOURCE_PROVEN_CORRECT | Worker offline? | API still returns ENQUEUED (row QUEUED, job in Redis); nothing claims it. The reconciler lives in the worker, so no sweep runs while it is down; visibility comes from platform.worker_heartbeat_stale. UI: evidence detail flags stale-pending after its budget; Reports stops polling after 10 minutes. If Redis is down instead, outcome QUEUE_UNAVAILABLE with honest copy and the reconciler re-enqueues later. |
| recovery:13.14 | SOURCE_PROVEN_CORRECT | Recovery timeout? | Claim lease 15 min (registry claim.leaseMs); an expired PROCESSING lease is reclaimable in the claim predicate and released to FAILED_RETRYABLE by the reconciler; BullMQ ARTIFACT policy 5 attempts / 10 min timeout; durable ceiling 12 claims then FAILED_TERMINAL + incident. Note BullMQ files a 'retry budget exhausted' HIGH incident at attempt 5 while the durable budget (12) keeps retrying (RECOVERY-10). |
| recovery:13.15 | SOURCE_AND_RUNTIME_PROVEN_CORRECT | Repeated clicks race? | Safe. Client busy flags; server key REPORT:<id>:v<N> / VERIFICATION_PACKAGE:<id>:v<N> is a unique column, the P2002 loser reuses the winner; BullMQ jobId is deterministic in request id and live jobs collapse; claim is a conditional updateMany; supersede ordinals race onto the same :s<n> key. Rate limits (60/user, 10/record per hour for recovery) bound abuse. [Runtime: RT-RECOVERY: two concurrent RECOVER calls returned the same requestId; one QUEUED request row.] |
| recovery:13.16 | SOURCE_AND_RUNTIME_PROVEN_CORRECT | Idempotency key? | Recovery: server-derived idempotencyKey (artifact:evidence:vN[:force][:sN]) with a unique index; no client key is needed or sent. NEW_VERSION: mandatory caller Idempotency-Key/clientRequestKey (8-80 chars), replay returns the first request. OTS: jobId ots-upgrade-<evidenceId>. [Runtime: RT-RECOVERY: same clientRequestKey twice -> ALREADY_ACTIVE, same requestId.] |
| recovery:13.17 | SOURCE_PROVEN_DEFECT | Honest progress? | Customer surfaces: yes - typed outcome (ENQUEUED/ALREADY_ACTIVE/QUEUE_UNAVAILABLE/TERMINAL/...) with bounded copy, progress from server pollIntervalMs. Operations: partly - OTS resume reports QUEUED when the enqueue collapsed onto a live job and when the worker will no-op (RECOVERY-01, RECOVERY-06); web ops page loses server message on 409/503 (RECOVERY-05); queue retry of terminal report job reports success (RECOVERY-08). |
| recovery:13.18 | SOURCE_PROVEN_CORRECT | Success shown only after authoritative reread? | Yes on customer surfaces (web evidence detail, Reports, mobile): the click toast only acknowledges the request; READY is shown from re-read /artifacts/status or the list. Web Operations falls back to an optimistic 'Accepted and queued.' if the response lacks a remediation body (operations/page.tsx:1239-1241) - a presentation fallback only. |
| recovery:13.19 | SOURCE_PROVEN_CORRECT | Reports KPI updates after recovery? | Web Reports re-reads the summary right after the request and again when no visible row is live any more; polling is bounded to 10 minutes, after which the KPI updates only on manual refresh. Mobile Reports row re-reads list and counters after each request. |
| recovery:13.2 | SOURCE_PROVEN_CORRECT | Report vs package vs TSA vs OTS vs storage? | Report and package: one request model (ReportGenerationRequest) with artifactType REPORT\|VERIFICATION_PACKAGE and run modes NEW_REPORT / PACKAGE_FOR_VERSION. TSA: explicitly NO_SAFE_REMEDIATION_AUTHORITY; report/package recovery never contacts TSA. OTS: separate ots-upgrade queue keyed by evidence id; report job no longer creates or schedules OTS. Storage: package publication refusal is terminal and escalated; original 404 is terminal EVIDENCE_ORIGINAL_NOT_FOUND. |
| recovery:13.20 | SOURCE_PROVEN_DEFECT | Audited? | Customer route: every accepted/blocked/denied/failed request audited (evidence.report.regenerate_requested). Workspace Operations: tenant audit for every answer, incident event on QUEUED; outcome mapping records ALREADY_SATISFIED/ALREADY_IN_PROGRESS as 'error'. Platform admin: audit outcome 'success' even for NOT_ELIGIBLE/REFUSED (RECOVERY-07). Worker sweeps: machine principal on the request row + logs, no audit row at request time. Communications retry: no audit (RECOVERY-09). |
| recovery:13.21 | SOURCE_PROVEN_DEFECT | Escalation after terminal failure? | Report/package: non-retriable -> DLQ + CRITICAL incident; durable budget exhausted -> FAILED_TERMINAL + HIGH incident (PACKAGE vs REPORT source chosen by stage); customer sees ESCALATED_TO_OPERATOR; operator supersede requires operations.resolve + reason (not reachable from mobile - RECOVERY-04). Incidents auto-resolve from source truth (report/package presence). OTS budget exhausted -> CRITICAL WORKER incident that can never auto-resolve and offers no action (RECOVERY-02). TSA -> guidance only. |
| recovery:13.22 | SOURCE_PROVEN_CORRECT | Feature flags defaults; UI buttons that do nothing when OFF? | OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED and OUTPUT_PACKAGE_RECOVERY_ENABLED default OFF (only literal 'true' enables) and gate ONLY the worker's automatic backfill (first issuance for records signed >7 days ago; package recovery sweep). No UI reads them and every manual control (customer Generate/Recover/Retry, Operations recover/supersede, platform recover) works independently of them, so no button silently depends on a flag. LIFECYCLE_RECOVERY_ENABLED defaults true. PACKAGE_RECOVERY_BACKFILL_EXECUTE gates the CLI executor. None are present in any .env.example. |
| recovery:13.3 | SOURCE_PROVEN_CORRECT | Does recovery diagnose first? | Yes for report/package: requestOutputRecovery loads facts (latest report, package at that version, latest requests, eligibility, hold, lifecycle, permission) and derives the action before acting; the worker re-derives tenancy, org status, policy version and pair completeness before running. OTS resume diagnoses only 'already ANCHORED/UPGRADED' before queueing (not permanent proof failure - RECOVERY-06). |
| recovery:13.4 | SOURCE_PROVEN_CORRECT | Does it rerun successful components? | No. A retry after REPORT_COMMITTED resumes as PACKAGE_FOR_VERSION; package-only recovery embeds the stored report after verifying pdf_sha256 / stored checksum and skips the provisional render; if the pair already exists the run returns without work. Report re-render only occurs before commit, at the same reserved version. |
| recovery:13.5 | SOURCE_AND_RUNTIME_PROVEN_CORRECT | Can recovery charge twice / consume another credit? | No. Evidence credits are consumed only in consumeEvidenceCreditForCompletion (completion transaction), idempotent on the unique evidence_id ledger row; no recovery path or worker module calls it. Recovery only reads funding. Storage: each retried package publication that got published-but-unrecorded leaves an immutable orphan object (storage cost, not a credit), and the allowance gate runs before each upload. [Runtime: RT-RECOVERY: no credit-ledger rows after four RECOVER calls.] |
| recovery:13.6 | SOURCE_AND_RUNTIME_PROVEN_CORRECT | Can recovery produce duplicate reports/packages/timestamps? | Reports: no - version reservation under pg_advisory_xact_lock, own reservation reused on retry, commit re-checks (evidence_id,version) and reservation. Packages: no DB duplicate - pre-publish existence check + PackageAlreadyCommittedError; a concurrent loser may leave an unreferenced immutable orphan object. Timestamps: TSA never re-requested; OTS single job id per evidence. Requests: unique idempotency key collapses concurrent clicks and worker sweeps. [Runtime: RT-RECOVERY: report count stayed 1; one package request.] |
| recovery:13.7 | SOURCE_PROVEN_CORRECT | Same evidence version? | Package recovery targets exactly the latest report version (customer/operator) or the version named in the incident fingerprint (platform operator) and embeds the stored report of that version; it never hands out an older package or mints a new report. An updated report (N+1) is only the explicit NEW_VERSION action with reason and key. |
| recovery:13.8 | SOURCE_PROVEN_CORRECT | Does recovery reset terminal state incorrectly? | No for report/package: markRequestTerminal only writes over non-terminal rows; a terminal head is never re-run - the writer creates a NEW row (:s<n>) only for commercially-obsolete, cleared recoverable-blocked, or operator-superseded TECHNICAL terminals; the worker replays terminal rows as no-ops. OTS: FAILED(budget) can become ANCHORED on a later proven anchor, or PENDING via 'recovered_from_failed_attempt' only when the budget is no longer exhausted; permanent proof failures never change. |
| recovery:13.9 | SOURCE_PROVEN_CORRECT | Original object missing? | A store 404 on the original becomes terminal non-retryable EVIDENCE_ORIGINAL_NOT_FOUND; nothing is built from other bytes; job goes to DLQ with a CRITICAL report incident; the customer sees a dedicated 'Original unreadable - under operator review' note. It classifies TECHNICAL, so an operator can supersede once the object is restored. |
| reports:12.1 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | Do KPI cards and table come from the same population/query? | Yes for population: both use finalizedPopulation(workspaceEvidenceWhere(teamId)) (SIGNED\|REPORTED, deletedAt null, not TRASHED/PENDING_DESTRUCTION/DESTROYED), same NULL-team personal arm, no date window, no cap on the summary (batched 1000), list take 25 with total counted over the same where. Every filtered card equals count(finalized AND lifecycleWhere(filter)). Divergences are in the STATE vocabulary, not the population: failed requests on records that already have a report (REPORTS-01) and BLOCKED requests (REPORTS-02). [Runtime: RT-REPORTS: same population, but a failed updated-report request is counted READY not FAILED.] |
| reports:12.2 | SOURCE_PROVEN_CORRECT | What renders when the KPI fetch fails? | Summary failure (network or server exception) sets status unavailable and the page shows 'Summary is temporarily unavailable. The artifact list below remains usable.' — never zeros or 'no failures'. Cards render only fields that are numbers. The same notice is shown while the summary is still loading (initial state is 'unavailable') and permanently on the user-scoped fallback path (REPORTS-05). |
| reports:12.3 | SOURCE_PROVEN_CORRECT | Report vs package distinction in rows; recovery controls reread authoritatively? | Each row carries separate report and package lifecycle + server-projected actions per output; the POST names the output; after any request the page re-reads summary and list (never optimistic) and polls at server pollIntervalMs (max 10 min). |
| reports:9.1 | SOURCE_PROVEN_CORRECT | Trace UI request -> route -> authorization -> plan check -> request record -> job -> worker. | Reports row posts POST /v1/evidence/:id/reports/regenerate {intent, output}. Route checks resolveEvidenceOperationAccess(permission evidence.generate_report), refuses FAILED_HASH_MISMATCH, rate-limits, then requestOutputRecovery -> requestReportGeneration which re-resolves entitlement (report AND package both required for REPORT) and calls createReportGenerationRequest (durable QUEUED row keyed REPORT:<evidence>:v<latest>[:force]) then enqueueCanonicalWork(GENERATE_REPORT, commandId=requestId). Worker processGenerateReport -> resolveAndClaimReportRequest (tenant cross-check, org ACTIVE, policy-version stale check, legal hold only for forceRegenerate, atomic claim) -> runReportGeneration (re- |
| reports:9.2 | SOURCE_PROVEN_CORRECT | Is a report bound to an exact evidence version + hash and unable to silently switch versions? | Evidence content is single-version (fingerprint/fileSha256 fixed at completion); the Report row is keyed (evidenceId, version) with pdfSha256 + s3VersionId, and downloads presign that VersionId. Version N is reserved on the request row (stage REPORT_RESERVED) and re-confirmed at commit under an advisory lock; package-only recovery verifies stored bytes against pdf_sha256 before embedding. /report/latest always serves the newest version (by design). Minor: the HEAD existence check ignores s3VersionId. |
| reports:9.3 | SOURCE_PROVEN_CORRECT | Can the report say verified when TSA/OTS pending/invalid? | Persisted TSA status values are only STAMPED/FAILED/null (timestamp.service.ts). TSA FAILED is a 'partial' signal (3/15) that caps the score below the 90% VERIFIED_FINALIZED threshold, so the report reads 'Recorded integrity verified with supporting limitations' and 'Trusted timestamp could not be obtained'. OTS PENDING -> 'Recorded integrity verified; Bitcoin anchoring pending'. OTS FAILED/hash mismatch -> anchoring 'failed'. The TSA wording for STAMPED is 'Trusted timestamp token recorded' (not 'verified'). Residual: ANCHORED-but-not-chain-checked OTS scores as 'passed' and can yield VERIFIED_FINALIZED wording (REPORTS-09, P3). |
| reports:9.4 | SOURCE_PROVEN_CORRECT | QR target correctness. | QR encodes REPORT_VERIFY_BASE_URL + '/' + evidenceId (default https://app.proovra.com/verify/<uuid>); the web /verify/[token] page calls /public/verify/:id which parses a UUID evidence id. The QR therefore targets the LIVE public verification of the record, not the report version snapshot; no tenant id is carried. |
| reports:9.5 | SOURCE_PROVEN_CORRECT | Timezone / generated-at / actor identity. | All report timestamps are formatted via formatTimestampForReportUtc and labelled UTC; generatedAtUtc = prepared.now at render and persisted on the Report row; submitter identity is snapshotted (submittedByEmailSnapshot/AuthProvider). |
| reports:9.6 | SOURCE_PROVEN_CORRECT | Access vs custody separation. | Downloads append REPORT_DOWNLOADED custody events, but the report's custody model classifies events into forensic vs access categories and the forensic count/summary use only the forensic set. |
| reports:9.7 | SOURCE_PROVEN_DEFECT | Legal hold wording in the report. | The PDF's only legal-hold statement is the storage row 'Legal Hold: <S3 object-lock legal hold status \| OFF>'. S3 object-lock legal hold is deliberately not implemented (ON refused at boot), so this always prints OFF even when a canonical evidence legal hold is ACTIVE. The canonical-store lifecycle summary section exists but has zero production callers. |
| reports:9.8 | SOURCE_PROVEN_CORRECT | Regeneration / supersession semantics. | Idempotency key is per (artifactType, evidence, baseline report version, force). A terminal head is only superseded (':sN') when commercially obsolete, a recoverable blocker cleared, or an operator supersedes a TECHNICAL terminal. Retries resume from stage REPORT_COMMITTED as PACKAGE_FOR_VERSION so a retry never mints a second report. Updated reports are a separate reasoned NEW_VERSION intent with required reason + idempotency key; Reports page never offers it. |
| reports:9.9 | SOURCE_PROVEN_CORRECT | Can a failure render as success at request level? | Package failures are carried out of the swallow and thrown (retryable or terminal) so a request is not SUCCEEDED with a missing owed package; governance denials are modelled separately. The SUCCEEDED write records the newest report id rather than the run's own (REPORTS-07, P3). |
| security:18.1 | SOURCE_PROVEN_CORRECT | Are there route aliases with different authorization on the evidence lifecycle? | No. workspace-alias rewrites /v1/workspaces->/v1/teams before routing (same handler); deprecated-alias wraps the same handler for 4 admin/ops GETs with identical preHandler. No v0/unversioned evidence routes except /public/verify/:id. Real duplicate authorities are elsewhere: two evidence read gates (SEC-03), two case detach services (SEC-02/16), two upload auth families (SEC-25). |
| security:18.2 | SOURCE_PROVEN_DEFECT | Web vs API entitlement/pricing tables disagree? | Only the pricing page FREE storage add-on row (SEC-23); otherwise web/mobile read the API catalog. |
| security:18.3 | SOURCE_PROVEN_DEFECT | Worker-local plan rule copies? | No worker-local plan table; worker imports shared PLAN_CAPABILITIES. But plan-only vs lifecycle-aware owed-output predicates coexist in worker and API (SEC-20) and storage population differs (SEC-22). |
| security:18.4 | SOURCE_PROVEN_DEFECT | Multiple ready/status/verification aggregators? | Yes: verified headline vs live checks (SEC-10); five backlog aggregators (SEC-20); stale integrity snapshot (SEC-21). |
| security:18.5 | SOURCE_PROVEN_CORRECT | Multiple recovery orchestrators / duplicate queue consumers? | Recovery sweeps composed under one cron lock; operator paths reuse the same request authority with deterministic jobIds; one consumer per queue. Duplicate reaper exists only for capture drafts (SEC-24). |
| security:19.1 | SOURCE_PROVEN_CORRECT | Cross-tenant upload/finalization possible? | Refuted: upload session binds evidenceId to proven teamId; completeEvidence loads by id+ownerUserId; parts require record access + owner in tx; keys server-derived. Intra-tenant part injection into signed evidence exists (SEC-08). |
| security:19.10 | SOURCE_PROVEN_DEFECT | Membership re-proof on lifecycle routes? | Canonical routes re-prove via evaluateMemberAccess; ~30 legacy-gated routes, the download gate role lookup, list, reports list and capture create check status only (SEC-03), and case grants/creator bypass membership (SEC-04/05). |
| security:19.2 | SOURCE_PROVEN_CORRECT | Cross-tenant report/package generation or recovery? | Refuted: regenerate uses canonical resolveEvidenceOperationAccess (404); worker re-derives workspace from DB and refuses mismatch (report-generation-authority.ts:179-205); exchange builder reads teamId from package row. |
| security:19.3 | SOURCE_PROVEN_DEFECT | Verify-token access? | Public verify keyed by evidence UUID, rate-limited, PUBLISHED-only, PII redacted, original only via export gate; 409 status oracle for unfinalized records (SEC-31); headline false-verified (SEC-10). |
| security:19.4 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | Case association to another tenant's case? | Refuted for team cases (evaluateCrossTeamAttach strict equality + service re-check). NULL/NULL exception via case-workspace evidence-links (SEC-09). [Runtime: RT-TENANCY/SEC-09.] |
| security:19.5 | SOURCE_PROVEN_CORRECT | Intake link rebound? | Refuted: target workspace from link row found by token hash; sessions checked session.intakeLinkId === link.id. |
| security:19.6 | SOURCE_PROVEN_CORRECT | External reviewer reading unrelated evidence? | Refuted: grant scope validated at issuance; portal access through resolveWorkflowInGrantScope. |
| security:19.7 | SOURCE_PROVEN_CORRECT | Platform admin acting in wrong workspace? | admin-evidence-ops is intentionally cross-tenant read-only with DB-confirmed platform admin and no storage keys; operations-recovery requires membership in named team; evidence.routes has no admin bypass. |
| security:19.8 | SOURCE_PROVEN_CORRECT | Worker trusts payload tenant ids? | Refuted for report, OTS, exchange: payload carries request/evidence/package id only; tenancy re-derived from DB. |
| security:19.9 | SOURCE_PROVEN_CORRECT | Prisma undefined-teamId (no filter) holes? | None on lifecycle routes: conditional spreads are audit metadata, platform-admin, system sweeps, or dead helpers (SEC-34). The real NULL-team hazard is code WRITING teamId:null (SEC-02) and NULL==NULL equality (SEC-09). |
| security:20.1 | SOURCE_PROVEN_DEFECT | Two finalize requests | Safe against double sign/charge (advisory lock + conditional updateMany + ledger unique); REPORTED repeat re-runs fan-out (SEC-11). |
| security:20.2 | SOURCE_PROVEN_DEFECT | Finalize + delete | Trash does not take the evidence lock; finalize claim lacks deletedAt predicate (SEC-12). |
| security:20.3 | SOURCE_AND_RUNTIME_PROVEN_CORRECT | Two recovery clicks / report / package requests | Safe via idempotency keys, deterministic jobIds, reserve/commit + unique version. Residual: lease fencing (SEC-30), exchange lease race (SEC-27), pointer regression (SEC-29). [Runtime: RT-RECOVERY.] |
| security:20.4 | SOURCE_PROVEN_CORRECT | TSA retry vs original / two OTS upgrades | TSA single call inside finalize tx, no retry path. OTS CAS on full snapshot; custody on win only. |
| security:20.5 | SOURCE_PROVEN_CORRECT | Credit purchases / last credit | Safe: partial unique indexes, grantRef unique, webhook ids unique, conditional decrement + count. Question: multi-active entitlements (Entitlement has no unique on userId). |
| security:20.6 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | Legal hold vs destruction | RACE: hold verdict computed before claim, not re-read (SEC-01, P0); restore during destruction (SEC-06). [Runtime: RT-TENANCY/SEC-01.] |
| security:20.7 | OWNER_DECISION_REQUIRED | Plan webhook vs worker / downgrade during job | Plan checked at claim and render, not at commit; finalize uses pre-lock plan snapshot. Treated as policy question. |
| statemachine:3.1 | SOURCE_PROVEN_CORRECT | What do 'created', 'uploaded', 'finalized' mean? | CREATED is written and immediately overwritten to UPLOADING in the SAME createEvidence transaction, so no committed row normally rests in CREATED (except adapters that reserve differently). UPLOADING = a key has been reserved and a presigned PUT will be issued after commit; it says nothing about bytes. UPLOADED is a dead enum value: no writer sets it anywhere in services/api, services/worker or packages (only readers). 'Finalized' = SIGNED, written by the single finalize claim after the server HEADs and fully GET-streams every original (by the HEAD's VersionId), computes SHA-256, signs the fingerprint and requests an RFC3161 token, all inside one transaction. REPORTED = a report version has  |
| statemachine:3.2 | SOURCE_PROVEN_CORRECT | When do original bytes become immutable, by what call? | Only when S3_OBJECT_LOCK_ENABLED=true. Then the Object Lock mode + retain-until are part of the presigned PutObject command (so every uploaded VERSION is locked at PUT time), CreateMultipartUpload carries the same defaults, and after the finalize commit applyRetentionOrThrow issues PutObjectRetention BY KEY (no VersionId), then HEADs BY KEY and snapshots the result onto the row. Before that commit nothing prevents a new version being written at the same key: the presigned PUT URL stays valid for up to 600s (clamped <=900s) after issuance, and the part-presign route re-issues a PUT URL for an existing part key while status is not SIGNED/REPORTED. Immutability of 'what was signed' therefore re |
| statemachine:3.3 | SOURCE_PROVEN_CORRECT | When does chain of custody begin? | At row creation, before any byte exists: EVIDENCE_CREATED, IDENTITY_SNAPSHOT_RECORDED and UPLOAD_AUTHORIZED are appended in the createEvidence transaction. Byte-level custody (UPLOAD_COMPLETED with server fileSha256, SIGNATURE_APPLIED, TIMESTAMP_*) is appended inside the finalize transaction; EVIDENCE_LOCKED or STORAGE_PROTECTION_UNAVAILABLE after commit (can be missing entirely if the post-commit step throws). |
| statemachine:3.4 | SOURCE_PROVEN_DEFECT | Which states are terminal? | status: FAILED_HASH_MISMATCH is terminal by intent (finalize refuses it; integrity helper only enters it) but the report-commit writer can overwrite it in a race (STATEMACHINE-02). REPORTED is sticky (no writer moves it backward except to FAILED_HASH_MISMATCH). lifecycleState: DESTROYED is terminal by table (governance-lifecycle.ts:63) but writers are check-then-write (STATEMACHINE-04). Destruction never changes `status`, so a destroyed tombstone still says SIGNED/REPORTED; readers must consult lifecycleState/destroyedAtUtc. No terminal state exists for abandoned uploads: CREATED/UPLOADING rows are never moved anywhere. |
| statemachine:3.5 | SOURCE_PROVEN_DEFECT | What happens to partial records / who cleans abandoned multipart uploads? | Evidence rows stuck in CREATED/UPLOADING are never transitioned or deleted; services/worker/src/orphan-scan.ts is explicitly read-only (logs counts). capture-reaper.ts only expires DRAFT CaptureSession rows and 'Never deletes or modifies any Evidence'. Single-shot PUT objects uploaded but never completed stay in the bucket indefinitely (and, with Object Lock, locked for the retention window). Native S3 multipart uploads are aborted by reapStaleMultipartUploads, which is DB-driven (only sessions with multipart_upload_id recorded) and reachable only from POST /v1/ops/reconcile (cron-secret; no in-repo scheduler). No bucket lifecycle rule (AbortIncompleteMultipartUpload) exists in the repo. An  |
| statemachine:3.6 | SOURCE_PROVEN_DEFECT | Can the DB claim success while storage is incomplete? | Not for SIGNED: the finalize tx HEADs and fully hashes every object before the claim. But (a) the post-commit retention/lock-snapshot step can throw after SIGNED is committed, returning an error to the client while the DB says SIGNED, with no lock snapshot and no EVIDENCE_LOCKED/STORAGE_PROTECTION_UNAVAILABLE event and no OTS/report request from this call (reconcilers later cover OTS and report, nothing re-applies/records the lock); (b) completeStorageMultipart persists completion then creates the bridge EvidencePart in a swallowed try/catch — the storage object exists without a part row. Both are recorded in STATEMACHINE-05. |
| statemachine:3.7 | SOURCE_PROVEN_DEFECT | Can storage succeed while DB failed? | Yes, by design and without cleanup: any uploaded original whose /complete never succeeds (client abandons, tx timeout, checklist refusal, EVIDENCE_TOO_LARGE after hashing) remains in the bucket under evidence/{id}/...; the row stays UPLOADING forever. Destruction enumerates evidence/{id}/ by prefix, so trashing+destroying the row would reach them, but nothing trashes stuck rows. |
| statemachine:4.1 | SOURCE_PROVEN_CORRECT | Which bytes are hashed, and is the multipart assembled object re-hashed server-side? | The ORIGINAL stored bytes, streamed from S3 (never a transformed derivative). Single file: fileSha256 = SHA-256 of the object version the HEAD described. Multi-part (EvidencePart rows): each part hashed; fileSha256 = sha256(partHashes.join('\|')) and multipartManifestSha256 = sha256(partHashes.join('\n')). A native S3 multipart object IS re-hashed server-side as a whole object by completeEvidence (it is bridged as an EvidencePart); the ETag is never used as a hash (fingerprint etag: null). The worker re-hashes the same versions at report time and compares to fileSha256. |
| statemachine:4.2 | SOURCE_PROVEN_DEFECT | Is the version ID persisted and used? | Persisted since 2026-09-29 (Evidence.storageVersionId, EvidencePart.storageVersionId) from the HEAD used for hashing. Used by the worker re-hash, the authenticated original download (evidence.routes.ts:11517) and per-part download (:6236). NOT used by buildPublicEvidenceContent viewUrl (evidence.routes.ts:3767, :3906 — the params type has no version field), by applyObjectRetention / post-commit HEAD snapshot, by archive-tier CopyObject/Restore, nor by verifyCompletedObject. See STATEMACHINE-03. |
| statemachine:4.3 | SOURCE_PROVEN_CORRECT | Object key tenant binding; can a client choose the key? | No. Keys are server-built: evidence/{serverUUID}/original-{sanitizedBasename}, evidence/{id}/parts/{NNN}-{sanitizedName}, evidence/{id}/multipart/{sessionUUID}/object (UUID-validated). The client influences only the sanitized filename suffix. Keys are bound to the evidence id, not the team; tenant isolation is by authorization before presign. |
| statemachine:4.4 | SOURCE_PROVEN_CORRECT | Destruction path and download after destruction | Single executor: claim (CAS) -> eligibility recompute -> inventory every version under row keys + evidence-owned prefixes -> refuse if any version retained/held -> DeleteObject by VersionId -> re-list and refuse certificate on survivors -> tombstone (storageKey null) + child rows deleted + EVIDENCE_PURGED. Downloads after destruction have no key to presign. Residual risk: a report commit racing the executor can recreate reports/{id}/ objects and a Report row after the certificate (STATEMACHINE-02). |
| statemachine:4.5 | SOURCE_PROVEN_CORRECT | Presigned URL TTLs | Evidence/part PUT: 600s requested, clamped to [60,900] by S3_PRESIGN_EXPIRES_SECONDS logic. Multipart UploadPart: default 300s, cap 900s. GET (download/view): 600s. Sessions: 1h default expiry. |
| statemachine:4.6 | SOURCE_PROVEN_DEFECT | Integrity-rejection path | rejectEvidenceIntegrity is called ONLY from the report worker's prepareReportArtifacts (processor.ts:2384 multipart, :2423 single). The declared sources 'worker.reconciler' and 'api.completion' have zero callers. Records whose plan/funding never produces a report are never re-hashed after finalize, so storage drift on them is never detected (they stay SIGNED). The helper itself is sound: CAS on status IN (SIGNED,REPORTED)+deletedAt null, custody + security event in one tx, idempotent. |
| tsa:6.1 | SOURCE_PROVEN_CORRECT | Exact digest submitted | Evidence.fileSha256: for single-file evidence the SHA-256 of the streamed S3 object (version-pinned); for multipart (>1 part) a synthetic SHA-256 over the per-part hex digests joined with '\|' (parts ordered by partIndex asc). NOT the fingerprint hash, NOT the Ed25519 signature, NOT multipartManifestSha256. So the TSA token does not bind the fingerprint/metadata/signature. |
| tsa:6.10 | SOURCE_PROVEN_DEFECT | Trusted root / pinning policy | None. No TSA CA bundle env var, no pinning, no provider allow-list; TSA_* vars are absent from .env.example and from the secrets authority. TLS server auth relies on curl defaults only if TSA_URL is https (scheme not enforced). |
| tsa:6.11 | SOURCE_PROVEN_DEFECT | Policy OID checked | No. No reqPolicy in request, policy OID in reply ignored; EvidenceIntegritySnapshot.tsaPolicyOid is always null (API stub; the 'worker-side ASN.1 parser' the comment references does not exist). |
| tsa:6.12 | SOURCE_PROVEN_CORRECT | genTime semantics / timezone | Parsed from openssl's printed 'Time stamp: Mon DD HH:MM:SS[.frac] YYYY GMT' via new Date(); GMT so UTC; stored timestamptz. Unparseable -> null with warning, row still STAMPED (report then shows no RFC3161 time while status reads 'Trusted timestamp token recorded'). Accuracy/ordering ignored. Fractional-seconds formats are an untested parse path. |
| tsa:6.13 | SOURCE_PROVEN_CORRECT | Raw token bytes stored | Yes: the full TimeStampResp DER (not just the TimeStampToken) base64 in Evidence.tsaTokenBase64, on STAMPED and on parser-side FAILED (not-granted, imprint mismatch); '' on provider/subprocess failure. |
| tsa:6.14 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | Can an invalid/mismatched token be stored as SUCCESS | YES. (a) Any response whose openssl text says Granted with a matching imprint is STAMPED with zero signature/chain/nonce/policy checks — a forged, self-signed, replayed or test-TSA response (or a MITM on a plain-http TSA_URL) becomes 'Trusted timestamp token recorded' (TSA-01). (b) A granted PKIStatus with NO timeStampToken (openssl prints 'TST info: Not included.') has no 'Message data' block -> imprint null -> granted -> STAMPED with no serial/genTime and no token content; read-side then reports imprint 'matches' (TSA-02/TSA-03). An explicit imprint MISMATCH is correctly FAILED, but its bytes then ship in the package as timestamp.tsr 'Included' (TSA-04). [Runtime: RT-TSA: an untrusted toke |
| tsa:6.15 | SOURCE_PROVEN_DEFECT | Timeout | Per-subprocess execFile timeout TSA_TIMEOUT_MS (default 20s) x3 sequential steps (up to ~60s) executed INSIDE the finalize Prisma transaction (timeout 120s) while holding a pg advisory lock and a pooled connection. curl has no --connect-timeout/--max-time. A killed process yields 'Command failed: ...' (no 'timeout' text), so the tsa_provider_timeout classification effectively never fires (TSA-07). |
| tsa:6.16 | SOURCE_PROVEN_CORRECT | 4xx/5xx/malformed ASN.1 | curl --fail -> non-zero exit -> catch -> FAILED with classified reason (substring heuristics over the whole error message, which includes argv: URL, username:password, temp paths; digits in those can drive classification). Malformed DER -> `openssl ts -reply -text` exits non-zero -> catch -> FAILED, token bytes discarded ('' stored). Finalize still succeeds (record SIGNED, tsaStatus FAILED). |
| tsa:6.17 | SOURCE_PROVEN_CORRECT | Retries idempotent | No automatic retry exists (design). But the TSA request happens before the finalize CAS and before billing settlement in the same tx: any later rollback (402 INSUFFICIENT_EVIDENCE_CREDITS from settlement, tx timeout, race loss 409) discards the obtained token; a client retry of /complete mints a NEW token (new genTime, new provider charge). Not harmful to truth (nothing persisted) but not idempotent w.r.t. provider quota. |
| tsa:6.18 | SOURCE_PROVEN_CORRECT | Multiple tokens per version | No: single set of tsa* columns on Evidence; no per-version/token table. One token per record lifetime. |
| tsa:6.19 | SOURCE_PROVEN_CORRECT | Authoritative token | Evidence.tsaTokenBase64 + tsaStatus written once by the finalize CAS; the only other writer is the operator CLI repair script (FAILED->STAMPED, CAS on tsaStatus='FAILED'). The runbook/remediation-registry claim 'tsaStatus is written once, inside the finalize claim' is therefore not strictly true. |
| tsa:6.2 | SOURCE_PROVEN_DEFECT | Original vs manifest digest | Single-file: original file digest. Multipart: the '\|'-joined composite, which the package itself labels 'Synthetic composite ... The reproducible canonical multipart digest is multipartManifestSha256' (LF-joined). The TSA certifies the composite the package tells reviewers is NOT the reproducible digest, and the '\|' recipe is not documented in the package; the report labels the composite 'Canonical Package Digest'. See TSA-05. |
| tsa:6.20 | SOURCE_PROVEN_DEFECT | Pending/Failed/Anchored honest in report/package/verify | Mostly: FAILED -> 'Trusted timestamp attempt failed' (report), 'failed' (basic verification), null -> 'not configured'. Basic verification honestly reports basis IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED. BUT: (1) public verify summary asserts 'trusted timestamp linkage ... consistent' and the page counts it as a passed signal on a tautological comparison (TSA-03); (2) the package includes timestamp.tsr for FAILED rows and the README says 'Included ... RFC 3161 DER-encoded timestamp data' without stating the FAILED status (TSA-04); (3) report says token 'remains available through ... technical verification endpoint' but no API route exposes tsaTokenBase64 (TSA-08). No PENDING state exists |
| tsa:6.21 | SOURCE_PROVEN_DEFECT | Recovery verifies or resubmits | Neither automatically: lifecycle-recovery touches no TSA column; remediation-registry marks tsa_failure NO_SAFE_REMEDIATION_AUTHORITY. The manual repair CLI re-parses stored bytes (no resubmission) with the same fail-open parser and no signature verification, and — contrary to its own docstring step 4 — does not require serial AND genTime before writing STAMPED (only parsed.granted). |
| tsa:6.22 | SOURCE_PROVEN_CORRECT | Late response overwrite | Not possible from the live path (synchronous, response consumed inside the finalize tx; CAS on status CREATED/UPLOADING). Only the operator repair CLI can later change tsaStatus, guarded by CAS tsaStatus='FAILED'. |
| tsa:6.23 | SOURCE_PROVEN_CORRECT | TSA credits/limits charging | No customer-facing TSA credit or plan gating; TSA is global per env (TSA_ENABLED). Customer completion credit is settled inside the same tx AFTER the TSA call, so a rolled-back completion does not charge the customer, but the provider request has already been spent. Quota exhaustion at the provider permanently fails TSA for all tenants' records finalized meanwhile (no retry by design). Completion is rate-limited per user/plan. |
| tsa:6.24 | OWNER_DECISION_REQUIRED | Test vs production TSA authority separation | Purely env-driven (TSA_ENABLED/TSA_URL/TSA_USERNAME/TSA_PASSWORD/TSA_PROVIDER free-text label). No allow-list, no trust anchor, no environment guard, no boot-time validation; local fixture sets TSA_ENABLED=false. A test/self-signed TSA configured in production would be accepted and labelled 'Trusted timestamp token recorded'. TSA_PROVIDER is a cosmetic label written into the report. |
| tsa:6.25 | SOURCE_PROVEN_DEFECT | Read-time verification of stored token | None. Verify page, public verify API, worker promotion gate, integrity snapshot and package builder all trust DB columns; compareTimestampDigest compares tsaMessageImprint vs tsaInputDigestHex, which are both written from the same request-digest variable. Token bytes are never decoded after finalize (except by the manual repair CLI). |
| tsa:6.3 | SOURCE_PROVEN_CORRECT | Hash alg OID encoding | Delegated to openssl CLI via `-${TSA_HASH_ALGORITHM}` (default sha256). digestHex is hard-validated as 64 hex, so any non-sha256 env value makes every request fail at `openssl ts -query` (classified tsa_unknown_error). The response's Hash Algorithm line is never compared to the request. |
| tsa:6.4 | SOURCE_PROVEN_DEFECT | Nonce used and validated | Used implicitly (openssl ts -query adds a 64-bit random nonce unless -no_nonce). NEVER validated: the request file is deleted and the reply is only printed with -text; parser has no nonce handling; no `ts -verify -queryfile`. A replayed/cached Granted response for the same digest is accepted. |
| tsa:6.5 | SOURCE_PROVEN_DEFECT | PKIStatus checked | Only textually: regex on the first 'Status:' line of openssl -text output, Granted/GrantedWithMods accepted. There is no check that a timeStampToken is actually present when status is granted (see TSA-02). |
| tsa:6.6 | SOURCE_PROVEN_DEFECT | Imprint compared byte-for-byte | Only as lowercase hex scraped from the openssl -text hexdump, and only when the 'Message data:' block is present. If absent/unparseable, imprintMatchesRequest=null and the reply is GRANTED (fail-open, warning only). The token's own imprint is never persisted — the column tsaMessageImprint is the digest we SENT, so every read-time comparison is a tautology (TSA-03). |
| tsa:6.7 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | TSA signature cryptographically validated | No. No `openssl ts -verify`, no CMS/pkijs/node-forge/asn1 library anywhere (repo-wide grep for -verify/CAfile/pkijs/asn1js/node-forge/@peculiar: zero hits in services/packages src). shared/evidence-digest-policy.ts itself states nothing in the platform verifies the token signature or chain. [Runtime: RT-TSA forged self-signed token accepted as granted.] |
| tsa:6.8 | SOURCE_AND_RUNTIME_PROVEN_DEFECT | Cert chain validated | No. `-cert` only asks the TSA to embed its cert; nothing validates it. [Runtime: RT-TSA: openssl ts -verify refuses the chain the product accepted.] |
| tsa:6.9 | SOURCE_PROVEN_DEFECT | Cert validity dates | Not checked (no cert processing). genTime is also not bounded against the request time. |

## Machine-readable inventories

Full rows live in the JSON under `inventories`. Row counts:

| inventory | rows |
|---|---|
| acquisition.acquisitionPaths | 10 |
| acquisition.conservation | 5 |
| acquisition.createEvidenceCallers | 3 |
| acquisition.evidenceRowCreators | 2 |
| commercial.creditTypesAndLedgers | 8 |
| commercial.evidenceCreatorPaths | 4 |
| commercial.freeLimitPredicate | 2 |
| commercial.planAuthorityWriters | 3 |
| custody.appendOnlyEnforcement | 3 |
| custody.auditWriters | 5 |
| custody.custodyAppenders | 5 |
| custody.custodyEventEmitters | 48 |
| custody.custodyVerifiers | 5 |
| directcapture.directCapturePaths | 6 |
| intake.intakePaths | 6 |
| ots.fixtures | 2 |
| ots.otsStateMap | 12 |
| ots.schedulersAndDelays | 7 |
| package-verify.packageContents | 49 |
| package-verify.verifyPageSemanticCases | 18 |
| queues.conservationTotals | 10 |
| queues.jobs | 17 |
| queues.sweeps | 22 |
| recovery.failureRecoveryMatrix | 15 |
| recovery.recoveryControls | 12 |
| reports.reconciliation | 10 |
| reports.reportRequestStates | 10 |
| reports.reportsPageFields | 7 |
| security.concurrencyScenarios | 13 |
| security.duplicateAuthorities | 26 |
| security.tenancyRoutes | 27 |
| statemachine.evidenceDbWriters | 40 |
| statemachine.evidenceLifecycleColumns | 14 |
| statemachine.evidencePartDbWriters | 10 |
| statemachine.evidenceStatusTransitions | 6 |
| statemachine.forbiddenOrUnguardedTransitions | 6 |
| statemachine.frontendStatusMaps | 9 |
| statemachine.storageWriters | 12 |
| tsa.fixtures | 3 |
| tsa.persistedColumns | 6 |
| tsa.readSideProjections | 8 |
| tsa.stateMapping | 6 |
| tsa.tsaCallChain | 14 |
| uploads.resumableUploadPaths | 9 |

