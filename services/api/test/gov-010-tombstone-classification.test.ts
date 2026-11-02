/**
 * GOV-010 — every table carrying an evidence id is classified, and the classified
 * lists are what the executor actually does. A new table with no decision about
 * what destruction means for it fails here.
 */
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EVIDENCE_TABLE_TOMBSTONE_CLASS,
  EVIDENCE_TOMBSTONE_CLEARED_FIELDS,
} from "@proovra/shared-runtime";

const schema = fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const executor = fs.readFileSync(
  new URL("../../../packages/shared-runtime/src/evidence-destruction/executor.ts", import.meta.url),
  "utf8",
);

function modelsWithEvidenceId(): string[] {
  const models: string[] = [];
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    if (name !== "Evidence" && /^\s+\w*[eE]videnceIds?\s+(String|Json)/m.test(body ?? "")) {
      models.push(name as string);
    }
  }
  return models.sort();
}

describe("GOV-010 tombstone classification", () => {
  it("every model with an evidence id has a class, and no class names a model that is gone", () => {
    const models = modelsWithEvidenceId();
    expect(models.length).toBeGreaterThan(50);
    const classified = Object.keys(EVIDENCE_TABLE_TOMBSTONE_CLASS).sort();
    expect(models.filter((m) => !classified.includes(m)), "unclassified").toEqual([]);
    expect(classified.filter((m) => !models.includes(m)), "stale").toEqual([]);
  });

  it("every DELETED model is deleted by the executor", () => {
    const deleted = Object.entries(EVIDENCE_TABLE_TOMBSTONE_CLASS)
      .filter(([, c]) => c === "DELETED")
      .map(([m]) => m);
    for (const model of deleted) {
      const client = model.charAt(0).toLowerCase() + model.slice(1);
      expect(executor, `${model} is classified DELETED`).toContain(`tx.${client}.deleteMany(`);
    }
  });

  it("every cleared Evidence field is cleared by the tombstone write", () => {
    const tombstone = executor.slice(executor.indexOf("const tombstoned = await tx.evidence.updateMany"));
    for (const field of EVIDENCE_TOMBSTONE_CLEARED_FIELDS) {
      expect(tombstone, field).toMatch(new RegExp(`\\b${field}: (null|prismaPkg\\.Prisma\\.DbNull)`));
    }
  });
});
