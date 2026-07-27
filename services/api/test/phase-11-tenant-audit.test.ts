import { afterEach, describe, expect, it, vi } from "vitest";
const H = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (p: any) => { H.calls.push(p); },
}));
import { emitTenantAudit } from "../src/services/audit/tenant-audit.service.js";
afterEach(() => { H.calls.length = 0; });
describe("Phase 11 — emitTenantAudit (ONE envelope authority over the hash-chained sink)", () => {
  it("composes appendPlatformAuditLog with tenant attribution + dual identity", async () => {
    await emitTenantAudit({ action: "evidence.read", outcome: "success", sourceApp: "API", actorUserId: "support-1", supportActorUserId: "support-1", effectiveCustomerUserId: "cust-1", organizationId: "org-1", workspaceId: "team-1", workspaceKind: "ORGANIZATION", resourceType: "evidence", resourceId: "ev-1", capability: "evidence.read", policyVersion: 3, sessionRefHash: "sh", authMethod: "SSO", correlationId: "req-1" });
    expect(H.calls).toHaveLength(1);
    const c = H.calls[0];
    expect(c).toMatchObject({ action: "evidence.read", category: "tenant_audit", source: "api", outcome: "success", resourceType: "evidence", resourceId: "ev-1", userId: "support-1", isPublic: false });
    expect(c.metadata).toMatchObject({ organizationId: "org-1", workspaceId: "team-1", workspaceKind: "ORGANIZATION", supportActorUserId: "support-1", effectiveCustomerUserId: "cust-1", capability: "evidence.read", policyVersion: 3, authMethod: "SSO", correlationId: "req-1" });
  });
  it("service/system event (no human actor) is a public row with serviceActor", async () => {
    await emitTenantAudit({ action: "worker.revalidate", outcome: "success", sourceApp: "WORKER", actorUserId: null, serviceActor: "revalidation-worker", jobId: "job-9", causationId: "cause-1", workspaceId: "team-1" });
    expect(H.calls[0]).toMatchObject({ userId: null, isPublic: true });
    expect(H.calls[0].metadata).toMatchObject({ serviceActor: "revalidation-worker", jobId: "job-9", causationId: "cause-1" });
  });
  it("NEVER stores secrets — token/jwt/secret keys are redacted", async () => {
    await emitTenantAudit({ action: "sso.login", outcome: "success", sourceApp: "SSO", actorUserId: "u1", metadata: { relayState: "x", nested: { apiKey: "k", ok: 1 }, jwt: "e.y.z" } });
    const m = H.calls[0].metadata;
    expect(m.relayState).toBe("[redacted]");
    expect(m.jwt).toBe("[redacted]");
    expect(m.nested.apiKey).toBe("[redacted]");
    expect(m.nested.ok).toBe(1);
  });
  it("denial is audited with a bounded reason (warning severity)", async () => {
    await emitTenantAudit({ action: "evidence.read", outcome: "denied", denialReason: "not_a_member", sourceApp: "API", actorUserId: "u1", resourceType: "evidence", resourceId: "ev-1" });
    expect(H.calls[0]).toMatchObject({ severity: "warning", outcome: "denied" });
    expect(H.calls[0].metadata.denialReason).toBe("not_a_member");
  });
  it("break-glass attribution is captured", async () => {
    await emitTenantAudit({ action: "session.revoke", outcome: "success", sourceApp: "API", actorUserId: "op-1", breakGlassGrantId: "eag-1", workspaceId: "team-1" });
    expect(H.calls[0].metadata.breakGlassGrantId).toBe("eag-1");
  });
});
