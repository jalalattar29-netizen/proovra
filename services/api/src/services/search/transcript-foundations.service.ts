/**
 * Phase 24-J — Transcript foundations.
 *
 * TODO(phase-repair-cleanup): ORPHAN. Mirror of ocr-foundations
 * which writes to `evidence_transcript_segments`. Same cleanup
 * applies: the canonical write path is `extractAndPersist` in
 * `intelligence/extraction.service.ts`, which uses
 * `evidence_extracted_texts` (EvidenceExtractedText). No production
 * code path imports anything from this file. A follow-up wave should
 * drop both the service and the `evidence_transcript_segments`
 * table.
 *
 * Mirror of `ocr-foundations.service.ts` for audio/video transcript
 * segments. Each segment carries millisecond start/end offsets so the
 * Discovery timeline pivot can deep-link to the exact moment.
 *
 * Governance rules + invariants identical to the OCR foundations:
 *   - visibility scope catalog bounded
 *   - forbidden-overclaim scrub at write
 *   - indexer-facing read enforces TEAM + non-redacted + lifecycle gate
 *   - cross-team reads impossible (every read anchored on team_id)
 */

import type { PrismaClient } from "@prisma/client";
import {
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  stringContainsForbiddenOverclaim,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

export const TRANSCRIPT_VISIBILITY_SCOPES = [
  "TEAM",
  "REVIEWER_RESTRICTED",
  "CONTRIBUTOR_PRIVATE",
  "BLOCKED",
] as const;

export type TranscriptVisibilityScope =
  (typeof TRANSCRIPT_VISIBILITY_SCOPES)[number];

const TRANSCRIPT_VISIBILITY_SCOPE_SET: ReadonlySet<string> = new Set(
  TRANSCRIPT_VISIBILITY_SCOPES,
);

const MAX_SEGMENT_TEXT_CHARS = 16 * 1024;

export type RecordTranscriptSegmentInput = {
  teamId: string;
  evidenceId: string;
  partId: string | null;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  speakerId: string | null;
  engine: string;
  languageHint: string | null;
  text: string;
  confidence: number | null;
  visibilityScope: TranscriptVisibilityScope;
  redacted: boolean;
};

export type TranscriptSegmentRow = {
  id: string;
  teamId: string;
  evidenceId: string;
  partId: string | null;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  speakerId: string | null;
  engine: string;
  languageHint: string | null;
  text: string;
  confidence: number | null;
  visibilityScope: TranscriptVisibilityScope;
  redacted: boolean;
  indexedAtUtc: string | null;
  extractedAtUtc: string;
};

type RawTranscriptRow = {
  id: string;
  team_id: string;
  evidence_id: string;
  part_id: string | null;
  segment_index: number;
  start_ms: number;
  end_ms: number;
  speaker_id: string | null;
  engine: string;
  language_hint: string | null;
  text: string;
  confidence: number | null;
  visibility_scope: string;
  redacted: boolean;
  indexed_at_utc: Date | null;
  extracted_at_utc: Date;
};

function projectRow(raw: RawTranscriptRow): TranscriptSegmentRow {
  return {
    id: raw.id,
    teamId: raw.team_id,
    evidenceId: raw.evidence_id,
    partId: raw.part_id,
    segmentIndex: raw.segment_index,
    startMs: raw.start_ms,
    endMs: raw.end_ms,
    speakerId: raw.speaker_id,
    engine: raw.engine,
    languageHint: raw.language_hint,
    text: raw.text,
    confidence: raw.confidence,
    visibilityScope: raw.visibility_scope as TranscriptVisibilityScope,
    redacted: raw.redacted,
    indexedAtUtc: raw.indexed_at_utc?.toISOString() ?? null,
    extractedAtUtc: raw.extracted_at_utc.toISOString(),
  };
}

function scrubOverclaim(text: string): { safe: string; scrubbed: boolean } {
  if (!stringContainsForbiddenOverclaim(text)) {
    return { safe: text, scrubbed: false };
  }
  let cleaned = text;
  for (const phrase of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
    const re = new RegExp(phrase, "gi");
    cleaned = cleaned.replace(re, "[redacted]");
  }
  return { safe: cleaned, scrubbed: true };
}

export async function recordTranscriptSegment(
  input: RecordTranscriptSegmentInput,
  client: PrismaClient = defaultPrisma,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!TRANSCRIPT_VISIBILITY_SCOPE_SET.has(input.visibilityScope)) {
    return { ok: false, reason: "visibility_scope_invalid" };
  }
  if (!input.text || input.text.length === 0) {
    return { ok: false, reason: "empty_text" };
  }
  if (input.text.length > MAX_SEGMENT_TEXT_CHARS) {
    return { ok: false, reason: "text_exceeds_segment_bound" };
  }
  if (input.segmentIndex < 0 || !Number.isInteger(input.segmentIndex)) {
    return { ok: false, reason: "segment_index_invalid" };
  }
  if (input.startMs < 0 || input.endMs < input.startMs) {
    return { ok: false, reason: "segment_offsets_invalid" };
  }
  if (
    input.confidence !== null &&
    (input.confidence < 0 || input.confidence > 1)
  ) {
    return { ok: false, reason: "confidence_out_of_range" };
  }

  const { safe, scrubbed } = scrubOverclaim(input.text);
  const redacted = input.redacted || scrubbed;

  try {
    const rows = (await client.$queryRawUnsafe(
      `INSERT INTO "evidence_transcript_segments" (
         "team_id", "evidence_id", "part_id", "segment_index",
         "start_ms", "end_ms", "speaker_id", "engine", "language_hint",
         "text", "confidence", "visibility_scope", "redacted"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (
         "evidence_id",
         COALESCE("part_id", '00000000-0000-0000-0000-000000000000'),
         "segment_index"
       ) DO UPDATE SET
         "start_ms" = EXCLUDED."start_ms",
         "end_ms" = EXCLUDED."end_ms",
         "speaker_id" = EXCLUDED."speaker_id",
         "text" = EXCLUDED."text",
         "confidence" = EXCLUDED."confidence",
         "visibility_scope" = EXCLUDED."visibility_scope",
         "redacted" = EXCLUDED."redacted",
         "engine" = EXCLUDED."engine",
         "language_hint" = EXCLUDED."language_hint",
         "updated_at_utc" = NOW(),
         "indexed_at_utc" = NULL
       RETURNING "id"`,
      input.teamId,
      input.evidenceId,
      input.partId,
      input.segmentIndex,
      input.startMs,
      input.endMs,
      input.speakerId ? input.speakerId.slice(0, 64) : null,
      input.engine.slice(0, 40),
      input.languageHint ? input.languageHint.slice(0, 16) : null,
      safe,
      input.confidence,
      input.visibilityScope,
      redacted,
    )) as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) {
      return { ok: false, reason: "upsert_returned_no_id" };
    }
    bump("search_transcript_segment_recorded_total");
    if (scrubbed) {
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "search_transcript_segment_redacted",
        severity: "INFO",
        details: {
          evidenceId: input.evidenceId,
          segmentIndex: input.segmentIndex,
        },
      });
    }
    return { ok: true, id };
  } catch (err) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "search_transcript_segment_indexing_failed",
      severity: "WARNING",
      details: {
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
    });
    return { ok: false, reason: "db_write_failed" };
  }
}

