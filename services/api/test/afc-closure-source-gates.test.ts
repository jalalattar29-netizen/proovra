/**
 * Independent forward audit closure (Wave F) — source gates that a revert
 * would trip.
 *
 * F-16: no surface derives an output state from an ASSUMED eligibility
 *       (`?? "ELIGIBLE"`) or from a swallowed request read; each reads THE
 *       helper eligibilityOrUnresolved.
 * F-37: the package reserve / commit transactions carry their explicit bounds
 *       (the Prisma 5 s default included the advisory-lock wait).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("F-16 — no assumed eligibility, no swallowed request read", () => {
  const SITES = [
    "src/routes/reports.routes.ts",
    "src/services/cases/matter-workspace.service.ts",
    "src/services/evidence-artifact-status.service.ts",
  ];
  it.each(SITES)("%s derives with eligibilityOrUnresolved and never assumes ELIGIBLE", (file) => {
    const src = read(file);
    expect(src).toMatch(/eligibilityOrUnresolved\(/);
    expect(src).not.toMatch(/Eligibility \?\? "ELIGIBLE"/);
  });

  it("the request reads are not swallowed into 'nothing requested'", () => {
    const reports = read("src/routes/reports.routes.ts");
    expect(reports).not.toMatch(/terminalReasonCode: true,\s*\},\s*\}\)\s*\.catch\(\(\) => \[\]\)/);
    const matter = read("src/services/cases/matter-workspace.service.ts");
    expect(matter).not.toMatch(/return \[\] as Array<\{ evidenceId: string; state: string \}>/);
  });
});

describe("F-37 — bounded package issuance transactions", () => {
  it("reserve and commit run with explicit timeout and lock-wait bounds", async () => {
    const issuance = await import("../../worker/src/package-issuance.js");
    expect(issuance.PACKAGE_ISSUANCE_TRANSACTION).toEqual({ timeout: 30_000, maxWait: 10_000 });
    const src = read("../worker/src/package-issuance.ts");
    expect(src.match(/\}, PACKAGE_ISSUANCE_TRANSACTION\);/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Wave A minor (closure) — an intake submit claims a persisted location only when it sealed the record", () => {
  it("decides from completeEvidence's answer under the record lock, not an unlocked read", () => {
    const src = read("src/services/external-intake-orchestration.service.ts");
    expect(src).toMatch(/sealedByThisSubmission = completed\?\.alreadyFinalized !== true;/);
    expect(src).toMatch(/const locationPersisted = shouldPersistLocation && sealedByThisSubmission;/);
  });
});

describe("R-1 / R-2 (closure re-audits) — the link issuer is carried by role, never as a submitter", () => {
  it("the report pipeline's submitter email is the submitter's (null for intake); the issuer is its own field", () => {
    const src = read("../worker/src/processor.ts");
    expect(src).toContain("\n    submittedByEmail: acquisitionIdentity.submittedByEmail,\n");
    expect(src).toContain("\n    linkIssuerEmail: acquisitionIdentity.linkIssuerEmail,\n");
    expect(src).toContain("linkIssuerEmail: prepared.identitySnapshot.linkIssuerEmail,");
    expect(src).not.toContain('INTAKE_CONTRIBUTOR" ? acquisitionIdentity.linkIssuerEmail');
    const pkg = read("../worker/src/verification-package.ts");
    expect(pkg).toContain("const linkCreatorEmail = metadata.linkIssuerEmail ?? null;");
  });

  it("an intake record whose acquisition context cannot be read fails the run, never renders as non-intake", () => {
    const bridge = read("../worker/src/report-technical-summary-bridge.ts");
    expect(bridge).toMatch(/if \(input\.acquisitionMode === "SECURE_INTAKE_LINK"\) \{\s*throw Object\.assign\(new Error\("REPORT_INTAKE_ACQUISITION_UNREADABLE"\)/);
    const src = read("../worker/src/processor.ts");
    expect((src.match(/await buildReportAcquisitionContext\(\{[^}]*acquisitionMode:/g) ?? []).length).toBe(4);
  });
});

describe("O-2 (closure re-audit) — intake records are not a submitter cluster of the link issuer", () => {
  it("the repeat-submitter clusters exclude intake records and keep legacy records with no mode", () => {
    const src = read("src/services/dashboard/command-center.service.ts");
    expect(src).toMatch(
      /submittedByUserId: \{ not: null \}, OR: \[\{ acquisitionMode: null \}, \{ acquisitionMode: \{ not: "SECURE_INTAKE_LINK" \} \}\] \}/,
    );
  });
});
