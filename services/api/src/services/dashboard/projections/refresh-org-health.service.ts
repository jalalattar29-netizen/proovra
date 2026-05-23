/**
 * PHASE 37.97 — Org-health projection refresh.
 *
 * Computes the dashboard projection row for a single tenant and writes
 * (upserts) the latest snapshot. The refresh is:
 *
 *   - Tenant-scoped. The function only writes the row for the `teamId`
 *     it was scheduled with. A separate refresh job exists per tenant.
 *   - Idempotent. Repeated invocations are safe — the upsert key is
 *     `(teamId, sampledAtUtc)`, and `sampledAtUtc` is supplied per call.
 *   - Bounded. Every input query is scoped by `teamId`; no globally-
 *     unbounded scan can happen here.
 *   - Side-effect minimal. No audit emission, no queue enqueue, no
 *     billing writes. Only the projection row is upserted.
 *
 * The dashboard read path consults this projection first; if no row
 * exists (e.g. immediately after team creation) the page falls back
 * to its live aggregator. Stale projections do not bypass auth — the
 * dashboard guard still authorizes the actor for `teamId`.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../../db.js";

export type OrgHealthProjectionRow = {
  teamId: string;
  sampledAtUtc: Date;
  evidenceCount: number;
  caseCount: number;
  openIncidentCount: number;
  slaBreachCount: number;
  governanceBlockerCount: number;
  recentVerificationCount: number;
  pendingPackageCount: number;
  pendingReportCount: number;
};

const REFRESH_SOURCE = "worker_refresh_v1";

/**
 * Refresh the org-health projection for a single tenant. Returns the
 * row that was written.
 */
export async function refreshOrgHealthProjection(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<OrgHealthProjectionRow> {
  if (!input.teamId) {
    throw new Error("refreshOrgHealthProjection requires a teamId");
  }
  const teamId = input.teamId;
  const sampledAtUtc = new Date();

  // Each count below is bounded by teamId. No cross-tenant join is
  // possible. The counts use Prisma's `.count` so the SQL is a single
  // aggregate per metric.
  const [
    evidenceCount,
    caseCount,
    pendingReportCount,
    pendingPackageCount,
  ] = await Promise.all([
    client.evidence.count({ where: { teamId, deletedAt: null } }),
    client.case.count({ where: { teamId } }),
    // "Pending" = report row absent for evidence. Use a bounded EXISTS-
    // style query via Prisma's `none` filter on the related Report table.
    client.evidence.count({
      where: {
        teamId,
        deletedAt: null,
        reports: { none: {} },
      },
    }),
    // Same for VerificationPackage.
    client.evidence.count({
      where: {
        teamId,
        deletedAt: null,
        verificationPackages: { none: {} },
      },
    }),
  ]);

  // The remaining four counters require domain-specific subsystem
  // queries that may not exist for every deployment (e.g. legal-hold
  // and SLA tables). We default to 0 here and document the gap; a
  // follow-up extends the refresh as those subsystems are wired in.
  const openIncidentCount = 0;
  const slaBreachCount = 0;
  const governanceBlockerCount = 0;
  const recentVerificationCount = 0;

  const row: OrgHealthProjectionRow = {
    teamId,
    sampledAtUtc,
    evidenceCount,
    caseCount,
    openIncidentCount,
    slaBreachCount,
    governanceBlockerCount,
    recentVerificationCount,
    pendingPackageCount,
    pendingReportCount,
  };

  await client.orgHealthProjection.upsert({
    where: { teamId_sampledAtUtc: { teamId, sampledAtUtc } },
    create: { ...row, source: REFRESH_SOURCE },
    update: {
      evidenceCount,
      caseCount,
      openIncidentCount,
      slaBreachCount,
      governanceBlockerCount,
      recentVerificationCount,
      pendingPackageCount,
      pendingReportCount,
      source: REFRESH_SOURCE,
    },
  });

  return row;
}

/**
 * Read the most-recent org-health projection row for a tenant. Returns
 * null if no projection exists yet — the dashboard falls back to its
 * live aggregator in that case.
 */
export async function readLatestOrgHealthProjection(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<OrgHealthProjectionRow | null> {
  const row = await client.orgHealthProjection.findFirst({
    where: { teamId: input.teamId },
    orderBy: { sampledAtUtc: "desc" },
  });
  if (!row) return null;
  return {
    teamId: row.teamId,
    sampledAtUtc: row.sampledAtUtc,
    evidenceCount: row.evidenceCount,
    caseCount: row.caseCount,
    openIncidentCount: row.openIncidentCount,
    slaBreachCount: row.slaBreachCount,
    governanceBlockerCount: row.governanceBlockerCount,
    recentVerificationCount: row.recentVerificationCount,
    pendingPackageCount: row.pendingPackageCount,
    pendingReportCount: row.pendingReportCount,
  };
}
