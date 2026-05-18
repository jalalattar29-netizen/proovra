/**
 * Phase 15 — Governance-aware keyword search.
 *
 * Searches evidence within a single workspace by:
 *   - title / displayFileName / originalFileName (existing index)
 *   - extracted OCR / transcript text (Phase 15)
 *   - extracted entity values (Phase 15)
 *
 * Governance rules enforced BEFORE results are returned:
 *   - workspace scope (teamId must match)
 *   - excluded states: deletedAt set, publicVerifyState != PUBLISHED
 *     when caller asked for the "publishable-only" scope
 *   - never returns the raw extracted text body (operator must open
 *     the per-evidence detail to see full text)
 *
 * Search NEVER calls AI. It is a pure keyword surface — semantic
 * search lives behind a feature flag in `semantic.service.ts` and is
 * a no-op when unconfigured.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type SearchInput = {
  teamId: string;
  q: string;
  /**
   * "publishable" → only PUBLISHED + non-deleted evidence (safe for
   * any operator). "internal" → also include other publication
   * states (admin / reviewer view).
   */
  scope?: "publishable" | "internal";
  limit?: number;
};

export type SearchHit = {
  evidenceId: string;
  title: string | null;
  displayFileName: string | null;
  type: string;
  status: string;
  publicVerifyState: string;
  matches: {
    title?: boolean;
    filename?: boolean;
    ocr?: boolean;
    transcript?: boolean;
    entity?: boolean;
  };
};

export async function searchEvidence(
  input: SearchInput,
  client: PrismaClient = defaultPrisma,
): Promise<SearchHit[]> {
  const q = input.q.trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const scope = input.scope ?? "publishable";

  const baseWhere = {
    teamId: input.teamId,
    deletedAt: null,
    ...(scope === "publishable"
      ? { publicVerifyState: "PUBLISHED" as const }
      : {}),
  };

  // Three parallel keyword reads:
  //   1. evidence metadata (title / displayFileName / originalFileName)
  //   2. extracted text (OCR / transcript / pdf-text)
  //   3. entity values
  const [titleHits, textHits, entityHits] = await Promise.all([
    client.evidence.findMany({
      where: {
        ...baseWhere,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { displayFileName: { contains: q, mode: "insensitive" } },
          { originalFileName: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        title: true,
        displayFileName: true,
        originalFileName: true,
        type: true,
        status: true,
        publicVerifyState: true,
      },
      take: limit,
    }),
    client.evidenceExtractedText.findMany({
      where: {
        teamId: input.teamId,
        status: "COMPLETED",
        text: { contains: q, mode: "insensitive" },
      },
      select: { evidenceId: true, kind: true },
      take: limit,
    }),
    client.evidenceEntity.findMany({
      where: {
        teamId: input.teamId,
        OR: [
          { value: { contains: q, mode: "insensitive" } },
          { normalizedValue: { contains: q.toLowerCase(), mode: "insensitive" } },
        ],
      },
      select: { evidenceId: true },
      take: limit,
    }),
  ]);

  // Coalesce by evidenceId.
  const byId = new Map<string, SearchHit>();
  for (const t of titleHits) {
    const isFilenameMatch =
      !!t.displayFileName?.toLowerCase().includes(q.toLowerCase()) ||
      !!t.originalFileName?.toLowerCase().includes(q.toLowerCase());
    const isTitleMatch = !!t.title?.toLowerCase().includes(q.toLowerCase());
    byId.set(t.id, {
      evidenceId: t.id,
      title: t.title,
      displayFileName: t.displayFileName,
      type: t.type,
      status: t.status,
      publicVerifyState: t.publicVerifyState,
      matches: {
        title: isTitleMatch || undefined,
        filename: isFilenameMatch || undefined,
      },
    });
  }

  // Re-fetch metadata for evidence found via extracted text / entities
  // (and enforce scope filter on those too, since we used team-scoped
  // tables that don't carry publication state).
  const extraIds = new Set<string>();
  for (const h of textHits) if (!byId.has(h.evidenceId)) extraIds.add(h.evidenceId);
  for (const h of entityHits) if (!byId.has(h.evidenceId)) extraIds.add(h.evidenceId);
  if (extraIds.size > 0) {
    const extras = await client.evidence.findMany({
      where: { id: { in: Array.from(extraIds) }, ...baseWhere },
      select: {
        id: true,
        title: true,
        displayFileName: true,
        type: true,
        status: true,
        publicVerifyState: true,
      },
    });
    for (const ev of extras) {
      byId.set(ev.id, {
        evidenceId: ev.id,
        title: ev.title,
        displayFileName: ev.displayFileName,
        type: ev.type,
        status: ev.status,
        publicVerifyState: ev.publicVerifyState,
        matches: {},
      });
    }
  }

  for (const t of textHits) {
    const hit = byId.get(t.evidenceId);
    if (!hit) continue;
    if (t.kind.startsWith("TRANSCRIPT")) hit.matches.transcript = true;
    else hit.matches.ocr = true;
  }
  for (const e of entityHits) {
    const hit = byId.get(e.evidenceId);
    if (hit) hit.matches.entity = true;
  }

  return Array.from(byId.values()).slice(0, limit);
}
