/**
 * PHASE 11 §1 — historical tenant-scope backfill is PROVABLE-ONLY. Scope is
 * derived exclusively from hash-protected, immutable bindings on hash-VALID rows;
 * anything unprovable is LEGACY_SCOPE_UNRESOLVED and is never guessed. The planner
 * is pure and writes nothing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  planAuditTenantScopeBackfill,
  type BackfillAuditRow,
} from "../src/services/audit/audit-tenant-backfill.js";

function row(over: Partial<BackfillAuditRow>): BackfillAuditRow {
  return {
    id: "r",
    chainVersion: 2,
    hashVerified: true,
    organizationId: null,
    workspaceId: null,
    resourceType: null,
    resourceId: null,
    metadata: {},
    ...over,
  };
}

describe("§1 — historical tenant backfill readiness (provable-only, no fabrication)", () => {
  it("V3 / already-bound rows need no backfill", async () => {
    const plan = await planAuditTenantScopeBackfill(
      [row({ id: "a", chainVersion: 3, workspaceId: "team-1" }), row({ id: "b", chainVersion: 2, workspaceId: "team-x" })],
      async () => "SHOULD_NOT_BE_CALLED",
    );
    expect(plan.entries.every((e) => e.status === "ALREADY_BOUND")).toBe(true);
    expect(plan.resolvable).toBe(0);
  });

  it("V2 hash-valid row with a resolvable resource binding is RESOLVABLE (derived, not guessed)", async () => {
    const resolve = vi.fn(async () => "team-DERIVED");
    const plan = await planAuditTenantScopeBackfill(
      [row({ id: "a", chainVersion: 2, resourceType: "evidence", resourceId: "ev-1" })],
      resolve,
    );
    expect(plan.entries[0]).toEqual({
      id: "a",
      status: "RESOLVABLE",
      source: "resource_binding",
      derivedWorkspaceId: "team-DERIVED",
    });
    expect(resolve).toHaveBeenCalledWith("evidence", "ev-1");
  });

  it("a hash-UNVERIFIED row is NEVER derived from — its bindings are untrusted", async () => {
    const resolve = vi.fn(async () => "team-DERIVED");
    const plan = await planAuditTenantScopeBackfill(
      [row({ id: "a", chainVersion: 2, hashVerified: false, resourceType: "evidence", resourceId: "ev-1" })],
      resolve,
    );
    expect(plan.entries[0]).toMatchObject({ status: "LEGACY_SCOPE_UNRESOLVED", reason: "hash_unverified" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a V1 row with no hash-protected resource binding is UNRESOLVED (columns are not hashed → not trusted)", async () => {
    const plan = await planAuditTenantScopeBackfill(
      // V1 hashes only metadata; the resource_* COLUMNS are not in the hash, so a
      // column-only binding must NOT be trusted.
      [row({ id: "a", chainVersion: 1, resourceType: "evidence", resourceId: "ev-1", metadata: {} })],
      async () => "team-SHOULD_NOT_USE",
    );
    expect(plan.entries[0]).toMatchObject({ status: "LEGACY_SCOPE_UNRESOLVED", reason: "no_hash_protected_binding" });
  });

  it("a V1 row WITH a hash-protected metadata binding is resolvable", async () => {
    const plan = await planAuditTenantScopeBackfill(
      [row({ id: "a", chainVersion: 1, metadata: { resourceType: "evidence", resourceId: "ev-9" } })],
      async (t, i) => (t === "evidence" && i === "ev-9" ? "team-META" : null),
    );
    expect(plan.entries[0]).toMatchObject({ status: "RESOLVABLE", derivedWorkspaceId: "team-META" });
  });

  it("a resource that no longer resolves is UNRESOLVED — never fabricated", async () => {
    const plan = await planAuditTenantScopeBackfill(
      [row({ id: "a", chainVersion: 2, resourceType: "evidence", resourceId: "ev-GONE" })],
      async () => null,
    );
    expect(plan.entries[0]).toMatchObject({ status: "LEGACY_SCOPE_UNRESOLVED", reason: "resource_not_resolvable" });
  });

  it("guessedScope metric is always 0 and summary counts are consistent", async () => {
    const plan = await planAuditTenantScopeBackfill(
      [
        row({ id: "a", chainVersion: 3, workspaceId: "t" }),
        row({ id: "b", chainVersion: 2, resourceType: "evidence", resourceId: "ev-1" }),
        row({ id: "c", chainVersion: 1, metadata: {} }),
      ],
      async () => "team-D",
    );
    expect(plan.guessedScope).toBe(0);
    expect(plan.total).toBe(3);
    expect(plan.alreadyBound + plan.resolvable + plan.unresolved).toBe(3);
  });
});
