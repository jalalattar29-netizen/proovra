/**
 * The package's human-readable documents never print a stored "null" or
 * "undefined": a stringified absent value reads as absent.
 */
import { describe, expect, it } from "vitest";

import {
  buildCustodianDeclarationTemplate,
  buildQualifiedPersonTemplate,
  buildSystemProcessDeclaration,
} from "../src/verification-package.js";

describe("package human-readable text never prints a stored \"null\"", () => {
  const nullish = {
    title: "null",
    caseId: "undefined",
    jurisdiction: "NULL",
    reviewerEvidenceType: "null",
    rawEvidenceType: "undefined",
  } as never;

  it("templates and the process declaration read a stringified absent value as absent", () => {
    const texts = [
      buildCustodianDeclarationTemplate({ evidenceId: "null", metadata: nullish }),
      buildQualifiedPersonTemplate({ evidenceId: "undefined" }),
      buildSystemProcessDeclaration({ evidenceFiles: [], metadata: nullish }),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/\bnull\b|\bundefined\b/i);
      expect(t).toContain("Not included");
    }
  });
});
