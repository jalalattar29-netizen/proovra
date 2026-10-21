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
