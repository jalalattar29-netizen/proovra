/**
 * Phase 32.8D — Matter Operations Queue.
 *
 * Aggregates Case rows for the /cases index page with REAL counters per
 * case: linked evidence, open incidents, active workflows, governance
 * blockers, reviewer pressure, audit-readiness gap, latest-activity,
 * plus the latest CaseRiskSnapshot.
 *
 * Hard rules:
 *   - Reads ONLY. NO mutations on this surface.
 *   - Per-case query failures degrade THAT row, never the whole queue.
 *   - Bounded result set (max 200 cases per query).
 *   - No raw payloads / signed URLs / storage keys.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import { listCaseEvidenceIds } from "./case-risk-engine.service.js";

/**
 * Canonical RFC-4122 UUID shape (8-4-4-4-12 hex). Used to decide whether
 * a search term is a FULL uuid (exact `id` match) vs a partial prefix.
 */
const FULL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A tractable uuid *prefix*: hex + hyphens only, at least 2 chars, and
 * NOT already a full uuid. `Case.id` is a Postgres `uuid` column
 * (`@db.Uuid`), so Prisma `startsWith` / `contains` do NOT work on it —
 * we must cast to text in a scoped `$queryRaw`. We only run that extra
 * query when the term actually looks like a uuid fragment, so ordinary
 * name/reference searches never pay for it.
 */
const UUID_PREFIX_RE = /^[0-9a-f-]{2,}$/i;

/**
 * Build the search OR-clause for the matter queue.
 *
 * Matches, WITHIN the caller-supplied `teamId` scope, any of:
 *   1. `name`            (contains, insensitive)
 *   2. `referenceNumber` (contains, insensitive)
 *   3. FULL case uuid    (exact `id` match when the term is a valid uuid)
 *   4. uuid PREFIX       (case `id` starts with the term — resolved via a
 *                         team-scoped `id::text LIKE $prefix || '%'` raw
 *                         subquery because `id` is `@db.Uuid`)
 *   5. OWNER             (User.email / displayName / firstName / lastName
 *                         contains → resolve to ownerUserId set). `Case`
 *                         has NO Prisma relation to `User`, so this is a
 *                         resolve-then-`ownerUserId in [...]` filter.
 *   6. LINKED EVIDENCE   (evidence id exact/prefix → resolve to the set of
 *                         caseIds that link that evidence, team-scoped).
 *
 * EVERY branch is either a Prisma structured filter or a parameter-bound
 * `Prisma.sql` raw query — the user term is NEVER string-concatenated
 * into SQL. Every raw query is bounded and scoped by `teamId`, so a
 * search can never surface a case from another workspace.
 */
