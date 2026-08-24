/**
 * OPERATIONS CONVERGENCE — the source→incident scope contract, live PG 16.
 *
 * ---------------------------------------------------------------------------
 * THE PRODUCTION FAILURE THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * In a Personal Pro workspace, Home reported "34 TSA timestamps failed" as
 * CRITICAL while Operations reported 0 and "Workspace operations are clear",
 * for the SAME workspace. Root cause: the incident reconciler discovered
 * failing evidence with a strict `teamId` equality, while a personal
 * workspace's records are the legacy `team_id = NULL` rows the capture path
 * wrote (owned by the personal user). The strict filter matched NONE of them,
 * so the reconciler materialised zero incidents and Operations rendered a
 * genuinely-empty-but-WRONG snapshot as truth.
 *
 * Home already read through the canonical `workspaceEvidenceWhere`, which is
 * why the two surfaces disagreed. The fix routes every evidence-derived scan
 * through that same authority.
 *
 * These cases drive the REAL reconciler and the REAL projection, and assert
 * the cross-surface conservation the two surfaces must obey: a workspace with
 * N failing records cannot be BOTH "N failed" on Home and "clear" on
 * Operations.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Operations convergence (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  let personal: { userId: string; teamId: string };
  let teamA: { teamId: string; ownerUserId: string; organizationId: string | null };
  let teamB: { teamId: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    personal = {
      userId: harness.fixtures.personal.userId,
      teamId: harness.fixtures.personal.teamId,
    };
    const teamARow = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    teamA = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      organizationId: teamARow.organizationId,
    };
    teamB = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
    };
  }, 240_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  const madeEvidence: string[] = [];
  const madeFingerprints: string[] = [];

  beforeEach(async () => {
    // Clean only what these tests created, across every scope touched.
    await prisma.operationalIncident.deleteMany({
      where: { fingerprint: { in: madeFingerprints } },
    });
    await prisma.evidence.deleteMany({ where: { id: { in: madeEvidence } } });
    madeEvidence.length = 0;
    madeFingerprints.length = 0;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** A failing record in the PERSONAL shape: team_id NULL, owned by the user. */
  async function personalFailing(
    which: "tsa" | "ots" = "tsa",
    ownerUserId = personal.userId,
  ): Promise<string> {
    const ev = await prisma.evidence.create({
      data: {
        title: `personal-${which}-fail-${randomUUID()}`,
        type: "PHOTO",
        status: "UPLOADED",
        teamId: null,
        organizationId: null,
        ownerUserId,
        ...(which === "tsa" ? { tsaStatus: "FAILED" } : { otsStatus: "FAILED" }),
      },
      select: { id: true },
    });
    madeEvidence.push(ev.id);
    madeFingerprints.push(`${which}_failure:${ev.id}`);
    return ev.id;
  }

  /** A failing record in a SHARED team: strict team_id. */
  async function teamFailing(): Promise<string> {
    const ev = await prisma.evidence.create({
      data: {
        title: `team-tsa-fail-${randomUUID()}`,
        type: "PHOTO",
        status: "UPLOADED",
        teamId: teamA.teamId,
        organizationId: teamA.organizationId,
        ownerUserId: teamA.ownerUserId,
        tsaStatus: "FAILED",
      },
      select: { id: true },
    });
    madeEvidence.push(ev.id);
    madeFingerprints.push(`tsa_failure:${ev.id}`);
    return ev.id;
  }

  async function sync(teamId: string) {
    const { syncEvidenceIntegrityConditions } = await import(
      "../src/services/operations/evidence-integrity-conditions.service.js"
    );
    return syncEvidenceIntegrityConditions({ teamId });
  }

  async function openIncidentCount(teamId: string) {
    return prisma.operationalIncident.count({
      where: {
        teamId,
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        category: "EVIDENCE_INTEGRITY",
      },
    });
  }

  /** What Home would count for this workspace, via the canonical authority. */
  async function homeFailingCount(teamId: string) {
    const { workspaceEvidenceWhere } = await import(
      "@proovra/shared-runtime"
    );
    const scope = await workspaceEvidenceWhere(teamId);
    return prisma.evidence.count({
      where: {
        AND: [scope, { OR: [{ tsaStatus: "FAILED" }, { otsStatus: "FAILED" }] }],
      },
    });
  }

  // =========================================================================
  // 1. THE FIX — personal-scope materialisation
  // =========================================================================

  it("1/2. a Personal Pro workspace's pre-existing TSA failures materialise as incidents", async () => {
    await personalFailing("tsa");
    await personalFailing("tsa");
    await personalFailing("ots");

    const result = await sync(personal.teamId);
    // Every failing record became a condition. Before the fix this was 0.
    expect(result.opened).toBe(3);
    expect(await openIncidentCount(personal.teamId)).toBe(3);
  });

  it("16. Home and Operations cannot disagree: canonical-scope count == materialised incidents", async () => {
    for (let i = 0; i < 4; i += 1) await personalFailing("tsa");
    await sync(personal.teamId);

    const home = await homeFailingCount(personal.teamId);
    const ops = await openIncidentCount(personal.teamId);
    // The cross-surface contract: N failing records -> N Operations conditions.
    // A workspace can never be "N failed" on Home and "clear" on Operations.
    expect(home).toBe(4);
    expect(ops).toBe(home);
  });

  it("5. repeated reconciliation is idempotent — no duplicate incidents", async () => {
    await personalFailing("tsa");
    await personalFailing("tsa");
    await sync(personal.teamId);
    const first = await openIncidentCount(personal.teamId);
    await sync(personal.teamId);
    await sync(personal.teamId);
    const third = await openIncidentCount(personal.teamId);
    expect(first).toBe(2);
    expect(third).toBe(2);
  });

  it("3. a SHARED team workspace still converges under the strict filter", async () => {
    await teamFailing();
    await teamFailing();
    const result = await sync(teamA.teamId);
    expect(result.opened).toBe(2);
    expect(await openIncidentCount(teamA.teamId)).toBe(2);
  });

  // =========================================================================
  // 2. RESOLVE / REOPEN — the resolver's scope must match discovery
  // =========================================================================

  it("6. a still-failing personal record's incident cannot resolve", async () => {
    const id = await personalFailing("tsa");
    await sync(personal.teamId);
    expect(await openIncidentCount(personal.teamId)).toBe(1);
    // The record is still FAILED. A second pass must not resolve it.
    await sync(personal.teamId);
    const inc = await prisma.operationalIncident.findFirstOrThrow({
      where: { fingerprint: `tsa_failure:${id}` },
    });
    expect(inc.status).toBe("OPEN");
  });

  it("7. a recovered personal record's incident resolves from domain truth", async () => {
    const id = await personalFailing("tsa");
    await sync(personal.teamId);
    // The record's own status leaves FAILED — the ONLY thing that resolves it.
    await prisma.evidence.update({
      where: { id },
      data: { tsaStatus: "ANCHORED" },
    });
    const result = await sync(personal.teamId);
    expect(result.resolved).toBe(1);
    const inc = await prisma.operationalIncident.findFirstOrThrow({
      where: { fingerprint: `tsa_failure:${id}` },
    });
    expect(inc.status).toBe("RESOLVED");
    // Domain-truth resolution fabricates no human resolver.
    expect(inc.resolvedByUserId).toBeNull();
  });

  it("8. a resolved personal record that fails again reopens", async () => {
    const id = await personalFailing("tsa");
    await sync(personal.teamId);
    await prisma.evidence.update({ where: { id }, data: { tsaStatus: "ANCHORED" } });
    await sync(personal.teamId);
    expect(
      (
        await prisma.operationalIncident.findFirstOrThrow({
          where: { fingerprint: `tsa_failure:${id}` },
        })
      ).status,
    ).toBe("RESOLVED");

    // The record fails again — a genuinely new occurrence.
    await prisma.evidence.update({ where: { id }, data: { tsaStatus: "FAILED" } });
    const result = await sync(personal.teamId);
    expect(result.reobserved).toBe(1);
    expect(
      (
        await prisma.operationalIncident.findFirstOrThrow({
          where: { fingerprint: `tsa_failure:${id}` },
        })
      ).status,
    ).toBe("OPEN");
  });

  // =========================================================================
  // 3. TENANT ISOLATION — the null-team fallback is owner-bound
  // =========================================================================

  it("10. one personal owner's NULL-team failures never leak into another workspace", async () => {
    // A failing NULL-team record owned by teamA's OWNER, not by the personal
    // user. The personal-scope fallback is bound to the personal owner's
    // userId, so this must NOT appear in the personal workspace's sweep.
    const foreignId = await personalFailing("tsa", teamA.ownerUserId);

    const result = await sync(personal.teamId);
    expect(result.opened).toBe(0);
    expect(await openIncidentCount(personal.teamId)).toBe(0);
    // The foreign record is untouched and did not become a personal incident.
    expect(
      await prisma.operationalIncident.count({
        where: { fingerprint: `tsa_failure:${foreignId}` },
      }),
    ).toBe(0);
  });

  it("a shared team's sweep does not pull in unrelated NULL-team rows", async () => {
    // A NULL-team failing record. A shared workspace keeps the STRICT filter,
    // so it must never see this.
    await personalFailing("tsa", personal.userId);
    const result = await sync(teamA.teamId);
    expect(result.opened).toBe(0);
  });

  it("workspace B cannot see workspace A's shared incidents", async () => {
    await teamFailing(); // created under teamA
    await sync(teamA.teamId);
    expect(await openIncidentCount(teamB.teamId)).toBe(0);
  });

  // =========================================================================
  // 4. THE OTHER EVIDENCE-DERIVED SCANS share the fix
  // =========================================================================

  it("4/12. the report-backlog scan also sees a personal workspace's records", async () => {
    // 20 SIGNED-without-report personal records (the HIGH threshold).
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const ev = await prisma.evidence.create({
        data: {
          title: `personal-signed-${randomUUID()}`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: null,
          organizationId: null,
          ownerUserId: personal.userId,
          latestReportVersion: null,
        },
        select: { id: true },
      });
      ids.push(ev.id);
      madeEvidence.push(ev.id);
    }
    madeFingerprints.push(`dashboard:pipeline:report_backlog:${personal.teamId}`);

    const { generateIncidentsForWorkspace } = await import(
      "../src/services/dashboard/incident-generator.service.js"
    );
    await generateIncidentsForWorkspace({ teamId: personal.teamId });

    const backlogIncident = await prisma.operationalIncident.findFirst({
      where: {
        teamId: personal.teamId,
        category: "REPORT",
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
      },
    });
    // Before the fix the strict scan counted 0 personal records and opened
    // nothing; now the backlog is seen and surfaced.
    expect(backlogIncident, "personal report backlog must surface").toBeTruthy();
    expect(ids.length).toBe(20);
  });

  // =========================================================================
  // 5. SOURCE INTEGRITY — no TSA provider contact
  // =========================================================================

  it("20. reconciliation contacts no TSA provider and mutates no token", async () => {
    const SRC = (
      await import("node:fs")
    ).readFileSync(
      (await import("node:url")).fileURLToPath(
        new URL(
          "../src/services/operations/evidence-integrity-conditions.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The reconciler READS integrity status and writes incidents. It must
    // never write an evidence integrity column or reach a timestamp provider.
    for (const forbidden of [
      "tsaStatus:",
      "otsStatus:",
      "tsaToken",
      "openssl",
      "ts -query",
      "TSA_URL",
    ]) {
      // Allow READS of the status (in `where`/`select`), forbid WRITES/contacts.
      const writes = new RegExp(
        `(update|create|upsert)[\\s\\S]{0,200}${forbidden.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`,
      );
      expect(
        writes.test(SRC),
        `reconciler must not write/contact ${forbidden}`,
      ).toBe(false);
    }
  });
});
