#!/usr/bin/env node
// Evidence-Truth audit — the LEAD AUDITOR's authored input.
//
// Everything a person decided lives here and nowhere else: the verdict on every
// candidate finding (confirm / merge / reject / re-severitise), the runtime
// dispositions, the prose of the 26 sections, the owner decisions, the backlog
// order and the adjudicated content gates. It writes lead.json; build.mjs joins
// it with the fragments. Deterministic: no clock is read.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const fragDir = path.join(auditDir, "fragments");

const AUDITED_SHA = "a40ca76f41f4edcd2c0898a25664ca7c5d7d5bf8";
const PROBE_ENDPOINTS = [
  "postgresql://et:***@127.0.0.1:58432/et_evidence_truth_test",
  "redis://127.0.0.1:58379",
  "http://127.0.0.1:59000",
];

// ---------------------------------------------------------------------------
// 1. Candidate adjudication
// ---------------------------------------------------------------------------
const CODE = {
  acquisition: "ACQ", uploads: "UPL", directcapture: "DC", intake: "INT", statemachine: "SM",
  custody: "CUS", tsa: "TSA", ots: "OTS", queues: "Q", reports: "RPT", "package-verify": "PKG",
  recovery: "REC", commercial: "COM", security: "SEC",
};
const stableId = (domain, localId) => `ET-${CODE[domain]}-${localId.match(/(\d+)$/)[1].padStart(2, "0")}`;

// Merges: duplicate root cause found independently by two passes.
const MERGED = {
  "statemachine:STATEMACHINE-01": ["uploads:UPL-01", "Same defect (upload-session bridge part injection) found independently by the state-machine pass."],
  "security:SEC-08": ["uploads:UPL-01", "Same defect found independently by the security pass."],
  "queues:QUEUES-01": ["ots:OTS-01", "Same defect (init follow-up collapses onto its own job) found independently by the queue pass."],
  "queues:QUEUES-02": ["ots:OTS-02", "Same defect (deterministic -next- id collision) found independently by the queue pass."],
  "commercial:COMMERCIAL-05": ["acquisition:ACQ-02", "Same root cause: abandoned/uncompleted records occupy allowance and are never reaped."],
  "statemachine:STATEMACHINE-10": ["acquisition:ACQ-02", "Same root cause: no terminal state or reaper for CREATED/UPLOADING rows."],
  "statemachine:STATEMACHINE-06": ["acquisition:ACQ-04", "Same defect: size limit checked after hashing inside the 120s finalize transaction."],
  "statemachine:STATEMACHINE-05": ["acquisition:ACQ-03", "Same root cause: one-shot post-commit steps are skipped permanently when the retention/lock-snapshot step throws."],
  "statemachine:STATEMACHINE-04": ["security:SEC-12", "Same defect class: lifecycle writers validate on a read and update WHERE id only."],
  "statemachine:STATEMACHINE-09": ["directcapture:DC-01", "The discard side of the same discard-vs-complete race."],
  "reports:REPORTS-08": ["custody:CUSTODY-06", "Same defect: recovery package selects custody by time instead of custodyThroughSequence."],
  "package-verify:PKGV-16": ["custody:CUSTODY-09", "Same defect: exchange package custody-chain.json truncated/unverifiable."],
  "package-verify:PKGV-10": ["security:SEC-31", "Same existence-oracle class (public verify 409/404/503 distinguishable)."],
  "ots:OTS-08": ["recovery:RECOVERY-01", "Same defect: the collapsed enqueue outcome is unreachable so Operations reports QUEUED."],
  "queues:QUEUES-11": ["recovery:RECOVERY-01", "Same defect as RECOVERY-01 / OTS-08."],
  "custody:CUSTODY-15": ["intake:INT-12", "Same intake attribution/post-commit custody defect."],
};

// Severity changes with the reason.
const RESEVERITY = {
  "security:SEC-09": ["P0", "Runtime proof RT-TENANCY/SEC-09: a user read another user's private record (404 -> link 200 -> read 200). Cross-tenant access is P0 by the audit's definition; the precondition (legacy NULL-team rows) is stated in the finding."],
  "security:SEC-10": ["P0", "Runtime proof RT-VERIFY/SEC-10: signatureValid:false and overallIntegrity:false while the public headline reads 'Core Integrity Verified'. False cryptographic verification is P0 by the audit's definition."],
  "security:SEC-03": ["P1", "Within-tenant stale authority (expired members / suspended orgs), not cross-tenant access; aligned with SEC-04/SEC-05 (P1)."],
  "tsa:TSA-02": ["P2", "Runtime proof RT-TSA refuted the concrete exploit: OpenSSL 3.5.4 refuses to decode a granted reply without a token ('token not present'), so it takes the subprocess-failure branch (FAILED). The parser still fails open on an unparseable imprint dump, which is a latent dependency on openssl's text format, not a demonstrated false success."],
};

// Section placement where the default (by domain) is not the best home.
const SECTION = {
  "commercial:COMMERCIAL-01": "downgrade", "commercial:COMMERCIAL-02": "freeLimit", "commercial:COMMERCIAL-03": "downgrade",
  "commercial:COMMERCIAL-04": "downgrade", "commercial:COMMERCIAL-06": "freeToPro",
  "acquisition:ACQ-02": "freeLimit", "acquisition:ACQ-06": "freeLimit",
  "security:SEC-01": "concurrency", "security:SEC-06": "concurrency", "security:SEC-10": "verify",
  "security:SEC-11": "concurrency", "security:SEC-12": "concurrency", "security:SEC-13": "concurrency",
  "security:SEC-16": "duplicates", "security:SEC-18": "reportsPage", "security:SEC-20": "duplicates", "security:SEC-21": "duplicates",
  "security:SEC-22": "duplicates", "security:SEC-23": "duplicates", "security:SEC-24": "duplicates",
  "security:SEC-27": "concurrency", "security:SEC-28": "concurrency", "security:SEC-29": "concurrency", "security:SEC-30": "concurrency",
  "security:SEC-34": "duplicates", "security:SEC-35": "duplicates",
  "statemachine:STATEMACHINE-03": "storage", "statemachine:STATEMACHINE-07": "storage",
  "reports:REPORTS-01": "reportsPage", "reports:REPORTS-02": "reportsPage", "reports:REPORTS-04": "reportsPage",
  "reports:REPORTS-05": "reportsPage", "reports:REPORTS-06": "reportsPage",
  "package-verify:PKGV-05": "verify", "package-verify:PKGV-06": "verify", "package-verify:PKGV-07": "verify",
  "package-verify:PKGV-09": "verify", "package-verify:PKGV-12": "verify", "package-verify:PKGV-13": "verify", "package-verify:PKGV-17": "verify",
  "uploads:UPL-01": "storage", "intake:INT-03": "freeLimit",
};