export async function listTranscriptSegmentsForEvidence(
  input: { teamId: string; evidenceId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<TranscriptSegmentRow>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 2000);
  const raw = (await client.$queryRawUnsafe(
    `SELECT "id", "team_id", "evidence_id", "part_id", "segment_index",
            "start_ms", "end_ms", "speaker_id", "engine", "language_hint",
            "text", "confidence", "visibility_scope", "redacted",
            "indexed_at_utc", "extracted_at_utc"
       FROM "evidence_transcript_segments"
       WHERE "team_id" = $1
         AND "evidence_id" = $2
       ORDER BY "part_id" NULLS FIRST, "segment_index" ASC
       LIMIT $3`,
    input.teamId,
    input.evidenceId,
    limit,
  )) as RawTranscriptRow[];
  return raw.map(projectRow);
}

export type IndexableTranscriptInput = {
  teamId: string;
  evidenceId: string;
  sourceEvidenceIsIndexable: boolean;
};

export async function listIndexableTranscriptText(
  input: IndexableTranscriptInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<string>> {
  if (!input.sourceEvidenceIsIndexable) {
    bump("search_fail_closed_engaged_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "search_fail_closed_engaged",
      severity: "INFO",
      details: {
        evidenceId: input.evidenceId,
        reason: "source_not_indexable",
        surface: "transcript",
      },
    });
    return [];
  }
  const raw = (await client.$queryRawUnsafe(
    `SELECT "text"
       FROM "evidence_transcript_segments"
       WHERE "team_id" = $1
         AND "evidence_id" = $2
         AND "visibility_scope" = 'TEAM'
         AND "redacted" = FALSE
       ORDER BY "part_id" NULLS FIRST, "segment_index" ASC`,
    input.teamId,
    input.evidenceId,
  )) as Array<{ text: string }>;
  return raw.map((r) => r.text);
}

export async function getTranscriptIndexingLagSeconds(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<number | null> {
  const raw = (await client.$queryRawUnsafe(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MIN("extracted_at_utc"))) AS lag_seconds
       FROM "evidence_transcript_segments"
       WHERE "team_id" = $1
         AND "indexed_at_utc" IS NULL`,
    teamId,
  )) as Array<{ lag_seconds: string | null }>;
  const lag = raw[0]?.lag_seconds;
  if (lag === null || lag === undefined) return null;
  const n = Number(lag);
  return Number.isFinite(n) ? n : null;
}
