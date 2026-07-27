/**
 * PHASE 11 §1 — the EXECUTABLE readiness command's real classification + exit
 * behaviour. Integrity is checked first; scope is never guessed; HASH_INVALID
 * and CONFLICT force a non-zero exit; the output carries no secrets.
 */
import { describe, expect, it } from "vitest";

import {
  assessAuditTenantScopeReadiness,
  formatReadinessReport,
} from "../src/commands/audit-tenant-scope-readiness.js";
import type { BackfillAuditRow } from "../src/services/audit/audit-tenant-backfill.js";

function row(over: Partial<BackfillAuditRow>): BackfillAuditRow {
  return {
    id: "r", chainVersion: 2, hashVerified: true, organizationId: null, workspaceId: null,
    resourceType: null, resourceId: null, metadata: {}, ...over,
  };
}

describe("§1 — audit tenant-scope readiness command (exit behaviour)", () => {
  it("a clean, fully-resolvable set exits 0", async () => {
    const r = await assessAuditTenantScopeReadiness(
      [
        row({ id: "a", resourceType: "evidence", resourceId: "ev-1" }),
        row({ id: "b", chainVersion: 3, workspaceId: "team-x" }),
      ],
      async () => "team-1",
    );
    expect(r.exitCode).toBe(0);
    expect(r.proven).toBe(1);
    expect(r.alreadyBound).toBe(1);
    expect(r.guessedScope).toBe(0);
  });

  it("HASH_INVALID forces a non-zero exit and is never derived from", async () => {
    const r = await assessAuditTenantScopeReadiness(
      [row({ id: "a", hashVerified: false, resourceType: "evidence", resourceId: "ev-1" })],
      async () => "team-SHOULD_NOT_USE",
    );
    expect(r.results[0].status).toBe("HASH_INVALID");
    expect(r.hashInvalid).toBe(1);
    expect(r.exitCode).toBe(1);
  });

  it("CONFLICT (derived ≠ existing column) forces a non-zero exit — never silently overwrites", async () => {
    const r = await assessAuditTenantScopeReadiness(
      [row({ id: "a", workspaceId: "team-STORED", resourceType: "evidence", resourceId: "ev-1" })],
      async () => "team-DERIVED", // disagrees with the stored column
    );
    expect(r.results[0].status).toBe("CONFLICT");
    expect(r.conflict).toBe(1);
    expect(r.exitCode).toBe(1);
  });

  it("an agreeing existing column is ALREADY_BOUND (exit 0)", async () => {
    const r = await assessAuditTenantScopeReadiness(
      [row({ id: "a", workspaceId: "team-SAME", resourceType: "evidence", resourceId: "ev-1" })],
      async () => "team-SAME",
    );
    expect(r.results[0].status).toBe("ALREADY_BOUND");
    expect(r.exitCode).toBe(0);
  });

  it("an unprovable row is LEGACY_SCOPE_UNRESOLVED, reported explicitly, and does NOT fail the exit", async () => {
    const r = await assessAuditTenantScopeReadiness(
      [row({ id: "a", chainVersion: 1, metadata: {} })], // V1, no hash-protected binding
      async () => "team-NEVER",
    );
    expect(r.results[0].status).toBe("LEGACY_SCOPE_UNRESOLVED");
    expect(r.unresolved).toBe(1);
    expect(r.exitCode).toBe(0); // unresolved is a policy decision, not an integrity failure
  });

  it("the formatted report emits only ids/statuses/counts — no secrets", async () => {
    const r = await assessAuditTenantScopeReadiness(
      [row({ id: "a", resourceType: "evidence", resourceId: "ev-1", metadata: { token: "s3cret", ssn: "x" } })],
      async () => "team-1",
    );
    const text = formatReadinessReport(r).join("\n");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("token");
    expect(text).toContain("PROVEN=1");
    expect(text).toContain("exitCode=0");
  });
});
