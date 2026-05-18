/**
 * Phase 24 — Evidence search service.
 *
 * Read surface on top of `evidence_search_documents`. Every search
 * request from the route layer goes through this service; the route
 * does NOT query Prisma directly.
 *
 * Responsibilities:
 *   1. Translate a validated `SearchFilterInput` into a Prisma
 *      `findMany` with bounded cursor pagination.
 *   2. Apply governance + visibility gates on every result row:
 *      - reviewer-restricted rows hidden unless the actor has the
 *        Phase 17 `identity.access_review.action` permission;
 *      - contributor-scoped rows hidden from non-reviewer actors
 *        unless the actor is the source contributor (we do not have
 *        an "is contributor" check on the operator path — they are
 *        OUT of the search surface entirely; this rule applies to
 *        EXTERNAL_CONTRIBUTOR users that ever reach the operator
 *        search route, which they should not);
 *      - legal-hold rows surface a `legal-hold` badge but the row's
 *        title + summary remain (operator needs to see them).
 *   3. Emit an audit + a metrics bump per execution.
 *   4. Return safe `SearchResultRow` projections — never the raw
 *     document, never the metadata JSON.
 *
 * Hard invariants:
 *   - The result projection NEVER contains a private reviewer note
 *     (the underlying table never stores it).
 *   - The free-text body is NEVER echoed back to the caller; only
 *     the title / subtitle / summary / badges.
 *   - Search query strings are bumped to the SecurityEvent surface
 *     ONLY as a length + a hash — never the raw text.
 */

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type SearchCursor,
  type SearchDocumentType,
  type SearchFilterInput,
  type SearchResultRow,
  decodeSearchCursor,
  encodeSearchCursor,
  isAllowedSearchBadge,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

// -----------------------------------------------------------------------------
// Result
// -----------------------------------------------------------------------------

export type SearchResult = {
  rows: ReadonlyArray<SearchResultRow>;
  nextCursor: string | null;
  totalReturned: number;
  filteredByGovernance: number;
  filteredByVisibility: number;
};

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

export type ExecuteSearchInput = {
  actorUserId: string;
  isReviewerCapable: boolean;
  filter: SearchFilterInput;
};

