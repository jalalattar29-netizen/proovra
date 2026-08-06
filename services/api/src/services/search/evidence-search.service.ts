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
  type SearchFallbackReason,
  type SearchMode,
  type SearchResultRow,
  decodeSearchCursor,
  encodeSearchCursor,
  isAllowedSearchBadge,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { recordSearchAudit } from "./search-audit.service.js";
import {
  type EmbeddingProvider,
  isSemanticReadyAtRuntime,
  logEmbeddingFailure,
  resolveEmbeddingProviderFromEnv,
} from "./embedding-provider.js";

// -----------------------------------------------------------------------------
// Result
// -----------------------------------------------------------------------------

export type SearchResult = {
  rows: ReadonlyArray<SearchResultRow>;
  nextCursor: string | null;
  totalReturned: number;
  filteredByGovernance: number;
  filteredByVisibility: number;
  // Phase 15 — hybrid ranker metadata. Backward-compatible: existing
  // Phase 14 callers ignore these fields. `modeUsed` is what the
  // backend actually executed; `fallbackReason` is set ONLY when
  // `modeUsed` differs from the operator's requested `mode`.
  modeUsed: SearchMode;
  semanticAvailable: boolean;
  fallbackReason: SearchFallbackReason | null;
};

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

export type ExecuteSearchInput = {
  actorUserId: string;
  isReviewerCapable: boolean;
  filter: SearchFilterInput;
  /** Phase 24-B — bounded surface label written to the dedicated audit
   *  log so compliance can answer "who searched where". Defaults to
   *  `api:executeSearch` when the caller doesn't pass one. */
  surface?: string;
  /** Phase 24-B — request correlation id, persisted on the audit row. */
  requestId?: string | null;
  /** Phase 24-B — raw IP — hashed inside the audit service, never
   *  persisted raw. */
  ipAddress?: string | null;
};

