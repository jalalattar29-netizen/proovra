/**
 * PRO-W1C-06 (RG-18) — the report custody timeline never prints raw payload
 * fields of events the summariser does not describe.
 */
import { describe, expect, it } from "vitest";

import { summarizePayloadForReport } from "../src/processor.js";

const USER = "6b1f3c4e-0000-4000-8000-000000000001";

describe("report custody summary — no raw payload (PRO-W1C-06)", () => {
  it("a revoked certification prints its type and version, never the revoker id or reason", () => {
    const line = summarizePayloadForReport("CERTIFICATION_REVOKED", {
      declarationType: "CUSTODIAN",
      revokedByUserId: USER,
      version: 2,
      revokeReason: "typed by a person: confidential",
    });
    expect(line).toBe("Certification revoked (custodian, version 2).");
    expect(line).not.toContain(USER);
    expect(line).not.toContain("confidential");
  });

  it("an ownership transfer prints no user ids", () => {
    const line = summarizePayloadForReport("EVIDENCE_OWNERSHIP_TRANSFERRED", {
      fromUserId: USER,
      toUserId: USER,
      reason: "member_removed",
      byUserId: USER,
    });
    expect(line).not.toContain(USER);
  });

  it("an unknown event prints no payload field", () => {
    const line = summarizePayloadForReport("EXTERNAL_INTAKE_LINK_REDEEMED", {
      intakeLinkId: USER,
      intakeSessionId: USER,
      note: "free text",
    });
    expect(line).toBe("Event details are not printed in the report.");
  });
});
