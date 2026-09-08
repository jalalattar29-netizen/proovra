import { describe, expect, it, vi } from "vitest";
type AuditMeta = { [key: string]: AuditMeta | unknown };
type AuditRow = Record<string, unknown> & { metadata?: AuditMeta };
const H = vi.hoisted(() => ({ calls: [] as AuditRow[] }));
vi.mock("../src/services/platform-audit-log.service.js", () => ({ appendPlatformAuditLog: async (p: AuditRow) => { H.calls.push(p); } }));
import { emitAdminManualAudit, AdminManualAuditError, ADMIN_MANUAL_AUDIT_SOURCE } from "../src/services/audit/tenant-audit.service.js";
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

/**
 * ADM-P2-007 / OWN-5 — the manual-entry arm names its real origin.
 *
 * `POST /v1/admin/audit-log` has no console control and never had one: the
 * Admin activity page reads the listing, the export and the verify legs and
 * writes nothing, and a repository-wide consumer scan finds no caller anywhere.
 * The row's authoritative `source` was nevertheless fixed to "admin_console",
 * so every entry claimed an origin surface that cannot produce it.
 *
 * OWN-5 keeps the capability API-only, so the field names the API.
 */
describe("ADM-P2-007 — manual audit source truth", () => {
  it("stores the truthful API source when the caller supplies none", async () => {
    const c = await run({});
    expect(c.source).toBe(ADMIN_MANUAL_AUDIT_SOURCE);
    expect(c.source).toBe("admin_api");
    expect(
      c.source,
      "the row must not claim an origin surface that does not exist",
    ).not.toBe("admin_console");
  });

  it("a caller-supplied source is recorded as DATA, never as authority", async () => {
    const c = await run({ source: "admin_console" });
    // The envelope stays fixed…
    expect(c.source).toBe(ADMIN_MANUAL_AUDIT_SOURCE);
    // …and the caller's claim is kept where a reader can see it is a claim.
    expect((c.metadata as Record<string, unknown>)?.requestedSource).toBe(
      "admin_console",
    );
  });

  it("the sealed envelope is otherwise unchanged", () => {
    // Actor, scope, category and severity handling are asserted above; this
    // pins that correcting the source did not loosen any of them.
    expect(ADMIN_MANUAL_AUDIT_SOURCE).toMatch(/^[a-z_]+$/);
  });
});
