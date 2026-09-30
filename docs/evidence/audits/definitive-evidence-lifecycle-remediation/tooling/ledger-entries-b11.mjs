// Authoring helper, batch 11: governance/authorization/integrations/package/
// verify (ET-SEC-17, -18, -25, -32, -34, ET-INT-10, ET-PKG-04, -09, -11, -13,
// -14, -17, ET-OTS-07). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const T = (f) => `services/api/test/${f}`;
const W = (f) => `services/worker/test/${f}`;
const CASEANN = T("case-delete-hold-and-annotation-part.integration.test.ts");
const INTEG = T("integrations-api-actor-and-lifecycle.integration.test.ts");
const PKGRED = "evidence/ET-PKG-04-OTS-07-PKG-14-red-baseline.txt";
const VIEWS = T("public-verify-view-privacy-and-debounce.integration.test.ts");

Object.assign(L.findings, {
  "ET-SEC-17": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The case-deletion hold check caught a store error and answered 'no hold', so the case was hard-deleted and every link detached with the hold state unknown.",
    canonicalAuthority: "legal-hold.service evaluateCaseDeletionHold (clear | held | unavailable); DELETE /v1/cases/:id answers 503 LEGAL_HOLD_STATE_UNAVAILABLE on unavailable",
    obsoleteRemoved: "route-local checkCaseLegalHold in cases.routes.ts",
    redTest: `${CASEANN} [ET-SEC-17] (evidence/ET-SEC-17-32-red-baseline.txt)`,
    greenTest: `${CASEANN} [ET-SEC-17]; ${T("legal-hold-tenant-spread-guard.test.ts")}`,
  },
  "ET-SEC-32": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Only the annotation POST checked that evidencePartId belongs to the record; PATCH accepted any part id.",
    canonicalAuthority: "evidence.routes annotationPartBelongsToEvidence — the one part-ownership check for annotation create and edit",
    redTest: `${CASEANN} [ET-SEC-32] (evidence/ET-SEC-17-32-red-baseline.txt)`,
    greenTest: `${CASEANN} [ET-SEC-32]`,
  },
  "ET-SEC-34": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Three dead exported legal-hold helpers spread teamId only when supplied, so a future caller forgetting it would read holds across every tenant.",
    canonicalAuthority: "legal-hold.service (canonical hold queries always tenant-anchored)",
    obsoleteRemoved: "countActiveCaseHolds, listCaseHolds, countLifecycleHolds",
    greenTest: `${T("legal-hold-tenant-spread-guard.test.ts")} [ET-SEC-34: no symbol anywhere in src; no optional tenant spread]`,
  },
  "ET-SEC-18": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "GET /v1/reports and the /v1/reports/artifacts aggregator admitted any ACTIVE-status membership row (no expiry, permission or organization lifecycle); the unscoped owner arm spanned every team; a primary-query error fell back to a query without the deletedAt/lifecycle filters.",
    canonicalAuthority: "middleware/authorize evaluateAuthorize / authorizeOrFail (evidence.read, antiEnumeration) for both lists; owner arm bounded to legacy NULL-team rows",
    obsoleteRemoved: "the filter-dropping fallback evidence query; the hand-rolled membership status check in requireWorkspaceMember",
    redTest: `${T("reports-list-authorization.integration.test.ts")} (evidence/ET-SEC-18-red-baseline.txt)`,
    greenTest: `${T("reports-list-authorization.integration.test.ts")}; ${T("phase-ia-self-serve-regression-fix.test.ts")}; ${T("phase-32-8-d-cases-reports.test.ts")}`,
  },
  "ET-SEC-25": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The API-key path checked key validity only and never the organization-lifecycle rule, so a suspended organization kept ingesting through its keys.",
    canonicalAuthority: "access-policy.service workspaceLifecycleDenial (shared by evaluateAccess and requireApiKey via loadWorkspaceLifecycleState; fail closed 503)",
    redTest: `${INTEG} [ET-SEC-25] (evidence/ET-INT-10-SEC-25-red-baseline.txt)`,
    greenTest: `${INTEG} [ET-SEC-25: SUSPENDED org key -> 403 ORGANIZATION_NOT_ACTIVE, nothing written]`,
  },
  "ET-INT-10": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The integrations evidence-request / intake-link routes passed the API credential id as the acting User (FK P2003 leaked as a raw 400) and skipped the secure-intake plan gate.",
    canonicalAuthority: "integrations-api.routes integrationActorAndIntakeGate (credential's createdByUserId + assertWorkspaceAllowsIntake); sendIntegrationDomainError (bounded 4xx codes only)",
    redTest: `${INTEG} [ET-INT-10] (evidence/ET-INT-10-SEC-25-red-baseline.txt)`,
    greenTest: `${INTEG} [ET-INT-10: attributed to the creator; FREE -> 409 INTAKE_NOT_INCLUDED; no credential id as user]`,
  },
  "ET-PKG-04": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The signed package manifest hard-coded verifyHtml and verificationScript true after both files were removed from the package.",
    canonicalAuthority: "verification-package buildPackageManifest contents — every flag that can be true maps to an appended entry (exhaustive test)",
    redTest: `${W("package-manifest-contents-truth.test.ts")} (${PKGRED})`,
    greenTest: W("package-manifest-contents-truth.test.ts"),
  },
  "ET-PKG-14": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "A single-file record's root name was derived from its title, so a record titled like a fixed entry (e.g. 'fingerprint') produced a second entry with the same path.",
    canonicalAuthority: "verification-package RESERVED_ROOT_ENTRY_NAMES + avoidReservedRootEntryName (case-folded), kept exhaustive against the appended root entries",
    redTest: `${W("package-entry-name-collision.test.ts")} (${PKGRED})`,
    greenTest: W("package-entry-name-collision.test.ts"),
  },
  "ET-OTS-07": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The package OTS hint told reviewers to run `ots verify opentimestamps-proof.ots`, which looks for a target file the package does not contain.",
    canonicalAuthority: "verification-package decideOtsPackageArtifact verificationHint: `ots verify -d <hash in this file>` (the companion hash is the SHA-256 of the stamped bytes)",
    redTest: `${W("package-readme-seal-instructions.test.ts")} [OTS hint] against a40ca76f (${PKGRED})`,
    greenTest: `${W("package-readme-seal-instructions.test.ts")} [the OTS hint names the digest]`,
  },
  "ET-PKG-11": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "historical-verification-material.json shipped the server's public-key file path or the KMS key id to every recipient and extracted one key for all four purposes.",
    canonicalAuthority: "verification-package-historical-material: publicMaterialRef always null; publicKeySpkiSha256 (publicFingerprintOfPem); per-purpose extraction (PACKAGE_SIGNING_PUBLIC_KEY_PATH for verification_package)",
    redTest: `${W("historical-verification-material.test.ts")} (evidence/ET-PKG-11-red-baseline.txt)`,
    greenTest: W("historical-verification-material.test.ts"),
  },
  "ET-PKG-13": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Public Verify capability URLs had no robots control, and the page's error path sent the token to Sentry.",
    canonicalAuthority: "apps/web verify/[token]/layout.tsx robots noindex; middleware isPublicVerifyCapabilityPath + X-Robots-Tag on every secured response",
    redTest: "apps/web/__tests__/verify-capability-noindex.test.ts (evidence/ET-PKG-13-red-baseline.txt)",
    greenTest: "apps/web/__tests__/verify-capability-noindex.test.ts",
  },
  "ET-PKG-17": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The per-evidence public Verify bucket counted requests shared by every viewer, so two clients could lock a record's page for everyone.",
    canonicalAuthority: "rate-limit.service enforceDistinctClientLimit (atomic Redis set, memory fallback) keyed per record over the trusted client key",
    redTest: `${T("public-verify-distinct-client-limit.integration.test.ts")} (evidence/ET-PKG-17-PKG-09-red-baseline.txt)`,
    greenTest: T("public-verify-distinct-client-limit.integration.test.ts"),
    concurrencyTest: `${T("public-verify-distinct-client-limit.integration.test.ts")} (the Lua script decides admission atomically)`,
  },
  "ET-PKG-09": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Anonymous views stored full viewer IP and user agent with no reader or retention, and the VERIFY_VIEWED debounce decided from a stale read so concurrent first views each appended.",
    canonicalAuthority: "public verify: maskIp network prefix, no user agent; debounce = one conditional updateMany whose winner alone emits VERIFY_VIEWED",
    redTest: `${VIEWS} (evidence/ET-PKG-17-PKG-09-red-baseline.txt)`,
    greenTest: VIEWS,
    concurrencyTest: `${VIEWS} [5 concurrent first views -> exactly 1 VERIFY_VIEWED]`,
    migrationImpact: "20280811000000_verification_views_anonymize: BACKFILL (user_agent -> NULL, ip_address -> masked prefix); idempotent, irreversible by intent",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