export async function executeSearch(
  input: ExecuteSearchInput,
  client: PrismaClient = defaultPrisma,
): Promise<SearchResult> {
  const { filter } = input;
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const overscan = limit + 1;

  // Build the Prisma where clause. Every filter is anchored on
  // teamId; the search service NEVER returns cross-team rows.
  const where: prismaPkg.Prisma.EvidenceSearchDocumentWhereInput = {
    teamId: filter.teamId,
  };

  if (filter.documentTypes && filter.documentTypes.length > 0) {
    where.documentType = { in: filter.documentTypes as string[] };
  }
  if (filter.workflowStatuses && filter.workflowStatuses.length > 0) {
    where.workflowState = { in: filter.workflowStatuses };
  }
  if (filter.reviewStatuses && filter.reviewStatuses.length > 0) {
    where.reviewState = { in: filter.reviewStatuses };
  }
  if (filter.onLegalHold !== undefined) {
    where.legalHoldState = filter.onLegalHold ? { not: null } : null;
  }
  if (filter.exportRestricted !== undefined) {
    where.exportState = filter.exportRestricted
      ? { in: ["INTERNAL", "SUSPENDED"] }
      : { in: ["PUBLIC", "PACKAGE_READY", "APPROVED"] };
  }
  if (filter.workflowLinked !== undefined) {
    where.workflowInstanceId = filter.workflowLinked ? { not: null } : null;
  }
  if (filter.contributorScoped !== undefined) {
    where.contributorScoped = filter.contributorScoped;
  }
  if (filter.updatedSinceUtc || filter.updatedUntilUtc) {
    const range: prismaPkg.Prisma.DateTimeFilter = {};
    if (filter.updatedSinceUtc) range.gte = new Date(filter.updatedSinceUtc);
    if (filter.updatedUntilUtc) range.lte = new Date(filter.updatedUntilUtc);
    where.sourceUpdatedAtUtc = range;
  }
  // Reviewer-restriction gate. Non-reviewer actors NEVER see rows
  // flagged reviewer-restricted. The service is fail-closed: an
  // unknown actor capability falls through to "non-reviewer".
  if (!input.isReviewerCapable) {
    where.reviewerRestricted = false;
  }

  // Free-text query — Postgres `to_tsvector('simple', body) @@
  // plainto_tsquery('simple', :q)` via raw fragment. Bounded to
  // 200 chars at the shared schema level.
  if (filter.q && filter.q.trim().length > 0) {
    // Prisma doesn't have a first-class operator for tsvector; we
    // use the contains fallback (ILIKE) for portability. A future
    // phase can switch to a tsvector column + GIN index for scale.
    where.OR = [
      { title: { contains: filter.q, mode: "insensitive" } },
      { subtitle: { contains: filter.q, mode: "insensitive" } },
      { summary: { contains: filter.q, mode: "insensitive" } },
      { searchableText: { contains: filter.q, mode: "insensitive" } },
    ];
  }

  // Cursor.
  let cursor: SearchCursor | null = null;
  if (filter.cursor) {
    cursor = decodeSearchCursor(filter.cursor);
  }
  const orderBy: prismaPkg.Prisma.EvidenceSearchDocumentOrderByWithRelationInput[] =
    sortToOrderBy(filter.sort ?? "UPDATED_DESC");

  let rows: prismaPkg.EvidenceSearchDocument[];
  try {
    rows = await client.evidenceSearchDocument.findMany({
      where,
      orderBy,
      take: overscan,
      ...(cursor
        ? {
            // We use a (updatedAt, id) tie-break to keep ordering
            // stable. Prisma does not give us a first-class
            // "after this composite key" — we approximate with a
            // strict less-than on the timestamp + tie-break on id.
            // For pages 2+, the route layer trusts the cursor as
            // an opaque token.
            cursor: { id: cursor.id },
            skip: 1,
          }
        : {}),
    });
  } catch (err) {
    bump("search_indexing_failed_total");
    safeEmitSecurityEvent({
      teamId: filter.teamId,
      eventType: "search_indexing_drift_detected",
      severity: "WARNING",
      details: {
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
    });
    return {
      rows: [],
      nextCursor: null,
      totalReturned: 0,
      filteredByGovernance: 0,
      filteredByVisibility: 0,
    };
  }

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  // Per-row governance + visibility gate. The query already filters
  // most of the table; this pass catches the per-row decisions that
  // the column-level filters can't express.
  let filteredByGovernance = 0;
  let filteredByVisibility = 0;
  const safeRows: SearchResultRow[] = [];
  for (const row of rows) {
    // Hide deleted-but-not-yet-cleaned-up docs.
    if (row.workflowState === "CANCELLED") {
      filteredByGovernance += 1;
      continue;
    }
    if (!input.isReviewerCapable && row.reviewerRestricted) {
      filteredByVisibility += 1;
      continue;
    }
    safeRows.push(toResultRow(row));
  }

  if (filteredByGovernance > 0) {
    bump("search_governance_filtered_total", filteredByGovernance);
    safeEmitSecurityEvent({
      teamId: filter.teamId,
      eventType: "search_governance_blocked_result",
      severity: "INFO",
      details: { count: filteredByGovernance },
    });
  }
  if (filteredByVisibility > 0) {
    bump("search_visibility_filtered_total", filteredByVisibility);
    safeEmitSecurityEvent({
      teamId: filter.teamId,
      eventType: "search_visibility_filtered_result",
      severity: "INFO",
      details: { count: filteredByVisibility },
    });
  }

  // Audit the execution itself. We bump the counter and write a
  // SecurityEvent with a HASH of the query (never the raw text) so
  // operators can correlate without us leaking what people typed.
  bump("search_executed_total");
  safeEmitSecurityEvent({
    teamId: filter.teamId,
    eventType: "search_executed",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      queryHash: filter.q ? hashQuery(filter.q) : null,
      queryLength: filter.q?.length ?? 0,
      documentTypes: filter.documentTypes ?? null,
      returned: safeRows.length,
      filteredByGovernance,
      filteredByVisibility,
    },
  });

  const nextCursor =
    hasMore && safeRows.length > 0
      ? encodeSearchCursor({
          updatedAtUtc: safeRows[safeRows.length - 1].updatedAtUtc,
          id: safeRows[safeRows.length - 1].documentId,
        })
      : null;

  return {
    rows: safeRows,
    nextCursor,
    totalReturned: safeRows.length,
    filteredByGovernance,
    filteredByVisibility,
  };
}