export async function executeSearch(
  input: ExecuteSearchInput,
  client: PrismaClient = defaultPrisma,
): Promise<SearchResult> {
  const { filter } = input;
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const overscan = limit + 1;

  // -------------------------------------------------------------------------
  // Phase 15 — resolve effective mode + provider readiness up front.
  // The actual semantic re-rank runs AFTER the keyword pass below
  // (so the governance / visibility gates apply to every hit).
  // -------------------------------------------------------------------------
  const requestedMode: SearchMode = filter.mode ?? "KEYWORD";
  const semanticAvailable = isSemanticReadyAtRuntime();
  let modeUsed: SearchMode = requestedMode;
  let fallbackReason: SearchFallbackReason | null = null;
  if (
    (requestedMode === "SEMANTIC" || requestedMode === "HYBRID") &&
    !semanticAvailable
  ) {
    modeUsed = "KEYWORD";
    fallbackReason = "SEMANTIC_FEATURE_DISABLED";
  }
  if (
    (requestedMode === "SEMANTIC" || requestedMode === "HYBRID") &&
    semanticAvailable &&
    (!filter.q || filter.q.trim().length < 2)
  ) {
    modeUsed = "KEYWORD";
    fallbackReason = "QUERY_TOO_SHORT";
  }

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
  // PHASE 12B — case scoping. Absorbed from the deleted owner-scoped
  // /v1/search/evidence primitive. `case_id` is an indexed column on
  // evidence_search_documents, so this stays a cheap index probe.
  if (filter.caseId) {
    where.caseId = filter.caseId;
  }
  // PHASE 12B — `evidenceTypes` was declared on SearchFilterSchema and
  // rendered as filter chips in the /search console but was NEVER
  // applied here, so the chips silently returned the unfiltered set.
  // The indexer writes the evidence type into
  // `searchable_metadata_json.type` (see packages/shared/search-projection
  // buildEvidenceProjection), so we narrow on that JSON path. The clause
  // is pushed onto `AND` rather than `OR` so it composes with the
  // free-text `OR` block below instead of clobbering it.
  if (filter.evidenceTypes && filter.evidenceTypes.length > 0) {
    const typeClauses: prismaPkg.Prisma.EvidenceSearchDocumentWhereInput[] =
      filter.evidenceTypes.map((t) => ({
        searchableMetadataJson: { path: ["type"], equals: t },
      }));
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { OR: typeClauses },
    ];
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
    bump("search_fail_closed_engaged_total");
    safeEmitSecurityEvent({
      teamId: filter.teamId,
      eventType: "search_indexing_drift_detected",
      severity: "WARNING",
      details: {
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
    });
    // Phase 24-B — even on a failed query the audit log records the
    // fail-closed engagement so compliance can prove the gate is firing.
    void recordSearchAudit(
      {
        teamId: filter.teamId,
        actorUserId: input.actorUserId,
        surface: input.surface ?? "api:executeSearch",
        queryText: filter.q ?? null,
        documentTypes: filter.documentTypes ?? null,
        filters: buildSafeFilterSnapshot(filter),
        resultCount: 0,
        filteredGovernanceCount: 0,
        filteredVisibilityCount: 0,
        failClosed: true,
        requestId: input.requestId ?? null,
        ipAddress: input.ipAddress ?? null,
      },
      client,
    );
    return {
      rows: [],
      nextCursor: null,
      totalReturned: 0,
      filteredByGovernance: 0,
      filteredByVisibility: 0,
      modeUsed: "KEYWORD",
      semanticAvailable,
      fallbackReason,
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
  if (safeRows.length > 0) {
    bump("search_result_returned_total", safeRows.length);
  }
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

  // Phase 24-B — dedicated operator-facing audit row. Best-effort:
  // recordSearchAudit catches its own errors and never throws to the
  // calling search handler. The SecurityEvent stream above remains as
  // the durable backup.
  void recordSearchAudit(
    {
      teamId: filter.teamId,
      actorUserId: input.actorUserId,
      surface: input.surface ?? "api:executeSearch",
      queryText: filter.q ?? null,
      documentTypes: filter.documentTypes ?? null,
      filters: buildSafeFilterSnapshot(filter),
      resultCount: safeRows.length,
      filteredGovernanceCount: filteredByGovernance,
      filteredVisibilityCount: filteredByVisibility,
      failClosed: false,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
    },
    client,
  );

  // -------------------------------------------------------------------------
  // Phase 15 — hybrid ranker pass.
  //
  // The keyword pass above is the canonical source for governance gating.
  // The hybrid ranker layers semantic cosine on top of the safe rows so:
  //
  //   - Legal-hold / destroyed / export-restriction filters are reapplied
  //     (semantic results live inside the already-gated `safeRows` set,
  //     they cannot widen the result envelope).
  //   - Workspace permissions are preserved (semantic only re-orders rows
  //     the keyword pass already approved).
  //   - On provider failure the array is returned as-is with a clear
  //     `fallbackReason=PROVIDER_UNAVAILABLE`, never a partial state.
  //
  // The actual `matchReasons` for each row are built operator-readable;
  // raw internal score names like "ts_rank" or "cosine_distance" NEVER
  // leak to the UI.
  // -------------------------------------------------------------------------
  let finalRows: SearchResultRow[] = safeRows.map(stampDefaultMatchReasons);
  if (
    (modeUsed === "SEMANTIC" || modeUsed === "HYBRID") &&
    filter.q &&
    finalRows.length > 0
  ) {
    try {
      const provider = resolveEmbeddingProviderFromEnv();
      const rankerOutcome = await rerankWithSemantic({
        client,
        teamId: filter.teamId,
        query: filter.q,
        rows: finalRows,
        provider,
        mode: modeUsed,
      });
      if (rankerOutcome.ok) {
        finalRows = rankerOutcome.rows;
        if (rankerOutcome.rows.length === 0) {
          // Semantic returned a non-error empty set — flag it so the UI
          // can render an honest "no semantic hits, keyword only" chip.
          fallbackReason = fallbackReason ?? "NO_SEMANTIC_RESULTS";
        }
      } else {
        // Degrade silently to keyword; never throw to the caller.
        modeUsed = "KEYWORD";
        fallbackReason = "PROVIDER_UNAVAILABLE";
        logEmbeddingFailure({
          status: "failed",
          errorCode: rankerOutcome.errorCode,
          workspaceId: filter.teamId,
        });
      }
    } catch (err) {
      modeUsed = "KEYWORD";
      fallbackReason = "PROVIDER_UNAVAILABLE";
      logEmbeddingFailure({
        status: "failed",
        errorCode:
          err instanceof Error
            ? (err as Error & { code?: string }).code ?? "RANKER_EXCEPTION"
            : "RANKER_EXCEPTION",
        workspaceId: filter.teamId,
      });
    }
  }

  const nextCursor =
    hasMore && finalRows.length > 0
      ? encodeSearchCursor({
          updatedAtUtc: finalRows[finalRows.length - 1].updatedAtUtc,
          id: finalRows[finalRows.length - 1].documentId,
        })
      : null;

  return {
    rows: finalRows,
    nextCursor,
    totalReturned: finalRows.length,
    filteredByGovernance,
    filteredByVisibility,
    modeUsed,
    semanticAvailable,
    fallbackReason,
  };
}

// ---------------------------------------------------------------------------
// Phase 15 — semantic re-rank helpers.
//
// `rerankWithSemantic` does NOT widen the result set. It only re-orders
// already-gated keyword rows AND attaches operator-readable matchReasons
// + a numeric semanticScore. When pgvector is installed, the per-row
// embeddings come from `embedding_vector` via raw SQL; otherwise the
// in-process Bytes column is read.
// ---------------------------------------------------------------------------

type RerankInput = {
  client: PrismaClient;
  teamId: string;
  query: string;
  rows: SearchResultRow[];
  provider: EmbeddingProvider;
  mode: SearchMode;
};

type RerankOutcome =
  | { ok: true; rows: SearchResultRow[] }
  | { ok: false; errorCode: string };

const KEYWORD_WEIGHT = clampWeight(
  Number.parseFloat(process.env.SEMANTIC_HYBRID_KEYWORD_WEIGHT ?? "0.6"),
  0.6,
);
const SEMANTIC_WEIGHT = clampWeight(
  Number.parseFloat(process.env.SEMANTIC_HYBRID_SEMANTIC_WEIGHT ?? "0.4"),
  0.4,
);

function clampWeight(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

async function rerankWithSemantic(input: RerankInput): Promise<RerankOutcome> {
  let queryVec: Float32Array | null;
  try {
    queryVec = await input.provider.embedText(input.query);
  } catch (err) {
    return {
      ok: false,
      errorCode:
        err instanceof Error
          ? (err as Error & { code?: string }).code ?? "QUERY_EMBED_FAILED"
          : "QUERY_EMBED_FAILED",
    };
  }
  if (!queryVec || queryVec.length === 0) {
    return { ok: false, errorCode: "QUERY_EMBED_EMPTY" };
  }

  // Per-row evidence ids we need to fetch chunk embeddings for.
  const evidenceIds = Array.from(
    new Set(
      input.rows
        .map((r) => r.evidenceId)
        .filter((id): id is string => typeof id === "string"),
    ),
  );
  if (evidenceIds.length === 0) {
    // Nothing semantic to re-rank — keyword order stands.
    return { ok: true, rows: input.rows };
  }

  // Phase 16 — try the pgvector SQL-side cosine path FIRST. The
  // worker (`mi-embed.processor`) and the backfill script populate
  // `embedding_vector`; when the column is populated for this team
  // we let Postgres do the nearest-neighbour math through the
  // ivfflat index. Workspace id + provider triple are passed as
  // bound parameters — NEVER string-interpolated.
  //
  // On any failure (missing pgvector extension, ivfflat index not
  // built, syntax error) we fall back to the in-process Bytes
  // ranker so the existing behaviour is preserved.
  const semanticByEvidence = new Map<string, number>();
  const SQL_CANDIDATE_LIMIT = 200;
  let pgvectorOk = false;
  try {
    const lit = queryVectorLiteral(queryVec);
    const rows = await input.client.$queryRaw<
      Array<{ evidence_id: string; distance: number | string }>
    >`
      SELECT evidence_id,
             (embedding_vector <=> ${lit}::vector) AS distance
        FROM evidence_semantic_chunks
       WHERE team_id = ${input.teamId}::uuid
         AND evidence_id = ANY (${evidenceIds}::uuid[])
         AND embedding_vector IS NOT NULL
         AND embedding_provider = ${input.provider.name}
         AND embedding_model = ${input.provider.model}
         AND embedding_dimensions = ${input.provider.dimensions}::int
       ORDER BY embedding_vector <=> ${lit}::vector
       LIMIT ${SQL_CANDIDATE_LIMIT}::int
    `;
    pgvectorOk = true;
    for (const row of rows) {
      // pgvector cosine distance ∈ [0, 2]. Convert to similarity
      // ∈ [-1, 1] then clamp to [0, 1] for the blender.
      const dist = typeof row.distance === "string"
        ? Number.parseFloat(row.distance)
        : row.distance;
      if (!Number.isFinite(dist)) continue;
      const sim = 1 - dist / 2;
      const clamped = Math.max(0, Math.min(1, sim));
      const prev = semanticByEvidence.get(row.evidence_id) ?? -1;
      if (clamped > prev) semanticByEvidence.set(row.evidence_id, clamped);
    }
  } catch {
    // pgvector unavailable — fall through to the in-process ranker.
    pgvectorOk = false;
  }

  if (!pgvectorOk) {
    // Legacy in-process Bytes ranker — preserved as the back-compat
    // path when pgvector is not installed. Same governance contract
    // (rows already approved by the keyword pass).
    let chunks: Array<{
      evidenceId: string;
      embedding: Uint8Array | null;
    }> = [];
    try {
      chunks = await input.client.evidenceSemanticChunk.findMany({
        where: {
          teamId: input.teamId,
          evidenceId: { in: evidenceIds },
          embeddingProvider: input.provider.name,
          embeddingModel: input.provider.model,
          embeddingDimensions: input.provider.dimensions,
          embedding: { not: null },
        },
        select: { evidenceId: true, embedding: true },
        take: 4000,
      });
    } catch {
      return { ok: false, errorCode: "CHUNK_QUERY_FAILED" };
    }

    for (const c of chunks) {
      if (!c.embedding) continue;
      const peer = new Float32Array(
        c.embedding.buffer,
        c.embedding.byteOffset,
        c.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      if (peer.length !== queryVec.length) continue;
      const s = cosineSimilarity(queryVec, peer);
      const prev = semanticByEvidence.get(c.evidenceId) ?? -1;
      if (s > prev) semanticByEvidence.set(c.evidenceId, s);
    }
  }

  // Layer the semantic score onto each row. Keyword score in this
  // pass is a positional proxy (top rows score higher) since the
  // underlying `findMany` doesn't surface a tsvector rank yet.
  const total = input.rows.length;
  const blended = input.rows.map((row, idx) => {
    const positional = total > 0 ? 1 - idx / Math.max(total, 1) : 0;
    const semantic = row.evidenceId
      ? semanticByEvidence.get(row.evidenceId) ?? null
      : null;
    const matchReasons = buildMatchReasonsForRow(row, semantic);
    const blendedScore =
      input.mode === "SEMANTIC"
        ? semantic ?? 0
        : KEYWORD_WEIGHT * positional + SEMANTIC_WEIGHT * (semantic ?? 0);
    return {
      row: {
        ...row,
        matchReasons,
        semanticScore: semantic,
        keywordScore: positional,
      } satisfies SearchResultRow,
      blendedScore,
    };
  });

  blended.sort((a, b) => b.blendedScore - a.blendedScore);
  return { ok: true, rows: blended.map((b) => b.row) };
}

/**
 * Phase 16 — build a literal pgvector parameter `'[a,b,c]'`. The
 * caller passes this as a BOUND template parameter cast to
 * `::vector`; the raw SQL never carries operator-supplied data.
 * Bounded to dim ≤ 4096 to guard against absurd inputs.
 */
function queryVectorLiteral(vec: Float32Array): string {
  if (vec.length === 0 || vec.length > 4096) return "[]";
  const parts = new Array<string>(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    parts[i] = Number.isFinite(v) ? v.toFixed(6) : "0";
  }
  return `[${parts.join(",")}]`;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function buildMatchReasonsForRow(
  row: SearchResultRow,
  semantic: number | null,
): string[] {
  const reasons: string[] = [];
  // Operator-readable only. NEVER include internal score names.
  if (row.title) reasons.push("Matched title");
  if (row.summary) reasons.push("Matched summary");
  if (row.workflowInstanceId) reasons.push("Workflow-linked");
  if (semantic !== null && semantic > 0) {
    reasons.push("Semantically similar");
  }
  return reasons;
}

function stampDefaultMatchReasons(row: SearchResultRow): SearchResultRow {
  if (row.matchReasons && row.matchReasons.length > 0) return row;
  // Keyword-only path: surface a minimal reason set so the inspector
  // can render badges even when semantic was never engaged.
  const reasons: string[] = [];
  if (row.title) reasons.push("Matched title");
  if (row.summary) reasons.push("Matched summary");
  return {
    ...row,
    matchReasons: reasons,
    semanticScore: null,
    keywordScore: null,
  };
}

function hashQuery(q: string): string {
  return createHash("sha256")
    .update(q.toLowerCase().trim(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Phase 24-B — operator-safe filter snapshot for the search audit row.
 *
 * The raw `SearchFilterInput` is safe to persist verbatim minus the
 * `q` text. We strip `q` (already hashed separately), `cursor` (opaque
 * pagination state, not investigation-relevant), and any field that
 * could leak raw search syntax. Document-type / lifecycle / governance
 * fields are persisted as-is so compliance can answer "who searched
 * for legal-hold blocks in October".
 */
function buildSafeFilterSnapshot(
  filter: SearchFilterInput,
): Record<string, unknown> {
  return {
    documentTypes: filter.documentTypes ?? null,
    workflowStatuses: filter.workflowStatuses ?? null,
    reviewStatuses: filter.reviewStatuses ?? null,
    onLegalHold: filter.onLegalHold ?? null,
    exportRestricted: filter.exportRestricted ?? null,
    workflowLinked: filter.workflowLinked ?? null,
    contributorScoped: filter.contributorScoped ?? null,
    updatedSinceUtc: filter.updatedSinceUtc ?? null,
    updatedUntilUtc: filter.updatedUntilUtc ?? null,
    sort: filter.sort ?? null,
    limit: filter.limit ?? null,
    hasQueryText: filter.q ? true : false,
    mode: filter.mode ?? null,
  };
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
  // Search-inclusion-audit — surface `archived` and `locked` tags
  // from `searchableTagsJson` as user-facing badges. The projection
  // writes these into the tags array when evidence.archivedAt /
  // evidence.lockedAt are set; the search service forwards them as
  // badges so a Personal/SMB user searching by filename can see at
  // a glance that the matched record is archived (not currently
  // workflowed) or locked (mutation gated). Both are explicitly
  // included as "indexed but flagged" — same Option B the
  // diagnostics audit settled on.
  const tagsRaw = doc.searchableTagsJson;
  if (Array.isArray(tagsRaw)) {
    if (tagsRaw.includes("archived")) badges.push("archived");
    if (tagsRaw.includes("locked")) badges.push("locked");
    // Search-inclusion-audit (trash decision) — soft-deleted
    // records remain in the index; the badge tells the user the
    // matched row is in the trash + still restorable. The Open
    // action on the result row routes to the safe (read-only)
    // detail surface so normal mutations cannot fire.
    if (tagsRaw.includes("in_trash")) badges.push("in_trash");
  }
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
