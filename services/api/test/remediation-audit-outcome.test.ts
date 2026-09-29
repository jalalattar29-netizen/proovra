/**
 * ET-REC-07 — ONE audit-outcome mapping for workspace and platform remediation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { REMEDIATION_RESULTS, remediationAuditOutcome } from "../src/services/operations/remediation-registry.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("remediation audit outcome (ET-REC-07)", () => {
  it("maps every result: met → success, said no → denied, could not accept → error", () => {
    expect(Object.fromEntries(REMEDIATION_RESULTS.map((r) => [r, remediationAuditOutcome(r)]))).toEqual({
      QUEUED: "success",
      ALREADY_IN_PROGRESS: "success",
      ALREADY_SATISFIED: "success",
      REFUSED: "denied",
      NOT_ELIGIBLE: "denied",
      QUEUE_UNAVAILABLE: "error",
      FAILED: "error",
    });
  });

  it("both paths use it; neither derives its own", () => {
    const exec = read("../src/services/operations/remediation-executor.ts");
    const admin = read("../src/routes/admin-security.routes.ts");
    expect(exec).toContain("outcome: remediationAuditOutcome(dispatched.result),");
    expect(admin).toContain("outcome: remediationAuditOutcome(result.result),");
    expect(admin).not.toMatch(/outcome: result\.result === "FAILED" \? "error" : "success"/);
  });
});
