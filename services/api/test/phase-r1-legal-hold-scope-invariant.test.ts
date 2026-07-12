/**
 * Phase R1 — Legal-hold scope invariant (documents why F2 is a non-issue).
 *
 * The audit flagged (F2, originally Critical) that
 * `runDestructiveActionGate` returns `{ gated: false }` for personal-scope
 * evidence (`teamId === null`), suspecting a legal-hold bypass. Reading the
 * schema showed this is NOT exploitable: `EvidenceLegalHold.teamId` is a
 * REQUIRED (non-nullable) column with a mandatory `Team` relation, so a
 * legal hold cannot exist for personal-scope evidence in the first place.
 * Personal-scope *retention* is separately enforced by
 * `assertEvidenceDeletionAllowedByRetention` on both single-record and bulk
 * delete paths.
 *
 * This test pins that invariant. If a future migration makes
 * `EvidenceLegalHold.teamId` nullable (introducing personal-scope holds),
 * this test fails LOUDLY — because the gate's personal-scope short-circuit
 * would then become a real bypass and must be revisited.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const schemaSrc = readSource("../prisma/schema.prisma");
const gateSrc = readSource(
  "../src/services/governance/destructive-action-gate.service.ts",
);

/** Extract the `model EvidenceLegalHold { ... }` block. */
function modelBlock(name: string): string {
  const start = schemaSrc.indexOf(`model ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const rest = schemaSrc.slice(start);
  const end = rest.indexOf("\n}");
  return rest.slice(0, end);
}

describe("Phase R1 — legal-hold scope invariant (F2)", () => {
  it("EvidenceLegalHold.teamId is REQUIRED (non-nullable) — no personal-scope holds", () => {
    const model = modelBlock("EvidenceLegalHold");
    // `teamId String` (no `?`) with a `.map("team_id")`. A nullable column
    // would render as `teamId String?`.
    expect(model).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
    expect(model).not.toMatch(/teamId\s+String\?\s/);
  });

  it("EvidenceLegalHold.team relation is mandatory (not optional)", () => {
    const model = modelBlock("EvidenceLegalHold");
    expect(model).toMatch(/team\s+Team\s+@relation/);
    expect(model).not.toMatch(/team\s+Team\?\s/);
  });

  it("the gate's personal-scope short-circuit is intentional and documented", () => {
    // The `teamId === null → { gated: false }` branch is safe ONLY because
    // of the schema invariant above. Keep the two coupled via this comment.
    expect(gateSrc).toContain("Personal-scope evidence");
    expect(gateSrc).toMatch(/if \(!input\.evidence\.teamId\)/);
  });
});
