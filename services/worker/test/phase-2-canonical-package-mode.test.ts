/**
 * PROOVRA Phase 2 — Canonical package-mode.json fields.
 *
 * The legacy `mode` field (`personal_basic` | `team_governed`) was
 * derived from `data.teamId ? "team_governed" : "personal_basic"`,
 * which mislabelled every personal-account record as "team_governed"
 * because personal workspaces are stored as Team rows. Phase 2 makes
 * the package emit explicit canonical workspace fields alongside the
 * legacy `mode`:
 *
 *   - workspaceScope (canonical enum)
 *   - workspaceLabelAtPackageTime (human label captured at build time)
 *   - isPersonalWorkspaceAtPackageTime (boolean)
 *   - governanceMeaning (plain-language explanation)
 *
 * Legacy `mode` is preserved for offline-verifier compatibility. The
 * new fields are sourced from the shared
 * `deriveCanonicalWorkspaceScope()` helper, which honours
 * `Team.isPersonal=true` instead of inferring governance from teamId.
 *
 * This is a source-string pin (mirroring forensic-hardening.test.ts
 * style) so it does not require a full Prisma + archiver runtime.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const verificationPackageSrc = readFileSync(
  fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)),
  "utf8",
);

describe("Phase 2 — canonical package-mode.json fields", () => {
  it("emits the new canonical workspaceScope/label/isPersonal/governanceMeaning fields", () => {
    expect(verificationPackageSrc).toContain("workspaceScope,");
    expect(verificationPackageSrc).toContain("workspaceLabelAtPackageTime:");
    expect(verificationPackageSrc).toContain("isPersonalWorkspaceAtPackageTime,");
    expect(verificationPackageSrc).toContain("governanceMeaning,");
  });

  it("derives workspaceScope through the shared canonical helper, not inline teamId logic", () => {
    expect(verificationPackageSrc).toContain(
      "deriveCanonicalWorkspaceScope({",
    );
    expect(verificationPackageSrc).toContain(
      "describeCanonicalWorkspaceScope(workspaceScope)",
    );
  });

  it("preserves the legacy `mode` field for offline-verifier compatibility", () => {
    // The legacy field must remain emitted so existing offline
    // verifiers and historical consumers keep working.
    expect(verificationPackageSrc).toContain("mode: packageMode,");
  });

  it("accepts the new optional inputs on createVerificationPackage", () => {
    expect(verificationPackageSrc).toContain("isPersonalTeam?: boolean | null;");
    expect(verificationPackageSrc).toContain(
      "workspaceLabelAtPackageTime?: string | null;",
    );
  });
});

describe("Phase 2 — processor.ts feeds the new canonical inputs", () => {
  const processorSrc = readFileSync(
    fileURLToPath(new URL("../src/processor.ts", import.meta.url)),
    "utf8",
  );

  it("loads Team.isPersonal so the workspace scope can be derived correctly", () => {
    expect(processorSrc).toContain("isPersonal: true,");
  });

  it("passes isPersonalTeam + workspaceLabelAtPackageTime into createVerificationPackage", () => {
    expect(processorSrc).toContain(
      "isPersonalTeam: prepared.identitySnapshot.workspaceIsPersonal",
    );
    expect(processorSrc).toContain(
      "workspaceLabelAtPackageTime:",
    );
  });
});

describe("Phase 2 — confirmed-dead pdf/report.ts duplicate is gone", () => {
  it("services/worker/src/pdf/report.ts has been deleted", () => {
    let existed = true;
    try {
      readFileSync(
        fileURLToPath(new URL("../src/pdf/report.ts", import.meta.url)),
        "utf8",
      );
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
  });
});
