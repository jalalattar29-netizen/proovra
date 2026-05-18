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
