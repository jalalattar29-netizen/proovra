"use client";

/**
 * PROOVRA Phase 12 — typed intelligence client.
 *
 * Thin wrapper around the EXISTING `/v1/intelligence/evidence/:id`
 * endpoint (defined in services/api/src/routes/intelligence.routes.ts).
 * No new backend route is introduced.
 *
 * The endpoint already returns:
 *   - extractedTexts  — OCR + transcript summaries (no raw text)
 *   - entities        — evidence entities (kind / source / value /
 *                       normalizedValue / confidence / createdAt)
 *   - similarities    — exact + perceptual similarity rows
 *   - disclaimer      — AI advisory disclaimer string
 *
 * Phase 12 only adds a typed projection + a client-side fetch helper
 * so existing pages can mount additive sections that display the data
 * the backend has been producing since Phase 11.
 *
 * Rules:
 *   - No raw env-var names surfaced; every label is operator-safe.
 *   - Returns `null` on any non-2xx so callers can render a bounded
 *     empty state without throwing.
 *   - Bounded — never recursive; one fetch per call.
 */

import { apiFetch } from "../api";

export type IntelligenceEntity = {
  id: string;
  kind: string;
  source: string;
  value: string;
  normalizedValue: string | null;
  confidence: number | null;
  createdAt: string;
};

export type IntelligenceExtractedText = {
  id: string;
  evidenceId: string;
  kind: string;
  status: string;
  provider: string;
  providerVersion: string | null;
  language: string | null;
  confidence: number | null;
  wordCount: number | null;
  extractedAtUtc: string | null;
  disclaimer: string;
};

export type IntelligenceSimilarity = {
  id: string;
  kind: string;
  otherEvidenceId: string;
  score: number;
  advisorySummary: string | null;
  createdAt: string;
};

export type IntelligenceEvidenceResponse = {
  extractedTexts: IntelligenceExtractedText[];
  entities: IntelligenceEntity[];
  similarities: IntelligenceSimilarity[];
  disclaimer: string;
};

/**
 * Fetch the intelligence projection for a single evidence record.
 *
 * Returns `null` if the request fails (404 / 403 / network) so the
 * caller can collapse to an empty state.
 */
export async function fetchEvidenceIntelligence(
  evidenceId: string,
  teamId: string,
): Promise<IntelligenceEvidenceResponse | null> {
  if (!evidenceId || !teamId) return null;
  try {
    const res = (await apiFetch(
      `/v1/intelligence/evidence/${encodeURIComponent(evidenceId)}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )) as IntelligenceEvidenceResponse | null;
    if (!res || typeof res !== "object") return null;
    return {
      extractedTexts: Array.isArray(res.extractedTexts) ? res.extractedTexts : [],
      entities: Array.isArray(res.entities) ? res.entities : [],
      similarities: Array.isArray(res.similarities) ? res.similarities : [],
      disclaimer: typeof res.disclaimer === "string" ? res.disclaimer : "",
    };
  } catch {
    return null;
  }
}

/** Group entities by kind so the operator surface can render a
 *  bounded set of pill clusters (PERSON / LOCATION / ORG / etc.). */
export function groupEntitiesByKind(
  entities: ReadonlyArray<IntelligenceEntity>,
): Map<string, IntelligenceEntity[]> {
  const grouped = new Map<string, IntelligenceEntity[]>();
  for (const entity of entities) {
    const bucket = grouped.get(entity.kind) ?? [];
    bucket.push(entity);
    grouped.set(entity.kind, bucket);
  }
  return grouped;
}

// =============================================================================
// Phase 13 — Cross-evidence findings (workspace-wide)
// =============================================================================

export type CrossEvidenceFinding = {
  kind: string;
  normalizedValue: string;
  evidenceCount: number;
  sampleEvidenceIds: ReadonlyArray<string>;
  operatorSummary: string;
};

export type CrossEvidenceFindingsResponse = {
  findings: CrossEvidenceFinding[];
  total: number;
};

/**
 * Fetch workspace-wide cross-evidence findings — entity tuples
 * that appear on more than one evidence record. Bounded to 20
 * findings server-side. Returns `null` on any non-2xx so the
 * caller can collapse to an empty state without throwing.
 */
export async function getCrossEvidenceFindings(
  teamId: string,
  limit: number = 20,
): Promise<CrossEvidenceFindingsResponse | null> {
  if (!teamId) return null;
  const bounded = Math.max(1, Math.min(limit, 20));
  try {
    const res = (await apiFetch(
      `/v1/investigation/cross-evidence?teamId=${encodeURIComponent(teamId)}&limit=${bounded}`,
      { method: "GET" },
    )) as CrossEvidenceFindingsResponse | null;
    if (!res || typeof res !== "object") return null;
    return {
      findings: Array.isArray(res.findings) ? res.findings : [],
      total: typeof res.total === "number" ? res.total : 0,
    };
  } catch {
    return null;
  }
}
