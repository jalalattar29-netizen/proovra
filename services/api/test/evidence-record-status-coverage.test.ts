/**
 * ET-SM-08 — every EvidenceStatus has a label and tone in the ONE shared
 * presentation, an integrity failure reads as danger, and the web and mobile
 * library labels are that authority rather than their own copies.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EVIDENCE_RECORD_STATUSES_PRESENTED,
  evidenceRecordStatusLabel,
  evidenceRecordStatusTone,
} from "@proovra/shared";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function enumValues(schema: string, name: string): string[] {
  const start = schema.indexOf(`enum ${name} {`);
  const body = schema.slice(start, schema.indexOf("}", start));
  return body
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

describe("evidence record status presentation (ET-SM-08)", () => {
  it("covers every EvidenceStatus value", () => {
    const values = enumValues(read("../prisma/schema.prisma"), "EvidenceStatus");
    expect(values).toContain("FAILED_HASH_MISMATCH");
    expect(values.filter((v) => !EVIDENCE_RECORD_STATUSES_PRESENTED.includes(v))).toEqual([]);
  });

  it("an integrity failure is danger with its own words; nothing presents as 'not recorded'", () => {
    expect(evidenceRecordStatusLabel("FAILED_HASH_MISMATCH")).toBe("Integrity check failed");
    expect(evidenceRecordStatusTone("FAILED_HASH_MISMATCH")).toBe("danger");
    for (const s of EVIDENCE_RECORD_STATUSES_PRESENTED) {
      expect(evidenceRecordStatusLabel(s)).not.toBe("Status not recorded");
    }
    expect(evidenceRecordStatusLabel(null)).toBe("Status not recorded");
  });

  it("the web and mobile library labels delegate to it", () => {
    const web = read("../../../apps/web/app/(app)/evidence/lib/evidence-library-status.ts");
    expect(web).toContain("return evidenceRecordStatusLabel(status);");
    expect(web).toContain("return evidenceRecordStatusTone(status);");
    const mobile = read("../../../apps/mobile/src/product/evidence-library.ts");
    expect(mobile).toContain("return evidenceRecordStatusLabel(status);");
  });
});
