// Authoring helper, batch 7: custody (ET-CUS-02..14). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const APPENDER = "@proovra/shared-runtime custody/custody-chain appendCustodyEventTx (the one custody append: lock, head, hash, create)";

Object.assign(L.findings, {
  "ET-CUS-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Chain-of-custody transfer transitions had no custody event type and wrote nothing to the record's chain; the transfer did not bind its evidence to the initiating workspace.",
    canonicalAuthority: `${APPENDER}; chain-transfer.service appendTransferCustodyTx inside each transition's conditional-claim transaction`,
    redTest: `${T("chain-transfer-custody.integration.test.ts")} (evidence/cus02-red-baseline.txt: no CHAIN_TRANSFER event; another workspace's evidence accepted)`,
    greenTest: `${T("chain-transfer-custody.integration.test.ts")} (INITIATED/ACCEPTED/COMPLETED on every record, in order; cross-workspace and cross-organisation refused, nothing appended)`,
    negativeAuthTests: `${T("chain-transfer-custody.integration.test.ts")} [INVALID_EVIDENCE / INVALID_ORGANIZATION]`,
    migrationImpact: "20280804000000_custody_chain_transfer_event: enum value CHAIN_TRANSFER_CUSTODY_EXTENDED (EXPAND)",
  },
  "ET-CUS-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Legal hold place/release appended custody best-effort after commit (silent failure), and CASE/WORKSPACE-scope holds never reached the covered records' chains.",
    canonicalAuthority: "@proovra/shared-runtime governance/legal-hold-custody: appendLegalHoldCustodyTx (in the hold transaction) + reconcileLegalHoldCustody (coverage for EVIDENCE/CASE/WORKSPACE scopes; run on place/release and by the Worker retention reconcile)",
    obsoleteRemoved: "the post-commit best-effort append in legal-hold.service; the stale 'mirrored' docblock in effective-legal-hold.ts",
    redTest: `${T("legal-hold-custody-coverage.integration.test.ts")} (evidence/cus03-red-baseline.txt)`,
    greenTest: `${T("legal-hold-custody-coverage.integration.test.ts")} (every covered record shows place and release; reconcile is idempotent)`,
  },
  "ET-CUS-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "custody_events and admin_audit_logs were append-only by convention only; a fully hash-stripped custody chain verified as valid 'legacy'.",
    canonicalAuthority: "database triggers custody_events_append_only / admin_audit_logs_append_only (proovra_refuse_history_rewrite); evaluateCustodyChain CUSTODY_HASH_REQUIRED_SINCE_UTC (unhashed modern chain = hash_missing)",
    redTest: `${T("custody-append-only.integration.test.ts")} (evidence/cus04-red-baseline.txt: UPDATE/DELETE accepted; stripped chain 'legacy')`,
    greenTest: `${T("custody-append-only.integration.test.ts")} (UPDATE/DELETE refused on both tables; stripped modern chain invalid; genuine pre-hash chain still legacy)`,
    migrationImpact: "20280805000000_custody_append_only: function + two triggers (EXPAND; no row rewritten)",
    compatibilityImpact: "tests that simulate tampering disable the trigger explicitly",
  },
  "ET-CUS-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "API and Worker each had their own admin-audit append with createdAt taken from the local clock, so skew or same-millisecond writes forked the hash chain order.",
    canonicalAuthority: "@proovra/shared-runtime audit/admin-audit-chain appendAdminAuditChainRowTx (createdAt strictly after the head)",
    obsoleteRemoved: "services/worker admin-audit chain copy; services/api/src/lib/admin-audit-chain.ts (git mv to shared-runtime)",
    redTest: `${T("admin-audit-chain-clock-skew.integration.test.ts")} (evidence/cus05-red-baseline.txt)`,
    greenTest: `${T("admin-audit-chain-clock-skew.integration.test.ts")}; ${T("custody-serialization-authority.test.ts")} (single-writer structural guard)`,
    concurrencyTest: `${T("admin-audit-chain-clock-skew.integration.test.ts")} [skewed concurrent writers produce one verifiable chain]`,
  },
  "ET-CUS-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A retried package build selected custody by atUtc rather than by sequence, so events near the cut-off were dropped or duplicated.",
    canonicalAuthority: "services/worker custody-issuance-cutoff custodyThroughIssuance (sequence prefix through the issuance event)",
    redTest: `${T("package-custody-completeness.integration.test.ts")} [the CUS-06 case asserts the prior time-based selection's gap] (evidence/cus09-red-baseline.txt)`,
    greenTest: `${T("package-custody-completeness.integration.test.ts")}`,
  },
  "ET-CUS-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Presigned ORIGINAL URLs from the parts listing, record views and public verify were issued with no custody fact.",
    canonicalAuthority: "artifact-download-gate recordOriginalRelease (channel -> EVIDENCE_DOWNLOADED / VERIFY_VIEWED / EVIDENCE_VIEWED original_url_issued); buildPublicEvidenceContent reports originalUrlsIssued",
    redTest: `${T("original-release-custody.integration.test.ts")} (evidence/cus07-red-baseline.txt)`,
    greenTest: `${T("original-release-custody.integration.test.ts")}`,
  },
  "ET-CUS-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Unlock wrote no custody event, and EVIDENCE_LOCKED meant both the operational lock and the storage retention lock.",
    canonicalAuthority: "evidence.routes lock/unlock conditional claims + custody in one transaction; EVIDENCE_UNLOCKED; custodyEventLabel distinguishes the two EVIDENCE_LOCKED meanings by payload",
    redTest: `${T("custody-lock-and-retention-extension.integration.test.ts")} (evidence/cus08-cus10-red-baseline.txt)`,
    greenTest: `${T("custody-lock-and-retention-extension.integration.test.ts")}`,
    migrationImpact: "20280806000000_custody_unlock_and_retention_extension: enum values (EXPAND)",
  },
  "ET-CUS-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The exchange package custody-chain.json omitted payloads (hashes not recomputable), truncated at 500 and swallowed per-evidence read failures.",
    canonicalAuthority: "services/worker exchange-package-builder: full chain with payloads + hash formula; per-evidence failure throws EXCHANGE_EVIDENCE_READ_FAILED",
    redTest: `${T("package-custody-completeness.integration.test.ts")} (evidence/cus09-red-baseline.txt: 500 of 520 events shipped)`,
    greenTest: `${T("package-custody-completeness.integration.test.ts")} (complete, contiguous, every hash recomputes)`,
  },
  "ET-CUS-10": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Retention auto-extension fired on ANY recent custody event, including anonymous public VERIFY_VIEWED, and left no custody fact.",
    canonicalAuthority: "@proovra/shared RETENTION_ACTIVITY_CUSTODY_EVENT_TYPES (workspace activity only); the retention worker writes RETENTION_AUTO_EXTENDED in the extension transaction",
    redTest: `${T("custody-lock-and-retention-extension.integration.test.ts")} (evidence/cus08-cus10-red-baseline.txt)`,
    greenTest: `${T("custody-lock-and-retention-extension.integration.test.ts")} (public views do not extend; an extension is a custody fact)`,
    migrationImpact: "20280806000000_custody_unlock_and_retention_extension (EXPAND)",
  },
  "ET-CUS-11": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Material governance mutations committed first and appended custody in a separate, silently-caught step.",
    canonicalAuthority: `${APPENDER} in the mutation's transaction (publication, certification, finalization governance, retention sweeper); swallowCustodyAppendError for non-mutating facts`,
    obsoleteRemoved: "the route-level post-commit appends in the certification routes; the .catch(() => null) custody appends",
    redTest: `${T("governance-custody-atomicity.integration.test.ts")} (evidence/cus11-red-baseline.txt)`,
    greenTest: `${T("governance-custody-atomicity.integration.test.ts")}; ${T("custody-append-no-silent-catch.test.ts")} (structural guard: .catch(() => null|undefined|{}) and try { append } catch {})`,
  },
  "ET-CUS-12": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Released redactions and review decisions lived only in unhashed mutable side tables; the emitter claimed a mirror that did not exist.",
    canonicalAuthority: "@proovra/shared REDACTION_CUSTODY_MATERIAL_CODES; emitRedactionActivity + reviewer-audit append REDACTION_RECORDED / REVIEW_DECISION_RECORDED in their transaction",
    obsoleteRemoved: "the false 'mirrored into the audit chain' docblock in redaction-activity.service",
    redTest: `${T("redaction-review-custody.integration.test.ts")} (evidence/cus12-red-baseline.txt)`,
    greenTest: `${T("redaction-review-custody.integration.test.ts")}`,
    migrationImpact: "20280807000000_custody_redaction_and_review: enum values (EXPAND)",
  },
  "ET-CUS-13": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Each surface labelled custody events its own way (web printed raw codes); retention-policy application was a second EVIDENCE_CREATED; the timeline read the OLDEST 500 events and counted that slice.",
    canonicalAuthority: "@proovra/shared custody-labels custodyEventLabel (report, web); RETENTION_POLICY_APPLIED; evidence.routes latestForDisplay + whole-chain counts (review-workspace and public verify)",
    obsoleteRemoved: "the worker's own custody label map (now delegates); the web tab's row.type.replace(/_/g); the second full-chain query in both handlers",
    redTest: `${T("custody-timeline-latest.integration.test.ts")} (evidence/ET-CUS-13-red-baseline.txt: expected 499 to be 510); ${T("custody-append-no-silent-catch.test.ts")} widened (found the intake-lineage silent catch)`,
    greenTest: `${T("custody-timeline-latest.integration.test.ts")}; ${T("custody-label-coverage.test.ts")} (every enum value labelled; no raw code)`,
    migrationImpact: "20280808000000_custody_retention_policy_applied: enum value (EXPAND); historic duplicate EVIDENCE_CREATED rows remain (append-only)",
    compatibilityImpact: "custodyLifecycle gains truncated/displayLimit; the lists are the latest 500 per class",
  },
  "ET-CUS-14": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The tenant-audit envelope had no ip/UA/requestId fields, so callers sealed raw address and user-agent into hashed metadata and requestId stayed null.",
    canonicalAuthority: "platform-audit-log appendPlatformAuditLog liftRequestContextFromMetadata (every row: address/UA to the masked columns; correlationId fills requestId); tenant/platform envelopes carry ipAddress/userAgent/requestId",
    redTest: `${T("audit-request-context-columns.integration.test.ts")} (evidence/ET-CUS-14-red-baseline.txt)`,
    greenTest: `${T("audit-request-context-columns.integration.test.ts")} (route-driven row and facade row; chain verifies); phase5-audit-identity-contract.integration.test.ts`,
    migrationImpact: "none (historic rows stay sealed; mask on read)",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
