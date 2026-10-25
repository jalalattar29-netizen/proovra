/**
 * PHASE 12 CORRECTIVE PASS §1 — NEW-005, DIRECT RUNTIME PROOF (permission-guard
 * edition, after members audit DOM-09).
 *
 * The finding
 * ---------------------------------------------------------------------------
 * The retired `requireDelegatedTier` resolved the workspace from
 * `User.currentWorkspaceId` and then asked whether a tier GRANT existed. That
 * said nothing about whether the caller was still a LIVE member, so a
 * SUSPENDED, REVOKED, removed or time-expired operator kept passing every
 * delegated-tier route for as long as their grant row stayed ACTIVE.
 *
 * The tier model is now retired: one authority remains, the canonical
 * permission engine (role + member capability grants + member delegated
 * scopes), and every former tier route is guarded by
 * `requireWorkspacePermission(...)`. The question NEW-005 asked is unchanged
 * and is re-asked here against the new guard: does holding the AUTHORITY (a
 * live capability grant for every permission the surface names) admit a
 * caller whose MEMBERSHIP is not live?
 *
 * What "the surface" means here, and why it is not three routes
 * ---------------------------------------------------------------------------
 * The route list is DERIVED from the sources by
 * `permission-guard-route-inventory.ts` and cross-checked against an
 * independent count of guard call sites; if the parser under-matches,
 * `beforeAll` throws rather than letting this suite claim a coverage it does
 * not have. Every registration is driven in every refusal case.
 *
 * The operator is a non-owner VIEWER of workspace A. Deliberately: an OWNER
 * holds every permission by role and a MEMBER (canonical REVIEWER) already
 * holds `audit.read`, so for either some routes would pass with no grant at
 * all and the "the grant is gone" cases would prove nothing for them.
 * `beforeAll` asserts the VIEWER role holds NONE of the surface's permissions,
 * so every admission in case 1 is attributable to the capability grants.
 *
 * Ids in paths are random UUIDs. The decision under test is taken in a
 * `preHandler`, before any handler reads an id — and an unresolvable id means
 * that if a guard ever regressed, the handler behind it would still find
 * nothing to act on, so this probe cannot become the thing that writes.
 *
 * Everything runs against a disposable PostgreSQL 16 + pgvector, a disposable
 * Redis and the local recording email transport. Nothing leaves the machine.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleHasPermission, type Permission } from "@proovra/shared";

import {
  assertInventoryComplete,
  concretePath,
  loadPermissionGuardRoutes,
  surfacePermissions,
  type PermissionGuardRoute,
} from "./permission-guard-route-inventory.js";
import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

/** The guard's denial envelope — the one thing every case asserts about. */
const GUARD_DENIAL = "PERMISSION_REQUIRED";

/**
 * Tables whose rows are AUDIT of a decision, not tenant business state.
 *
 * A refusal is *expected* to leave a trace: that is the point of a security
 * log. Case 14 asks a narrower question — did a refused request change
 * anything the tenant owns — so these are excluded by name rather than the
 * assertion being weakened to "some tables".
 */
const AUDIT_TABLES: ReadonlySet<string> = new Set([
  "security_events",
  "trust_events",
  "tenant_audit_events",
  "platform_audit_logs",
  "audit_events",
  "team_activities",
  "evidence_audit_events",
  "access_anomalies",
  "authorization_decisions",
  "delegated_admin_events",
  "governance_events",
  "lifecycle_events",
  // The authorization-denial telemetry pair: one `increment` event per
  // refused request, carrying a sanitised WARNING message and no
  // tenant-owned field. Excluded for the same reason `security_events` is.
  "operational_incidents",
  "operational_incident_events",
  "api_request_logs",
  "queue_telemetry_snapshots",
  "metric_samples",
]);

type RowCensus = ReadonlyMap<string, number>;

