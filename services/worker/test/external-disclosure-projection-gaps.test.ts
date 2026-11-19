/**
 * PRO-W1C-01 (RG-18) — the external-disclosure projection covers the advisory
 * fields its key-name policy used to miss: certification statements and
 * revoke reasons, camera unique ids / firmware tags, internal part ids, the
 * capture client's device facts in provenance/chain.json and the raw payload
 * of capture trust events. The full forensic profile is untouched.
 */
import { projectJsonForDisclosure } from "@proovra/shared";
import { describe, expect, it } from "vitest";

describe("external disclosure projection — PRO-W1C-01 gaps", () => {
  it("withholds certification free text, camera identifiers and part ids", () => {
    const { value } = projectJsonForDisclosure("EXTERNAL_DISCLOSURE", "certifications/custodian-record.json", {
      declarationType: "CUSTODIAN",
      statementMarkdown: "I, Jane Smith, confirm ...",
      statementSnapshot: { text: "I, Jane Smith" },
      revokeReason: "Jane asked",
      imageUniqueId: "A1B2C3",
      softwareTag: "fw-1.2.3",
      partId: "part-uuid",
      version: 2,
    });
    const body = JSON.stringify(value);
    expect(body).not.toContain("Jane");
    expect(body).not.toContain("A1B2C3");
    expect(body).not.toContain("fw-1.2.3");
    expect(body).not.toContain("part-uuid");
    expect(body).toContain("CUSTODIAN");
  });

  it("withholds the capture client facts and trust-event payloads in provenance/chain.json", () => {
    const { value } = projectJsonForDisclosure("EXTERNAL_DISCLOSURE", "provenance/chain.json", {
      captureManifestFacts: { client: { model: "Pixel 9", osVersion: "15", browserName: "Chrome" }, version: 3 },
      trustEventRecords: [{ eventType: "ATTESTATION_VERIFIED", payload: { attestationRecordId: "row-1", deviceLabel: "Jane's phone" } }],
    });
    const body = JSON.stringify(value);
    expect(body).not.toContain("Pixel 9");
    expect(body).not.toContain("Jane's phone");
    expect(body).not.toContain("row-1");
    expect(body).toContain("ATTESTATION_VERIFIED");
  });

  it("the full forensic profile is byte-for-byte unaffected", () => {
    const doc = { statementMarkdown: "I, Jane Smith", captureManifestFacts: { client: { model: "Pixel 9" } } };
    expect(projectJsonForDisclosure("FULL_FORENSIC", "provenance/chain.json", doc).value).toBe(doc);
  });
});
