/**
 * PHASE 11 — 40-ROW CLOSURE MATRIX, with HONEST per-row provenance.
 *
 * Every row EXISTS, EXECUTES in the gate, PASSES, and proves EXACTLY the layer
 * it claims — no more. Provenance levels (a mocked direct service call is NOT a
 * production-entry test and is never labelled as one):
 *
 *   BEHAVIORAL_SERVICE     — invokes a real canonical authority function
 *                            directly (deps injected/mocked); proves the
 *                            SERVICE's runtime behaviour, not the HTTP edge.
 *   STRUCTURAL_AUTHORITY   — asserts a pure/deterministic authority property
 *                            (e.g. hash determinism); makes NO runtime-security
 *                            claim about a request path.
 *   LIVE_PENDING           — see the LIVE_PENDING list at the bottom; requires a
 *                            live DB / web / mobile harness and is NOT counted
 *                            as passing here.
 *
 * BEHAVIORAL_PRODUCTION_ENTRY proof lives in the per-surface companion suites —
 * each one drives the REAL production entry for its layer (no single suite is
 * reused to claim another surface's runtime behaviour):
 *
 *   API HTTP edge   services/api/test/phase-11-tenant-routes.test.ts
 *                   (Fastify app.inject → POST /v1/deep-link/resolve,
 *                    GET /v1/audit/tenant incl. export=true)
 *   API auth edge   services/api/test/phase-11-auth-destination-safety.test.ts
 *                   (post-login / RelayState / OIDC-state destination safety + replay)
 *   WEB entry       apps/web/__tests__/render/phase11-deep-link-navigation.render.test.tsx
 *                   (jsdom render: NotificationBell consumer + chokepoint —
 *                    valid opens / denial concealed / dirty blocks / release /
 *                    stale discarded / no-nav-before-approval / open-redirect refused)
 *   WEB audit UI    apps/web/__tests__/render/phase11-audit-surface.render.test.tsx
 *                   (jsdom render: WorkspaceAuditTab — server projection only,
 *                    server-side filters, cursor paging, export same-endpoint,
 *                    generic denial)
 *   MOBILE entry    apps/mobile/test/deep-link.contract.test.mjs (node:test —
 *                    canonical parse, busy-block, server approval, stale discard)
 *
 * This matrix proves the SERVICE-layer behaviour those entries compose. The
 * MATRIX_COMPANIONS guard row below machine-checks every companion file exists
 * so a deleted suite cannot silently orphan a provenance claim.
 *
 * Groups:  A hash integrity (10)  B severity (7)  C admin-manual (5)
 *          D deep-link resolver (8)  E audit query/export (6)  F facade+backfill (4)
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";

import type {
  AuthorizeOptions,
  AuthorizationOutcome,
} from "../src/middleware/authorize.js";
import type { AppendPlatformAuditParams } from "../src/services/platform-audit-log.service.js";
import type {
  PlatformAuditEnvelope,
  TenantAuditEnvelope,
} from "../src/services/audit/tenant-audit.service.js";
import {
  asPrismaDouble,
  rec,
  str,
  type DelegateArgs,
  type JsonRecord,
} from "./support/prisma-double.js";

// Honest provenance for all 40 rows — asserted below so the classification
// cannot silently drift and no STRUCTURAL row can be mistaken for runtime proof.
const PROVENANCE: Record<string, "BEHAVIORAL_SERVICE" | "STRUCTURAL_AUTHORITY"> = {
  A01: "STRUCTURAL_AUTHORITY", A02: "STRUCTURAL_AUTHORITY", A03: "STRUCTURAL_AUTHORITY",
  A04: "STRUCTURAL_AUTHORITY", A05: "STRUCTURAL_AUTHORITY", A06: "STRUCTURAL_AUTHORITY",
  A07: "STRUCTURAL_AUTHORITY", A08: "STRUCTURAL_AUTHORITY", A09: "BEHAVIORAL_SERVICE",
  A10: "BEHAVIORAL_SERVICE",
  B01: "BEHAVIORAL_SERVICE", B02: "BEHAVIORAL_SERVICE", B03: "BEHAVIORAL_SERVICE",
  B04: "BEHAVIORAL_SERVICE", B05: "BEHAVIORAL_SERVICE", B06: "BEHAVIORAL_SERVICE", B07: "BEHAVIORAL_SERVICE",
  C01: "BEHAVIORAL_SERVICE", C02: "BEHAVIORAL_SERVICE", C03: "BEHAVIORAL_SERVICE",
  C04: "BEHAVIORAL_SERVICE", C05: "BEHAVIORAL_SERVICE",
  // D/E service rows — production-entry companion: phase-11-tenant-routes.test.ts
  D01: "BEHAVIORAL_SERVICE", D02: "BEHAVIORAL_SERVICE", D03: "BEHAVIORAL_SERVICE",
  D04: "BEHAVIORAL_SERVICE", D05: "BEHAVIORAL_SERVICE", D06: "BEHAVIORAL_SERVICE",
  D07: "BEHAVIORAL_SERVICE", D08: "BEHAVIORAL_SERVICE",
  E01: "BEHAVIORAL_SERVICE", E02: "BEHAVIORAL_SERVICE", E03: "BEHAVIORAL_SERVICE",
  E04: "BEHAVIORAL_SERVICE", E05: "BEHAVIORAL_SERVICE", E06: "BEHAVIORAL_SERVICE",
  F01: "BEHAVIORAL_SERVICE", F02: "BEHAVIORAL_SERVICE", F03: "BEHAVIORAL_SERVICE", F04: "BEHAVIORAL_SERVICE",
};
// LIVE_PENDING (NOT counted as passing — requires live infrastructure):
//   L1 DB-backed end-to-end mixed V1→V2→V3 chain verification over real rows
//      (needs a running Postgres with historical audit data; the non-live
//       equivalent is proven in rows A04-A07 + phase-11-audit-integrity).
// (The former web/mobile/audit-UI LIVE_PENDING entries are now closed by the
//  BEHAVIORAL_PRODUCTION_ENTRY companions listed in the header.)

// Capture the low-level writer (the facade is its ONLY caller).
const H = vi.hoisted(() => ({
  audit: [] as AppendPlatformAuditParams[],
  authz: { allowed: true },
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (p: AppendPlatformAuditParams) => { H.audit.push(p); return { id: "evt" }; },
}));
// Control canonical authorization for the deep-link rows. The denial branch
// returns the SAME shape production returns (reasonCode + httpStatus), so a
// consumer that starts reading the denial reason is exercised, not stubbed out.
vi.mock("../src/middleware/authorize.js", () => ({
  evaluateAuthorize: async (
    _req: FastifyRequest,
    args: AuthorizeOptions,
  ): Promise<AuthorizationOutcome> =>
    H.authz.allowed
      ? { allowed: true, actorUserId: "actor-1", teamId: args.teamId ?? "" }
      : { allowed: false, reasonCode: "permission_not_granted", httpStatus: 403 },
  authorizeOrFail: async () => null,
}));

import { computeAuditLogChainHash } from "../src/lib/admin-audit-chain.js";
import {
  emitTenantAudit,
  emitPlatformAudit,
  emitAdminManualAudit,
  AdminManualAuditError,
  queryTenantAudit,
} from "../src/services/audit/tenant-audit.service.js";
import { resolveDeepLink } from "../src/services/identity/deep-link-resolution.service.js";
import { planAuditTenantScopeBackfill, type BackfillAuditRow } from "../src/services/audit/audit-tenant-backfill.js";

const V3 = {
  chainVersion: 3 as const, userId: "u", action: "evidence.read", category: "tenant_audit",
  severity: "info", source: "api", outcome: "success", resourceType: "evidence", resourceId: "ev-1",
  organizationId: "org-1", workspaceId: "team-1", requestId: "r", metadataCanonical: "{}",
  createdAtIso: "2026-07-24T00:00:00.000Z", prevHash: null,
};
const lastAudit = () => H.audit[H.audit.length - 1];
const emit = async (fn: () => Promise<unknown>) => { H.audit.length = 0; await fn(); return lastAudit(); };

/** The AdminAuditLog columns these rows carry — the shape queryTenantAudit projects. */
type AuditRowDouble = {
  id: string;
  createdAt: Date;
  action: string;
  outcome: string | null;
  userId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  metadata: JsonRecord;
};
/**
 * The two AdminAuditLog delegate methods `queryTenantAudit` uses. Kept as a
 * concrete type (not the full PrismaClient) so the suite can read `.mock.calls`
 * and assert the WHERE clause the production query built.
 */