type Modules = {
  grantCapability: typeof import("../src/services/identity/rbac.service.js")["grantCapability"];
  evaluateMemberAccess: typeof import("../src/services/identity/access-policy.service.js")["evaluateMemberAccess"];
  evaluateCurrentWorkspace: typeof import("../src/middleware/authorize.js")["evaluateCurrentWorkspace"];
  suspendOrganizationWorkspace: typeof import("../src/services/workspace/workspace-lifecycle.service.js")["suspendOrganizationWorkspace"];
  resumeOrganizationWorkspace: typeof import("../src/services/workspace/workspace-lifecycle.service.js")["resumeOrganizationWorkspace"];
  readRecordedEmailFile: typeof import("@proovra/shared-runtime")["readRecordedEmailFile"];
};

describe("§1 — NEW-005: permission-guard admission requires a LIVE membership", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let mods: Modules;
  let routes: ReadonlyArray<PermissionGuardRoute>;
  /** The union of permissions the surface names — what the operator is granted. */
  let permissions: ReadonlyArray<Permission>;

  let operatorUserId: string;
  let operatorToken: string;
  let ownerUserId: string;
  let workspaceA: string;
  let workspaceB: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    // Loaded once, after the harness has pointed the process at its disposable
    // database — never inside a case (in-test dynamic imports time out under
    // load).
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    const [rbac, policy, authorize, lifecycle, runtime] = await Promise.all([
      import("../src/services/identity/rbac.service.js"),
      import("../src/services/identity/access-policy.service.js"),
      import("../src/middleware/authorize.js"),
      import("../src/services/workspace/workspace-lifecycle.service.js"),
      import("@proovra/shared-runtime"),
    ]);
    mods = {
      grantCapability: rbac.grantCapability,
      evaluateMemberAccess: policy.evaluateMemberAccess,
      evaluateCurrentWorkspace: authorize.evaluateCurrentWorkspace,
      suspendOrganizationWorkspace: lifecycle.suspendOrganizationWorkspace,
      resumeOrganizationWorkspace: lifecycle.resumeOrganizationWorkspace,
      readRecordedEmailFile: runtime.readRecordedEmailFile,
    };

    routes = loadPermissionGuardRoutes();
    // Fails the suite rather than shrinking its claim.
    assertInventoryComplete(routes);
    permissions = surfacePermissions(routes) as ReadonlyArray<Permission>;

    // Every admission in case 1 must be attributable to a capability grant.
    const roleHeld = permissions.filter((p) => roleHasPermission("VIEWER", p));
    expect(
      roleHeld,
      "the operator's bare role must hold none of the surface's permissions",
    ).toEqual([]);

    workspaceA = h.fixtures.teamA.teamId;
    workspaceB = h.fixtures.teamB.teamId;
    operatorUserId = h.fixtures.teamA.viewerUserId;
    operatorToken = h.fixtures.teamA.viewerToken;
    ownerUserId = h.fixtures.teamA.ownerUserId;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const call = async (route: PermissionGuardRoute) =>
    h.app.inject({
      method: route.method,
      url: concretePath(route.path, randomUUID()),
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      payload: route.method === "GET" ? undefined : {},
    });

  /** Body parsed defensively — a route may answer with a non-JSON body. */
  const denialOf = (body: string): string | null => {
    try {
      const parsed = JSON.parse(body) as { denial?: unknown };
      return typeof parsed.denial === "string" ? parsed.denial : null;
    } catch {
      return null;
    }
  };

  const isGuardRefusal = (res: { statusCode: number; body: string }): boolean =>
    res.statusCode === 403 && denialOf(res.body) === GUARD_DENIAL;

  /**
   * Drive the WHOLE surface and require the guard to refuse every one of them.
   * Reports the offenders by name — a bare count would not say which route
   * admitted a caller it should not have.
   */
  const expectWholeSurfaceRefused = async (label: string): Promise<void> => {
    const admitted: string[] = [];
    for (const route of routes) {
      const res = await call(route);
      if (!isGuardRefusal(res)) {
        admitted.push(
          `${route.method} ${route.path} → ${res.statusCode} ${res.body.slice(0, 160)}`,
        );
      }
    }
    expect(
      admitted,
      `${label}: every permission-guarded route must refuse. Admitted:\n${admitted.join("\n")}`,
    ).toEqual([]);
  };

  const operatorMemberId = async (teamId: string): Promise<string> =>
    (
      await prisma.teamMember.findFirstOrThrow({
        where: { teamId, userId: operatorUserId },
        select: { id: true },
      })
    ).id;

  /**
   * Restore the operator to the live, fully-granted baseline: an ACTIVE VIEWER
   * of A holding a live capability grant — issued through the production rbac
   * service, by the owner — for every permission the surface names.
   *
   * The membership row is recreated rather than patched, so capability grants
   * (which cascade with it) are re-issued fresh each time.
   */
  const restoreBaseline = async (): Promise<void> => {
    await prisma.teamMember.deleteMany({
      where: { teamId: workspaceA, userId: operatorUserId },
    });
    const member = await prisma.teamMember.create({
      data: {
        teamId: workspaceA,
        userId: operatorUserId,
        role: "VIEWER",
        status: "ACTIVE",
        accessExpiresAtUtc: null,
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceA },
    });
    // ARCH-002 — the fixture workspace is an ORGANIZATION workspace, and the
    // kind is no longer nullable.
    await prisma.team.update({
      where: { id: workspaceA },
      data: { workspaceKind: "ORGANIZATION" },
    });
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: workspaceA },
      select: { organizationId: true },
    });
    await prisma.organization.update({
      where: { id: team.organizationId },
      data: { status: "ACTIVE" },
    });
    for (const permission of permissions) {
      await mods.grantCapability(
        {
          teamId: workspaceA,
          teamMemberId: member.id,
          permission,
          actorUserId: ownerUserId,
          reason: "NEW-005 probe baseline",
        },
        prisma,
      );
    }
  };

  /** Mutate exactly the operator's capability grants in A. */
  const updateOperatorGrants = async (
    data: { expiresAtUtc?: Date; revokedAtUtc?: Date },
    where: { permissionNot?: Permission } = {},
  ): Promise<number> => {
    const teamMemberId = await operatorMemberId(workspaceA);
    const res = await prisma.memberCapabilityGrant.updateMany({
      where: {
        teamMemberId,
        ...(where.permissionNot ? { permission: { not: where.permissionNot } } : {}),
      },
      data,
    });
    return res.count;
  };

  /**
   * Row counts for every table in the public schema, minus the audit set.
   *
   * Derived from `information_schema` rather than a hand-picked list: a
   * hand-picked list can only detect writes to tables someone thought of, and
   * the interesting failure is a write nobody expected.
   */
  const censusTenantRows = async (): Promise<RowCensus> => {
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const out = new Map<string, number>();
    for (const { table_name: name } of tables) {
      if (AUDIT_TABLES.has(name)) continue;
      if (name.startsWith("_prisma")) continue;
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "${name}"`,
      );
      out.set(name, Number(rows[0]?.n ?? 0n));
    }
    return out;
  };

  const censusDiff = (before: RowCensus, after: RowCensus): string[] => {
    const changed: string[] = [];
    for (const [table, n] of after) {
      const was = before.get(table) ?? 0;
      if (was !== n) changed.push(`${table}: ${was} → ${n}`);
    }
    return changed;
  };

  /**
   * Records in the outbound ledger that represent an ACTUAL reach for the
   * network — the thing a refused request must never do. The ledger is shared
   * by every integration suite and every suite's disposable PostgreSQL/Redis
   * connections are written to it as `loopback-*`; filtering those out makes
   * the count attributable rather than merely smaller.
   */
  const outboundLedgerLines = (): number => {
    const file = process.env.P7_NETWORK_LEDGER;
    if (!file || !existsSync(file)) return 0;
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => {
        try {
          const rec = JSON.parse(l) as { category?: string };
          return !String(rec.category ?? "").startsWith("loopback");
        } catch {
          return false;
        }
      }).length;
  };

  const suspendOperator = async (): Promise<void> => {
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date() },
    });
  };

  // ---------------------------------------------------------------------------
  // The cases
  // ---------------------------------------------------------------------------

  it("0 — the inventory covers every guard call site in every listed module", () => {
    expect(routes.length).toBeGreaterThan(0);
    // Recomputed here so the assertion is visible in the report, not only in
    // a `beforeAll` that would fail with a setup error.
    expect(() => assertInventoryComplete(routes)).not.toThrow();
    // The retired tier endpoints are not on the guarded surface: they answer
    // 410 to everyone (pinned in case 17).
    expect(routes.map((r) => r.path)).not.toContain("/v1/governance/delegated-admin");
  });

  it("1 — ACTIVE membership + live capability grants is admitted on the whole surface", async () => {
    await restoreBaseline();
    const refused: string[] = [];
    for (const route of routes) {
      const res = await call(route);
      // The assertion is about ADMISSION, not about what the handler then did
      // with an unresolvable id: a 404/400/409 from the handler means the
      // guard passed the caller through, which is exactly what must happen.
      if (isGuardRefusal(res)) refused.push(`${route.method} ${route.path} → ${res.body}`);
    }
    expect(
      refused,
      `a live member holding every surface permission must not be refused by the guard:\n${refused.join("\n")}`,
    ).toEqual([]);
  }, 120_000);

  it("2 — SUSPENDED membership + live grants is refused everywhere", async () => {
    await restoreBaseline();
    await suspendOperator();
    await expectWholeSurfaceRefused("SUSPENDED membership");
  }, 120_000);

  it("3 — REVOKED membership + live grants is refused everywhere", async () => {
    await restoreBaseline();
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { status: "REVOKED", revokedAtUtc: new Date() },
    });
    await expectWholeSurfaceRefused("REVOKED membership");
  }, 120_000);

  it("4 — a DELETED membership row is refused everywhere", async () => {
    await restoreBaseline();
    await prisma.teamMember.deleteMany({
      where: { teamId: workspaceA, userId: operatorUserId },
    });
    await expectWholeSurfaceRefused("deleted membership");
  }, 120_000);

  it("5 — EXPIRED membership access + live grants is refused everywhere", async () => {
    await restoreBaseline();
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
    });
    await expectWholeSurfaceRefused("expired membership access");
  }, 120_000);

  it("6 — EXPIRED capability grants are refused everywhere (membership live)", async () => {
    await restoreBaseline();
    const n = await updateOperatorGrants({ expiresAtUtc: new Date(Date.now() - 60_000) });
    expect(n).toBe(permissions.length);
    await expectWholeSurfaceRefused("expired capability grants");
  }, 120_000);

  it("7 — REVOKED capability grants are refused everywhere (membership live)", async () => {
    await restoreBaseline();
    const n = await updateOperatorGrants({ revokedAtUtc: new Date() });
    expect(n).toBe(permissions.length);
    await expectWholeSurfaceRefused("revoked capability grants");
  }, 120_000);

  it("8 — a CLOSED/suspended workspace refuses, through the real lifecycle path", async () => {
    await restoreBaseline();
    // Driven through the production service, not by hand-editing rows: the
    // question is whether the SHIPPED closure path removes admission.
    await mods.suspendOrganizationWorkspace({
      teamId: workspaceA,
      actorUserId: ownerUserId,
    });
    // The lifecycle path also clears the pointer, so re-point it: the case
    // must prove the MEMBERSHIP is what refuses, not merely that the pointer
    // was cleared.
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceA },
    });
    try {
      await expectWholeSurfaceRefused("workspace suspended via lifecycle service");
    } finally {
      // The suspension mass-suspends EVERY active membership, the owner's
      // included; resume through the shipped path so later cases start from
      // a workspace whose owner can issue the baseline grants again.
      await mods.resumeOrganizationWorkspace({ teamId: workspaceA, actorUserId: ownerUserId });
    }
  }, 180_000);

  it("9 — a SUSPENDED parent Organization refuses everywhere", async () => {
    await restoreBaseline();
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: workspaceA },
      select: { organizationId: true, workspaceKind: true },
    });
    // Organization lifecycle applies to ORGANIZATION-kind workspaces; the
    // baseline sets it explicitly so this case tests the lifecycle, not the
    // classifier.
    expect(team.workspaceKind).toBe("ORGANIZATION");
    await prisma.organization.update({
      where: { id: team.organizationId },
      data: { status: "SUSPENDED" },
    });
    await expectWholeSurfaceRefused("suspended parent Organization");
  }, 120_000);

  it("10 — capability grants in workspace A cannot authorize workspace B", async () => {
    await restoreBaseline();
    // A live ACTIVE member of B holding NO grant in B, but every grant in A.
    // Pointing at B must yield nothing from A's grants.
    await prisma.teamMember.deleteMany({
      where: { teamId: workspaceB, userId: operatorUserId },
    });
    await prisma.teamMember.create({
      data: {
        teamId: workspaceB,
        userId: operatorUserId,
        role: "VIEWER",
        status: "ACTIVE",
      },
    });
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceB },
    });
    try {
      await expectWholeSurfaceRefused("grants scoped to A, pointer at B");
    } finally {
      await prisma.teamMember.deleteMany({
        where: { teamId: workspaceB, userId: operatorUserId },
      });
    }
  }, 120_000);

  it("11 — a permission the caller does not hold is refused on exactly the routes that require it", async () => {
    await restoreBaseline();
    // Hold ONLY identity.org_policy.manage. It is named alone on some routes
    // and as one member of an any-of on another (destruction approve), so it
    // exercises both shapes: every registration that names it must admit,
    // every one that does not must refuse.
    const kept: Permission = "identity.org_policy.manage";
    expect(permissions).toContain(kept);
    const n = await updateOperatorGrants({ revokedAtUtc: new Date() }, { permissionNot: kept });
    expect(n).toBe(permissions.length - 1);
    expect(
      routes.some((r) => r.permissions.length > 1 && r.permissions.includes(kept)),
      "the surface must still carry an any-of registration naming the kept permission",
    ).toBe(true);

    const wrong: string[] = [];
    for (const route of routes) {
      const res = await call(route);
      const refused = isGuardRefusal(res);
      const shouldPass = route.permissions.includes(kept);
      if (shouldPass === refused) {
        wrong.push(
          `${route.method} ${route.path} permissions=${route.permissions.join("|")} → ` +
            `${res.statusCode} (refused=${refused}, expectedRefused=${!shouldPass})`,
        );
      }
      if (refused) {
        // The denial names what the route asked for — the first permission,
        // and the whole any-of set when there is more than one.
        const body = JSON.parse(res.body) as { permission?: string; anyOf?: string[] };
        expect(body.permission).toBe(route.permissions[0]);
        if (route.permissions.length > 1) expect(body.anyOf).toEqual(route.permissions);
        else expect(body.anyOf).toBeUndefined();
      }
    }
    expect(wrong, `permission matching must be exact:\n${wrong.join("\n")}`).toEqual([]);
  }, 180_000);

  it("12 — a stale currentWorkspaceId grants nothing", async () => {
    await restoreBaseline();
    // The pointer names a workspace the operator is not a member of. The
    // grant rows in A are untouched and still live.
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceB },
    });
    await expectWholeSurfaceRefused("stale pointer at a non-member workspace");
  }, 120_000);

  it("13 — a live capability grant is not, by itself, an admission: the canonical evaluator refuses a SUSPENDED holder", async () => {
    await restoreBaseline();
    // Under the retired model this case proved the tier service answered
    // "a grant exists" for a suspended member — i.e. that it was not an
    // authorization primitive. In the canonical model the grant row is still
    // live and still says the same thing; the evaluator that reads it is what
    // must refuse.
    const teamMemberId = await operatorMemberId(workspaceA);
    const live = await prisma.memberCapabilityGrant.count({
      where: { teamMemberId, revokedAtUtc: null, expiresAtUtc: null },
    });
    expect(live, "every capability grant stays live through the suspension").toBe(
      permissions.length,
    );
    for (const permission of permissions) {
      const before = await mods.evaluateMemberAccess(
        { teamId: workspaceA, userId: operatorUserId, permission },
        prisma,
      );
      expect(before.allowed, `${permission} is admitted for the live holder`).toBe(true);
    }

    await suspendOperator();
    expect(
      await prisma.memberCapabilityGrant.count({
        where: { teamMemberId, revokedAtUtc: null, expiresAtUtc: null },
      }),
    ).toBe(permissions.length);
    for (const permission of permissions) {
      const after = await mods.evaluateMemberAccess(
        { teamId: workspaceA, userId: operatorUserId, permission },
        prisma,
      );
      expect(after.allowed, `${permission} must be refused for a suspended holder`).toBe(false);
      if (!after.allowed) expect(after.reason).toBe("member_not_active");
    }

    // …and the composed current-workspace chain the guard rides on refuses too.
    const fakeReq = {
      headers: { authorization: `Bearer ${operatorToken}` },
    } as unknown as Parameters<Modules["evaluateCurrentWorkspace"]>[0];
    const outcome = await mods.evaluateCurrentWorkspace(fakeReq, {
      permission: permissions[0]!,
    });
    expect(
      outcome.allowed,
      "the canonical chain must refuse a suspended member's pointer",
    ).toBe(false);
  }, 120_000);

  it("14 — a refused sweep of the whole surface mutates no tenant table", async () => {
    await restoreBaseline();
    await suspendOperator();
    const before = await censusTenantRows();
    await expectWholeSurfaceRefused("census sweep");
    const after = await censusTenantRows();
    const changed = censusDiff(before, after);
    expect(
      changed,
      `a refused request must not write tenant state. Changed:\n${changed.join("\n")}`,
    ).toEqual([]);
  }, 300_000);

  it("15 — a refused sweep produces no external side effect", async () => {
    await restoreBaseline();
    await suspendOperator();
    const mailBefore = mods.readRecordedEmailFile(process.env.EMAIL_RECORDER_FILE).length;
    const netBefore = outboundLedgerLines();

    await expectWholeSurfaceRefused("external-effect sweep");

    expect(
      mods.readRecordedEmailFile(process.env.EMAIL_RECORDER_FILE).length,
      "a refused request must not acknowledge a message to anybody",
    ).toBe(mailBefore);
    expect(
      outboundLedgerLines(),
      "a refused request must not reach for the network",
    ).toBe(netBefore);
  }, 300_000);

  it("16 — foreign and non-existent identifiers are concealed identically", async () => {
    await restoreBaseline();
    const sample = routes.slice(0, 12);

    const shapesFor = async (pointer: string | null): Promise<string[]> => {
      await prisma.user.update({
        where: { id: operatorUserId },
        data: { currentWorkspaceId: pointer },
      });
      const out: string[] = [];
      for (const route of sample) {
        const res = await call(route);
        out.push(`${route.method} ${route.path} → ${res.statusCode} ${res.body}`);
      }
      return out;
    };

    // A workspace that exists but is not theirs.
    const foreign = await shapesFor(workspaceB);
    // A workspace id that exists nowhere.
    const absent = await shapesFor(randomUUID());
    // No pointer at all.
    const none = await shapesFor(null);

    expect(
      foreign,
      "a foreign workspace must be indistinguishable from an absent one",
    ).toEqual(absent);
    expect(
      absent,
      "an absent workspace must be indistinguishable from no pointer at all",
    ).toEqual(none);
  }, 180_000);

  it("17 — the retired tier endpoints admit nobody and change nothing, even for the live, fully-granted operator and the owner", async () => {
    await restoreBaseline();
    const retired: Array<{ method: "GET" | "POST"; url: string }> = [
      { method: "GET", url: "/v1/governance/delegated-admin" },
      { method: "POST", url: "/v1/governance/delegated-admin" },
      { method: "POST", url: `/v1/governance/delegated-admin/${randomUUID()}/revoke` },
    ];
    const before = await censusTenantRows();
    for (const token of [operatorToken, h.fixtures.teamA.ownerToken]) {
      for (const r of retired) {
        const res = await h.app.inject({
          method: r.method,
          url: r.url,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          payload: r.method === "GET" ? undefined : {},
        });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(410);
        const body = JSON.parse(res.body) as { code?: string; nextAction?: string };
        expect(body.code).toBe("DELEGATED_ADMIN_TIERS_RETIRED");
        expect(body.nextAction).toBe("OPEN_SECURITY_CENTER");
      }
    }
    expect(censusDiff(before, await censusTenantRows())).toEqual([]);
  }, 180_000);
});
