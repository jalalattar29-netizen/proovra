import { describe, expect, it, vi } from "vitest";
const H = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("../src/services/platform-audit-log.service.js", () => ({ appendPlatformAuditLog: async (p: any) => { H.calls.push(p); } }));
import { emitTenantAudit } from "../src/services/audit/tenant-audit.service.js";
const emit = async (o: any) => { H.calls.length = 0; await emitTenantAudit({ sourceApp: "API", actorUserId: "u1", workspaceId: "t1", ...o }); return H.calls[0].severity; };
describe("§2 — severity policy (elevate-only, security floors)", () => {
  it("break-glass action floors at critical regardless of caller", async () => {
    expect(await emit({ action: "break_glass.session.revoke", outcome: "success" })).toBe("critical");
    expect(await emit({ action: "break_glass.session.revoke", outcome: "success", severity: "info" })).toBe("critical"); // downgrade denied
  });
  it("a caller may ELEVATE a normal event", async () => {
    expect(await emit({ action: "evidence.read", outcome: "success" })).toBe("info");
    expect(await emit({ action: "evidence.read", outcome: "success", severity: "critical" })).toBe("critical");
  });
  it("a caller may NOT downgrade a security floor", async () => {
    expect(await emit({ action: "security.mfa.disabled", outcome: "success" })).toBe("warning");
    expect(await emit({ action: "security.mfa.disabled", outcome: "success", severity: "info" })).toBe("warning"); // no downgrade
  });
  it("unknown caller severity fails closed to the floor", async () => {
    expect(await emit({ action: "evidence.read", outcome: "denied", severity: "bogus" })).toBe("warning"); // denied floor, unknown ignored
  });
  it("integrity/destruction failures floor at high", async () => {
    expect(await emit({ action: "evidence.destruction.certificate", outcome: "success" })).toBe("high");
  });
});
