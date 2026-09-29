/**
 * ET-PKG-02 / ET-PKG-03 — the package README tells a reviewer how to check a
 * SEALED package, including the one step the seal cannot do for itself:
 * comparing the seal key with the fingerprint PROOVRA publishes.
 *
 * On a40ca76f HOW TO VERIFY ignored the format-5 seal and pointed reviewers at
 * package-manifest.sig (which covers neither the report nor the checksum
 * index), the OTS hint named no digest, and the certification template claimed
 * verification "without reliance on the PROOVRA platform".
 *
 * buildReadme is module-private, so this reads the template source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)), "utf8");
const readme = SRC.slice(SRC.indexOf("function buildReadme("), SRC.indexOf("HOW TO VERIFY") + 4000);

describe("verification package README (ET-PKG-02/03)", () => {
  it("a sealed package is verified by its seal first, with the key checked against Public Verify", () => {
    expect(readme).toContain("${params.chronology ? `2) Verify the seal (this package is sealed, format 5):");
    expect(readme).toContain("the seal key fingerprint\n      PROOVRA shows for this package on the record's Public Verify page");
    expect(readme).toContain("package-manifest.sig covers package-manifest.json only; it does not cover\n   the report or the checksum index.");
    expect(readme).toContain("e. The report named by reportFile must hash to reportSha256.");
  });

  it("an unsealed package says what its manifest signature cannot show", () => {
    expect(readme).toContain("This package is not sealed: package-manifest.sig does not cover the\n   report or package-checksums.json");
  });

  it("the OTS hint names the digest, and no text claims platform-independent key trust", () => {
    expect(SRC).toContain("ots verify -d <hash in this file> opentimestamps-proof.ots");
    expect(SRC).not.toContain("without reliance on the PROOVRA platform");
    expect(SRC).not.toContain("Verify with: ots verify opentimestamps-proof.ots\"");
  });
});