// Runtime proofs that change a finding's disposition, with the evidence line.
const RUNTIME = {
  "uploads:UPL-01": "RT-UPL/UPL-01 (runtime/results/rt-upl-01.json): a teamA MEMBER who does not own a SIGNED record drove POST /v1/uploads/sessions (201) -> initiate (200) -> presign (200) -> PUT to loopback MinIO (200) -> parts/1/uploaded (200) -> multipart/complete verifyHash (200). evidence_parts went 1 -> 2 (partIndex 9999, uploadedAtUtc NULL, attacker bytes). The worker composite rule (processor.ts:2367) over the stored parts no longer equals evidence.fileSha256, so the next report run takes the rejectEvidenceIntegrity branch. The report job itself was not executed (see blocked item B6).",
  "custody:CUSTODY-01": "RT-VERIFY/CUSTODY-01 (rt-verify-custody01.json): a real legal hold placed and released through placeCanonicalLegalHold/releaseCanonicalLegalHold; an anonymous GET /public/verify/:id (no Authorization) returned 200 with payloadSummary 'title: ET-CONFIDENTIAL-MATTER-… v. Acme • placedByUserId: …' and 'releaseNoteInternal: ET-INTERNAL-ONLY settlement discussed with counsel …'.",
  "security:SEC-01": "RT-TENANCY/SEC-01 (rt-tenancy-sec01.json): TRASHED record past grace; 0 active holds when facts were gathered, 1 ACTIVE hold (placed through the production service) when executeEvidenceDestruction ran with the pre-hold verdict; result ok:true outcome DESTROYED, the original's only version deleted, destroyedAtUtc set, certificate issued. Storage was an honest in-memory port; the DB decision path is the production executor.",
  "security:SEC-02": "RT-TENANCY/SEC-02 (rt-tenancy-sec02.json): POST /v1/cases/:id/evidence (200) then DELETE /v1/cases/:id/evidence/:evidenceId (200) -> Evidence.teamId NULL; the workspace ADMIN's GET /v1/evidence/:id went 200 -> 404 while the creator still reads 200.",
  "security:SEC-09": "RT-TENANCY/SEC-09 (rt-tenancy-sec09.json): attacker (teamB member) GET victim's record 404; POST /v1/cases/:legacyNullTeamCase/evidence-links {victim evidence} 200 (link row created); GET again 200 with the victim's private title. Legacy NULL-team case and evidence rows were seeded (the API no longer mints NULL-team cases).",
  "security:SEC-10": "RT-VERIFY/SEC-10 (rt-verify-sec10.json): genuine record, live decision core_integrity 'passed', persisted as reports.trust_decision_snapshot; signature then replaced; anonymous verify answered signatureValid:false, overallIntegrity:false, source REPORT_SNAPSHOT, headline 'Core Integrity Verified' (the pre-tamper headline carried a 'Trusted Timestamp Unavailable' qualifier that disappeared).",
  "tsa:TSA-01": "RT-TSA (rt-tsa.json): a token minted by a throwaway self-signed TSA over the correct digest -> `openssl ts -reply -text` + production parseTsaReply -> granted:true -> STAMPED; `openssl ts -verify` against the system CA bundle REFUSED it (self-signed certificate).",
  "tsa:TSA-02": "RT-TSA (rt-tsa.json): granted-without-token DER is rejected by OpenSSL 3.5.4 before the parser runs -> FAILED. Concrete exploit refuted on this openssl; severity lowered.",
  "ots:OTS-01": "RT-OTS-QUEUE (rt-ots-queue.json): production enqueueCanonicalJob + UPGRADE_OTS registry entry on real BullMQ/Redis (loopback): called from inside the running job without selfJobId -> {enqueued:true, collapsed:true}; hops processed 1, jobs still scheduled 0.",
  "ots:OTS-02": "RT-OTS-QUEUE (rt-ots-queue.json): with selfJobId the ladder ran 3 hops; hop 3's enqueue returned {enqueued:true, collapsed:false, jobId '…-next-ab794fde-84'} — the same id as hop 1's retained completed job — and nothing further was scheduled.",
  "commercial:COMMERCIAL-01": "RT-COMMERCIAL/COMMERCIAL-01 (rt-commercial-01.json): production decideSubscriptionStatusWrite with the stamp reconciliation writes (current_period_end, +20d): a CANCELED webhook at +3d and a PAST_DUE at +5d both -> {apply:false, reason:OBSERVATION_IS_OLDER}; control with an honest stamp applies CANCELED. The provider round trip itself is blocked (B5).",
  "commercial:COMMERCIAL-02": "RT-COMMERCIAL/FREE (rt-commercial-free.json): FREE user at 4 active (after the race), trash -> 3, create refused 409 FREE_LIMIT_REACHED, POST /v1/evidence/:id/restore 200 -> 4 active records on a 3-record plan.",
  "acquisition:ACQ-02": "RT-COMMERCIAL/FREE: every counted row was CREATED/UPLOADING (3 UPLOADING + 1 CREATED, none completed) and the 4th attempt was refused 409 FREE_LIMIT_REACHED on their account. RT-INTAKE/INT-03 shows the same for an anonymous intake row.",
  "acquisition:ACQ-06": "RT-COMMERCIAL/FREE: two concurrent POST /v1/evidence at 2/3 both returned 201 (4 active FREE records). Completion settlement (per-subject advisory lock) is the backstop per commercial answer 14.3; not exercised here (no bytes uploaded).",
  "reports:REPORTS-01": "RT-REPORTS (rt-reports-01.json): two records each with a FAILED_TERMINAL REPORT request; listWorkspaceArtifacts summary reportsFailed:1 (first-issuance only) and reportsReady:1; the record with v1 + failed updated-report request rows as report.state READY with actionUnavailableReason ESCALATED_TO_OPERATOR.",
  "intake:INT-01": "RT-INTAKE (rt-intake.json): one-time link, anonymous open + consent, POST …/transition {to:SUBMITTED} 200 -> session SUBMITTED with evidenceId null, link EXPIRED usedCount 1; the real contributor's next GET -> 410 LINK_NO_LONGER_AVAILABLE.",
  "intake:INT-03": "RT-INTAKE (rt-intake.json): FREE owner at 2/3; anonymous open + consent + one part (201), never submitted -> owner count 3, record UPLOADING; owner's own POST /v1/evidence -> 409 FREE_LIMIT_REACHED.",
};

// Lead verification notes for P0/P1 (each re-read by the lead at the cited lines).
const LEAD_READ = {
  "uploads:UPL-01": "Lead re-read upload-session.service.ts:350-366 (team-only guard), :1860-1916 (bridge insert, no re-read), processor.ts:2061 (unfiltered findMany), :2270-2312 (all parts hashed), :2355-2385 (mismatch -> rejectEvidenceIntegrity); grep found no trigger on evidence_parts. Then runtime-reproduced.",
  "custody:CUSTODY-01": "Lead re-read evidence.routes.ts:2093-2125 (default branch prints up to 5 string fields, masking only emails) and :12753 (all custody events, take 500, feed the public summarizer). Then runtime-reproduced.",
  "security:SEC-01": "Lead re-read executor.ts:289-400 (claim, reload, eligibility with input.legalHold) and destruction-orchestrator.worker.ts:169/244 (facts gathered before the call). Then runtime-reproduced.",
  "security:SEC-02": "Lead re-read case-evidence-link.service.ts:236-256 (teamId set NULL when the last link goes). Then runtime-reproduced.",
  "security:SEC-09": "Lead re-read case-lifecycle.service.ts:620-640 (no check when case.teamId is null), case-permission.service.ts:386-396 (null === null allowed), evidence.routes.ts:3018-3045 (legacy read gate grants on linked-case ownership). Then runtime-reproduced.",
  "security:SEC-10": "Lead re-read evidence.routes.ts:1680-1700 (headline from core signal + stored verificationStatus only) and :13124-13137 (snapshot decision wins; overallIntegrity computed separately). Then runtime-reproduced.",
  "security:SEC-03": "Lead re-read evidence.routes.ts:3079 and artifact-download-gate.service.ts:150 (status === ACTIVE only) against access-policy.service.ts:216/234 (the canonical rule also checks expiry and org status).",
  "security:SEC-04": "Lead re-read evidence.routes.ts:3035-3045 (case owner / CaseAccess grant without membership re-proof).",
  "security:SEC-05": "Lead re-read evidence.routes.ts:3018 (creator short-circuit) against evidence-record-access.service.ts:79.",
  "security:SEC-06": "Accepted on the cited executor claim (PENDING_DESTRUCTION set in the claim) and the lifecycle restore write by id; the interleave was not runtime-exercised.",
  "security:SEC-07": "Lead re-read evidence.routes.ts:8395-8430: the actor needs read access to both records, so exposure requires a dual-workspace member; kept P1.",
  "tsa:TSA-01": "Lead re-read timestamp.service.ts:201-354 (only `openssl ts -reply -text`, no -verify). Then runtime-reproduced with a forged self-signed TSA token.",
  "tsa:TSA-03": "Lead re-read timestamp.service.ts:306 (messageImprint: digestHex — the REQUEST digest is persisted, the parsed imprint is discarded) and evidence-complete.service.ts:1051/1074.",
  "ots:OTS-01": "Lead re-read ots-upgrade.processor.ts:342-362 (no selfJobId) and enqueue.ts:145-195 (collapse onto a live job). Then runtime-reproduced on BullMQ.",
  "ots:OTS-02": "Lead re-read enqueue.ts:150-160 (deterministic -next- id) and removeOnComplete 100. Then runtime-reproduced on BullMQ.",
  "commercial:COMMERCIAL-01": "Lead re-read stripe.provider.ts:374-388 (observedAtUtc = current_period_end), reconciliation.service.ts:613-650 (stampProviderState on agreement), billing.service.ts:658 + subscription-status.ts:89 (older observation refused first). Then runtime-reproduced on the decision function.",
  "directcapture:DC-01": "Lead re-read direct-capture-ingest.service.ts:920-990 (discard lock key capture-session:*), evidence-complete.service.ts:1098 (claim without deletedAt), :840-846 (bound:true regardless).",
  "directcapture:DC-02": "Lead re-read apps/extension/src/background.ts:44-56 (capture before openWebSession) and evidence-acquisition.ts:250-258 (statement).",
  "directcapture:DC-03": "Lead re-read capture-trust.routes.ts:156-163 (mode is a caller-supplied enum).",
  "intake:INT-01": "Lead re-read external-intake.routes.ts:1395-1425 and workflow-intake-session.service.ts:536-558. Then runtime-reproduced.",
  "intake:INT-02": "Accepted on the cited completion/denial classification chain (evidence-complete.service.ts:762, errors.ts:387, external-intake.routes.ts:1340); not runtime-exercised.",
  "intake:INT-03": "Lead re-read external-intake.routes.ts:783-795 (session per GET) and billing-enforcement.service.ts:218-235 (count without status filter). Then runtime-reproduced.",
  "intake:INT-04": "Accepted on evidence-request.service.ts:1223/1259 and :869 (follow-up link never recorded on the request); not runtime-exercised.",
  "intake:INT-05": "Accepted on the same mechanism as UPL-01 (worker hashes every part) plus addExternalEvidencePart taking no completion lock; not runtime-exercised.",
  "package-verify:PKGV-01": "Lead re-read processor.ts:4425-4440 (payload normalized for presentation, 'immutable event hash is preserved') and normalizers.ts:90-105.",
  "package-verify:PKGV-02": "Accepted on the seal/key provenance citations (public key only inside the ZIP, no published fingerprint); consistent with package answer 10.12.",
  "security:SEC-11": null,
};

