/**
 * PHASE 12 CORRECTIVE PASS §1 — NEW-005, DIRECT RUNTIME PROOF.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * `requireDelegatedTier` resolved the workspace from `User.currentWorkspaceId`
 * and then asked `hasDelegatedTier` whether the caller held the tier. That
 * question is answered from `DelegatedAdminGrant` rows and the implicit-owner
 * ladder; it says nothing about whether the caller is still a LIVE member. So
 * a SUSPENDED, REVOKED, removed or time-expired operator kept passing every
 * delegated-tier route for as long as their grant row stayed ACTIVE.
 *
 * The source fix landed in the previous pass. The ledger kept NEW-005 open
 * because a source fix is not a runtime fact: nothing had driven a suspended
 * member holding a live grant at an actual route. This file is that drive.
 *
 * What "the surface" means here, and why it is not three routes
 * ---------------------------------------------------------------------------
 * The defect is in a GUARD, so its blast radius is every registration that
 * uses the guard. The route list is therefore DERIVED from the sources by
 * `delegated-tier-route-inventory.ts` and cross-checked against an independent
 * count of guard call sites; if the parser under-matches, `beforeAll` throws
 * rather than letting this suite claim a coverage it does not have. All 48
 * registrations are driven in every refusal case.
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

import {
  assertInventoryComplete,
  concretePath,
  loadDelegatedTierRoutes,
  type DelegatedTierRoute,
} from "./delegated-tier-route-inventory.js";
import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

/** The guard's denial envelope — the one thing every case asserts about. */
const DELEGATED_DENIAL = "DELEGATED_ADMIN_REQUIRED";

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
  // The authorization-denial telemetry pair. Named explicitly because the
  // first run of this case DID observe them grow — by exactly 48, one per
  // refused request — and that is the denial being recorded, not the tenant
  // being changed: `operational_incident_events` rows carry an `increment`
  // event with a sanitised WARNING message and no tenant-owned field. They
  // are excluded for the same reason `security_events` is, not because they
  // were inconvenient.
  "operational_incidents",
  "operational_incident_events",
  "api_request_logs",
  "queue_telemetry_snapshots",
  "metric_samples",
]);

type RowCensus = ReadonlyMap<string, number>;

