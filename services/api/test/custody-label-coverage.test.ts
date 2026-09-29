/**
 * ET-CUS-13 — every custody event type has a customer-readable label, from
 * ONE function, and no surface prints a raw code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CUSTODY_EVENT_LABELED_TYPES, custodyEventLabel } from "@proovra/shared";

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

describe("custody event labels (ET-CUS-13)", () => {
  it("every CustodyEventType value has a label in the one label function", () => {
    const values = enumValues(read("../prisma/schema.prisma"), "CustodyEventType");
    expect(values.length).toBeGreaterThan(50);
    expect(values.filter((v) => !CUSTODY_EVENT_LABELED_TYPES.includes(v))).toEqual([]);
  });

  it("no label is a raw code, and payload refines the two-meaning types", () => {
    for (const t of CUSTODY_EVENT_LABELED_TYPES) expect(custodyEventLabel(t)).not.toMatch(/_/);
    expect(custodyEventLabel("EVIDENCE_LOCKED", { retentionApplied: true })).toBe("Object Lock retention applied to storage");
    expect(custodyEventLabel("EVIDENCE_LOCKED", { lockedByUserId: "u" })).toBe("Evidence record locked");
    expect(custodyEventLabel("EXPORT_BLOCKED_BY_POLICY", { action: "finalization" })).toBe("Finalization blocked by policy");
    expect(custodyEventLabel("SOME_FUTURE_EVENT")).toBe("Some future event");
  });

  it("the report and the web timeline read the one label; neither prints a raw code", () => {
    const report = read("../../worker/src/report-v2/normalizers.ts");
    expect(report).toMatch(/return custodyEventLabel\(eventType, payload\);/);
    const tab = read("../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx");
    expect(tab).toContain("custodyEventLabel(row.type)");
    expect(tab).not.toMatch(/\.type\.replace\(\/_\/g/);
  });
});
