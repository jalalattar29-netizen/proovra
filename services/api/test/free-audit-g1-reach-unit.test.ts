/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G1-REACH, the rows proven without a database.
 *
 *   B2A-F-20  a boolean query parameter reads "false" as false
 *   B1-F-016  OAuth failures carry no redirect-URI configuration hint
 *   B4-F-310  capture/evidence-part catch blocks never answer a 5xx with the
 *             raw exception message
 *   B3B-F-103 provider message ids need the operator permission, not a flag
 *
 * The live-database rows are in free-audit-g1-reach.integration.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { queryBoolean } from "../src/http/query-boolean.js";

const SRC = resolve(__dirname, "../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("B2A-F-20: boolean query parameters", () => {
  it("parses the text, not its truthiness", () => {
    expect(queryBoolean.parse("false")).toBe(false);
    expect(queryBoolean.parse("0")).toBe(false);
    expect(queryBoolean.parse("true")).toBe(true);
    expect(queryBoolean.parse("1")).toBe(true);
    expect(queryBoolean.parse(false)).toBe(false);
    expect(queryBoolean.optional().parse(undefined)).toBeUndefined();
    expect(queryBoolean.safeParse("yes-please").success).toBe(false);
  });

  it("no route coerces a boolean with Boolean(value)", () => {
    for (const file of [
      "routes/search.routes.ts",
      "routes/phase11-tenant.routes.ts",
      "routes/admin-identity.routes.ts",
      "routes/case-workspace.routes.ts",
      "routes/governance-operations.routes.ts",
      "routes/identity.routes.ts",
      "routes/reviewer-ops.routes.ts",
      "routes/workflow-instances.routes.ts",
    ]) {
      expect(read(file), file).not.toMatch(/z\.coerce\.boolean\(/);
    }
    expect(read("routes/search.routes.ts")).toMatch(/failClosedOnly: queryBoolean\.optional\(\)/);
    expect(read("routes/phase11-tenant.routes.ts")).toMatch(/export: queryBoolean\.optional\(\)/);
  });
});

describe("B1-F-016: OAuth failure responses", () => {
  it("name no redirect-URI setting and no expected URL", () => {
    const src = read("routes/auth.routes.ts");
    expect(src).not.toMatch(/REDIRECT_URI matches exactly/);
    expect(src).not.toMatch(/REDIRECT_URI in API \.env/);
    expect(src).not.toMatch(/hint:\s*"[^"]*REDIRECT_URI/);
  });
});

describe("B4-F-310: unexpected failures keep their message server-side", () => {
  it("every catch that echoes err.message rethrows a 5xx to the central handler first", () => {
    for (const file of ["routes/capture.routes.ts", "routes/evidence.routes.ts"]) {
      const lines = read(file).split("\n");
      const sites = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /const message = err instanceof Error \? err\.message : "(Unexpected error|Bad request)";/.test(l));
      expect(sites.length, file).toBeGreaterThan(0);
      for (const { i } of sites) {
        const before = lines.slice(Math.max(0, i - 4), i).join("\n");
        expect(before, `${file}:${i + 1}`).toMatch(/if \(statusCode >= 500\) throw err;/);
      }
    }
  });
});

describe("B3B-F-103: provider message ids", () => {
  it("the debug flag only asks; the operator permission decides", () => {
    const src = read("routes/workflow-intake-links.routes.ts");
    expect(src).not.toMatch(/includeProviderMessageId:\s*\n?\s*typeof \(req\.query/);
    const uses = src.match(/includeProviderMessageId: await providerIdsDisclosed\(req, /g) ?? [];
    expect(uses.length).toBe(2);
    const fn = src.slice(src.indexOf("async function providerIdsDisclosed"), src.indexOf("export async function workflowIntakeLinksRoutes"));
    expect(fn).toMatch(/evaluateAuthorize\(req, \{ teamId, permission: "identity\.org_policy\.manage" \}\)/);
  });
});