describe("§1 — NEW-005: delegated-tier admission requires a LIVE membership", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let routes: ReadonlyArray<DelegatedTierRoute>;

  /**
   * The operator under test: a NON-OWNER member of workspace A holding an
   * explicit ACTIVE grant for every tier the surface names.
   *
   * Non-owner deliberately. `hasDelegatedTier` honours an implicit
   * workspace-owner ladder, so an owner would pass ORG_ADMIN routes with no
   * grant row at all and every "the grant is gone" case would prove nothing.
   */
  let operatorUserId: string;
  let operatorToken: string;
  let workspaceA: string;
  let workspaceB: string;

  /** Grant ids, so a case can expire or revoke exactly one thing. */
  const grantIds: string[] = [];

  const TIERS = [
    "GLOBAL_ADMIN",
    "ORG_ADMIN",
    "DEPARTMENT_ADMIN",
    "WORKSPACE_ADMIN",
    "REVIEWER_LEAD",
    "SECURITY_OFFICER",
    "COMPLIANCE_OFFICER",
  ] as const;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;

    routes = loadDelegatedTierRoutes();
    // Fails the suite rather than shrinking its claim.
    assertInventoryComplete(routes);

    workspaceA = h.fixtures.teamA.teamId;
    workspaceB = h.fixtures.teamB.teamId;
    operatorUserId = h.fixtures.teamA.memberUserId;
    operatorToken = h.fixtures.teamA.memberToken;

    // The pointer the guard reads as a CANDIDATE.
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceA },
    });

    const team = await prisma.team.findUniqueOrThrow({
      where: { id: workspaceA },
      select: { organizationId: true },
    });

    const { grantDelegatedAdmin } = await import(
      "../src/services/governance/delegated-admin.service.js"
    );
    // A department and a nested workspace scope are required for the two
    // scoped tiers; the ids only have to exist as scope discriminators.
    const departmentId = randomUUID();
    for (const tier of TIERS) {
      const res = await grantDelegatedAdmin({
        teamId: workspaceA,
        organizationId: team.organizationId,
        departmentId: tier === "DEPARTMENT_ADMIN" ? departmentId : null,
        workspaceId: tier === "WORKSPACE_ADMIN" ? workspaceA : null,
        granteeUserId: operatorUserId,
        tier,
        grantedByUserId: h.fixtures.teamA.ownerUserId,
      });
      expect(res.ok, `granting ${tier} must succeed`).toBe(true);
      if (res.ok) grantIds.push(res.grantId);
    }
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const call = async (route: DelegatedTierRoute) =>
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

  /**
   * Drive the WHOLE surface and require the guard to refuse every one of them.
   * Reports the offenders by name — a bare count would not say which route
   * admitted a caller it should not have.
   */
  const expectWholeSurfaceRefused = async (label: string): Promise<void> => {
    const admitted: string[] = [];
    for (const route of routes) {
      const res = await call(route);
      if (res.statusCode !== 403 || denialOf(res.body) !== DELEGATED_DENIAL) {
        admitted.push(
          `${route.method} ${route.path} → ${res.statusCode} ${res.body.slice(0, 160)}`,
        );
      }
    }
    expect(
      admitted,
      `${label}: every delegated-tier route must refuse. Admitted:\n${admitted.join("\n")}`,
    ).toEqual([]);
  };

  /** Restore the operator to the live, fully-granted baseline. */
  const restoreBaseline = async (): Promise<void> => {
    await prisma.teamMember.deleteMany({
      where: { teamId: workspaceA, userId: operatorUserId },
    });
    await prisma.teamMember.create({
      data: {
        teamId: workspaceA,
        userId: operatorUserId,
        role: "MEMBER",
        status: "ACTIVE",
        accessExpiresAtUtc: null,
      },
    });
    await prisma.delegatedAdminGrant.updateMany({
      where: { id: { in: grantIds } },
      data: { state: "ACTIVE", revokedAtUtc: null, expiresAtUtc: null },
    });
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceA },
    });
    // ARCH-002 — the fixture workspace is an ORGANIZATION workspace, and the
    // kind is no longer nullable. Restoring it to NULL is not expressible any
    // more, and was never right: it only worked because the removed
    // plan-derived fallback then classified it OWNED.
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
   * network — the thing a refused request must never do.
   *
   * The ledger file is SHARED by every integration suite in the run, and every
   * suite's own disposable PostgreSQL and Redis connections are written to it
   * with `category: "loopback-disposable"`. Counting raw lines therefore
   * counted other suites' database pool connections as this request's external
   * side effect: the assertion failed on `8276 vs 8275`, and the extra line was
   * `BoundPool.newClient` connecting to a container this test never touched.
   *
   * Filtering to non-loopback categories makes the count ATTRIBUTABLE rather
   * than merely smaller — a genuine outbound call still fails this, and a
   * neighbouring suite's loopback no longer can.
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
          // An unparseable line is not evidence of anything; counting it would
          // make the assertion depend on the writer's formatting.
          return false;
        }
      }).length;
  };

  // ---------------------------------------------------------------------------
  // The sixteen cases
  // ---------------------------------------------------------------------------

  it("0 — the inventory covers every guard call site in every listed module", () => {
    expect(routes.length).toBeGreaterThan(0);
    // Recomputed here so the assertion is visible in the report, not only in
    // a `beforeAll` that would fail with a setup error.
    expect(() => assertInventoryComplete(routes)).not.toThrow();
  });

  it("1 — ACTIVE membership + valid grant is admitted on the whole surface", async () => {
    await restoreBaseline();
    const refused: string[] = [];
    for (const route of routes) {
      const res = await call(route);
      // The assertion is about ADMISSION, not about what the handler then did
      // with an unresolvable id: a 404/400/409 from the handler means the
      // guard passed the caller through, which is exactly what must happen.
      if (res.statusCode === 403 && denialOf(res.body) === DELEGATED_DENIAL) {
        refused.push(`${route.method} ${route.path}`);
      }
    }
    expect(
      refused,
      `a live member holding every tier must not be refused by the tier guard:\n${refused.join("\n")}`,
    ).toEqual([]);
  }, 120_000);

  it("2 — SUSPENDED membership + valid grant is refused everywhere", async () => {
    await restoreBaseline();
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date() },
    });
    await expectWholeSurfaceRefused("SUSPENDED membership");
  }, 120_000);

  it("3 — REVOKED membership + valid grant is refused everywhere", async () => {
    await restoreBaseline();
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { status: "REVOKED", revokedAtUtc: new Date() },
    });
    await expectWholeSurfaceRefused("REVOKED membership");
  }, 120_000);

  it("4 — a DELETED membership row + valid grant is refused everywhere", async () => {
    await restoreBaseline();
    await prisma.teamMember.deleteMany({
      where: { teamId: workspaceA, userId: operatorUserId },
    });
    await expectWholeSurfaceRefused("deleted membership");
  }, 120_000);

  it("5 — EXPIRED membership access + valid grant is refused everywhere", async () => {
    await restoreBaseline();
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
    });
    await expectWholeSurfaceRefused("expired membership access");
  }, 120_000);

  it("6 — an EXPIRED delegated grant is refused everywhere (membership live)", async () => {
    await restoreBaseline();
    await prisma.delegatedAdminGrant.updateMany({
      where: { id: { in: grantIds } },
      data: { expiresAtUtc: new Date(Date.now() - 60_000) },
    });
    await expectWholeSurfaceRefused("expired delegated grant");
  }, 120_000);

  it("7 — a REVOKED delegated grant is refused everywhere (membership live)", async () => {
    await restoreBaseline();
    await prisma.delegatedAdminGrant.updateMany({
      where: { id: { in: grantIds } },
      data: { state: "REVOKED", revokedAtUtc: new Date() },
    });
    await expectWholeSurfaceRefused("revoked delegated grant");
  }, 120_000);

  it("8 — a CLOSED/suspended workspace refuses, through the real lifecycle path", async () => {
    await restoreBaseline();
    // Driven through the production service, not by hand-editing rows: the
    // question is whether the SHIPPED closure path removes admission.
    await prisma.team.update({
      where: { id: workspaceA },
      data: { workspaceKind: "ORGANIZATION" },
    });
    const { suspendOrganizationWorkspace } = await import(
      "../src/services/workspace/workspace-lifecycle.service.js"
    );
    await suspendOrganizationWorkspace({
      teamId: workspaceA,
      actorUserId: h.fixtures.teamA.ownerUserId,
    });
    // The lifecycle path also clears the pointer, so re-point it: the case
    // must prove the MEMBERSHIP is what refuses, not merely that the pointer
    // was cleared. A cleared pointer alone would be a weaker guarantee.
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceA },
    });
    await expectWholeSurfaceRefused("workspace suspended via lifecycle service");
  }, 180_000);

  it("9 — a SUSPENDED parent Organization refuses everywhere", async () => {
    await restoreBaseline();
    // Organization lifecycle applies to ORGANIZATION-kind workspaces. The
    // kind is set EXPLICITLY here rather than left to the plan-derived
    // fallback — that fallback is ARCH-002 and is removed in §5; this case
    // must test Organization lifecycle, not the classifier.
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
      data: { status: "SUSPENDED" },
    });
    await expectWholeSurfaceRefused("suspended parent Organization");
  }, 120_000);

  it("10 — a grant in workspace A cannot authorize workspace B", async () => {
    await restoreBaseline();
    // A live ACTIVE member of B, holding NO grant in B, but holding every
    // grant in A. Pointing at B must yield nothing from A's grants.
    await prisma.teamMember.deleteMany({
      where: { teamId: workspaceB, userId: operatorUserId },
    });
    await prisma.teamMember.create({
      data: {
        teamId: workspaceB,
        userId: operatorUserId,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceB },
    });
    try {
      await expectWholeSurfaceRefused("grant scoped to A, pointer at B");
    } finally {
      await prisma.teamMember.deleteMany({
        where: { teamId: workspaceB, userId: operatorUserId },
      });
    }
  }, 120_000);

  it("11 — a tier the caller does not hold is refused on the routes that require it", async () => {
    await restoreBaseline();
    // Hold ONLY SECURITY_OFFICER. Cross-cutting tiers do not satisfy each
    // other and do not satisfy the org ladder, so every registration that
    // does not name SECURITY_OFFICER must refuse — and every one that does
    // name it must not.
    await prisma.delegatedAdminGrant.updateMany({
      where: { id: { in: grantIds } },
      data: { state: "REVOKED", revokedAtUtc: new Date() },
    });
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: workspaceA },
      select: { organizationId: true },
    });
    const { grantDelegatedAdmin } = await import(
      "../src/services/governance/delegated-admin.service.js"
    );
    const only = await grantDelegatedAdmin({
      teamId: workspaceA,
      organizationId: team.organizationId,
      granteeUserId: operatorUserId,
      tier: "SECURITY_OFFICER",
      grantedByUserId: h.fixtures.teamA.ownerUserId,
    });
    expect(only.ok).toBe(true);

    const wrong: string[] = [];
    for (const route of routes) {
      const res = await call(route);
      const refused =
        res.statusCode === 403 && denialOf(res.body) === DELEGATED_DENIAL;
      const shouldPass = route.tiers.includes("SECURITY_OFFICER");
      if (shouldPass === refused) {
        wrong.push(
          `${route.method} ${route.path} tiers=${route.tiers.join("|")} → ` +
            `${res.statusCode} (refused=${refused}, expectedRefused=${!shouldPass})`,
        );
      }
    }
    expect(
      wrong,
      `tier matching must be exact:\n${wrong.join("\n")}`,
    ).toEqual([]);

    if (only.ok) {
      await prisma.delegatedAdminGrant.delete({ where: { id: only.grantId } });
    }
  }, 180_000);

  it("12 — a stale currentWorkspaceId grants nothing", async () => {
    await restoreBaseline();
    // The pointer names a workspace the operator has never been a member of.
    // The grant rows in A are untouched and still ACTIVE.
    await prisma.user.update({
      where: { id: operatorUserId },
      data: { currentWorkspaceId: workspaceB },
    });
    await expectWholeSurfaceRefused("stale pointer at a non-member workspace");
  }, 120_000);

  it("13 — the direct service check is not, by itself, an admission decision", async () => {
    await restoreBaseline();
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date() },
    });
    const { hasDelegatedTier } = await import(
      "../src/services/governance/delegated-admin.service.js"
    );
    // This is the POINT of NEW-005, stated as an executable fact: the tier
    // service answers "does a grant exist", and for a SUSPENDED member it
    // still answers yes. It is therefore NOT an authorization primitive, and
    // every call site must sit behind a membership-proving gate.
    const grantExists = await hasDelegatedTier({
      teamId: workspaceA,
      userId: operatorUserId,
      requiredTier: "ORG_ADMIN",
    });
    expect(
      grantExists,
      "hasDelegatedTier reports grant EXISTENCE; it is not membership-aware",
    ).toBe(true);

    // …and the composed guard refuses anyway.
    const { evaluateCurrentWorkspace } = await import(
      "../src/middleware/authorize.js"
    );
    const fakeReq = {
      headers: { authorization: `Bearer ${operatorToken}` },
    } as unknown as Parameters<typeof evaluateCurrentWorkspace>[0];
    const outcome = await evaluateCurrentWorkspace(fakeReq, {
      permission: "evidence.read",
    });
    expect(
      outcome.allowed,
      "the canonical chain must refuse a suspended member's pointer",
    ).toBe(false);
  }, 120_000);

  it("14 — a refused sweep of the whole surface mutates no tenant table", async () => {
    await restoreBaseline();
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date() },
    });
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
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: operatorUserId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date() },
    });
    const recorder = await import("@proovra/shared-runtime");
    const mailBefore = recorder.readRecordedEmailFile(
      process.env.EMAIL_RECORDER_FILE,
    ).length;
    const netBefore = outboundLedgerLines();

    await expectWholeSurfaceRefused("external-effect sweep");

    const mailAfter = recorder.readRecordedEmailFile(
      process.env.EMAIL_RECORDER_FILE,
    ).length;
    expect(
      mailAfter,
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
});
