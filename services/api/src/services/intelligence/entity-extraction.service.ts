/**
 * Phase 15 — Entity extraction service.
 *
 * Deterministic regex-driven extraction over OCR / transcript text +
 * existing evidence metadata. No AI required for the baseline. Results
 * are ADVISORY — never claimed as ground truth.
 *
 * Persists rows in `evidence_entities` with the source tag so
 * operators can audit where a candidate came from.
 */

import type {
  EvidenceEntity as DbEntity,
  EvidenceEntityKind as DbEntityKind,
  EvidenceEntitySource as DbEntitySource,
  PrismaClient,
} from "@prisma/client";
import {
  extractRegexEntities,
  normaliseEmail,
  normalisePhone,
  normaliseUrl,
  type EvidenceEntityKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

function normaliseFor(
  kind: EvidenceEntityKind,
  value: string,
): string | null {
  switch (kind) {
    case "EMAIL":
      return normaliseEmail(value);
    case "PHONE":
      return normalisePhone(value);
    case "URL":
      return normaliseUrl(value);
    default:
      return value.trim().toLowerCase();
  }
}

export type ExtractEntitiesInput = {
  evidenceId: string;
  teamId: string | null;
  text: string;
  source: DbEntitySource;
};

/**
 * Idempotent: re-running over the same text from the same source
 * does not duplicate rows (we de-dup on (kind, normalizedValue)
 * within the (evidence, source) scope).
 */
export async function extractAndPersistEntities(
  input: ExtractEntitiesInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbEntity[]> {
  if (!input.text || input.text.length === 0) return [];
  const matches = extractRegexEntities(input.text);
  if (matches.length === 0) return [];

  // De-dup within the run by (kind, normalizedValue).
  const seen = new Set<string>();
  const candidates: Array<{
    kind: DbEntityKind;
    value: string;
    normalizedValue: string | null;
  }> = [];
  for (const m of matches) {
    const norm = normaliseFor(m.kind, m.value);
    const key = `${m.kind}::${norm ?? m.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      kind: m.kind as DbEntityKind,
      value: m.value.slice(0, 512),
      normalizedValue: norm ? norm.slice(0, 512) : null,
    });
  }

  // De-dup vs already-stored rows from the same source — avoids
  // building a fat row table when the same OCR run re-fires.
  const existing = await client.evidenceEntity.findMany({
    where: { evidenceId: input.evidenceId, source: input.source },
    select: { kind: true, normalizedValue: true },
  });
  const existingKeys = new Set(
    existing.map(
      (e) => `${e.kind}::${(e.normalizedValue ?? "").toLowerCase()}`,
    ),
  );
  const fresh = candidates.filter(
    (c) =>
      !existingKeys.has(
        `${c.kind}::${(c.normalizedValue ?? c.value).toLowerCase()}`,
      ),
  );

  if (fresh.length === 0) return [];

  await client.evidenceEntity.createMany({
    data: fresh.map((c) => ({
      evidenceId: input.evidenceId,
      teamId: input.teamId,
      kind: c.kind,
      source: input.source,
      value: c.value,
      normalizedValue: c.normalizedValue,
      confidence: null,
    })),
    skipDuplicates: true,
  });

  return client.evidenceEntity.findMany({
    where: { evidenceId: input.evidenceId, source: input.source },
    orderBy: { createdAt: "desc" },
  });
}

export async function listEvidenceEntities(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbEntity[]> {
  return client.evidenceEntity.findMany({
    where: { evidenceId },
    orderBy: [{ kind: "asc" }, { createdAt: "desc" }],
  });
}

export function projectEvidenceEntity(row: DbEntity): {
  id: string;
  kind: string;
  source: string;
  value: string;
  normalizedValue: string | null;
  confidence: number | null;
  createdAt: string;
} {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    value: row.value,
    normalizedValue: row.normalizedValue,
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
  };
}

// =============================================================================
// Phase 13 — Cross-evidence findings (workspace-scoped)
// =============================================================================
//
// Returns a bounded list of entity (kind, normalizedValue) tuples
// that appear on more than one evidence record in the same team.
// Operator-readable: each finding states "this {kind} appears in N
// evidence records". The route layer (intelligence.routes.ts) maps
// each row to a deep-link into /search?q=<normalizedValue>.
//
// Hard rules:
//   * Team-anchored — single WHERE clause on team_id (no cross-tenant
//     reads possible).
//   * Bounded — LIMIT is clamped to 20 by the caller (the synthesis
//     constraint). The service tolerates higher values but the route
//     layer enforces the cap.
//   * No raw value in the projection — only `normalizedValue` (which
//     is the regex-normalised form, e.g. lowercased email / digits-
//     only phone). The raw `value` column may contain user-supplied
//     content and is intentionally NOT exposed.
//   * Reads-only; never modifies entity rows.
//   * Best-effort try/catch — returns an empty array on DB failure
//     so the route can still respond 200.

export type CrossEvidenceFinding = {
  kind: string;
  normalizedValue: string;
  evidenceCount: number;
  /** Bounded sample of up to 5 evidence ids that match this finding.
   *  Operators use these to verify the grouping before opening the
   *  full search results. */
  sampleEvidenceIds: ReadonlyArray<string>;
};

export type ListCrossEvidenceFindingsInput = {
  teamId: string;
  /** Bounded 1..20 by the route layer; the service clamps defensively. */
  limit?: number;
};

export async function listCrossEvidenceFindings(
  input: ListCrossEvidenceFindingsInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<CrossEvidenceFinding>> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 20));
  if (!input.teamId) return [];
  try {
    type Row = {
      kind: string;
      normalized_value: string;
      evidence_count: bigint | number;
      sample_evidence_ids: string[];
    };
    const rows = (await client.$queryRawUnsafe(
      `SELECT en."kind"::text AS "kind",
              en."normalized_value",
              COUNT(DISTINCT en."evidence_id") AS "evidence_count",
              (
                ARRAY(
                  SELECT DISTINCT inner_en."evidence_id"::text
                    FROM "evidence_entities" inner_en
                   WHERE inner_en."team_id" = en."team_id"
                     AND inner_en."kind" = en."kind"
                     AND inner_en."normalized_value" = en."normalized_value"
                   LIMIT 5
                )
              ) AS "sample_evidence_ids"
         FROM "evidence_entities" en
        WHERE en."team_id" = $1
          AND en."normalized_value" IS NOT NULL
        GROUP BY en."team_id", en."kind", en."normalized_value"
        HAVING COUNT(DISTINCT en."evidence_id") > 1
        ORDER BY COUNT(DISTINCT en."evidence_id") DESC,
                 en."normalized_value" ASC
        LIMIT $2`,
      input.teamId,
      limit,
    )) as Row[];
    return rows.map((r) => ({
      kind: r.kind,
      normalizedValue: r.normalized_value,
      evidenceCount: Number(r.evidence_count ?? 0),
      sampleEvidenceIds: Array.isArray(r.sample_evidence_ids)
        ? r.sample_evidence_ids.slice(0, 5)
        : [],
    }));
  } catch {
    return [];
  }
}
