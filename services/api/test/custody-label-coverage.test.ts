/**
 * ET-CUS-13 — every custody event type has a customer-readable label, from
 * ONE function, and no surface prints a raw code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CUSTODY_EVENT_LABELED_TYPES, custodyEventLabel, custodyLabelHints } from "@proovra/shared";

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

  it("bounded label hints carry exactly what the label reads, and the report threads them", () => {
    expect(custodyLabelHints({ retentionApplied: true, storageRegion: "eu", itemCount: 3 })).toEqual({ retentionApplied: true });
    expect(custodyLabelHints({ lockedByUserId: "u-1", ip: "203.0.113.1" })).toEqual({ lockedByUserId: true });
    expect(custodyLabelHints({ note: "x" })).toBeNull();
    expect(custodyEventLabel("EVIDENCE_LOCKED", custodyLabelHints({ retentionApplied: true }))).toBe("Object Lock retention applied to storage");
    expect(custodyEventLabel("EVIDENCE_LOCKED", custodyLabelHints({ lockedByUserId: "u-1" }))).toBe("Evidence record locked");
    const processor = read("../../worker/src/processor.ts");
    expect(processor.match(/labelHints: custodyLabelHints\(ev\.payload\)/g)?.length).toBe(3);
    expect(read("../../worker/src/report-v2/build-view-model.ts")).toContain("mapCustodyEventLabel(event.eventType, event.labelHints)");
    expect(read("../../worker/src/report-v2/custody-model.ts")).toContain("mapCustodyEventLabel(ev.eventType, ev.labelHints)");
  });

  it("the report and the web timeline read the one label; neither prints a raw code", () => {
    const report = read("../../worker/src/report-v2/normalizers.ts");
    expect(report).toMatch(/return custodyEventLabel\(eventType, payload\);/);
    const tab = read("../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx");
    expect(tab).toContain("custodyEventLabel(row.type)");
    expect(tab).not.toMatch(/\.type\.replace\(\/_\/g/);
  });
});