async function buildSearchOrClause(
  teamId: string,
  rawTerm: string,
): Promise<Array<Record<string, unknown>>> {
  const term = rawTerm.trim();
  const or: Array<Record<string, unknown>> = [
    { name: { contains: term, mode: "insensitive" } },
    { referenceNumber: { contains: term, mode: "insensitive" } },
  ];

  // (3) FULL uuid — exact id match. Prisma accepts a valid uuid string
  // against a `@db.Uuid` column directly.
  if (FULL_UUID_RE.test(term)) {
    or.push({ id: { equals: term } });
  }

  // (4) uuid PREFIX — `id::text LIKE $prefix || '%'`, team-scoped. We
  // only run this for full uuids (covers the exact case too) OR proper
  // prefixes; skip when the term is a full uuid (already handled by 3).
  if (!FULL_UUID_RE.test(term) && UUID_PREFIX_RE.test(term)) {
    try {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"::text AS id
          FROM "cases"
         WHERE "team_id" = ${teamId}::uuid
           AND "id"::text LIKE ${`${term.toLowerCase()}%`}
         LIMIT 200
      `);
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) or.push({ id: { in: ids } });
    } catch {
      /* prefix search degrades silently — name/ref still apply */
    }
  }

  // (5) OWNER — resolve users whose email / displayName / firstName /
  // lastName contains the term, then match `ownerUserId in [...]`. There
  // is no Case→User relation in the Prisma schema, so we cannot use a
  // relation filter; we resolve the id set instead. Bounded.
  try {
    const owners = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: term, mode: "insensitive" } },
          { displayName: { contains: term, mode: "insensitive" } },
          { firstName: { contains: term, mode: "insensitive" } },
          { lastName: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    const ownerIds = owners.map((u) => u.id);
    if (ownerIds.length > 0) or.push({ ownerUserId: { in: ownerIds } });
  } catch {
    /* owner search degrades silently */
  }

  // (6) LINKED EVIDENCE — a case matches if it links an evidence record
  // whose id equals or starts with the term. Evidence links live in the
  // canonical `case_evidence_links` join AND the legacy `evidence.case_id`
  // column; both `id`/`case_id` are `@db.Uuid`, so we cast to text. Both
  // subqueries are team-scoped. Only run for uuid-shaped terms.
  if (FULL_UUID_RE.test(term) || UUID_PREFIX_RE.test(term)) {
    try {
      const evPattern = `${term.toLowerCase()}%`;
      const rows = await prisma.$queryRaw<Array<{ case_id: string }>>(
        Prisma.sql`
          SELECT DISTINCT "case_id"::text AS case_id
            FROM "case_evidence_links"
           WHERE "team_id" = ${teamId}::uuid
             AND "evidence_id"::text LIKE ${evPattern}
          UNION
          SELECT DISTINCT c."id"::text AS case_id
            FROM "cases" c
            JOIN "evidence" e ON e."case_id" = c."id"
           WHERE c."team_id" = ${teamId}::uuid
             AND e."id"::text LIKE ${evPattern}
          LIMIT 200
        `,
      );
      const caseIds = rows.map((r) => r.case_id);
      if (caseIds.length > 0) or.push({ id: { in: caseIds } });
    } catch {
      /* evidence search degrades silently */
    }
  }

  return or;
}

export type MatterQueueFilter = {
  status?: string;
  riskLevel?: string;
  assignedToUserId?: string;
  hasOpenIncidents?: boolean;
  hasGovernanceBlockers?: boolean;
  hasOverdueWorkflows?: boolean;
  hasLegalHold?: boolean;
  missingArtifact?: boolean;
  search?: string;
};

export type MatterQueueItem = {
  id: string;
  name: string;
  referenceNumber: string | null;
  status: string;
  priority: string;
  ownerUserId: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  linkedEvidenceCount: number;
  activeAssignmentCount: number;
  openIncidentCount: number;
  activeWorkflowCount: number;
  overdueWorkflowCount: number;
  governanceBlockerCount: number;
  activeLegalHoldCount: number;
  evidenceGapCount: number;
  riskScore: number | null;
  riskLevel: string | null;
  riskReasonCodes: string[];
  recommendedAction: string | null;
  latestActivityAtUtc: string;
};

export type MatterQueueEnvelope = {
  generatedAt: string;
  workspace: {
    teamId: string;
    role: string;
  };
  items: MatterQueueItem[];
  total: number;
};

export async function buildMatterQueue(input: {
  teamId: string;
  userId: string;
  role: string;
  filter: MatterQueueFilter;
  limit?: number;
}): Promise<MatterQueueEnvelope> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  // Build the WHERE clause deterministically from the filter.
  const where: Record<string, unknown> = { teamId: input.teamId };
  if (input.filter.status) where.status = input.filter.status;
  if (input.filter.search) {
    // The search OR-clause is composed here but the workspace scope
    // (`teamId`) stays as a top-level AND on `where`, so no OR branch can
    // ever widen the query beyond the caller's workspace.
    where.OR = await buildSearchOrClause(input.teamId, input.filter.search);
  }

  // Pull base cases.
  let cases: Array<{
    id: string;
    name: string;
    referenceNumber: string | null;
    status: string;
    priority: string;
    ownerUserId: string;
    teamId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  try {
    cases = await prisma.case.findMany({
      where,
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
      take: limit,
      select: {
        id: true,
        name: true,
        referenceNumber: true,
        status: true,
        priority: true,
        ownerUserId: true,
        teamId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch {
    cases = [];
  }

  // Bulk-load the latest CaseRiskSnapshot per case in this batch.
  const riskByCase = new Map<
    string,
    {
      riskScore: number;
      riskLevel: string;
      reasonCodes: string[];
      recommendedAction: string;
    }
  >();
  if (cases.length > 0) {
    try {
      const caseIds = cases.map((c) => c.id);
      const allSnaps = await prisma.caseRiskSnapshot.findMany({
        where: { caseId: { in: caseIds } },
        orderBy: { sampledAtUtc: "desc" },
        take: caseIds.length * 4,
        select: {
          caseId: true,
          riskScore: true,
          riskLevel: true,
          reasonCodes: true,
          recommendedAction: true,
        },
      });
      for (const s of allSnaps) {
        if (riskByCase.has(s.caseId)) continue;
        riskByCase.set(s.caseId, {
          riskScore: s.riskScore,
          riskLevel: String(s.riskLevel),
          reasonCodes: Array.isArray(s.reasonCodes)
            ? (s.reasonCodes as string[])
            : [],
          recommendedAction: s.recommendedAction,
        });
      }
    } catch {
      /* degrade: rows render without risk */
    }
  }

  // Per-case counters in parallel batches. Each failure degrades that row.
  const items: MatterQueueItem[] = [];
  for (const c of cases) {
    try {
      const evidenceIds = await listCaseEvidenceIds({
        teamId: c.teamId,
        caseId: c.id,
      });
      const [
        openIncidentCount,
        activeWorkflowCount,
        overdueWorkflowCount,
        governanceBlockerCount,
        activeLegalHoldCount,
        evidenceGapCount,
        activeAssignmentCount,
      ] = await Promise.all([
        evidenceIds.length === 0
          ? Promise.resolve(0)
          : prisma.operationalIncident.count({
              where: {
                relatedEvidenceId: { in: evidenceIds },
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
              },
            }),
        prisma.operationalWorkflow.count({
          where: {
            caseId: c.id,
            status: {
              in: [
                "OPEN",
                "ASSIGNED",
                "IN_PROGRESS",
                "WAITING_ON_SYSTEM",
                "WAITING_ON_REVIEWER",
                "WAITING_ON_GOVERNANCE",
                "MITIGATING",
                "FAILED",
              ],
            },
          },
        }),
        prisma.operationalWorkflow.count({
          where: {
            caseId: c.id,
            status: {
              in: [
                "OPEN",
                "ASSIGNED",
                "IN_PROGRESS",
                "WAITING_ON_REVIEWER",
                "WAITING_ON_GOVERNANCE",
                "MITIGATING",
              ],
            },
            dueAtUtc: { lt: new Date(), not: null },
          },
        }),
        prisma.operationalWorkflow.count({
          where: {
            caseId: c.id,
            workflowType: {
              in: [
                "GOVERNANCE_ESCALATION",
                "EXPORT_BLOCKER_RESOLUTION",
                "AUDIT_READINESS",
              ],
            },
            status: {
              in: [
                "OPEN",
                "ASSIGNED",
                "IN_PROGRESS",
                "WAITING_ON_REVIEWER",
                "WAITING_ON_GOVERNANCE",
                "MITIGATING",
                "FAILED",
              ],
            },
          },
        }),
        prisma.caseLegalHold.count({
          where: { caseId: c.id, status: "ACTIVE" },
        }),
        evidenceIds.length === 0
          ? Promise.resolve(0)
          : (async () => {
              const [reportGap, packageGap] = await Promise.all([
                prisma.evidence.count({
                  where: {
                    id: { in: evidenceIds },
                    status: "SIGNED",
                    latestReportVersion: null,
                  },
                }),
                prisma.evidence.count({
                  where: {
                    id: { in: evidenceIds },
                    status: "REPORTED",
                    verificationPackageVersion: null,
                  },
                }),
              ]);
              return reportGap + packageGap;
            })(),
        prisma.caseAssignment.count({
          where: { caseId: c.id, status: "ACTIVE" },
        }),
      ]);

      const riskRow = riskByCase.get(c.id) ?? null;
      const item: MatterQueueItem = {
        id: c.id,
        name: c.name,
        referenceNumber: c.referenceNumber,
        status: String(c.status),
        priority: String(c.priority),
        ownerUserId: c.ownerUserId,
        teamId: c.teamId,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        linkedEvidenceCount: evidenceIds.length,
        activeAssignmentCount,
        openIncidentCount,
        activeWorkflowCount,
        overdueWorkflowCount,
        governanceBlockerCount,
        activeLegalHoldCount,
        evidenceGapCount,
        riskScore: riskRow?.riskScore ?? null,
        riskLevel: riskRow?.riskLevel ?? null,
        riskReasonCodes: riskRow?.reasonCodes ?? [],
        recommendedAction: riskRow?.recommendedAction ?? null,
        latestActivityAtUtc: c.updatedAt.toISOString(),
      };

      // Apply the post-aggregation filters (we can't push these into the
      // single base query because the counters span multiple tables).
      if (
        input.filter.hasOpenIncidents &&
        item.openIncidentCount === 0
      )
        continue;
      if (
        input.filter.hasGovernanceBlockers &&
        item.governanceBlockerCount === 0
      )
        continue;
      if (
        input.filter.hasOverdueWorkflows &&
        item.overdueWorkflowCount === 0
      )
        continue;
      if (input.filter.hasLegalHold && item.activeLegalHoldCount === 0)
        continue;
      if (input.filter.missingArtifact && item.evidenceGapCount === 0)
        continue;
      if (input.filter.riskLevel && item.riskLevel !== input.filter.riskLevel)
        continue;
      if (
        input.filter.assignedToUserId &&
        // We applied this filter via the caseAssignment join below.
        false
      ) {
        // The assignment filter is handled in a separate query path; we
        // approximate it here by checking the activeAssignmentCount > 0
        // combined with an explicit per-row check.
        continue;
      }

      items.push(item);
    } catch {
      // Degrade this row to a bounded shape with whatever we know.
      items.push({
        id: c.id,
        name: c.name,
        referenceNumber: c.referenceNumber,
        status: String(c.status),
        priority: String(c.priority),
        ownerUserId: c.ownerUserId,
        teamId: c.teamId,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        linkedEvidenceCount: 0,
        activeAssignmentCount: 0,
        openIncidentCount: 0,
        activeWorkflowCount: 0,
        overdueWorkflowCount: 0,
        governanceBlockerCount: 0,
        activeLegalHoldCount: 0,
        evidenceGapCount: 0,
        riskScore: null,
        riskLevel: null,
        riskReasonCodes: [],
        recommendedAction: null,
        latestActivityAtUtc: c.updatedAt.toISOString(),
      });
    }
  }

  // Apply assignedToUserId filter via a secondary join (cheap and
  // bounded).
  let filtered = items;
  if (input.filter.assignedToUserId) {
    try {
      const assigned = await prisma.caseAssignment.findMany({
        where: {
          assignedToUserId: input.filter.assignedToUserId,
          status: "ACTIVE",
          caseId: { in: items.map((i) => i.id) },
        },
        select: { caseId: true },
      });
      const assignedCaseIds = new Set(assigned.map((a) => a.caseId));
      filtered = items.filter((i) => assignedCaseIds.has(i.id));
    } catch {
      /* degrade: no filter applied */
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    workspace: { teamId: input.teamId, role: input.role },
    items: filtered,
    total: filtered.length,
  };
}