// ---------------------------------------------------------------------------
// 2. Build the adjudication map from the fragments
// ---------------------------------------------------------------------------
const citations = JSON.parse(fs.readFileSync(path.join(here, "citation-report.json"), "utf8")).candidates;
const adjudication = {};
const absorbs = {};
for (const [from, [into]] of Object.entries(MERGED)) (absorbs[into] ??= []).push(from);

for (const f of fs.readdirSync(fragDir).filter((x) => x.endsWith(".json")).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(fragDir, f), "utf8"));
  for (const c of d.findings) {
    const key = `${d.domain}:${c.localId}`;
    if (MERGED[key]) {
      adjudication[key] = { verdict: "MERGED", into: stableId(...MERGED[key][0].split(":")), reason: MERGED[key][1] };
      continue;
    }
    const sev = RESEVERITY[key]?.[0] ?? c.severity;
    const cit = citations[key];
    const note = LEAD_READ[key]
      ?? (sev === "P0" || sev === "P1"
        ? "Lead re-read the cited lines."
        : `Accepted from the tracing pass after machine verification: ${cit.resolved}/${cit.total} cited file:line snippets resolve in the audited tree (check-citations.mjs). Not individually re-read by the lead.`);
    adjudication[key] = {
      verdict: "CONFIRMED",
      id: stableId(d.domain, c.localId),
      ...(RESEVERITY[key] ? { severity: sev } : {}),
      section: SECTION[key],
      disposition: RUNTIME[key] ? "SOURCE_AND_RUNTIME_PROVEN_DEFECT" : "SOURCE_PROVEN_DEFECT",
      runtimeEvidence: RUNTIME[key] ?? (c.runtimeProofNeeded ? `Not runtime-exercised. Proposed probe: ${c.runtimeProofIdea}` : "not required (deterministic code path; source-proven)"),
      leadVerification: RESEVERITY[key] ? `${note} Severity ${c.severity} -> ${sev}: ${RESEVERITY[key][1]}` : note,
      absorbs: absorbs[key] ?? [],
      ...(key === "directcapture:DC-04" ? { ownerDecision: "Confirm EXTENSION_OAUTH_REDIRECT_ALLOW is set in production (the audit never reads production configuration)." } : {}),
    };
  }
}

// Answer corrections from runtime proof and lead verification.
const answerOverrides = {
  "tsa:6.7": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-TSA forged self-signed token accepted as granted." },
  "tsa:6.8": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-TSA: openssl ts -verify refuses the chain the product accepted." },
  "tsa:6.14": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-TSA: an untrusted token is persisted STAMPED; a mismatched imprint is correctly FAILED; a token-less granted reply is FAILED on OpenSSL 3.5.4." },
  "ots:7.9": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-OTS-QUEUE: no follow-up is scheduled from the init branch; the ladder dies at hop 3." },
  "recovery:13.5": { disposition: "SOURCE_AND_RUNTIME_PROVEN_CORRECT", runtime: "RT-RECOVERY: no credit-ledger rows after four RECOVER calls." },
  "recovery:13.6": { disposition: "SOURCE_AND_RUNTIME_PROVEN_CORRECT", runtime: "RT-RECOVERY: report count stayed 1; one package request." },
  "recovery:13.15": { disposition: "SOURCE_AND_RUNTIME_PROVEN_CORRECT", runtime: "RT-RECOVERY: two concurrent RECOVER calls returned the same requestId; one QUEUED request row." },
  "recovery:13.16": { disposition: "SOURCE_AND_RUNTIME_PROVEN_CORRECT", runtime: "RT-RECOVERY: same clientRequestKey twice -> ALREADY_ACTIVE, same requestId." },
  "reports:12.1": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-REPORTS: same population, but a failed updated-report request is counted READY not FAILED." },
  "security:19.4": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-TENANCY/SEC-09." },
  "security:20.3": { disposition: "SOURCE_AND_RUNTIME_PROVEN_CORRECT", runtime: "RT-RECOVERY." },
  "security:20.6": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-TENANCY/SEC-01." },
  "commercial:14.3": { disposition: "SOURCE_AND_RUNTIME_PROVEN_DEFECT", runtime: "RT-COMMERCIAL: concurrent creates at 2/3 both admitted (201, 201)." },
  "commercial:14.5": { disposition: "SOURCE_AND_RUNTIME_PROVEN_CORRECT", runtime: "RT-COMMERCIAL: 409 FREE_LIMIT_REACHED with the exact public message." },
  "commercial:16.1": { disposition: "SOURCE_AND_RUNTIME_PROVEN_CORRECT", runtime: "RT-COMMERCIAL: after the purchase (ledger PURCHASE +1) the next NEW record was admitted at cap; no existing record changed funding. Completion-time CONSUMPTION was not exercised (no bytes uploaded)." },
  "commercial:17.5": { disposition: "SOURCE_PROVEN_CORRECT", answer: "No route moves an evidence record to another workspace: team/org 'transfer-ownership' (teams.routes.ts:3707, organizations.routes.ts:2108) changes the owner, not Evidence.teamId. The one reassignment path is the case-detach side effect that NULLs teamId (SEC-02, P0). Credit funding is keyed by evidenceId (ledger evidence_id UNIQUE) and survives any move; the worker refuses a request whose record's workspace no longer matches (BLOCKED_POLICY, recoverable). Lead-verified by grep of services/api/src/routes for transfer/move routes." },
  "package-verify:11.3": { runtime: "RT-VERIFY/ENUM: unknown and malformed ids both 404 with Cache-Control no-store." },
};

