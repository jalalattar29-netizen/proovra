/**
 * ORG HEALTH — the ONE projection authority.
 *
 * WHY THIS MOVED HERE
 * -------------------
 * The arithmetic existed twice: `services/api/src/services/dashboard/
 * projections/refresh-org-health.service.ts` and the Worker's
 * `processOrgHealthRefreshJob`. Its own comment admitted the arrangement —
 * "when the API-side service grows new counters, mirror them here or extract
 * to a shared package" — and the mirroring did not happen. The two DISAGREED:
 *
 *     pendingReportCount   API: status IN (SIGNED, REPORTED) AND no report
 *                          Worker: no report            ← no status filter
 *     pendingPackageCount  API: status = REPORTED AND no package
 *                          Worker: no package           ← no status filter
 *
 * So the Worker counted a CREATED, UPLOADING, UPLOADED or
 * FAILED_HASH_MISMATCH record as "pending a report". Those records are not
 * pending a report; they are pending a PRIOR step, or they are terminally
 * failed. A workspace with ten stalled uploads and nothing else read as ten
 * reports outstanding — and which number Home showed depended on whether the
 * Worker's row or the API's live path had written last. Same workspace, same
 * instant, two answers, and the larger one was manufactured.
 *
 * The fix is not to synchronise the two. It is to have one.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a new source of truth. `OrgHealthProjection` remains the single
 * persisted row and this module is the only thing that computes it; the
 * counts are derived from Evidence and Case at read time, exactly as before.
 * Nothing here caches, and nothing here is authoritative over the domain
 * tables it counts.
 */

import type { PrismaClient } from "@prisma/client";

import { getRegisteredPrisma } from "./prisma-registry.js";
import {
  workspaceCaseWhere,
  workspaceEvidenceWhere,
} from "./workspace-scope.js";

/**
 * THE PIPELINE STAGES, named once.
 *
 * "Pending a report" is a statement about a record that has FINISHED the
 * upload-and-signature pipeline and has not yet produced its artifact. A
 * record that never got that far is not outstanding work of this kind, and
 * counting it as such is what made the two implementations disagree.
 */
export const REPORT_ELIGIBLE_STATUSES = ["SIGNED", "REPORTED"] as const;

/**
 * A verification package is only legitimately missing once the report exists,
 * i.e. the record reached REPORTED. A SIGNED record has not yet reached the
 * package stage and is not missing anything.
 */
export const PACKAGE_ELIGIBLE_STATUSES = ["REPORTED"] as const;

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

/** Just the four derived counters, without the projection row's identity. */
export type OrgHealthCounts = Pick<
  OrgHealthProjectionRow,
  "evidenceCount" | "caseCount" | "pendingReportCount" | "pendingPackageCount"
>;

/**
 * The sample bucket. Every refresh inside the same wall-clock minute writes the
 * SAME `sampledAtUtc`, which is the only thing that makes the upsert below an
 * upsert.
 *
 * PHASE 13 §4 — the unique key is `(teamId, sampledAtUtc)` and the timestamp
 * was `new Date()`, never equal twice, so the "upsert" could only ever take its
 * create branch. Every refresh appended a row and the table grew without bound
 * while the read path took the newest. A minute is the smallest bucket that
 * makes concurrent and immediately-retried ticks collapse while leaving a
 * genuine time series intact at any real cadence.
 */
export const ORG_HEALTH_SAMPLE_BUCKET_MS = 60_000;

export function orgHealthSampleBucket(now: Date = new Date()): Date {
  return new Date(
    Math.floor(now.getTime() / ORG_HEALTH_SAMPLE_BUCKET_MS) *
      ORG_HEALTH_SAMPLE_BUCKET_MS,
  );
}

/**
 * THE PREDICATES.
 *
 * Written INLINE in the one function that runs them, not returned from a
 * helper. There is no duplication to guard against any more — this is the only
 * implementation, and the Worker reaches it by delegation — so the reason to
 * keep them here is the opposite one: the repository's capability analyzer
 * reads a Prisma call's own `where` OBJECT LITERAL to decide whether the
 * access is tenant-scoped. Passing `where: where.evidence` hides that literal
 * and the count reports as WHERE_NOT_STATICALLY_READABLE — an unreadable
 * predicate is an analysis gap, not proof of scoping, and a read whose tenancy
 * cannot be measured is a read nobody can vouch for.
 */

/**
 * Compute the four derived counters for one workspace.
 *
 * FAILS CLOSED on an absent workspace id. A blank id would make
 * `workspaceEvidenceWhere` resolve an unknown workspace, which returns a
 * strict filter on the empty string and therefore a confident set of zeros —
 * a projection that says "this workspace is empty" about a workspace nobody
 * named. Throwing is the only honest answer.
 */
