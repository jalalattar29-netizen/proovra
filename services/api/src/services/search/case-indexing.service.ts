/**
 * Phase SEARCH-REMEDIATION — Case search projection.
 *
 * Mirrors the shape of evidence-indexing.service.ts but for Case
 * rows. Writes one `evidence_search_documents` row per Case with
 * `documentType = "CASE"` so:
 *
 *   - Searching for "acme" finds the case named "Acme deposition".
 *   - Searching for the case's reference number finds it.
 *   - Filtering by documentType=CASE returns only cases.
 *
 * Same hard rules as the evidence indexer:
 *   - Upsert by (teamId, documentType, sourceId) — idempotent.
 *   - Best-effort: failures bump a metric and emit a security event
 *     but never throw to the calling lifecycle path.
 *   - Free-text body runs through the shared scrubber.
 *   - Deleted / non-team cases delete-from-index.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { collapseControlCharacters } from "../../lib/text-sanitize.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { extractPrismaErrorDetail } from "./evidence-indexing.service.js";

export type IndexCaseInput = {
  teamId: string;
  caseId: string;
};

export type IndexCaseResult =
  | { ok: true; documentId: string; created: boolean }
  | {
      ok: false;
      reason: string;
      prismaCode?: string;
      prismaMeta?: Record<string, unknown>;
      prismaMessage?: string;
    };

const MAX_TITLE = 200;
const MAX_SUBTITLE = 200;
const MAX_SUMMARY = 400;
const MAX_BODY = 16 * 1024;

function clip(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const t = collapseControlCharacters(String(s), { keep: [0x09, 0x0a] });
  if (t.length === 0) return null;
  if (t.length <= max) return t;
  return t.slice(0, Math.max(1, max - 1)) + "…";
}

const CASE_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  INVESTIGATING: "Investigating",
  ON_HOLD: "On hold",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

export async function indexCase(
  input: IndexCaseInput,
  client: PrismaClient = defaultPrisma,
): Promise<IndexCaseResult> {
  let caseRow: prismaPkg.Case | null;
  try {
    caseRow = await client.case.findFirst({
      where: { id: input.caseId, teamId: input.teamId },
    });
  } catch {
    return { ok: false, reason: "case_load_failed" };
  }
  if (!caseRow) {
    // Source row missing or team mismatch — delete any stale index row.
    try {
      await client.evidenceSearchDocument.deleteMany({
        where: {
          teamId: input.teamId,
          documentType: "CASE",
          sourceId: input.caseId,
        },
      });
    } catch {
      /* non-fatal */
    }
    return { ok: false, reason: "case_not_found" };
  }
  if (!caseRow.teamId) {
    return { ok: false, reason: "case_team_missing" };
  }

  const title = clip(caseRow.name, MAX_TITLE) ?? "(unnamed case)";
  const subtitle = clip(
    CASE_STATUS_LABEL[caseRow.status] ?? caseRow.status,
    MAX_SUBTITLE,
  );
  const summary = clip(
    caseRow.referenceNumber
      ? `Reference ${caseRow.referenceNumber}`
      : caseRow.description ?? null,
    MAX_SUMMARY,
  );
  const bodyParts = [
    caseRow.name ?? "",
    caseRow.referenceNumber ?? "",
    caseRow.description ?? "",
  ].filter((s) => s.length > 0);
  const searchableText = clip(bodyParts.join("\n"), MAX_BODY);

  // Pull a short list of linked-case-comment bodies so a user can
  // search for words inside their notes (e.g. "depot"). Bounded.
  try {
    const comments = await client.caseComment.findMany({
      where: { caseId: caseRow.id },
      select: { body: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    if (comments.length > 0) {
      const noteText = comments
        .map((c) => (c.body ?? "").slice(0, 400))
        .filter((s) => s.length > 0)
        .join("\n");
      if (noteText.length > 0) {
        const combined =
          (searchableText ?? "") + (searchableText ? "\n" : "") + noteText;
        return await upsert(client, input.teamId, caseRow, {
          title,
          subtitle,
          summary,
          searchableText: clip(combined, MAX_BODY),
        });
      }
    }
  } catch {
    /* notes are best-effort */
  }

  return await upsert(client, input.teamId, caseRow, {
    title,
    subtitle,
    summary,
    searchableText,
  });
}

async function upsert(
  client: PrismaClient,
  teamId: string,
  caseRow: prismaPkg.Case,
  fields: {
    title: string;
    subtitle: string | null;
    summary: string | null;
    searchableText: string | null;
  },
): Promise<IndexCaseResult> {
  try {
    const existing = await client.evidenceSearchDocument.findUnique({
      where: {
        teamId_documentType_sourceId: {
          teamId,
          documentType: "CASE",
          sourceId: caseRow.id,
        },
      },
      select: { id: true },
    });
    const data = {
      title: fields.title,
      subtitle: fields.subtitle,
      summary: fields.summary,
      searchableText: fields.searchableText,
      searchableMetadataJson: {
        status: caseRow.status,
        priority: caseRow.priority,
        referenceNumber: caseRow.referenceNumber,
      },
      searchableTagsJson: [
        "case",
        caseRow.status.toLowerCase(),
        caseRow.priority.toLowerCase(),
      ],
      visibilityScopeJson: { ownerUserId: caseRow.ownerUserId },
      governanceScopeJson: { status: caseRow.status },
      reviewState: null,
      workflowState: caseRow.status,
      exportState: null,
      retentionState: null,
      legalHoldState: null,
      contributorScoped: false,
      reviewerRestricted: false,
      evidenceId: null,
      workflowInstanceId: null,
      workflowStepInstanceId: null,
      caseId: caseRow.id,
      claimRef: null,
      matterRef: caseRow.referenceNumber,
      sourceUpdatedAtUtc: caseRow.updatedAt,
    };
    if (existing) {
      const row = await client.evidenceSearchDocument.update({
        where: { id: existing.id },
        data,
      });
      return { ok: true, documentId: row.id, created: false };
    }
    const row = await client.evidenceSearchDocument.create({
      data: {
        teamId,
        documentType: "CASE",
        sourceId: caseRow.id,
        ...data,
      },
    });
    return { ok: true, documentId: row.id, created: true };
  } catch (err) {
    bump("search_indexing_failed_total");
    const detail = extractPrismaErrorDetail(err);
    safeEmitSecurityEvent({
      teamId,
      eventType: "search_indexing_drift_detected",
      severity: "WARNING",
      details: {
        reason: detail.prismaMessage?.slice(0, 200) ?? "unknown",
        prismaCode: detail.prismaCode ?? null,
        prismaMeta: detail.prismaMeta ?? null,
        documentType: "CASE",
        sourceId: caseRow.id,
      },
    });
    return {
      ok: false,
      reason: detail.prismaMessage
        ? detail.prismaMessage.slice(0, 200)
        : "upsert_failed",
      prismaCode: detail.prismaCode,
      prismaMeta: detail.prismaMeta,
      prismaMessage: detail.prismaMessage,
    };
  }
}