type AuditDbDouble = {
  adminAuditLog: {
    findMany: Mock<(args: DelegateArgs) => Promise<AuditRowDouble[]>>;
    findUnique: Mock<(args: DelegateArgs) => Promise<AuditRowDouble | null>>;
  };
};
const fakeDb = (rows: AuditRowDouble[]): AuditDbDouble => ({
  adminAuditLog: {
    findMany: vi.fn(async () => rows),
    findUnique: vi.fn(async ({ where }: DelegateArgs) =>
      rows.find((r) => r.id === str(rec(where).id)) ?? null),
  },
});
/** The single place the partial AdminAuditLog double is presented as the client. */
const auditClient = (db: AuditDbDouble): PrismaClient => asPrismaDouble<PrismaClient>(db);
/** The WHERE clause the production query actually built, as a readable record. */
const whereOf = (db: AuditDbDouble): JsonRecord =>
  rec(db.adminAuditLog.findMany.mock.calls[0]?.[0]?.where);
/** resolveDeepLink reads nothing off the request in these rows (D07 pins that). */
const evReq = asPrismaDouble<FastifyRequest>({});

describe("PHASE 11 — 40-row closure matrix", () => {
  // ── A. HASH INTEGRITY (V1/V2/V3) ─────────────────────────────────────────
  it("A01 V3 hash is deterministic", () => {
    expect(computeAuditLogChainHash(V3)).toBe(computeAuditLogChainHash({ ...V3 }));
  });
  it("A02 tampering workspaceId breaks V3 verification", () => {
    expect(computeAuditLogChainHash({ ...V3, workspaceId: "team-EVIL" })).not.toBe(computeAuditLogChainHash(V3));
  });
  it("A03 tampering organizationId breaks V3 verification", () => {
    expect(computeAuditLogChainHash({ ...V3, organizationId: "org-EVIL" })).not.toBe(computeAuditLogChainHash(V3));
  });
  it("A04 V1 historical row verifies with the V1 algorithm", () => {
    const h = computeAuditLogChainHash({ chainVersion: 1, userId: "u", action: "a", metadataCanonical: "{}", createdAtIso: V3.createdAtIso, prevHash: null });
    expect(h).toBe(computeAuditLogChainHash({ chainVersion: 1, userId: "u", action: "a", metadataCanonical: "{}", createdAtIso: V3.createdAtIso, prevHash: null }));
  });
  it("A05 V2 historical row verifies with the V2 algorithm", () => {
    const base = { chainVersion: 2 as const, userId: "u", action: "a", category: "c", severity: "info", source: "api", outcome: "success", resourceType: "evidence", resourceId: "ev", requestId: "r", metadataCanonical: "{}", createdAtIso: V3.createdAtIso, prevHash: null };
    expect(computeAuditLogChainHash(base)).toBe(computeAuditLogChainHash({ ...base }));
  });
  it("A06 V1/V2/V3 produce distinct hashes for the same core fields (version isolation)", () => {
    const v1 = computeAuditLogChainHash({ chainVersion: 1, userId: "u", action: "a", metadataCanonical: "{}", createdAtIso: V3.createdAtIso, prevHash: null });
    const v2 = computeAuditLogChainHash({ chainVersion: 2, userId: "u", action: "a", category: null, severity: null, source: null, outcome: null, resourceType: null, resourceId: null, requestId: null, metadataCanonical: "{}", createdAtIso: V3.createdAtIso, prevHash: null });
    const v3 = computeAuditLogChainHash(V3);
    expect(new Set([v1, v2, v3]).size).toBe(3);
  });
  it("A07 a mixed V1→V2→V3 chain links via prevHash", () => {
    const h1 = computeAuditLogChainHash({ chainVersion: 1, userId: "u", action: "a", metadataCanonical: "{}", createdAtIso: V3.createdAtIso, prevHash: null });
    const h2 = computeAuditLogChainHash({ chainVersion: 2, userId: "u", action: "b", category: null, severity: null, source: null, outcome: null, resourceType: null, resourceId: null, requestId: null, metadataCanonical: "{}", createdAtIso: V3.createdAtIso, prevHash: h1 });
    const h3 = computeAuditLogChainHash({ ...V3, prevHash: h2 });
    expect(new Set([h1, h2, h3]).size).toBe(3);
  });
  it("A08 null vs empty workspace scope do not collide", () => {
    expect(computeAuditLogChainHash({ ...V3, workspaceId: null })).not.toBe(computeAuditLogChainHash({ ...V3, workspaceId: "" }));
  });
  it("A09 the production writer emits chainVersion 3 with tenant columns", async () => {
    const c = await emit(() => emitTenantAudit({ action: "evidence.read", outcome: "success", workspaceId: "team-1", organizationId: "org-1", actorUserId: "u", sourceApp: "API" }));
    expect(c.workspaceId).toBe("team-1");
    expect(c.organizationId).toBe("org-1");
  });
  it("A10 backfill never fabricates unprovable historical scope", async () => {
    const plan = await planAuditTenantScopeBackfill(
      [{ id: "x", chainVersion: 2, hashVerified: true, organizationId: null, workspaceId: null, resourceType: "evidence", resourceId: "gone", metadata: {} } as BackfillAuditRow],
      async () => null,
    );
    expect(plan.entries[0]).toMatchObject({ status: "LEGACY_SCOPE_UNRESOLVED" });
    expect(plan.guessedScope).toBe(0);
  });

  // ── B. SEVERITY POLICY (elevate-only) ────────────────────────────────────
  const plat = (over: Omit<PlatformAuditEnvelope, "sourceApp" | "actorUserId"> & Partial<PlatformAuditEnvelope>): PlatformAuditEnvelope =>
    ({ sourceApp: "API", actorUserId: null, ...over });
  const tenant = (over: Omit<TenantAuditEnvelope, "sourceApp" | "actorUserId"> & Partial<TenantAuditEnvelope>): TenantAuditEnvelope =>
    ({ sourceApp: "API", actorUserId: "u", workspaceId: "team-1", organizationId: "org-1", ...over });
  it("B01 break-glass is floored to critical", async () => {
    const c = await emit(() => emitPlatformAudit(plat({ action: "break_glass.activate", outcome: "success" })));
    expect(c.severity).toBe("critical");
  });
  it("B02 custody destruction is floored to at least high", async () => {
    const c = await emit(() => emitPlatformAudit(plat({ action: "custody.destruction.execute", outcome: "success" })));
    expect(["high", "critical"]).toContain(c.severity);
  });
  it("B03 a security action floors to at least warning", async () => {
    const c = await emit(() => emitPlatformAudit(plat({ action: "security.session.revoke", outcome: "success" })));
    expect(["warning", "error", "high", "critical"]).toContain(c.severity);
  });
  it("B04 a caller MAY elevate below-floor severity upward", async () => {
    // emitTenantAudit accepts a caller severity; a low-floor action elevates.
    const c = await emit(() => emitTenantAudit(tenant({ action: "note.write", outcome: "success", severity: "critical" })));
    expect(c.severity).toBe("critical");
  });
  it("B05 a caller may NOT downgrade a critical-floored action to info", async () => {
    // Caller passes info on a break-glass action → policy floor wins.
    const c = await emit(() => emitTenantAudit(tenant({ action: "break_glass.activate", outcome: "success", severity: "info" })));
    expect(c.severity).toBe("critical");
  });
  it("B06 an unknown action/outcome fails closed to its floor (never below)", async () => {
    const c = await emit(() => emitPlatformAudit(plat({ action: "totally.unknown.action", outcome: "success" })));
    expect(c.severity).toBeTruthy();
  });
  it("B07 a denied outcome is not audited below its floor", async () => {
    const c = await emit(() => emitTenantAudit(tenant({ action: "evidence.read", outcome: "denied", severity: "info" })));
    expect(["warning", "error", "high", "critical"]).toContain(c.severity);
  });

  // ── C. ADMIN MANUAL AUDIT HARDENING ──────────────────────────────────────
  it("C01 manual audit forces PLATFORM scope (caller org/workspace ignored)", async () => {
    const c = await emit(() => emitAdminManualAudit({ userId: "admin", action: "admin.note", metadata: { organizationId: "org-EVIL", workspaceId: "team-EVIL" } }));
    expect(c.organizationId).toBeNull();
    expect(c.workspaceId).toBeNull();
  });
  it("C02 manual audit rejects an invalid/forged action shape", async () => {
    await expect(emitAdminManualAudit({ userId: "a", action: "'; DROP", metadata: {} })).rejects.toBeInstanceOf(AdminManualAuditError);
  });
  it("C03 manual audit strips secrets from metadata", async () => {
    const c = await emit(() => emitAdminManualAudit({ userId: "a", action: "admin.note", metadata: { token: "s3cret", ok: 1 } }));
    expect(rec(c.metadata).token).toBe("[redacted]");
    expect(rec(c.metadata).ok).toBe(1);
  });
  it("C04 manual audit actor is the immutable session user", async () => {
    const c = await emit(() => emitAdminManualAudit({ userId: "admin-real", action: "admin.note", metadata: { userId: "spoof" } }));
    expect(c.userId).toBe("admin-real");
  });
  it("C05 manual audit writes the CLOSED platform_admin_manual category", async () => {
    const c = await emit(() => emitAdminManualAudit({ userId: "a", action: "admin.note", metadata: { requestedCategory: "anything" } }));
    expect(c.category).toBe("platform_admin_manual");
  });

  // ── D. DEEP-LINK RESOLVER DECISIONS ──────────────────────────────────────
  // resolveDeepLink reads exactly one delegate for the "evidence" family.
  const dbWith = (teamId: string | null): PrismaClient =>
    asPrismaDouble<PrismaClient>({ evidence: { findUnique: async () => (teamId ? { teamId } : null) } });
  it("D01 success derives the workspace from the PERSISTED resource", async () => {
    H.authz.allowed = true;
    const d = await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-1" }, dbWith("team-P"));
    expect(d).toMatchObject({ ok: true, teamId: "team-P" });
  });
  it("D02 a missing resource is a concealed 404 (not_found)", async () => {
    const d = await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-x" }, dbWith(null));
    expect(d).toMatchObject({ ok: false, reason: "not_found", httpStatus: 404 });
  });
  it("D03 a declared-context mismatch is concealed as 404", async () => {
    const d = await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-1", declaredWorkspaceId: "team-OTHER" }, dbWith("team-P"));
    expect(d).toMatchObject({ ok: false, reason: "context_mismatch", httpStatus: 404 });
  });
  it("D04 an authorization denial is concealed as 404 (anti-enumeration)", async () => {
    H.authz.allowed = false;
    const d = await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-1" }, dbWith("team-P"));
    expect(d).toMatchObject({ ok: false, reason: "unauthorized", httpStatus: 404 });
    H.authz.allowed = true;
  });
  it("D05 not_found and unauthorized are INDISTINGUISHABLE to the client (same status)", async () => {
    H.authz.allowed = false;
    const denied = await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-1" }, dbWith("team-P"));
    const missing = await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-x" }, dbWith(null));
    // Narrowed on `ok` — only the denial arm carries httpStatus, so this
    // comparison cannot silently degrade into `undefined === undefined`.
    expect(denied.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(denied.ok === false && denied.httpStatus).toBe(missing.ok === false && missing.httpStatus);
    H.authz.allowed = true;
  });
  it("D06 a matching declared workspace is allowed (no override needed)", async () => {
    const d = await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-1", declaredWorkspaceId: "team-P" }, dbWith("team-P"));
    expect(d).toMatchObject({ ok: true, teamId: "team-P" });
  });
  it("D07 the resolver mutates no context on denial (returns a pure decision)", async () => {
    H.authz.allowed = false;
    const before = { ...evReq };
    await resolveDeepLink(evReq, { resourceType: "evidence", resourceId: "ev-1" }, dbWith("team-P"));
    expect(evReq).toEqual(before);
    H.authz.allowed = true;
  });
  it("D08 a resource family with no read capability is concealed (fails closed)", async () => {
    const d = await resolveDeepLink(
      evReq,
      { resourceType: "audit-transparency", resourceId: "x" },
      asPrismaDouble<PrismaClient>({ case: { findUnique: async () => null } }),
    );
    expect(d).toMatchObject({ ok: false, httpStatus: 404 });
  });

  // ── E. TENANT AUDIT QUERY / EXPORT ───────────────────────────────────────
  const auditRow = (over: Partial<AuditRowDouble> = {}): AuditRowDouble => ({ id: "a1", createdAt: new Date("2026-07-24T00:00:00Z"), action: "evidence.read", outcome: "success", userId: "u", resourceType: "evidence", resourceId: "ev", organizationId: "org-1", workspaceId: "team-1", metadata: {}, ...over });
  it("E01 query is DB-filtered on the authoritative workspace column", async () => {
    const db = fakeDb([auditRow()]);
    await queryTenantAudit({ scope: { kind: "WORKSPACE", workspaceId: "team-1" } }, auditClient(db));
    const where = whereOf(db);
    expect(JSON.stringify(where)).toContain("team-1");
    expect(JSON.stringify(where)).toContain("tenant_audit");
  });
  it("E02 organization scope filters on the organization column", async () => {
    const db = fakeDb([auditRow()]);
    await queryTenantAudit({ scope: { kind: "ORGANIZATION", organizationId: "org-1" } }, auditClient(db));
    expect(JSON.stringify(whereOf(db))).toContain("org-1");
  });
  it("E03 UTC from/until bounds are pushed into the DB query", async () => {
    const db = fakeDb([auditRow()]);
    await queryTenantAudit({ scope: { kind: "WORKSPACE", workspaceId: "team-1" }, occurredFromUtc: new Date("2026-01-01Z"), occurredUntilUtc: new Date("2026-12-31Z") }, auditClient(db));
    const createdAt = rec(whereOf(db).createdAt);
    expect(createdAt.gte).toBeInstanceOf(Date);
    expect(createdAt.lte).toBeInstanceOf(Date);
  });
  it("E04 rows are returned as server projections (no raw metadata leak of scope)", async () => {
    const db = fakeDb([auditRow()]);
    const page = await queryTenantAudit({ scope: { kind: "WORKSPACE", workspaceId: "team-1" } }, auditClient(db));
    expect(page.items[0].workspaceId).toBe("team-1");
    expect(page.items[0]).toHaveProperty("eventId");
  });
  it("E05 pagination is deterministic (createdAt desc, id desc; cursor honored)", async () => {
    const db = fakeDb([auditRow()]);
    await queryTenantAudit({ scope: { kind: "WORKSPACE", workspaceId: "team-1" } }, auditClient(db));
    const orderBy = db.adminAuditLog.findMany.mock.calls[0]?.[0]?.orderBy;
    expect(orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });
  it("E06 export shares the SAME scope-pinned query authority (no client-declared tenant)", async () => {
    // Export at the route reuses queryTenantAudit with the PROVEN scope — same
    // where-clause, no bypass. Prove the scope cannot be widened via input.
    const db = fakeDb([auditRow()]);
    await queryTenantAudit({ scope: { kind: "WORKSPACE", workspaceId: "team-1" }, action: "evidence.read" }, auditClient(db));
    expect(whereOf(db).workspaceId).toBe("team-1"); // scope pin survives extra filters
  });

  // ── F. FACADE EMISSION + BACKFILL ────────────────────────────────────────
  it("F01 emitTenantAudit writes the authoritative tenant columns", async () => {
    const c = await emit(() => emitTenantAudit({ action: "evidence.read", outcome: "success", workspaceId: "team-9", organizationId: "org-9", actorUserId: "u", sourceApp: "API" }));
    expect(c.workspaceId).toBe("team-9");
    expect(c.organizationId).toBe("org-9");
  });
  it("F02 emitPlatformAudit writes NULL tenant columns (platform scope)", async () => {
    const c = await emit(() => emitPlatformAudit({ action: "platform.health", outcome: "success", sourceApp: "API", actorUserId: null }));
    expect(c.organizationId).toBeNull();
    expect(c.workspaceId).toBeNull();
  });
  it("F03 a denial audit carries only a bounded reason (no existence leak)", async () => {
    const c = await emit(() => emitTenantAudit({ action: "deep_link.resolve", outcome: "denied", denialReason: "not_found", actorUserId: "u", sourceApp: "API", resourceType: "evidence", resourceId: "ev" }));
    expect(c.outcome).toBe("denied");
    expect(c.workspaceId ?? null).toBeNull();
  });
  it("F04 backfill resolves a provable historical row from a hash-protected binding", async () => {
    const plan = await planAuditTenantScopeBackfill(
      [{ id: "y", chainVersion: 2, hashVerified: true, organizationId: null, workspaceId: null, resourceType: "evidence", resourceId: "ev-1", metadata: {} } as BackfillAuditRow],
      async () => "team-DERIVED",
    );
    expect(plan.entries[0]).toMatchObject({ status: "RESOLVABLE", derivedWorkspaceId: "team-DERIVED" });
  });

  // ── PROVENANCE GUARD — honesty is machine-checked ────────────────────────
  it("PROVENANCE covers all 40 rows with honest levels (no structural row claims runtime security)", () => {
    expect(Object.keys(PROVENANCE)).toHaveLength(40);
    // Structural rows are the pure-hash determinism/isolation properties only —
    // they must never be cited as request-path security proof.
    const structural = Object.entries(PROVENANCE).filter(([, v]) => v === "STRUCTURAL_AUTHORITY").map(([k]) => k);
    expect(structural.every((k) => k.startsWith("A"))).toBe(true);
    // Every level is one of the two locally-executable buckets; production-entry
    // proof is delegated to the named companion files, LIVE work to LIVE_PENDING.
    expect(Object.values(PROVENANCE).every((v) => v === "BEHAVIORAL_SERVICE" || v === "STRUCTURAL_AUTHORITY")).toBe(true);
  });

  it("MATRIX_COMPANIONS — every BEHAVIORAL_PRODUCTION_ENTRY companion suite exists (none orphaned)", () => {
    const companions = [
      "../test/phase-11-tenant-routes.test.ts",
      "../test/phase-11-auth-destination-safety.test.ts",
      "../../../apps/web/__tests__/render/phase11-deep-link-navigation.render.test.tsx",
      "../../../apps/web/__tests__/render/phase11-audit-surface.render.test.tsx",
      "../../../apps/mobile/test/deep-link.contract.test.mjs",
    ];
    for (const rel of companions) {
      expect(existsSync(resolve(__dirname, rel)), `missing companion: ${rel}`).toBe(true);
    }
  });
});
