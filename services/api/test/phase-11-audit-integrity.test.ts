/**
 * PHASE 11 §1 — the authoritative tenant scope is HASH-BOUND (V3). Modifying
 * organizationId/workspaceId breaks verification; V1/V2 remain historical and
 * verify with their own algorithm; V3 is the only new write format.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { computeAuditLogChainHash } from "../src/lib/admin-audit-chain.js";

const baseV3 = {
  chainVersion: 3 as const,
  userId: "u1",
  action: "evidence.read",
  category: "tenant_audit",
  severity: "info",
  source: "api",
  outcome: "success",
  resourceType: "evidence",
  resourceId: "ev-1",
  organizationId: "org-1",
  workspaceId: "team-1",
  requestId: "req-1",
  metadataCanonical: "{}",
  createdAtIso: "2026-07-24T00:00:00.000Z",
  prevHash: null,
};

describe("§1 — V3 hash binds the authoritative tenant scope", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeAuditLogChainHash(baseV3)).toBe(computeAuditLogChainHash({ ...baseV3 }));
  });

  it("changing workspaceId BREAKS the hash (tamper-evident)", () => {
    const tampered = computeAuditLogChainHash({ ...baseV3, workspaceId: "team-EVIL" });
    expect(tampered).not.toBe(computeAuditLogChainHash(baseV3));
  });

  it("changing organizationId BREAKS the hash", () => {
    const tampered = computeAuditLogChainHash({ ...baseV3, organizationId: "org-EVIL" });
    expect(tampered).not.toBe(computeAuditLogChainHash(baseV3));
  });

  it("null vs empty workspace are distinct + deterministic (no collision)", () => {
    const withNull = computeAuditLogChainHash({ ...baseV3, workspaceId: null });
    const withEmpty = computeAuditLogChainHash({ ...baseV3, workspaceId: "" });
    expect(withNull).not.toBe(withEmpty);
    expect(withNull).toBe(computeAuditLogChainHash({ ...baseV3, workspaceId: null }));
  });

  it("V3 differs from V2/V1 for the same core fields (version isolation)", () => {
    const v3 = computeAuditLogChainHash(baseV3);
    const v2 = computeAuditLogChainHash({ chainVersion: 2, userId: baseV3.userId, action: baseV3.action, category: baseV3.category, severity: baseV3.severity, source: baseV3.source, outcome: baseV3.outcome, resourceType: baseV3.resourceType, resourceId: baseV3.resourceId, requestId: baseV3.requestId, metadataCanonical: baseV3.metadataCanonical, createdAtIso: baseV3.createdAtIso, prevHash: null });
    const v1 = computeAuditLogChainHash({ chainVersion: 1, userId: baseV3.userId, action: baseV3.action, metadataCanonical: baseV3.metadataCanonical, createdAtIso: baseV3.createdAtIso, prevHash: null });
    expect(new Set([v1, v2, v3]).size).toBe(3);
  });

  it("a mixed V1→V2→V3 chain links via prevHash", () => {
    const h1 = computeAuditLogChainHash({ chainVersion: 1, userId: "u1", action: "a", metadataCanonical: "{}", createdAtIso: baseV3.createdAtIso, prevHash: null });
    const h2 = computeAuditLogChainHash({ chainVersion: 2, userId: "u1", action: "b", category: null, severity: null, source: null, outcome: null, resourceType: null, resourceId: null, requestId: null, metadataCanonical: "{}", createdAtIso: baseV3.createdAtIso, prevHash: h1 });
    const h3 = computeAuditLogChainHash({ ...baseV3, prevHash: h2 });
    expect(h1 && h2 && h3).toBeTruthy();
    expect(new Set([h1, h2, h3]).size).toBe(3);
  });

  it("SOURCE CONTRACT — the writer emits chainVersion 3 (new V1/V2 writes = 0)", () => {
    const src = readFileSync(resolve(__dirname, "../src/services/platform-audit-log.service.ts"), "utf8");
    const createIdx = src.indexOf("tx.adminAuditLog.create");
    const block = src.slice(createIdx, createIdx + 700);
    expect(block).toMatch(/chainVersion:\s*3/);
    expect(block).not.toMatch(/chainVersion:\s*[12]\b/);
  });
});