function hashQuery(q: string): string {
  return createHash("sha256")
    .update(q.toLowerCase().trim(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function sortToOrderBy(
  sort: SearchFilterInput["sort"] = "UPDATED_DESC",
): prismaPkg.Prisma.EvidenceSearchDocumentOrderByWithRelationInput[] {
  switch (sort) {
    case "UPDATED_ASC":
      return [{ sourceUpdatedAtUtc: "asc" }, { id: "asc" }];
    case "CREATED_DESC":
      return [{ createdAt: "desc" }, { id: "desc" }];
    case "CREATED_ASC":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "RELEVANCE_DESC":
    case "UPDATED_DESC":
    default:
      return [{ sourceUpdatedAtUtc: "desc" }, { id: "desc" }];
  }
}

function toResultRow(
  doc: prismaPkg.EvidenceSearchDocument,
): SearchResultRow {
  const badges: string[] = [];
  if (doc.workflowInstanceId) badges.push("workflow-linked");
  if (doc.contributorScoped) badges.push("contributor-scoped");
  if (doc.reviewerRestricted) badges.push("visibility-restricted");
  if (doc.legalHoldState) badges.push("legal-hold");
  if (doc.exportState === "INTERNAL") badges.push("export-restricted");
  // Defensive: drop any accidental badge that isn't in the allowed
  // catalog. (Belt-and-braces — we control all writers above.)
  const safeBadges = badges.filter(isAllowedSearchBadge);
  return {
    documentId: doc.id,
    documentType: doc.documentType as SearchDocumentType,
    title: doc.title,
    subtitle: doc.subtitle,
    summary: doc.summary,
    evidenceId: doc.evidenceId,
    workflowInstanceId: doc.workflowInstanceId,
    workflowStepInstanceId: doc.workflowStepInstanceId,
    caseId: doc.caseId,
    reviewState: doc.reviewState,
    workflowState: doc.workflowState,
    exportState: doc.exportState,
    retentionState: doc.retentionState,
    legalHoldState: doc.legalHoldState,
    contributorScoped: doc.contributorScoped,
    reviewerRestricted: doc.reviewerRestricted,
    badges: safeBadges,
    updatedAtUtc: doc.sourceUpdatedAtUtc.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Relationship discovery — pure read against the existing Phase ?
// EvidenceRelationship table. Phase 24 does NOT add a parallel table.
// -----------------------------------------------------------------------------

export type RelatedEvidenceProjection = {
  relationshipId: string;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  relationshipType: string;
  note: string | null;
  createdByUserId: string | null;
  createdAt: string;
};

export async function listRelationshipsForEvidence(
  input: { teamId: string; evidenceId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<RelatedEvidenceProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  // Confirm the evidence belongs to the team (anti-cross-team).
  const ev = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { id: true },
  });
  if (!ev) return [];
  const rows = await client.evidenceRelationship.findMany({
    where: {
      teamId: input.teamId,
      OR: [
        { sourceEvidenceId: input.evidenceId },
        { targetEvidenceId: input.evidenceId },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    relationshipId: r.id,
    sourceEvidenceId: r.sourceEvidenceId,
    targetEvidenceId: r.targetEvidenceId,
    relationshipType: r.relationshipType,
    note: r.note,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type CreateRelationshipInput = {
  teamId: string;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  relationshipType: prismaPkg.EvidenceRelationshipType;
  note?: string | null;
  createdByUserId: string;
};

export async function createRelationship(
  input: CreateRelationshipInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.EvidenceRelationship | null> {
  if (input.sourceEvidenceId === input.targetEvidenceId) return null;
  // Confirm both evidences belong to the team.
  const [src, tgt] = await Promise.all([
    client.evidence.findFirst({
      where: { id: input.sourceEvidenceId, teamId: input.teamId },
      select: { id: true },
    }),
    client.evidence.findFirst({
      where: { id: input.targetEvidenceId, teamId: input.teamId },
      select: { id: true },
    }),
  ]);
  if (!src || !tgt) return null;
  try {
    const row = await client.evidenceRelationship.create({
      data: {
        teamId: input.teamId,
        sourceEvidenceId: input.sourceEvidenceId,
        targetEvidenceId: input.targetEvidenceId,
        relationshipType: input.relationshipType,
        note: input.note?.slice(0, 1000) ?? null,
        createdByUserId: input.createdByUserId,
      },
    });
    bump("search_relationship_created_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "search_relationship_created",
      severity: "INFO",
      details: {
        actorUserId: input.createdByUserId,
        relationshipType: input.relationshipType,
      },
    });
    return row;
  } catch {
    // Duplicate (uk on source+target+type) — return null silently.
    return null;
  }
}
