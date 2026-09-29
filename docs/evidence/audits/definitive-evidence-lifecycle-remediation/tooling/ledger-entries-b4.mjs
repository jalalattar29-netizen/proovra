// Authoring helper, batch 4: TSA (ET-TSA-01..09). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const U = "services/api/test/tsa-token-validation.test.ts";
const I = "services/api/test/tsa-finalize-persistence.integration.test.ts";
const V = "services/api/test/public-verify-tsa-missing-imprint.integration.test.ts";
const C = "services/api/test/phase-ia-tsa-false-failed.test.ts";
const RED = "red on the prior tree: forged / expired-signer / replayed-nonce / corrupted tokens returned STAMPED (evidence/tsa-red-baseline.txt)";
const MIG = "additive 20280802000000_evidence_tsa_validation (4 nullable evidence columns; EXPAND, SAFE_TO_APPLY_NOW; registered in curation, deployment plan, drift allowlist, inventory)";
const EXT = "Production TSA_TRUST_BUNDLE_PATH must be provisioned with the real provider's root before deploy (unset fails closed); validating a real provider token is external proof not available locally";

Object.assign(L.findings, {
  "ET-TSA-01": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "createEvidenceTimestamp persisted STAMPED from `openssl ts -reply -text` output alone; nothing validated the CMS signature, chain, trust anchor, nonce or policy.",
    canonicalAuthority: "services/api/src/services/timestamp/validate-tsa-token.ts validateTsaToken (openssl ts -verify -queryfile -CAfile <env anchor> -attime genTime + accepted policy); presentedTsaStatus (packages/shared) is the one read-side reading",
    obsoleteRemoved: "the text-only granted => STAMPED branch; the read-side positive-status checks now receive the presented status",
    redTest: `${U} [forged, expired signer, wrong nonce, corrupted, policy, no anchor, test anchor in production] (${RED})`,
    greenTest: `${U} (13 cases); ${I} (trusted STAMPED+validated, forged FAILED); ${V} (validated -> verified, legacy -> TOKEN_RECORDED_NOT_VALIDATED); packages/shared/tests/verification-claim-consistency.test.mjs`,
    negativeAuthTests: "forged self-signed token, expired signer, replayed nonce, corrupted signature, policy outside allow-list, unset anchor, test anchor under NODE_ENV=production — all FAILED",
    migrationImpact: MIG,
    compatibilityImpact: "legacy STAMPED rows (no tsa_validated_at_utc) now present as RECORDED_NOT_VALIDATED everywhere until the operator CLI validates their kept token; with no anchor configured new tokens are kept but recorded FAILED tsa_trust_anchor_not_configured",
    remainingExternalProof: EXT,
  },
  "ET-TSA-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "parseTsaReply treated a granted reply with no readable imprint as granted with a warning; a granted status without a token reached the provider-error classifier.",
    canonicalAuthority: "parseTsaReply (missing imprint => tsa_response_parse_failed) + timestamp.service reply stage (openssl 'token not present' => tsa_token_missing)",
    redTest: `${U} [granted_no_token] (red: classified tsa_provider_http_error)`,
    greenTest: `${U} [ET-TSA-02]; ${C} [granted reply with NO readable imprint]`,
  },
  "ET-TSA-03": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "TimestampResult.messageImprint was the digest sent, and both tsaMessageImprint and tsaInputDigestHex were written from it, so every 'imprint matches' check compared a value with itself.",
    canonicalAuthority: "TimestampResult.messageImprint = parsed token imprint; requestDigestHex = digest sent; compareTimestampDigest only answers for a presented (validated) STAMPED",
    obsoleteRemoved: "messageImprint: digestHex in the service; tsaInputDigestHex from messageImprint at finalize and in both custody payloads",
    redTest: `${U} [wrong_imprint: expected token imprint abab.., got the sent digest] (${RED})`,
    greenTest: `${U}; ${I} [token imprint beside request digest]; ${V} [legacy token: timestampDigestMatches null]; phase-ia-digest-policy.test.ts [ET-TSA-03]`,
  },
  "ET-TSA-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The package appended timestamp.tsr whenever tsaTokenBase64 was present, including FAILED replies, and the README called it included.",
    canonicalAuthority: "processor.ts passes timestampToken only when presentedTsaStatus === STAMPED; README describes a not-included unvalidated reply",
    greenTest: "services/worker unit suite (package README/entries); source: processor.ts timestampToken gate",
    compatibilityImpact: "packages for FAILED or legacy-unvalidated records no longer contain timestamp.tsr",
  },
  "ET-TSA-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The package never stated that the RFC 3161 token certifies the '|'-joined multipart composite, and labelled multipartManifestSha256 the reproducible digest.",
    canonicalAuthority: "verification-package README timestamp.tsr section + fileSha256Label state the exact recomputation (per-part lowercase hex in partIndex order joined by '|', SHA-256) and that it differs from multipartManifestSha256",
    greenTest: "services/worker unit suite",
  },
  "ET-TSA-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "failureCode was computed but never persisted; provider outage, rejection and invalid token all read FAILED with free text.",
    canonicalAuthority: "evidence.tsa_failure_code (bounded TimestampFailureCode) written at finalize and in the TIMESTAMP_* custody payload",
    redTest: `${I} (column did not exist on the prior tree)`,
    greenTest: `${I} [tsa_token_untrusted, tsa_message_imprint_mismatch persisted]`,
    migrationImpact: MIG,
  },
  "ET-TSA-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "classifyTsaSubprocessError substring-matched the whole execFile error (argv with user:password, digest, URL); a kill on timeout was never classified as a timeout.",
    canonicalAuthority: "classifyTsaSubprocessError reads killed / curl exit code / HTTP status only; credentials in a 0600 curl config (-K)",
    obsoleteRemoved: "curl -u user:password in argv; message substring matching",
    redTest: `${U} [unreachable provider] (red: tsa_unknown_error)`,
    greenTest: `${U} [ET-TSA-07, credentials absent from the result]; ${C} [credentials never in argv]`,
  },
  "ET-TSA-08": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Report copy promised a 'technical verification endpoint' that does not exist; a docblock claimed a worker ASN.1 TSA parser that does not exist.",
    canonicalAuthority: "report technical-model reference notes point to the package (timestamp.tsr when validated); integrity-snapshot docblock states no parser is wired and names the validator",
    greenTest: "services/worker unit suite; grep: no 'technical verification endpoint' remains in services/apps/packages",
  },
  "ET-TSA-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The repair CLI wrote STAMPED on granted without enforcing its documented serial+genTime precondition and without validating the token; the registry claimed tsaStatus is written only at finalize.",
    canonicalAuthority: "kept-token-validation.ts evaluateKeptTsaToken (same parser + same validator; serial, genTime, imprint required) used by repair-tsa-failed-with-token.ts; remediation-registry names the CLI as the one later writer",
    obsoleteRemoved: "the CLI's own openssl parse + granted-only write path",
    redTest: "source contract on the prior tree: the CLI wrote STAMPED after `if (!parsed.granted)` with no validation (phase-ia-tsa-false-failed.test.ts pinned that shape)",
    greenTest: `${U} [ET-TSA-09 kept-token decision: validated ok; other digest, forged, no anchor, no token refused]; ${C} [ET-TSA-09 source contracts]`,
    compatibilityImpact: "the CLI now also validates legacy STAMPED-unvalidated rows (records tsa_validated_at_utc, no custody event); FAILED->STAMPED appends TIMESTAMP_APPLIED with repair_source tsa_kept_token_validated",
    remainingExternalProof: EXT,
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
