/**
 * Offline Verifier decommission — anti-regression guard.
 *
 * The PROOVRA Offline Verifier and all offline/local ZIP-verification are
 * permanently discontinued. This pins that they cannot return, and that the
 * ACTIVE verification experience (Public Verify + core package materials) is
 * preserved.
 *
 * Why source-contract (and not a generated ZIP): `createVerificationPackage`
 * runs a fail-closed package-eligibility gate that throws
 * `PackageGateDeniedError("GOVERNANCE_STATE_UNAVAILABLE")` without live
 * governance/DB state (verification-package.ts), so a real ZIP cannot be
 * produced in a unit test. But the ZIP's contents are ENTIRELY determined by
 * `appendPackageEntry` (the sole wrapper over `archive.append`). Proving no
 * `appendPackageEntry` call emits the four offline files therefore proves no
 * generated package can contain them.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repo(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function read(rel: string): string {
  return readFileSync(repo(rel), "utf8");
}

const generator = read("services/worker/src/verification-package.ts");
const REMOVED_FILES = [
  "verify.html",
  "verify-package.mjs",
  "OFFLINE-VERIFICATION.md",
  "verification-instructions.md",
];

describe("Offline Verifier decommission — package generator", () => {
  it("appendPackageEntry is the only archive-write path (contents = its call set)", () => {
    // The single archive.append lives inside appendPackageEntry.
    const appends = (generator.match(/archive\.append\(/g) ?? []).length;
    expect(appends).toBe(1);
  });

  it("no appendPackageEntry call emits any offline verifier file", () => {
    // Match every appendPackageEntry(...) call's target file name (arg 3).
    for (const name of REMOVED_FILES) {
      // A file only enters the ZIP via `appendPackageEntry(archive, entries, "<name>"`.
      const emitted = new RegExp(
        `appendPackageEntry\\([\\s\\S]{0,80}?["'\`]${name.replace(".", "\\.")}["'\`]`,
      ).test(generator);
      expect(emitted, `${name} must not be appended to the package`).toBe(false);
    }
  });

  it("the offline builder functions are gone", () => {
    for (const fn of [
      "buildVerifyHtml",
      "buildVerifyPackageScript",
      "buildVerificationInstructions",
      "buildOfflineVerificationReadme",
    ]) {
      expect(generator).not.toContain(`function ${fn}`);
    }
  });

  it("the generator carries no Offline Verifier references", () => {
    for (const term of [
      "offline verifier",
      "Offline Verifier",
      "@proovra/offline-verifier",
      ...REMOVED_FILES,
    ]) {
      expect(generator.includes(term), `generator must not mention "${term}"`).toBe(false);
    }
  });

  it("core evidentiary materials are still emitted", () => {
    for (const core of [
      "package-manifest.json",
      "package-manifest.sig",
      "package-checksums.json",
      "evidence-manifest.json",
      "timestamp.tsr",
    ]) {
      expect(generator.includes(core), `${core} must still be generated`).toBe(true);
    }
  });
});

describe("Offline Verifier decommission — product surfaces removed", () => {
  it("the package and standalone app directories are gone", () => {
    expect(existsSync(repo("packages/offline-verifier"))).toBe(false);
    expect(existsSync(repo("apps/offline-verifier"))).toBe(false);
  });

  it("no /offline-verifier web route exists", () => {
    expect(existsSync(repo("apps/web/app/offline-verifier"))).toBe(false);
    expect(existsSync(repo("apps/web/app/(app)/offline-verifier"))).toBe(false);
  });
});

describe("Offline Verifier decommission — Public Verify preserved", () => {
  const verifyPage = read("apps/web/app/verify/[token]/page.tsx");

  it("the public verify page still exists and no longer gates on an offline verifier", () => {
    expect(verifyPage.length).toBeGreaterThan(0);
    expect(verifyPage).not.toContain("offlineVerifierIncluded");
    expect(verifyPage).not.toContain("Offline Verifier");
  });

  it("package-integrity 'complete' no longer requires the removed offline verifier", () => {
    // The `complete` gate must still check the CORE materials...
    expect(verifyPage).toContain("integrity.manifestPresent");
    expect(verifyPage).toContain("integrity.checksumIndexPresent");
    expect(verifyPage).toContain("integrity.auditExportIncluded");
  });
});
