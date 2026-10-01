/**
 * UC-PROV-007 — the verification package never names itself "court-ready".
 *
 *   - the readiness checklist is `reviewer-readiness-checklist.json` with the
 *     profile SUPPORTING_REVIEW_PACKET;
 *   - no PROOVRA-named package entry may carry a forbidden artifact phrase
 *     (runtime guard on every appended entry);
 *   - no string literal in the package builder carries one either (source
 *     guard over entry names and PROOVRA-authored JSON values).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findForbiddenArtifactPhrases } from "@proovra/shared";
import { assertPackageEntryNameHonest, buildCourtReadinessChecklist } from "../src/verification-package.js";

const SRC = readFileSync(fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)), "utf8");

describe("UC-PROV-007 — package naming", () => {
  it("the checklist profile is neutral and every JSON value is free of forbidden phrases", () => {
    const checklist = buildCourtReadinessChecklist({
      evidenceFiles: [],
      hasTimestampToken: false,
      anchorIncluded: false,
      forensicCustodyCount: 0,
      accessActivityCount: 0,
      metadata: {} as never,
      reportIncluded: true,
      certificationTemplateIncluded: true,
      originalLinkageIncluded: true,
      caseMetadataIncluded: true,
    });
    expect(checklist.packetProfile).toBe("SUPPORTING_REVIEW_PACKET");
    const values: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") values.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(checklist);
    for (const v of values) expect(findForbiddenArtifactPhrases(v), v).toEqual([]);
  });

  it("an entry name with a forbidden phrase is refused at append time", () => {
    expect(() => assertPackageEntryNameHonest("court-admissibility-checklist.json")).not.toThrow();
    expect(() => assertPackageEntryNameHonest("court-ready-packet.json")).toThrow(/PACKAGE_ENTRY_NAME_FORBIDDEN_PHRASE/);
    expect(() => assertPackageEntryNameHonest("reviewer-readiness-checklist.json")).not.toThrow();
  });

  it("no string literal in the package builder carries a forbidden phrase", () => {
    // Code only: comments may discuss the phrases.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const literals = code.match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    const offenders = literals.filter((l) => findForbiddenArtifactPhrases(l).length > 0);
    expect(offenders).toEqual([]);
    expect(SRC).not.toContain('"court-admissibility-checklist.json"');
    expect(SRC).not.toContain("COURT_READY");
  });
});