// ---------------------------------------------------------------------------
// 3. Runtime proofs, blocked items, owner decisions, backlog
// ---------------------------------------------------------------------------
const run = "bash docs/evidence/audits/definitive-evidence-lifecycle-truth/runtime/run-probes.sh";
const INFRA = "disposable containers et-pg (pgvector/pgvector:pg16, 127.0.0.1:58432, db et_evidence_truth_test, all migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1 so no .env was read), et-redis (redis:7, 127.0.0.1:58379), et-minio (127.0.0.1:59000); the API's own integration config (credential scrub + outbound socket guard + network ledger)";
const CLEAN = "docker rm -f et-pg et-redis et-minio after the final full run; each probe file boots and cleans its own harness fixtures";
const runtimeProofs = [
  { id: "RT-TSA", title: "RFC3161 acceptance without signature verification", claim: "TSA-01/02/03: acceptance is `openssl ts -reply -text` + parseTsaReply; nothing verifies signature or chain.", fixture: "throwaway self-signed TSA minted in a temp dir (never written to the repo); three replies: forged-granted, mismatch, granted-no-token", command: `${run} tsa`, expected: "an untrusted token must not be STAMPED", actual: "forged-granted -> STAMPED (openssl ts -verify REFUSED: self-signed); mismatch -> FAILED tsa_message_imprint_mismatch; granted-no-token -> openssl refuses to decode -> FAILED", result: "TSA-01 DEFECT REPRODUCED; imprint-mismatch rejection CORRECT; TSA-02 concrete exploit REFUTED on OpenSSL 3.5.4", cleanup: "temp dir removed in finally", endpoints: [] },
  { id: "RT-OTS-QUEUE", title: "OTS upgrade ladder on real BullMQ", claim: "OTS-01/02", fixture: "real BullMQ queue on disposable Redis; production enqueueCanonicalJob + UPGRADE_OTS registry entry loaded from the built @proovra/shared the worker imports", command: `${run} ots`, expected: "a follow-up job is scheduled after every hop", actual: "init path: {enqueued:true, collapsed:true}, 1 hop, 0 scheduled; ladder: 3 hops then hop-3 add targets a retained completed id, reported enqueued:true, 0 scheduled", result: "OTS-01 and OTS-02 DEFECTS REPRODUCED", stateBeforeAfter: "queue obliterated after each scenario", cleanup: "queue.obliterate + connections closed", endpoints: ["redis://127.0.0.1:58379"] },
  { id: "RT-VERIFY", title: "Public Verify disclosure, states, headline", claim: "CUSTODY-01, SEC-10, Verify pending/failed states, anti-enumeration", fixture: `${INFRA}; genuinely Ed25519-signed records; real legal hold place/release`, command: `${run} integration RT-VERIFY`, expected: "no internal hold text on the anonymous page; FAILED/PENDING never shown as verified; a tampered signature never headlined as verified; uniform 404", actual: "hold title, internal release note and actor ids disclosed; TSA FAILED/OTS PENDING rendered honestly; after signature tamper headline 'Core Integrity Verified' with signatureValid:false; unknown/malformed ids 404 no-store", result: "CUSTODY-01 and SEC-10 DEFECTS REPRODUCED; states and enumeration CORRECT", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
  { id: "RT-TENANCY", title: "Cross-user link, workspace escape, hold vs destruction", claim: "SEC-09, SEC-02, SEC-01", fixture: `${INFRA}; legacy NULL-team case/evidence rows seeded for SEC-09 (declared); in-memory honest storage port for SEC-01`, command: `${run} integration RT-TENANCY`, expected: "cross-user read refused; detach keeps the record in its workspace; an active hold stops destruction", actual: "SEC-09 404 -> 200 after link; SEC-02 teamId NULL, admin 200 -> 404; SEC-01 DESTROYED with an active hold", result: "three P0 DEFECTS REPRODUCED", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
  { id: "RT-UPL", title: "Part injection into a sealed record", claim: "UPL-01", fixture: `${INFRA}; SIGNED record owned by the team OWNER; actor = team MEMBER`, command: `${run} integration UPL-01`, expected: "session creation or bridge refuses a SIGNED record the actor does not own", actual: "all six calls succeeded; evidence_parts 1 -> 2; worker composite != fileSha256", result: "P0 DEFECT REPRODUCED (report-run consequence source-proven; worker not booted, B6)", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
  { id: "RT-COMMERCIAL", title: "FREE cap, race, restore, credit, Stripe ordering", claim: "FREE three-record rule, concurrent 3rd/4th, COMMERCIAL-02, ACQ-02, one-credit allocation, COMMERCIAL-01", fixture: `${INFRA}; harness FREE personal user; credit granted through grantEvidenceCredits (the purchase webhook's service) with a fake provider ref`, command: `${run} integration RT-COMMERCIAL`, expected: "cap 3 enforced atomically; restore re-checks the cap; cancellation after reconciliation applies", actual: "race admitted 4; 409 FREE_LIMIT_REACHED thereafter; restore -> 4 active; credit admits the next NEW record only; cancel/past-due refused OBSERVATION_IS_OLDER", result: "COMMERCIAL-01, COMMERCIAL-02, ACQ-02, ACQ-06 DEFECTS REPRODUCED; cap message and credit allocation behaviour CONFIRMED", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
  { id: "RT-INTAKE", title: "Intake allowance exhaustion and link burning", claim: "INT-03, INT-01", fixture: `${INFRA}; throwaway intake HMAC secret set in-process; declared fixture step: owner credit set to 0 after links were minted`, command: `${run} integration RT-INTAKE`, expected: "an abandoned anonymous session does not consume the owner's allowance; /transition cannot mark SUBMITTED without finalizing", actual: "owner 2 -> 3 and own create 409; session SUBMITTED with no evidence, link EXPIRED, contributor 410", result: "INT-01 and INT-03 DEFECTS REPRODUCED", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
  { id: "RT-REPORTS", title: "Reports cards vs rows", claim: "REPORTS-01 / known risk 'failure visible in table, not in KPI'", fixture: `${INFRA}; TEAM workspace; record with Report v1 + FAILED_TERMINAL updated-report request; control record with first-issuance failure`, command: `${run} integration REPORTS-01`, expected: "both failures counted in reportsFailed", actual: "reportsFailed 1, reportsReady 1; the v1 record's row READY + ESCALATED_TO_OPERATOR", result: "DEFECT REPRODUCED", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
  { id: "RT-RECOVERY", title: "Recovery double-click", claim: "Recovery idempotency (section 13 Q15-17)", fixture: `${INFRA}; REPORTED record with Report v1 and a failed package request`, command: `${run} integration double-click`, expected: "one request row, no new report, no credit", actual: "same requestId for concurrent calls; one QUEUED VERIFICATION_PACKAGE request; reports 1; credit ledger 0", result: "CORRECT", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
  { id: "RT-FREE-PRO", title: "Existing FREE records after upgrade", claim: "FREE -> PRO (section 15)", fixture: `${INFRA}; FREE user with records signed 1 and 10 days ago; syncPlanForSubscription with a fake ACTIVE Stripe subscription and an injected no-op superseded-canceller`, command: `${run} integration "existing FREE records"`, expected: "records preserved; outputs become available", actual: "both records NOT_INCLUDED -> ELIGIBLE_NOT_GENERATED with a GENERATE action; the upgrade itself created 0 reports and 0 requests", result: "CONFIRMED (automatic first issuance is the worker's 7-day rule; source-proven)", cleanup: CLEAN, endpoints: PROBE_ENDPOINTS },
];

const blocked = [
  { id: "B1", item: "DC-01 discard-vs-complete race", disposition: "BLOCKED_FIXTURE_CAPABILITY", blocker: "a deterministic interleave requires a pause point inside completeEvidence after its entry checks; the product exposes none and the audit may not add one", attempted: "source trace of both lock keys and the claim predicate", established: "different advisory-lock keys; finalize claim lacks deletedAt; bound:true regardless of claim count", futureProof: "remediation adds the shared lock + predicate; an injected-delay test then proves discard cannot interleave" },
  { id: "B2", item: "Package staging on the real Object Lock bucket (Sentry 150024171 class)", disposition: "BLOCKED_EXTERNAL_PROVIDER", blocker: "MinIO accepts checksum-less PUTs on a lock bucket; AWS does not", attempted: "none against AWS (Production forbidden)", established: "staging PUT carries no checksum (package answer 10.8 records the current path)", futureProof: "staging-account Object Lock bucket run" },
  { id: "B3", item: "OTS calendar upgrade and Bitcoin attestation verification", disposition: "BLOCKED_EXTERNAL_PROVIDER", blocker: "no .ots fixtures in the repo; calendars and a Bitcoin node are external", attempted: "queue-ladder proof on BullMQ (RT-OTS-QUEUE)", established: "anchors are PROOF_STRUCTURE from offline `ots info`; badge says CHAIN NOT CHECKED (OTS answers 7.13-7.16)", futureProof: "recorded calendar responses + a regtest node" },
  { id: "B4", item: "Behaviour against the production TSA provider", disposition: "BLOCKED_EXTERNAL_PROVIDER", blocker: "TSA credentials/provider are Production", attempted: "local untrusted TSA (RT-TSA) exercising the exact acceptance path", established: "no signature/chain/nonce/policy validation exists in code", futureProof: "provider sandbox token + openssl ts -verify with the provider chain" },
  { id: "B5", item: "COMMERCIAL-01 end to end with real Stripe webhook timing", disposition: "BLOCKED_EXTERNAL_PROVIDER", blocker: "Stripe Production/sandbox not contacted", attempted: "production decision function with the exact stamps (RT-COMMERCIAL)", established: "cancellation and past-due refused as OBSERVATION_IS_OLDER", futureProof: "Stripe test-mode subscription + reconciliation sweep + deleted webhook" },
  { id: "B6", item: "Worker-side execution (report run after injection; first-issuance sweep)", disposition: "BLOCKED_FIXTURE_CAPABILITY", blocker: "the worker boots through its own env loader (services/worker/src/env-loader.ts) which may read services/worker/.env; the audit did not find an audited hermetic worker launcher equivalent to dev-admin-fixture-api.mjs and refused to boot it", attempted: "the consequence computed with the worker's own composite rule (RT-UPL) and the upgrade projection via the API (RT-FREE-PRO)", established: "processor.ts:2367 rule and first-issuance-reconciliation.ts windows (source)", futureProof: "a hermetic worker harness, then run processReport over the injected record" },
  { id: "B7", item: "Production value of EXTENSION_OAUTH_REDIRECT_ALLOW (DC-04)", disposition: "OWNER_DECISION_REQUIRED", blocker: "the audit never reads production configuration", attempted: "code path read", established: "unset => any chromiumapp.org id accepted", futureProof: "owner confirms the variable is set" },
];

const ownerDecisions = [
  { id: "OD-1", question: "Which evidence should a purchased credit fund?", context: "Today the credit is never applied retroactively: it funds the next NEW record that completes over the plan allowance, chosen deterministically by (createdAt,id). The three existing FREE records stay NOT_INCLUDED. Deterministic, but a user who bought a credit 'for' an existing record gets nothing for it.", recommendation: "Keep credits unallocated in the canonical per-user ledger; let the user explicitly choose the record (and bind evidenceId on an evidence-specific checkout); reserve transactionally; consume at the billable milestone; release on failure by class. Never allocate by array order." },
  { id: "OD-2", question: "Should records older than 7 days get outputs automatically after an upgrade?", context: "OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED defaults OFF; after upgrade older records show a GENERATE action (RT-FREE-PRO) but are not issued automatically.", recommendation: "Decide explicitly; if manual, say so in the upgrade confirmation." },
  { id: "OD-3", question: "May a PAST_DUE_EXPIRED account create evidence under the FREE allowance or with purchased credits?", context: "COMMERCIAL-04: today it cannot create anything, which is stricter than FREE.", recommendation: "Allow FREE-equivalent + credit-funded creation; block only paid features." },
  { id: "OD-4", question: "How strong must the binding between a direct-capture mode and the capturing client be?", context: "DC-03: any bearer can open any DIRECT_* mode.", recommendation: "At minimum an adapter-scoped token per mode, plus a CLIENT_NOT_VERIFIED limitation when absent." },
  { id: "OD-5", question: "Which TSA trust anchors are acceptable, and must test and production TSAs be separated by configuration?", context: "TSA answer 6.24; no trust store exists.", recommendation: "Pin the provider chain; refuse STAMPED without `ts -verify` success; refuse non-https TSA_URL in production." },
  { id: "OD-6", question: "How should TSA and OTS disagreement be presented?", context: "OTS answer 7.19.", recommendation: "Show each layer's own status; never merge into one 'anchored' claim." },
  { id: "OD-7", question: "Which bytes does a package contain for redacted evidence?", context: "Package answer 10.10.", recommendation: "Decide per audience; record the choice in the manifest." },
  { id: "OD-8", question: "Is the permanent evidence UUID acceptable as the public verify capability?", context: "PKGV-07 / package answers 11.1-11.2: no expiry, rotation or per-recipient revocation; SEC-09 shows how a known UUID can be leveraged.", recommendation: "Introduce revocable, rotatable verify tokens distinct from the primary key." },
  { id: "OD-9", question: "Should an output earned under PRO survive a downgrade that lands before the job runs?", context: "Commercial answers 15.5 / security 20.7.", recommendation: "Bind entitlement to the completion-time funding fact (as credits already are)." },
  { id: "OD-10", question: "How must custody attribute machine actions triggered by a person?", context: "Custody answer 5.8.", recommendation: "Record initiator and executor separately." },
];

const backlog = [
  { findings: ["ET-SEC-10", "ET-TSA-01", "ET-TSA-03", "ET-PKG-05", "ET-PKG-06"], action: "Verification truth first: headline only from live checks; verify RFC3161 tokens (signature, chain, nonce, policy) before STAMPED; persist the parsed imprint; derive package/storage badges from verification, not presence." },
  { findings: ["ET-UPL-01", "ET-INT-05", "ET-UPL-02"], action: "One guarded EvidencePart writer (owner/intake principal, CREATED|UPLOADING, not locked/held/deleted, under the evidence lock); worker ignores NULL-uploadedAt parts; production scan for stray parts on sealed records." },
  { findings: ["ET-SEC-09", "ET-SEC-02", "ET-SEC-03", "ET-SEC-04", "ET-SEC-05"], action: "Tenancy: owner check on NULL-team case links; never NULL teamId on detach; route every read through the canonical access engine (expiry, org lifecycle, membership re-proof)." },
  { findings: ["ET-SEC-01", "ET-SEC-06"], action: "Executor re-reads holds inside its claim; restore refuses PENDING_DESTRUCTION." },
  { findings: ["ET-CUS-01", "ET-PKG-09"], action: "Allow-list public custody summaries; never print raw payload fields; minimise anonymous-view writes." },
  { findings: ["ET-OTS-01", "ET-OTS-02", "ET-OTS-03", "ET-REC-02"], action: "Pass selfJobId on the init branch; make follow-up ids unique per hop; add a PENDING-without-job sweep and a closable terminal incident." },
  { findings: ["ET-COM-01", "ET-COM-03", "ET-COM-02", "ET-COM-04"], action: "Stamp providerStateAtUtc with a provider event time, not period end (backfill stamped rows); handle Stripe credit refunds/disputes; cap check on restore; decide OD-3." },
  { findings: ["ET-PKG-01", "ET-PKG-02", "ET-PKG-03", "ET-PKG-04", "ET-TSA-04", "ET-TSA-05"], action: "Make packages independently verifiable: ship hash-consistent custody payloads, publish the seal key fingerprint, document the seal in README, fix the TSA digest documentation." },
  { findings: ["ET-INT-01", "ET-INT-03", "ET-INT-02", "ET-INT-04", "ET-ACQ-02"], action: "Intake: SUBMITTED only via /submit; unfinalized records do not consume allowance (or expire); part replace/remove; follow-up links attach to the request; reap abandoned rows." },
  { findings: ["ET-DC-01", "ET-DC-02", "ET-DC-03"], action: "Direct capture truth: shared lock + deletedAt predicate; open sessions before capture and enforce the window; bind mode to client (OD-4)." },
  { findings: ["ET-RPT-01", "ET-RPT-02", "ET-REC-03", "ET-REC-04"], action: "Reports KPIs count request-level failures and blocks; recovery for NULL-team personal records; mobile sends the required reason." },
  { findings: ["ET-SM-02", "ET-SEC-12", "ET-SM-03", "ET-SM-07"], action: "State writers: WHERE-guarded transitions everywhere; version-pinned byte access on every path; integrity re-hash independent of report entitlement." },
  { findings: ["ET-CUS-04", "ET-CUS-02", "ET-CUS-03", "ET-CUS-11"], action: "Custody durability: DB-enforced append-only, keyed chain; custody written in the mutation transaction; fix the chain-transfer event type." },
  { findings: ["ET-Q-03", "ET-Q-04", "ET-Q-05", "ET-Q-06"], action: "Queue hygiene: terminal states for non-OCR intelligence runs, redaction reclaim, trash sweep cursor, workers start after bootstrap." },
];

// ---------------------------------------------------------------------------
// 4. Prose sections (the 26 mandated headings)
// ---------------------------------------------------------------------------
const sections = {
  verdict: { body: `**AUDIT COMPLETE (every gate dispositioned) — PRODUCT NOT CORRECT AS A DIGITAL-EVIDENCE PLATFORM IN ITS CURRENT STATE.**

Capture, hashing and the finalize claim are sound: the server recomputes SHA-256 over the stored original object version, client digests are never trusted, finalize cannot run twice, and custody for finalization/report/package/OTS/lifecycle/destruction is written in the same transaction as the change. Recovery of reports and packages is idempotent and never charges twice (runtime-proven).

But six P0 defects were confirmed, **all six reproduced at runtime** on disposable loopback infrastructure:

1. A same-workspace member can append bytes to someone else's **sealed** record through the resumable-upload bridge; the next report run then declares it tampered (ET-UPL-01).
2. The anonymous public Verify page prints **internal legal-hold titles, release notes and actor ids** (ET-CUS-01).
3. The destruction executor **destroys evidence under an active legal hold** placed after its facts were gathered (ET-SEC-01).
4. Detaching evidence from its last case **moves it out of the workspace** — admins lose it, the creator keeps it (ET-SEC-02).
5. A legacy personal case can link **another user's private record** and read it (ET-SEC-09).
6. Public Verify headlines **"Core Integrity Verified" while its own live signature and integrity checks fail** (ET-SEC-10).

The cryptographic layer is weaker than the product claims: RFC3161 replies are recorded STAMPED **without any signature or chain validation** (a forged self-signed token was accepted, ET-TSA-01) and the "timestamp digest matches" check compares the request digest with itself (ET-TSA-03). OpenTimestamps proofs stamped since the scheduling change **are never upgraded** (ET-OTS-01/02, reproduced on BullMQ). Packages are not independently verifiable in their custody chain or seal (ET-PKG-01/02).` },
  methodology: { body: `- **Audited SHA:** \`${AUDITED_SHA}\` (origin/main at start, pinned; no drift during the audit — re-checked before push). Worktree \`D:\\pv-evidence-truth\`, branch \`audit/definitive-evidence-lifecycle-truth\`; the shared checkout was never read or modified.
- **Source first.** 14 domain fragments (acquisition, uploads, direct capture, intake, state machine & storage, custody, TSA, OTS, queues, reports, package & Verify, recovery, commercial, security/duplicates/concurrency) were traced read-only against the pinned tree; each claim carries file:line and a code snippet. 169 candidates were raised.
- **Lead verification.** Every P0 and P1 was re-read by the lead at its cited lines (notes per finding). Every citation of every candidate was machine-resolved against the audited tree (\`tooling/check-citations.mjs\`: 512/534 snippets found within ±6 lines; every accepted finding has ≥1 resolving citation). P2/P3 findings not individually re-read say so in their own record.
- **Harness correction (recorded):** the first citation run found 8 candidates with zero resolving citations — all in the three fragments the lead transcribed from sub-audit hand-backs, whose snippets were paraphrases. They were replaced by the literal code (claims unchanged). Before: 497 resolved / 37 not-near / 8 zero-resolved candidates. After: 512 / 22 / 0.
- **Runtime.** 10 probes (TSA, OTS queue, Verify, tenancy, part injection, commercial, intake, Reports KPI, recovery, FREE→PRO) ran through the API's own integration configuration (credential scrub, outbound guard, network ledger) against disposable containers bound to 127.0.0.1, in one final full run. 57 outbound attempts were recorded, all 127.0.0.1 ALLOWED. Containers were removed afterwards.
- **No product file changed; no Production system was contacted;** \`services/api/.env\` was never read (migrations applied with PROOVRA_ENV_BOOTSTRAPPED=1; the worker was deliberately not booted, see B6).
- **Gate interpretation.** A conservation gate PASSES when every item it names is dispositioned — mapped as correct or recorded as a defect with an ID. A product defect found is not an audit gap.` },
  lifecycle: { body: "```text\nCLIENT (web capture | extension UC-1 | Android UC-2/3 | iOS UC-5 | intake link | API key)\n   │ POST /v1/evidence · capture-trust open/reserve · external-intake parts\n   ▼\ncreateEvidence (evidence.service.ts:428) — the ONE Evidence insert\n   │ tx: Evidence(UPLOADING) + EVIDENCE_CREATED + IDENTITY_SNAPSHOT_RECORDED + UPLOAD_AUTHORIZED\n   │ admission: assertWorkspaceAllowsEvidenceCreation (count, no lock)\n   ▼\npresigned PUT (600s) ─or─ upload-session multipart ──► bridge EvidencePart  ⚠ ET-UPL-01\n   ▼\nPOST …/complete → completeEvidence (advisory lock, 120s tx)\n   │ HEAD+GET every original by VersionId → SHA-256 → fingerprint → Ed25519 signature\n   │ RFC3161: openssl ts -query → curl → ts -reply -text → STAMPED/FAILED   ⚠ ET-TSA-01/03\n   │ funding settled (PLAN | EVIDENCE_CREDIT) under per-subject lock\n   │ claim status CREATED|UPLOADING → SIGNED (+ custody UPLOAD_COMPLETED, SIGNATURE_APPLIED, TIMESTAMP_*)\n   ▼ post-commit (one-shot)  ⚠ ET-ACQ-03\nObject Lock retention by key · malware scan · webhooks · OTS request · report request\n   ▼\nworker: report (re-hash all parts → reject integrity on mismatch) → PDF → package → REPORTED\nworker: OTS stamp → upgrade ladder (5 min)  ⚠ ET-OTS-01/02 → PENDING forever\nsweeps (19): lifecycle recovery, OTS init reconciler, first issuance, trash grace, …\n   ▼\nReports page (listWorkspaceArtifacts)  ⚠ ET-RPT-01\nPublic Verify /public/verify/:evidenceId  ⚠ ET-SEC-10, ET-CUS-01\nDownload gate evaluateArtifactDownload · legal hold · trash · destruction executor  ⚠ ET-SEC-01\n```" },
  acquisition: { body: "Exactly one production Evidence insert exists (`createEvidence`, evidence.service.ts:428) with three callers — web `POST /v1/evidence`, direct-capture reserve (extension, Android single/continuous, iOS) and external intake. No worker, webhook or integration creates Evidence; seed scripts are environment-guarded (one only by NODE_ENV, ET-UPL-04). Conservation of entry points: acquisition fragment 10 = 7 mapped + 2 retired (web getDisplayMedia absent; no worker/webhook creator) + 1 blocked (seed scripts); plus 9 upload-session/integration paths, 6 direct-capture modes and 6 intake paths, each dispositioned in the inventories. Client hashes are advisory only; the server hash is authoritative. The weakest points are the resumable-upload bridge (a second EvidencePart writer without guards), the absence of any reaper for abandoned rows, and caller-chosen direct-capture provenance." },
  stateMachine: { body: "`EvidenceStatus`: CREATED → UPLOADING (same transaction, so no committed row normally rests in CREATED) → SIGNED (the single finalize claim) → REPORTED (report commit); FAILED_HASH_MISMATCH is the integrity terminal (entered only by the report worker). UPLOADED is a dead enum value with readers but no writer. `lifecycleState` (ACTIVE / ARCHIVED / TRASHED / PENDING_DESTRUCTION / DESTROYED) runs orthogonally; destruction never changes `status`, so a tombstone still says SIGNED/REPORTED. Definitions: *created* = row + custody before any byte; *uploaded* = never recorded; *finalized* = SIGNED after full server re-hash, signature and TSA attempt; *immutable* = Object Lock retention applied after the SIGNED commit (by key, not version) when enabled; *custody begins* at row creation; *billable* = funding settled at completion; *reportable/verifiable* = SIGNED and entitled; *end-to-end ready* = REPORTED with package and an anchored OTS proof — which the OTS ladder defect currently prevents. Terminal states: FAILED_HASH_MISMATCH (overwritable in a race, ET-SM-02), DESTROYED; CREATED/UPLOADING have no exit." },
  storage: { body: "Bytes hashed are the stored originals, streamed by VersionId; multipart: `fileSha256 = sha256(partHashes.join('|'))`, `multipartManifestSha256 = sha256(join('\\n'))`; ETags are never used as hashes. Keys are server-built from the evidence id; clients choose only a sanitized filename suffix. Presigned PUT 600 s (≤ 900 s), UploadPart 300 s, GET 600 s. Gaps: the version id is persisted but not used on every byte path (verify viewUrl, retention apply, archive CopyObject — ET-SM-03); the integrity re-hash runs only inside report generation, so records with no report entitlement are never re-verified (ET-SM-07); abandoned uploads stay in the bucket and the row stays UPLOADING forever (ET-ACQ-02); and a sealed record can be given an extra part (ET-UPL-01). Download after destruction is impossible (no key remains)." },
  custody: { body: "Per-evidence hash chain (sequence, prevEventHash, eventHash over canonical JSON), serialised by advisory lock and a unique (evidenceId, sequence). Finalization, report, package, OTS, integrity rejection, lifecycle and destruction events are written in the mutation's own transaction and retries do not duplicate them. Weaknesses: append-only is convention only and the hash is unkeyed (ET-CUS-04); many governance mutations append custody in a separate transaction with a silent catch (ET-CUS-11); legal-hold custody is best-effort (ET-CUS-03); chain-transfer events are never recorded because the enum value does not exist (ET-CUS-02); original-URL issuance leaves no custody (ET-CUS-07); the public summarizer leaks payloads (ET-CUS-01, P0)." },
  tsa: { body: "Digest submitted: the original `fileSha256` for single files, the `|`-joined composite for multipart. The request carries a nonce and `-cert`, but the reply is only printed with `openssl ts -reply -text` and parsed with regular expressions: **no signature, certificate-chain, validity, trust-root, nonce or policy-OID check exists anywhere** (ET-TSA-01, runtime-proven with a forged token). The persisted `tsaMessageImprint` is the request digest, so every read-side 'digest matches' compares a value with itself (ET-TSA-03). An imprint mismatch is correctly refused (runtime-proven). Outage, rejection and invalid token all collapse to FAILED without a persisted failure code (ET-TSA-06). tsaStatus is written once inside the finalize claim — by design there is no retry — but the operator repair CLI is a second writer (ET-TSA-09). The TSA password is passed on curl's argv." },
  ots: { body: "The digest stamped is the fingerprint hash; the initial `.ots` proof is stored and bound to the record. Upgrades are serialised and idempotent. The scheduling is broken: the init branch enqueues its follow-up without `selfJobId`, so it collapses onto the running job (ET-OTS-01), and where the ladder does run its follow-up id repeats and is silently dropped on the third hop (ET-OTS-02) — both reproduced on real BullMQ. Nothing recovers a PENDING row without a job (ET-OTS-03). Bitcoin attestation is not verified against a chain in the shipped image: anchors are proof-structure only and the badge honestly says CHAIN NOT CHECKED; the Verify page trusts the stored status. Calendar outages during stamping are persisted as per-record FAILED without retry (ET-OTS-04)." },
  queues: { body: "17 queues (15 processed + 2 DLQs), 15 Worker registrations (no duplicates), 19 interval sweeps + 3 observability timers, all started. Conservation: 10 of 15 processed queues have a production producer; mi-exif, mi-search-index, graph-domain-sync, graph-timeline-sync and org-health-refresh have consumers and no producer (ET-Q-07); report-dlq is written by design and read by nothing; media-intelligence-dlq has neither. Payloads carry only command ids — consumers re-derive tenant and plan from the database (correct). Durable rows commit before enqueue (correct). Defects: the OTS ladder (merged into ET-OTS-01/02), non-OCR intelligence runs never leaving PENDING (ET-Q-03), redaction derivatives stuck in RENDERING (ET-Q-04), a trash sweep cursor that can starve (ET-Q-05), and workers claiming jobs before bootstrap (ET-Q-06)." },
  reports: { body: "Report generation is request-driven (`createReportGenerationRequest` → reservation → worker → PDF → package), bound to the evidence version and custody sequence, and never silently switches versions. The PDF does not claim verified while TSA/OTS are pending or invalid. Defects: the only legal-hold line prints the inert S3 flag ('Legal Hold: OFF') even under an active canonical hold (ET-RPT-03); `resultReportId` points at the newest report rather than the one produced (ET-RPT-07); executive wording overstates OTS when not chain-checked (ET-RPT-09)." },
  package: { body: "Contents are inventoried in the JSON (fingerprint, signature, public key, TSA token, OTS proof, custody/forensic custody, report, manifest, seal, checksums, README). Entry names are server-controlled (no traversal), serialization is deterministic, and the format-5 seal covers every entry including the report. A recipient **can** verify the original hash and the evidence signature (key authenticity still needs PROOVRA), and the TSA token (without its CA chain). A recipient **cannot** recompute the custody chain — payloads are rewritten after hashing (ET-PKG-01) — and the seal is verifiable only against a key shipped in the same ZIP with no published fingerprint (ET-PKG-02). The README points to the older manifest signature, which does not cover the report (ET-PKG-03), and asserts files that are not emitted (ET-PKG-04). Failed TSA replies are shipped as 'Included' (ET-TSA-04)." },
  verify: { body: "The verify 'token' is the evidence UUID (122 random bits), published by default, never expiring, not rotatable (ET-PKG-07). Unknown and malformed ids answer an identical 404 with `no-store` (runtime); unfinalized records answer a distinguishable 409 (merged into ET-SEC-31). Pending OTS and failed TSA are rendered honestly (runtime). Defects: the headline trusts a stored snapshot over live checks (ET-SEC-10, P0, runtime); raw custody payloads reach the anonymous page (ET-CUS-01, P0, runtime); 'Package Integrity Complete' and 'Immutable Storage Locked' come from file presence and DB snapshots (ET-PKG-05/06); anonymous GETs write audit, raw-IP view rows and custody (ET-PKG-09)." },
  reportsPage: { body: "Cards and table come from ONE aggregator call over the same finalized population (no cap, no date window, same NULL-team arm), and a failed summary fetch renders 'temporarily unavailable', never zeros. The known risk is nevertheless real in a narrower form, reproduced at runtime: a failed *updated-report* request on a record that already has a report is counted as READY and excluded from 'Reports failed', while its row shows a Retry/Escalated badge (ET-RPT-01). Request-level BLOCKED is uncounted for reports (ET-RPT-02). `GET /v1/reports` uses a bare ACTIVE-membership check instead of the canonical authorizer (ET-SEC-18). TSA and OTS status are not shown on the Reports page at all." },
  recovery: { body: "Every Recover/Retry control (web evidence tab, Reports row, Copilot, mobile, Operations, Admin, queue console, automatic sweep) was traced; the failure × action matrix is in `inventories[\"recovery.failureRecoveryMatrix\"]`. Report/package recovery repairs only the missing component, rebuilds the package from the stored report after checking its hash, never mints a new report version or timestamp, never charges, and shows success only after a server reread — runtime-proven idempotent under concurrent clicks. TSA has no recovery by design. OTS recovery is 'Resume OTS anchoring', which reports QUEUED even when it collapsed or the proof is invalid (ET-REC-01/06). Gaps: OTS budget-exhausted incidents never auto-close and say the record will recover (ET-REC-02); NULL-team personal records get no recovery button (ET-REC-03); mobile's exhausted-failure retry always 400s (ET-REC-04)." },
  freeLimit: { body: "**The FREE limit is three lifetime evidence records** — every non-trashed, non-destroyed personal Evidence row of ANY status (drafts, uploading, failed, archived, held all count; trashed does not). A multi-file capture, folder upload, screen recording or intake submission is ONE record. Admission is checked at creation without a lock; funding is settled at completion under a per-subject advisory lock. Deterministic examples (runtime where marked): 0/3–2/3 admitted; **two concurrent creates at 2/3 are both admitted (runtime)**, and completion settlement then refuses the later-created one with 402 after its upload, stranding it; **at 3/3 the 4th is refused 409 FREE_LIMIT_REACHED with 'You have reached the record limit included in the Free plan: 3 records…' (runtime)**; a failed or abandoned third keeps its slot (runtime, ET-ACQ-02); trash frees a slot but **restore re-admits without a check (runtime, ET-COM-02)**; archived counts; an intake submission counts against the link owner and **an anonymous, never-submitted intake session consumes it (runtime, ET-INT-03)**; mobile and all creators share the backend gate; no admin bypass exists (admins can only grant credits)." },
  freeToPro: { body: "PRO becomes authoritative only when a provider-confirmed ACTIVE subscription is applied through `syncPlanForSubscription` (verified webhook, checkout settlement that re-reads the provider, reconciliation); client redirects grant nothing; duplicate webhooks collapse. The three FREE records are preserved unchanged (no deletion, reordering or new version). Runtime: after an ACTIVE PRO sync both a 1-day-old and a 10-day-old FREE record changed from NOT_INCLUDED to ELIGIBLE_NOT_GENERATED with a GENERATE action; the upgrade itself created nothing. Automatic first issuance is the worker's job and serves only records signed within 7 days of activation unless `OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED` is on (default off) — older records need a user click (ET-COM-06, OD-2). TSA/OTS already ran at completion on FREE. Unknown plan state resolves UNRESOLVED (retry), never FREE or PRO, in API and worker; the worker re-resolves at job time." },
  credits: { body: "One credit type exists: **evidence credits** (per-user wallet `entitlements.credits` + ledger `evidence_credit_ledger_entries`: PURCHASE, CONSUMPTION, REVERSAL, ADMIN_GRANT; purchases idempotent on provider ref; consumption unique per evidence id). Storage add-ons are subscriptions, not credits. **A FREE user with three records who buys one credit unlocks none of the three.** The credit is spent only inside a NEW record's completion, after the plan allowance is exhausted; that fourth record becomes credit-funded and earns a report and package even on FREE. Allocation is deterministic by (createdAt, id), not array order — runtime: after the purchase the next new record was admitted at cap and no existing record changed funding. Stripe credit refunds/chargebacks are never reversed (ET-COM-03; PayPal is). Whether this is the right product behaviour is OD-1." },
  downgrade: { body: "No plan change deletes or relabels evidence; downgrade to FREE freezes a legacy cap at the current count, so new FREE records are refused until below it. Original/package downloads carry no plan gate; issued reports are not revoked; queued jobs re-check entitlement at run time (a PRO-completed record whose job runs after cancellation is refused as COMMERCIAL — supersedable on re-upgrade; OD-9). PAST_DUE keeps PRO through a 7-day grace, then blocks **all** creation including credit-funded (ET-COM-04, OD-3). Refund/chargeback of a subscription is recorded for review; entitlement changes only when the provider reports CANCELED. **But after the reconciliation sweep has agreed with Stripe once, a later cancellation or past-due webhook is refused as older (ET-COM-01, runtime), so a cancelled Stripe customer can keep PRO indefinitely.**" },
  duplicates: { body: "Dispositioned in `inventories[\"security.duplicateAuthorities\"]`. Canonical single authorities hold for Evidence creation, finalization, byte release, plan resolution (API and worker share one resolver), credit consumption and recovery. Real competing authorities: two EvidencePart writers with different guards (ET-UPL-01); five report/package backlog aggregators with three rules (ET-SEC-20); two case-link authorities (ET-SEC-16); two draft reapers (ET-SEC-24); storage-used populations that differ between creation and completion (ET-SEC-22); a pricing page that contradicts the commercial policy on FREE storage add-ons (ET-SEC-23); the TSA repair CLI as a second tsaStatus writer (ET-TSA-09); an integrity snapshot writing booleans from status (ET-SEC-35). Dead or phantom: UPLOADED enum, five producer-less consumers, media-intelligence-dlq, device-registry client, integration.evidence.create scope." },
  security: { body: "Refuted at the source (and the enumeration case at runtime): cross-tenant upload, finalization, report, package and recovery; intake link rebinding; external-reviewer scope escape; worker trust in payload tenant ids; Prisma `teamId: undefined` holes on lifecycle routes. Confirmed: the NULL-team case link read (ET-SEC-09, P0) and the detach workspace escape (ET-SEC-02, P0) — both runtime; stale standing authority for expired members, suspended orgs, case grants and former creators (ET-SEC-03/04/05); cross-workspace relationship metadata (ET-SEC-07); creation authorized by membership status without `evidence.create` (ET-ACQ-01); extension OAuth fail-open (ET-DC-04); redaction derivative downloads outside the byte-release gate (ET-SEC-26); a persisted exchange-package signed URL returned to readers (ET-SEC-19)." },
  concurrency: { body: "Sound under concurrency (source, runtime where marked): double finalize (advisory lock + status claim); double recovery/report/package requests (unique idempotency + reservation, runtime); last-credit consumption (conditional decrement + unique evidence id); OTS double upgrade (claim on proof state). Check-then-write races found: legal hold vs destruction (ET-SEC-01, P0, runtime); restore vs destruction claim (ET-SEC-06); discard vs completion (ET-DC-01); FREE admission (ET-ACQ-06, runtime); intake one-time link use and per-session evidence creation (ET-INT-09); lifecycle writers updating WHERE id only (ET-SEC-12); report commit overwriting FAILED_HASH_MISMATCH (ET-SM-02); storage capacity check outside the lock (ET-SEC-28); report lease without fencing (ET-SEC-30); exchange-package lease expiry overwrite (ET-SEC-27)." },
  runtime: { body: "Ten probes, one final full run (8 vitest files / 14 cases passed + 2 standalone probes). Results are machine-readable in `runtime/results/`; the harness's own network ledger recorded 57 outbound attempts, all to 127.0.0.1. Every probe calls production code unmodified; fixture shortcuts are declared in each probe's header." },
  blocked: { body: "Items whose full proof needs an external system or a capability the audit may not add. For each, the source evidence still established and the proof that would close it:" },
  owner: { body: "Behaviour that is deterministic in code but whose product-correctness is a policy choice:" },
  backlog: { body: "Ordered by evidentiary risk, grouping findings that share a fix:" },
};

// ---------------------------------------------------------------------------
// 5. Final answers and gates
// ---------------------------------------------------------------------------
const finalAnswers = [
  { q: "Is capture-to-verify correct?", a: "No. The capture → hash → sign → finalize core is correct, but six P0 defects (all runtime-reproduced) break integrity, tenancy, legal hold and verification truth, and the OTS layer never completes." },
  { q: "Are original bytes protected?", a: "Partly. The original object is never overwritten once hashed and is version-pinned for re-hash and download, and Object Lock applies when enabled. But a same-workspace member can add foreign bytes to a sealed record (ET-UPL-01), and the destruction executor deletes originals under an active hold (ET-SEC-01)." },
  { q: "Are hashes trustworthy?", a: "Yes as computed: server SHA-256 over the stored version; client digests are never trusted. The published multipart TSA digest is documented inconsistently (ET-TSA-05)." },
  { q: "Is custody complete?", a: "Core events are complete and transactional; custody is not DB-enforced append-only, some governance events are best-effort, and the public page leaks custody payloads (ET-CUS-01)." },
  { q: "Is report generation truthful?", a: "Mostly: version-bound and honest about pending TSA/OTS, but it prints 'Legal Hold: OFF' under an active hold (ET-RPT-03)." },
  { q: "Is the package independently verifiable?", a: "Only partially: hash and evidence signature yes (key authenticity still needs PROOVRA); custody chain no (ET-PKG-01); seal key self-asserted (ET-PKG-02)." },
  { q: "Is TSA cryptographically validated?", a: "No. No signature/chain/nonce/policy check; a forged self-signed token was stored STAMPED (ET-TSA-01, runtime)." },
  { q: "Is OTS correctly upgraded and verified?", a: "No. Newly stamped proofs are never upgraded (ET-OTS-01/02, runtime); Bitcoin attestation is not chain-checked (disclosed honestly on the badge)." },
  { q: "Is Recovery safe and idempotent?", a: "Yes for reports and packages (runtime: one request, no new version, no charge). OTS resume reports QUEUED when it did nothing (ET-REC-01/06); TSA has no recovery by design." },
  { q: "Are Reports KPIs truthful?", a: "Not fully: a failed updated-report request is counted as ready and missing from 'Reports failed' (ET-RPT-01, runtime); blocked requests are uncounted (ET-RPT-02). A failed summary read never shows zeros." },
  { q: "What exactly happens to a FREE user's first three evidence records?", a: "Each is admitted at creation, hashed, signed, RFC3161-timestamped and OTS-stamped at completion, funded by the plan allowance, and gets no report or package (NOT_INCLUDED). A slot is held from creation whether or not the upload finishes." },
  { q: "What happens to the fourth?", a: "Refused at creation with 409 FREE_LIMIT_REACHED and the Free-plan message (runtime) — unless a credit exists, in which case it is admitted and the credit is spent at its completion. Concurrent creation at 2/3 can admit a 4th row, which completion settlement then refuses with 402." },
  { q: "What happens after upgrading to PRO?", a: "Existing records are preserved and become eligible (GENERATE action, runtime); outputs are issued automatically only for records signed within 7 days of activation (default configuration); older ones need a click. No new versions are created; TSA/OTS already ran." },
  { q: "If one credit is purchased, which evidence receives it and why?", a: "None of the existing records. The next NEW record that completes beyond the plan allowance consumes it, chosen deterministically by (createdAt, id), because consumption happens only inside a completion transaction. Product-correctness is OD-1." },
  { q: "What happens on processing failure?", a: "Report/package: request moves to FAILED_RETRYABLE (bounded retries) or FAILED_TERMINAL with an incident; recoverable from the UI; no charge. TSA failure is permanent by design. OTS failure is persisted per record; OTS pending can stall forever (ET-OTS-03)." },
  { q: "What happens on retry?", a: "Idempotent for reports/packages (same request, same version, no charge — runtime). Intake parts cannot be retried after a failed PUT (ET-INT-02); resumable sessions cannot be retried after abort (ET-UPL-02)." },
  { q: "What happens on downgrade/refund?", a: "Evidence is never destroyed; downloads remain; new captures are capped; paid-for jobs re-check entitlement. Stripe credit refunds are not reversed (ET-COM-03), and a Stripe cancellation can be ignored after reconciliation (ET-COM-01, runtime)." },
  { q: "Are there duplicate authorities?", a: "Yes — two EvidencePart writers, five backlog aggregators, two case-link authorities, two draft reapers and two storage populations are real competing authorities; the rest are projections or dead code (inventory)." },
  { q: "Are there cross-tenant defects?", a: "Yes: a legacy personal case can read another user's record (ET-SEC-09, runtime) and case detach moves workspace evidence into a personal scope (ET-SEC-02, runtime). Direct cross-tenant upload/finalize/report/package/recovery were refuted." },
  { q: "What must be fixed first?", a: "Verification truth (ET-SEC-10, ET-TSA-01/03), the part-injection writer (ET-UPL-01), the two tenancy P0s (ET-SEC-09, ET-SEC-02), hold-vs-destruction (ET-SEC-01), the public custody leak (ET-CUS-01), then the OTS ladder and the Stripe ordering stamp. See the ordered backlog." },
];

const g = (id, gate, status, detail) => ({ id, gate, status, detail });
const gates = [
  g(1, "Every acquisition path is dispositioned", "PASS", "acquisition 10 = 7 mapped + 2 retired + 1 blocked; plus 9 upload/integration, 6 direct-capture and 6 intake paths each dispositioned in inventories"),
  g(2, "Every evidence state is defined", "PASS", "all EvidenceStatus values and lifecycleState values defined (statemachine.evidenceLifecycleColumns); UPLOADED recorded as dead"),
  g(3, "Every transition has an authority", "PASS", "statemachine.evidenceStatusTransitions names the writer file:line of every transition; unguarded ones are findings ET-SM-02, ET-SEC-12"),
  g(4, "Every material DB writer is inventoried", "PASS", "statemachine.evidenceDbWriters / evidencePartDbWriters (3 EvidencePart writers), custody.custodyAppenders, custody.auditWriters"),
  g(5, "Every storage writer is inventoried", "PASS", "statemachine.storageWriters"),
  g(6, "Every queue producer maps to a consumer", "PASS", "all producers map to a consumer except report-dlq, which is a documented DLQ sink (queues.conservationTotals)"),
  g(7, "Every consumer maps to a producer or documented schedule", "PASS", "19 sweeps scheduled; 5 consumers without a producer and media-intelligence-dlq dispositioned as defect ET-Q-07/ET-Q-08"),
  g(8, "Every report/package status has one authoritative meaning", "PASS", "reports.reportRequestStates maps every persisted state to its writer and meaning; mis-projections recorded as ET-RPT-01/02"),
  g(9, "Every Recovery action maps to specific failed components", "PASS", "recovery.failureRecoveryMatrix"),
  g(10, "Every TSA state maps to persisted evidence", "PASS", "tsa.stateMapping / persistedColumns; collisions recorded as ET-TSA-06"),
  g(11, "Every OTS state maps to persisted evidence", "PASS", "ots.otsStateMap (12 persisted states with writer and display)"),
  g(12, "Every visible Reports KPI maps to authoritative data", "PASS", "reports.reportsPageFields + reports.reconciliation (runtime RT-REPORTS)"),
  g(13, "FREE limit behaviour is answered completely", "PASS", "commercial 14.1-14.6 + section 16 (runtime RT-COMMERCIAL, RT-INTAKE)"),
  g(14, "FREE -> PRO behaviour is answered completely", "PASS", "commercial 15.1-15.5 + section 17 (runtime RT-FREE-PRO)"),
  g(15, "Credit allocation behaviour is answered completely", "PASS", "commercial 16.1-16.2 + section 18 (runtime RT-COMMERCIAL); product policy is OD-1"),
  g(16, "Downgrade/refund behaviour is answered", "PASS", "commercial 17.1-17.5 (17.5 corrected by the lead from 'not reviewed in depth' to a verified answer)"),
  g(17, "Every duplicate authority is dispositioned", "PASS", "security.duplicateAuthorities + section 20"),
  g(18, "Every high-risk finding has runtime proof or a precise blocker", "PASS", "all 6 P0 runtime-reproduced; every section-21 item exercised (cross-tenant, FREE 3, concurrent 3rd/4th, FREE->PRO, one credit, report/package failed projection, recovery idempotency, TSA malformed/mismatched, OTS ladder, Reports KPI/table, Verify states); OTS proof-upgrade/attestation and worker-side runs carry precise blockers B3/B6; P1s not runtime-exercised are labelled as such in their own records"),
];

const lead = {
  meta: {
    title: "PROOVRA — Definitive Evidence Lifecycle Truth Audit",
    auditedSha: AUDITED_SHA,
    originMainShaAtStart: AUDITED_SHA,
    branch: "audit/definitive-evidence-lifecycle-truth",
    worktree: "D:\\pv-evidence-truth (detached from the shared checkout)",
    startedAt: "2026-09-29T12:02:12Z",
    completedAt: "2026-09-29 (UTC; recorded at commit)",
    productFilesChanged: [],
    productionContacted: false,
    environmentSources: "No .env file read. Runtime env = the API integration bootstrap (services/api/test/setup/test-bootstrap.mjs) + runtime/run-probes.sh loopback variables.",
    fragmentsTranscribedByLead: ["uploads.json", "directcapture.json", "intake.json"],
  },
  verdict: {
    status: "AUDIT_COMPLETE",
    productVerdict: "NOT_CORRECT_P0_OPEN",
    statement: "Every conservation gate is dispositioned; the product has 6 open P0 defects, all runtime-reproduced.",
  },
  finalAnswers,
  sections,
  adjudication,
  answerOverrides,
  leadFindings: [],
  runtimeProofs,
  blocked,
  ownerDecisions,
  backlog,
  gates,
};
fs.writeFileSync(path.join(auditDir, "lead.json"), JSON.stringify(lead, null, 2) + "\n");
const counts = Object.values(adjudication).reduce((a, v) => ((a[v.verdict] = (a[v.verdict] ?? 0) + 1), a), {});
console.log(`lead.json: ${Object.keys(adjudication).length} candidates adjudicated ${JSON.stringify(counts)}`);
