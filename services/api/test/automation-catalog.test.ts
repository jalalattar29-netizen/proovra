/**
 * PV-ALLOW-001 / PV-DOC-001 — the automation allowlists explain themselves.
 *
 * The console listed the trigger and action allowlists as bare identifiers,
 * and the actions service header named seven actions while the allowlist
 * carried eight (WEBHOOK_DELIVERY_INTERNAL_ONLY was missing from the prose).
 * Each allowlisted value now has an operator label and a sentence of meaning
 * beside the allowlist, and the service header names every action.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTOMATION_ACTION_CATALOG,
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_CATALOG,
  AUTOMATION_TRIGGER_TYPES,
} from "../src/services/automation/automation.service.js";

describe("PV-ALLOW-001 — every allowlisted value has a label and a meaning", () => {
  it("the catalogs cover the allowlists exactly", () => {
    expect(Object.keys(AUTOMATION_TRIGGER_CATALOG).sort()).toEqual([...AUTOMATION_TRIGGER_TYPES].sort());
    expect(Object.keys(AUTOMATION_ACTION_CATALOG).sort()).toEqual([...AUTOMATION_ACTION_TYPES].sort());
  });

  it("each entry reads as product language, not as its identifier", () => {
    for (const [value, entry] of [
      ...Object.entries(AUTOMATION_TRIGGER_CATALOG),
      ...Object.entries(AUTOMATION_ACTION_CATALOG),
    ]) {
      expect(entry.label, value).not.toBe(value);
      expect(entry.label, value).not.toMatch(/_/);
      expect(entry.description.length, value).toBeGreaterThan(20);
      expect(entry.description, value).toMatch(/\.$/);
    }
  });

  it("only the webhook action leaves the platform, and it says so", () => {
    const external = Object.entries(AUTOMATION_ACTION_CATALOG).filter(([, e]) => e.internalOnly);
    expect(external.map(([v]) => v)).toEqual(["WEBHOOK_DELIVERY_INTERNAL_ONLY"]);
    expect(external[0][1].description).toMatch(/registered/);
  });
});

describe("PV-DOC-001 — the actions service header names every action", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/services/automation/automation-actions.service.ts", import.meta.url)),
    "utf8",
  );
  const header = SRC.slice(0, SRC.indexOf("*/") + 2);

  it("every allowlisted action type appears in the header", () => {
    for (const action of AUTOMATION_ACTION_TYPES) expect(header, action).toContain(action);
  });
});