export async function computeOrgHealthCounts(
  input: { teamId: string },
  client: PrismaClient = getRegisteredPrisma(),
): Promise<OrgHealthCounts> {
  // Two refusals, written separately rather than as one `||`.
  //
  // The absent case is the one the structural gate matches on
  // (`refusalGuardOn("input.teamId")` reads an `if (!<subject>)` statement), and
  // collapsing the pair into a single boolean expression makes the refusal
  // invisible to it — the guard would still be there and the instrument would
  // report it missing. The blank case is a second, stricter refusal: a
  // whitespace id is not a workspace either.
  if (!input.teamId) {
    throw new Error("computeOrgHealthCounts requires a teamId");
  }
  if (!input.teamId.trim()) {
    throw new Error("computeOrgHealthCounts requires a non-blank teamId");
  }
  const [evidence, cases] = await Promise.all([
    workspaceEvidenceWhere(input.teamId, client),
    workspaceCaseWhere(input.teamId, client),
  ]);
  const [evidenceCount, caseCount, pendingReportCount, pendingPackageCount] =
    await Promise.all([
      client.evidence.count({ where: { AND: [evidence], deletedAt: null } }),
      client.case.count({ where: { AND: [cases] } }),
      // "Pending a report" is a statement about a record that FINISHED the
      // upload-and-signature pipeline. A CREATED / UPLOADING / UPLOADED /
      // FAILED_HASH_MISMATCH record is pending a PRIOR step, or terminally
      // failed; counting it here is exactly what the Worker's now-deleted copy
      // did, and it turned ten stalled uploads into ten reports outstanding.
      client.evidence.count({
        where: {
          AND: [evidence],
          deletedAt: null,
          status: { in: [...REPORT_ELIGIBLE_STATUSES] as never },
          reports: { none: {} },
        },
      }),
      // A package is only legitimately missing once the report exists, i.e.
      // the record reached REPORTED. A SIGNED record has not reached the
      // package stage and is missing nothing.
      client.evidence.count({
        where: {
          AND: [evidence],
          deletedAt: null,
          status: { in: [...PACKAGE_ELIGIBLE_STATUSES] as never },
          verificationPackages: { none: {} },
        },
      }),
    ]);

  return { evidenceCount, caseCount, pendingReportCount, pendingPackageCount };
}

/**
 * Refresh the projection for one workspace and return the row written.
 *
 * The four counters below that are hard-coded to zero require subsystem
 * tables this projection does not yet read. They are stated here, once,
 * rather than defaulted independently in two places — which is how the pair
 * of implementations came to differ in the first place.
 */
export async function refreshOrgHealthProjection(
  input: { teamId: string; now?: Date },
  client: PrismaClient = getRegisteredPrisma(),
): Promise<OrgHealthProjectionRow> {
  const counts = await computeOrgHealthCounts(input, client);
  const sampledAtUtc = orgHealthSampleBucket(input.now);

  const row: OrgHealthProjectionRow = {
    teamId: input.teamId,
    sampledAtUtc,
    ...counts,
    openIncidentCount: 0,
    slaBreachCount: 0,
    governanceBlockerCount: 0,
    recentVerificationCount: 0,
  };

  await client.orgHealthProjection.upsert({
    where: { teamId_sampledAtUtc: { teamId: input.teamId, sampledAtUtc } },
    create: { ...row, source: ORG_HEALTH_REFRESH_SOURCE },
    update: {
      evidenceCount: row.evidenceCount,
      caseCount: row.caseCount,
      openIncidentCount: row.openIncidentCount,
      slaBreachCount: row.slaBreachCount,
      governanceBlockerCount: row.governanceBlockerCount,
      recentVerificationCount: row.recentVerificationCount,
      pendingPackageCount: row.pendingPackageCount,
      pendingReportCount: row.pendingReportCount,
      source: ORG_HEALTH_REFRESH_SOURCE,
    },
  });

  return row;
}

/**
 * ONE source label for both hosts.
 *
 * It used to be `worker_refresh_v1` in the Worker and `worker_refresh_v1` in
 * the API too — the same string, which meant an operator reading the table
 * could not tell which process wrote a row and, more importantly, could not
 * tell that TWO processes were writing rows with different arithmetic. Now
 * there is one writer, so one label is the truth rather than a coincidence.
 */
export const ORG_HEALTH_REFRESH_SOURCE = "org_health_refresh_v2";

/**
 * Read the most-recent projection row for a workspace.
 *
 * Returns null when none exists; the caller falls back to its live aggregator
 * rather than rendering zeros.
 */
export async function readLatestOrgHealthProjection(
  input: { teamId: string },
  client: PrismaClient = getRegisteredPrisma(),
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
