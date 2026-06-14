import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = readFileSync(
  resolve(__dirname, "../app/(app)/evidence/[id]/page.tsx"),
  "utf8",
);

test("published verification url helper gates on PUBLISHED state", () => {
  assert.match(SRC, /function buildPublishedVerificationUrl/);
  assert.match(SRC, /summary\.state !== "PUBLISHED"/);
  assert.match(SRC, /disabled=\{isIntegrityFailed \|\| !shareUrl\}/);
});

test("public verification copy comes from canonical state mapping", () => {
  assert.match(SRC, /function describePublicVerificationState/);
  assert.match(SRC, /Configured but not published/);
  assert.match(SRC, /Not included on plan/);
  assert.match(SRC, /Suspended/);
  assert.match(SRC, /Unpublished/);
});

test("client signal wording distinguishes missing, false, detected, and unavailable", () => {
  assert.match(SRC, /Client signal not collected/);
  assert.match(SRC, /Collected: no signal detected/);
  assert.match(SRC, /Signal detected/);
  assert.match(SRC, /Unavailable for this evidence type/);
  assert.match(SRC, /Screenshot filename heuristic/);
});

test("artifact rendering uses canonical report and package status helpers", () => {
  assert.match(SRC, /function describeReportArtifactStatus/);
  assert.match(SRC, /function describeVerificationPackageStatus/);
  assert.match(SRC, /function describeReportPdfSignature/);
  assert.match(SRC, /function describePackageManifestStatus/);
});

test("artifact polling is scoped to report and package readiness only", () => {
  assert.match(SRC, /function shouldPollArtifactReadiness/);
  assert.match(SRC, /status === "SIGNED" \|\| status === "REPORTED"/);
  // Phase CAPTURE-CLOSURE Part A — polling stops once a plan-gated
  // artifact is unreachable (workspaceCapabilitySnapshot.reportsIncluded /
  // verificationPackageIncluded === false). The predicate is now:
  //   reportNeedsRefresh = reportReachable && !workspace.artifactStatus.report.available
  // (and the symmetric form for the verification package).
  assert.match(
    SRC,
    /reportNeedsRefresh\s*=\s*\n?\s*reportReachable\s*&&\s*!workspace\.artifactStatus\.report\.available/,
  );
  assert.match(
    SRC,
    /!verificationPackage\.available &&\s*!verificationPackage\.blocked &&\s*!verificationPackage\.unavailable/
  );
  assert.equal((SRC.match(/setInterval\(/g) ?? []).length, 1);
});

test("OTS pending stays passive and uses manual one-shot refresh", () => {
  assert.match(SRC, /function isOtsTerminal/);
  assert.match(SRC, /Check latest status/);
  assert.match(SRC, /showManualLatestStatusCheck/);
  assert.doesNotMatch(SRC, /window\.location\.reload/);
  assert.doesNotMatch(SRC, /window\.setInterval/);
});

test("technical readiness wording is separated from workflow lifecycle", () => {
  assert.match(SRC, /Technical Review Readiness/);
  assert.match(
    SRC,
    /Evidence is technically ready; no reviewer workflow has started yet\./,
  );
  assert.match(SRC, /Review workflow/);
});
