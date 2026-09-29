/**
 * ET-PKG-04 — every `contents` flag the signed package-manifest.json can set
 * true names an entry the generator actually appends.
 *
 * On a40ca76f the manifest asserted verifyHtml: true and verificationScript:
 * true although both files were removed with the offline verifier, so a signed
 * document described files no package contained.
 *
 * Source-contract, for the reason offline-verifier-decommission.test.ts gives:
 * createVerificationPackage cannot run without live governance state, and the
 * ZIP's contents are exactly the appendPackageEntry / appendEvidencePart
 * targets. The map is EXHAUSTIVE — a new flag fails here until its entry is
 * named.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)), "utf8");

/** flag → the entry that must exist whenever the flag can be true. null = the flag must be false. */
const FLAG_ENTRY: Record<string, string | null> = {
  evidenceFiles: "__EVIDENCE_PARTS__",
  fingerprint: '"fingerprint.json"',
  signature: '"signature.txt"',
  publicKey: '"public-key.pem"',
  custody: '"custody.json"',
  timestampToken: '"timestamp.tsr"',
  anchor: '"anchor.json"',
  evidenceManifest: '"evidence-manifest.json"',
  originalLinkage: '"original-linkage.json"',
  duplicateDigests: '"duplicate-digests.json"',
  trustDecision: '"trust-decision.json"',
  forensicCustody: '"forensic-custody.json"',
  accessActivity: '"access-activity.json"',
  reportArtifact: "reportEntryPath",
  courtReadiness: '"court-admissibility-checklist.json"',
  certificationTemplates: '"certifications/custodian-declaration-template.md"',
  verifyHtml: null,
  readme: '"README.txt"',
  actualCertifications: '"certifications/custodian-record.json"',
  packageChecksums: '"package-checksums.json"',
  signedPackageManifest: '"package-manifest.sig"',
  // The HOW TO VERIFY instructions live in README.txt.
  verificationInstructions: '"README.txt"',
  verificationScript: null,
  caseMetadata: '"case-metadata.json"',
  auditAccessReport: '"audit-access-report.json"',
  captureContext: '"capture-context.json"',
  captureContextMapPreview: '"map-preview.png"',
};

function appendedTargets(): Set<string> {
  const out = new Set<string>();
  for (const m of SRC.matchAll(/appendPackageEntry\(\s*archive,\s*packageEntries,\s*([^,]+),/g)) out.add(m[1]!.trim());
  if (/await appendEvidencePart\(archive, packageEntries,/.test(SRC)) out.add("__EVIDENCE_PARTS__");
  return out;
}

function manifestContents(): Array<[string, string]> {
  const fn = SRC.indexOf("function buildPackageManifest(");
  const start = SRC.indexOf("    contents: {", fn);
  const end = SRC.indexOf("\n    },", start);
  expect(fn).toBeGreaterThan(0);
  expect(start).toBeGreaterThan(fn);
  const body = SRC.slice(start, end);
  return [...body.matchAll(/^\s+(\w+):\s*([^,\n]+),/gm)].map((m) => [m[1]!, m[2]!.trim()]);
}

describe("signed package manifest contents (ET-PKG-04)", () => {
  it("the flag map is exhaustive", () => {
    expect(manifestContents().map(([k]) => k).sort()).toEqual(Object.keys(FLAG_ENTRY).sort());
  });

  it("every flag that can be true names an appended entry; the removed files' flags are false", () => {
    const appended = appendedTargets();
    for (const [flag, value] of manifestContents()) {
      const entry = FLAG_ENTRY[flag];
      if (entry === null) {
        expect(value, flag).toBe("false");
        continue;
      }
      expect(value, flag).not.toBe("false");
      expect(appended.has(entry!), `${flag} -> ${entry}`).toBe(true);
    }
  });
});
