import { describe, expect, it } from "vitest";
import { queryTenantAudit } from "../src/services/audit/tenant-audit.service.js";
import { asPrismaDouble, type DelegateArgs, type JsonRecord } from "./support/prisma-double.js";

/** What each test captures off the delegate call it exercises. */
type Captured = { where?: JsonRecord; orderBy?: unknown; take?: number };

function db(rows: JsonRecord[], captured: Captured = {}) {
  return {
    adminAuditLog: {
      findUnique: async () => null,
      findMany: async (args: DelegateArgs) => { captured.where = args.where; captured.orderBy = args.orderBy; captured.take = args.take; return rows; },
    },
  };
}

describe("Phase 11 — queryTenantAudit (ONE tenant-scoped read/export surface)", () => {
  it("pins the caller's PROVEN workspace via the persisted attribution filter", async () => {
    const cap: Captured = {};
    await queryTenantAudit({ scope: { kind: "WORKSPACE", workspaceId: "team-1" } }, asPrismaDouble(db([], cap)));
    expect(cap.where).toMatchObject({ category: "tenant_audit", workspaceId: "team-1" });
    expect(cap.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]); // deterministic UTC
  });

  it("organization scope filters by organizationId (cross-org rows cannot match)", async () => {
    const cap: Captured = {};
    await queryTenantAudit({ scope: { kind: "ORGANIZATION", organizationId: "org-9" }, action: "evidence.read", outcome: "denied" }, asPrismaDouble(db([], cap)));
    expect(cap.where).toMatchObject({ organizationId: "org-9", action: "evidence.read", outcome: "denied" });
  });

  it("projects the envelope (no raw metadata passthrough) + paginates deterministically", async () => {
    const row = (id: string) => ({ id, createdAt: new Date(0), action: "a", outcome: "success", userId: "u1", resourceType: "evidence", resourceId: "ev-1", workspaceId: "team-1", organizationId: "org-1", metadata: { sourceApp: "API", denialReason: null, correlationId: "c1", supportActorUserId: "s1" } });
    const cap: Captured = {};
    const res = await queryTenantAudit({ scope: { kind: "WORKSPACE", workspaceId: "team-1" }, limit: 2 }, asPrismaDouble(db([row("e3"), row("e2"), row("e1")], cap)));
    expect(cap.take).toBe(3); // limit+1
    expect(res.items).toHaveLength(2);
    expect(res.nextCursorId).toBe("e2");
    expect(res.items[0]).toMatchObject({ eventId: "e3", occurredAtUtc: "1970-01-01T00:00:00.000Z", workspaceId: "team-1", sourceApp: "API", correlationId: "c1" });
    // projection does NOT expose the raw metadata object
    expect((res.items[0] as JsonRecord).metadata).toBeUndefined();
  });
});
