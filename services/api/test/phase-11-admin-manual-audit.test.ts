import { describe, expect, it, vi } from "vitest";
type AuditMeta = { [key: string]: AuditMeta | unknown };
type AuditRow = Record<string, unknown> & { metadata?: AuditMeta };
const H = vi.hoisted(() => ({ calls: [] as AuditRow[] }));
vi.mock("../src/services/platform-audit-log.service.js", () => ({ appendPlatformAuditLog: async (p: AuditRow) => { H.calls.push(p); } }));
import { emitAdminManualAudit, AdminManualAuditError } from "../src/services/audit/tenant-audit.service.js";
const run = async (o: Partial<Parameters<typeof emitAdminManualAudit>[0]>) => { H.calls.length = 0; await emitAdminManualAudit({ userId: "admin-1", action: "admin.note", metadata: {}, ...o }); return H.calls[0]; };
describe("§3 — emitAdminManualAudit hardening", () => {
  it("forces PLATFORM scope — caller cannot set organization/workspace", async () => {
    const c = await run({ metadata: { organizationId: "org-EVIL", workspaceId: "team-EVIL" } });
    expect(c.organizationId).toBeNull();
    expect(c.workspaceId).toBeNull();
    expect(c.category).toBe("platform_admin_manual");
  });
  it("rejects a forged/invalid action shape", async () => {
    await expect(emitAdminManualAudit({ userId: "a", action: "'; DROP TABLE", metadata: {} })).rejects.toBeInstanceOf(AdminManualAuditError);
    await expect(emitAdminManualAudit({ userId: "a", action: "", metadata: {} })).rejects.toBeInstanceOf(AdminManualAuditError);
  });
  it("caller cannot forge support/break-glass/service actor (not accepted)", async () => {
    const c = await run({ metadata: { supportActorUserId: "x", breakGlassGrantId: "y" } });
    // those go into metadata as data, never authoritative envelope fields
    expect(c.userId).toBe("admin-1"); // actor is the session user, immutable
  });
  it("caller cannot downgrade a security-floored action", async () => {
    const c = await run({ action: "security.override", severity: "info" });
    expect(c.severity).toBe("warning"); // floored, not info
  });
  it("strips secrets from metadata", async () => {
    const c = await run({ metadata: { token: "secret", ok: 1 } });
    expect(c.metadata?.token).toBe("[redacted]");
    expect(c.metadata?.ok).toBe(1);
  });
});
