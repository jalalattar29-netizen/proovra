/**
 * Leave-organization contracts (lifecycle Phase 1, 2026-07-16).
 *
 * Pins the enforcement wiring of POST /v1/orgs/:id/leave. The route module
 * imports the DB-coupled client, so these are handler-slice contracts in
 * the established style; live login→leave behavior belongs to the
 * Testcontainers harness.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(
  resolve(HERE, "../src/routes/organizations.routes.ts"),
  "utf8",
);
const AUDIT = readFileSync(
  resolve(HERE, "../src/services/organization/org-audit.service.ts"),
  "utf8",
);

const at = ROUTES.indexOf('"/v1/orgs/:id/leave"');
const H = ROUTES.slice(at, at + 5200);

describe("POST /v1/orgs/:id/leave", () => {
  it("is registered behind auth + legal acceptance", () => {
    expect(at).toBeGreaterThan(-1);
    expect(H).toMatch(/preHandler:\s*requireAuthAndLegal/);
  });

  it("blocks ORG_OWNER with the stable OWNERSHIP_TRANSFER_REQUIRED code BEFORE any mutation", () => {
    const guard = H.indexOf('membership.role === "ORG_OWNER"');
    // PHASE 3: the governance removal is the canonical orchestrator call.
    const del = H.indexOf("removeOrganizationMembership");
    expect(guard).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(del);
    expect(H).toMatch(/OWNERSHIP_TRANSFER_REQUIRED/);
  });

  it("verifies the CALLER's own membership (self-scoped, not a target param)", () => {
    expect(H).toMatch(
      /organizationMembership\.findFirst\(\{\s*\n?\s*where:\s*\{\s*organizationId:\s*orgId,\s*userId\s*\}/,
    );
  });

  it("revokes workspace access via TeamMember REVOKED scoped to THIS org's non-personal teams", () => {
    expect(H).toMatch(/organizationId:\s*orgId,\s*isPersonal:\s*false/);
    // PHASE 3: same org-scoped revocation via the canonical orchestrator.
    expect(H).toMatch(/massRevokeWorkspaceMemberships/);
    expect(H).toMatch(/teamIds:\s*orgTeamIds/);
    // Rows are deactivated, never erased — attribution preserved.
    expect(H).not.toMatch(/teamMember\.deleteMany/);
  });

  it("clears a now-inaccessible currentWorkspaceId (personal-workspace fallback)", () => {
    expect(H).toMatch(/orgTeamIds\.includes\(me\.currentWorkspaceId\)/);
    expect(H).toMatch(/currentWorkspaceId:\s*null/);
  });

  it("runs the whole transition in one transaction and audits both streams", () => {
    expect(H).toMatch(/prisma\.\$transaction/);
    expect(H).toMatch(/"ORG_MEMBER_LEFT"/);
    expect(H).toMatch(/identity\.organization_left/);
  });

  it("second call is safe: missing membership returns 404, no destructive re-execution", () => {
    expect(H).toMatch(/membership_not_found/);
  });
});

describe("audit vocabulary", () => {
  it("ORG_MEMBER_LEFT is a bounded event type distinct from admin removal", () => {
    expect(AUDIT).toMatch(/"ORG_MEMBER_LEFT"/);
    expect(AUDIT).toMatch(/"ORG_MEMBER_REMOVED"/);
  });
});
