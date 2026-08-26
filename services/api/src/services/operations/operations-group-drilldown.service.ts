/**
 * THE AFFECTED-RECORD DRILL-DOWN.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * `projectConditionGroups` collapses five thousand per-record integrity
 * conditions into one row that says so. That is the right queue — and it is
 * only usable if the individual records are still reachable, because the whole
 * reason per-record conditions are per-record is that each one is a different
 * record somebody has to fix.
 *
 * This is how they are reached: one group, paged, bounded, workspace-scoped.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RETURNS, AND WHAT IT REFUSES TO
 * ---------------------------------------------------------------------------
 * Enough to identify a record and open it, and nothing else. No Evidence
 * content, no filenames beyond the operator-safe title the condition already
 * carries, no provider strings, no failure reasons that might embed a URL, no
 * infrastructure identifiers. The condition's own `safeSummary` is already
 * bounded and redacted by the writer, and that is what a reader gets.
 *
 * ---------------------------------------------------------------------------
 * WHY KEYSET AND NOT OFFSET
 * ---------------------------------------------------------------------------
 * A group's membership changes while an operator is paging through it —
 * records recover, new ones fail. An OFFSET page would then skip or repeat
 * rows silently, and on a five-thousand-row group an operator would have no
 * way to notice. `(firstSeenAtUtc, id)` is a TOTAL order: two conditions can
 * share an instant and cannot share an id, so a cursor names exactly one
 * position and the page after it is exactly the rows after that position.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import {
  OPERATIONS_SOURCE_LIFECYCLES,
  resolveConditionSource,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { workspaceIncidentWhereWith } from "../observability/incident-scope.js";

/** The largest page a caller may ask for. */
export const AFFECTED_PAGE_MAX = 200;
/** What a caller gets when it does not ask. */
export const AFFECTED_PAGE_DEFAULT = 50;

/**
 * How many conditions the grouped queue reads before projecting.
 *
 * Deliberately larger than any plausible real queue and still BOUNDED: the
 * grouped response is one row per source whatever this is, so the cost of
 * raising it is the scan, not the payload. Hitting it makes the response
 * `complete: false`, which stops anything concluding "all clear".
 */
export const GROUPED_SCAN_LIMIT = 500;

/** One affected record, bounded. */
export type AffectedRecordRow = {
  conditionId: string;
  /** Present for per-record sources; null for aggregate ones. */
  evidenceId: string | null;
  /** The condition's own operator-safe title. Never a raw filename. */
  title: string;
  severity: string;
  status: string;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  occurrenceCount: number;
  assignedOperatorUserId: string | null;
};

export type AffectedRecordPage = {
  records: AffectedRecordRow[];
  /** The id to pass back as `cursor`. Null when this page reached the end. */
  nextCursor: string | null;
};

/**
 * The members of ONE group, paged.
 *
 * `sourceId` is the group key. The predicate is built as
 * `workspace AND (declared source OR legacy fingerprint shapes)`, because a
 * workspace that has not yet been swept carries rows written before
 * `source_id` existed and an operator opening a group must see all of its
 * members, not only the modern half.
 */
export async function listGroupAffectedRecords(
  input: {
    teamId: string;
    sourceId: string;
    status?: string | null;
    severity?: string | null;
    limit: number;
    cursor?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<AffectedRecordPage> {
  const limit = Math.min(Math.max(1, input.limit), AFFECTED_PAGE_MAX);

  // The legacy half of the group's identity. Resolved from the SAME table the
  // runtime and the migration's backfill use, so a group cannot contain a row
  // in one reading and exclude it in another.
  const legacy = legacyFingerprintPrefixesFor(input.sourceId);
  const identity: prismaPkg.Prisma.OperationalIncidentWhereInput =
    legacy.length > 0
      ? {
          OR: [
            { sourceId: input.sourceId },
            ...legacy.map((prefix) => ({
              sourceId: null,
              fingerprint: { startsWith: prefix },
            })),
          ],
        }
      : { sourceId: input.sourceId };

  // The cursor row's position, read first. A cursor for a row in ANOTHER
  // workspace resolves to nothing and yields the first page rather than
  // leaking that the row exists.
  let after: { firstSeenAtUtc: Date; id: string } | null = null;
  if (input.cursor) {
    after = await client.operationalIncident.findFirst({
      where: workspaceIncidentWhereWith(input.teamId, { id: input.cursor }),
      select: { firstSeenAtUtc: true, id: true },
    });
  }

  const rows = await client.operationalIncident.findMany({
    where: workspaceIncidentWhereWith(
      input.teamId,
      identity,
      ...(input.status ? [{ status: input.status as prismaPkg.IncidentStatus }] : []),
      ...(input.severity
        ? [{ severity: input.severity as prismaPkg.IncidentSeverity }]
        : []),
      ...(after
        ? [
            {
              OR: [
                { firstSeenAtUtc: { gt: after.firstSeenAtUtc } },
                {
                  firstSeenAtUtc: after.firstSeenAtUtc,
                  id: { gt: after.id },
                },
              ],
            },
          ]
        : []),
    ),
    select: {
      id: true,
      relatedEvidenceId: true,
      title: true,
      severity: true,
      status: true,
      firstSeenAtUtc: true,
      lastSeenAtUtc: true,
      occurrenceCount: true,
      assignedOperatorUserId: true,
    },
    // The SAME total order the cursor is built from. A different order here
    // and the cursor would name a position in a sequence nobody is reading.
    orderBy: [{ firstSeenAtUtc: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    records: page.map((r) => ({
      conditionId: r.id,
      evidenceId: r.relatedEvidenceId,
      title: r.title,
      severity: r.severity,
      status: r.status,
      firstSeenAtUtc: r.firstSeenAtUtc.toISOString(),
      lastSeenAtUtc: r.lastSeenAtUtc.toISOString(),
      occurrenceCount: r.occurrenceCount,
      assignedOperatorUserId: r.assignedOperatorUserId,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * The legacy fingerprint prefixes a source claims.
 *
 * Read back out of the canonical contract rather than restated here: the
 * grouping, the backfill and this drill-down must agree about which rows
 * belong to a source, and three copies of that table would be three chances
 * to disagree.
 */
function legacyFingerprintPrefixesFor(sourceId: string): string[] {
  const out: string[] = [];
  // The contract exposes patterns per source; the resolver is the reverse
  // direction, so this walks the small registry once.
  const registry = registryPatterns();
  for (const entry of registry) {
    if (entry.sourceId === sourceId) out.push(entry.prefix);
  }
  return out;
}

let PATTERNS: Array<{ sourceId: string; prefix: string }> | null = null;

function registryPatterns(): Array<{ sourceId: string; prefix: string }> {
  if (PATTERNS) return PATTERNS;
  // Derived by ASKING the resolver, so this cannot drift from it: for each
  // registered source, every prefix it declares resolves back to that source.
  // Computed once — the registry is frozen and cannot change at runtime.
  const built: Array<{ sourceId: string; prefix: string }> = [];
  for (const lifecycle of OPERATIONS_SOURCE_LIFECYCLES) {
    for (const pattern of lifecycle.legacyFingerprints) {
      if (pattern.kind !== "PREFIX") continue;
      // Confirm the round trip rather than trusting the declaration: a prefix
      // two sources both claimed would be a group that stole another's rows.
      const back = resolveConditionSource({
        fingerprint: `${pattern.prefix}:probe`,
      });
      if (back.lifecycle.sourceId === lifecycle.sourceId) {
        built.push({ sourceId: lifecycle.sourceId, prefix: `${pattern.prefix}:` });
      }
    }
  }
  PATTERNS = built;
  return built;
}
