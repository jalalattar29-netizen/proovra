/**
 * ET-PKG-05 — the public Verify package badge rests on the seal.
 *
 * "Package Integrity Complete / Independent Review Enabled" was computed from
 * artifact-presence flags alone, so an unsealed legacy package got the success
 * badge; and a package that EXISTED but was partial was described as absent.
 *
 * Converged 2026-10-18: the client no longer decides the package state at
 * all. The card prints the server's sealCheck / sealStatement /
 * completenessCheck / completenessStatement (resolvePackageSealCheck — the
 * same authority the matrix's package rows print), and the client rebuild
 * (buildVerificationPackageIntegrity, which dropped sealCheck and credited
 * exports from event counts) is gone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../app/verify/[token]/page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("../app/verify/[token]/VerifyRecordSections.tsx", import.meta.url), "utf8");
const card = sections.slice(
  sections.indexOf("export function PackageIntegrityCard("),
  sections.indexOf("// Consistency with the issued artifact"),
);

test("ET-PKG-05: the card prints the server's seal and completeness checks verbatim", () => {
  assert.match(card, /<StatusMark status=\{integrity\.sealCheck\}/);
  assert.match(card, /\{integrity\.sealStatement\}/);
  assert.match(card, /<StatusMark status=\{integrity\.completenessCheck\}/);
  assert.match(card, /\{integrity\.completenessStatement\}/);
  assert.match(card, /<QualifierList qualifiers=\{integrity\.sealQualifiers\}/);
  assert.match(card, /data-print-avoid-break/);
});

test("ET-PKG-05: no client verdict on the package — no 'Complete' badge computed from presence flags", () => {
  assert.ok(!card.includes("Package Integrity Complete"));
  assert.ok(!card.includes("Independent Review Enabled"));
  assert.doesNotMatch(page + sections, /function buildVerificationPackageIntegrity\(/);
  assert.doesNotMatch(page + sections, /forensicEventCount > 0|accessEventCount > 0/);
});

test("ET-PKG-05: the page hands the API's package integrity to the card unchanged", () => {
  assert.match(page, /<PackageIntegrityCard integrity=\{data\.verificationPackageIntegrity \?\? null\} \/>/);
});
