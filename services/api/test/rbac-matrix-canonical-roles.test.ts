/**
 * `GET /v1/platform/rbac/matrix` — every row agrees with the enforcement
 * authority (`roleHasPermission`, packages/shared/src/permissions.ts).
 *
 * The matrix used to carry hand-written role lists and told a VIEWER they
 * could "View billing + seats" while VIEWER holds no `billing.read`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PERMISSIONS, roleHasPermission } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { RBAC_MATRIX_ROLES, buildRbacMatrix } from "../src/services/platform-context/rbac-matrix.js";

const matrix = buildRbacMatrix();
const rows = matrix.categories.flatMap((c) => c.capabilities);
const ROLE_IDS = RBAC_MATRIX_ROLES.map((r) => r.id);

describe("RBAC matrix — computed from the canonical permission matrix", () => {
  it("every permission-backed row lists exactly the roles roleHasPermission grants", () => {
    const backed = rows.filter((r) => r.permission !== null);
    expect(backed.length).toBe(20);
    for (const row of backed) {
      expect((PERMISSIONS as readonly string[]).includes(row.permission!), row.id).toBe(true);
      const expected = ROLE_IDS.filter((role) => roleHasPermission(role, row.permission!));
      expect(row.roles, `${row.id} (${row.permission})`).toEqual(expected);
    }
  });

  it("VIEWER is not told it can view billing (it holds no billing.read)", () => {
    const billing = rows.find((r) => r.id === "billing.view")!;
    expect(billing.permission).toBe("billing.read");
    expect(roleHasPermission("VIEWER", "billing.read")).toBe(false);
    expect(billing.roles).not.toContain("VIEWER");
  });

  it("only rows whose authority is not a role permission are exempt, and each names its authority", () => {
    const exempt = rows.filter((r) => r.permission === null);
    expect(exempt.map((r) => r.id).sort()).toEqual(["audit.platform", "security_center.view", "team.delete"]);
    for (const row of exempt) {
      expect(row.authority, row.id).toBeTruthy();
    }
    expect(rows.find((r) => r.id === "audit.platform")!.roles).toEqual([]);
  });

  it("row ids are unique", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("the route serves the computed matrix, with no inline role lists", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/routes/teams.routes.ts", import.meta.url)), "utf8");
    const start = src.indexOf('"/v1/platform/rbac/matrix"');
    const handler = src.slice(start, src.indexOf("  );", start));
    expect(handler).toContain("buildRbacMatrix()");
    expect(handler).not.toMatch(/roles:\s*\[/);
  });
});
