/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — CRITICAL domain:
 * AI-over-evidence (ai-evidence / ai-case / ai-reviewer / ai-search /
 * ai-operations routes).
 *
 * Behavioral proof (via the reusable negative-conformance harness) that the
 * canonical primitive these routes now compose denies across the full
 * negative matrix for the intelligence permissions the domain uses, plus
 * source-contract assertions that each file routes through the primitive
 * against the RESOURCE's team (or the claimed workspace) with
 * anti-enumeration, and no longer trusts a bare membership existence check.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertNegativeAuthorizationConformance } from "./helpers/authorization-conformance.js";

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");
const read = (f: string) => readFileSync(join(ROUTES, f), "utf8");

const FILES = [
  "ai-evidence.routes.ts",
  "ai-case.routes.ts",
  "ai-reviewer.routes.ts",
  "ai-search.routes.ts",
  "ai-operations.routes.ts",
];

describe("AI-over-evidence — intelligence.run is authorization-closed", () => {
  assertNegativeAuthorizationConformance("intelligence.run");
});
describe("AI-over-evidence — intelligence.read is authorization-closed", () => {
  assertNegativeAuthorizationConformance("intelligence.read");
});

describe("AI-over-evidence — every route composes the canonical primitive", () => {
  for (const f of FILES) {
    it(`${f} routes through authorizeOrFail with anti-enumeration`, () => {
      const src = read(f);
      expect(src).toContain("authorizeOrFail");
      expect(src).toMatch(/antiEnumeration:\s*true/);
    });

    it(`${f} no longer denies with the bare not_a_member membership check`, () => {
      const src = read(f);
      expect(src).not.toMatch(/code:\s*"not_a_member"/);
    });
  }

  it("ai-evidence / ai-case / ai-reviewer authorize against the RESOURCE's team", () => {
    expect(read("ai-evidence.routes.ts")).toMatch(/teamId:\s*ev\.teamId/);
    expect(read("ai-case.routes.ts")).toMatch(/teamId:\s*caseRow\.teamId/);
    expect(read("ai-reviewer.routes.ts")).toMatch(/teamId:\s*wf\.teamId/);
    expect(read("ai-reviewer.routes.ts")).toMatch(/teamId:\s*run\.workspaceId/);
  });

  it("ai-operations keeps its stricter OWNER/ADMIN constraint on top of intelligence.run", () => {
    const src = read("ai-operations.routes.ts");
    expect(src).toMatch(/permission:\s*"intelligence\.run"/);
    expect(src).toMatch(/membership\.role !== "OWNER" && membership\.role !== "ADMIN"/);
  });
});
