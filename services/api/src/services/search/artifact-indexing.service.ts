/**
 * Phase SEARCH-REMEDIATION-2 — projection builders for the
 * remaining workspace entities: REPORT / PACKAGE / NOTE.
 *
 * All three write to the same denormalized
 * `evidence_search_documents` table (one row per source row,
 * keyed by `(teamId, documentType, sourceId)`). Same hard rules
 * as the evidence + case indexers:
 *
 *   - Best-effort: failures bump a metric and emit a security
 *     event but never throw to the calling lifecycle path.
 *   - Free-text scrubbed (control chars stripped, max-length
 *     enforced).
 *   - Source-row missing → delete the index row (anti-zombie).
 *   - Strictly workspace-scoped: every projection carries the
 *     evidence's `teamId` (for reports + packages, joined
 *     through `Evidence`) or the comment's own `teamId`. The
 *     `executeSearch` engine filters every query by `teamId`,
 *     so the per-row column is the security boundary.
 *
 * Hooks: see the lifecycle additions in
 *   - services/api/src/services/evidence-finalization-fanout.service.ts
 *     (report + package — both fire on evidence finalize via the
 *      existing fanout; we ride on the same hook here)
 *   - services/api/src/routes/case-workspace.routes.ts
 *     (note add + note delete)
 */

import type { PrismaClient } from "@prisma/client";
import type * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { extractPrismaErrorDetail } from "./evidence-indexing.service.js";

const MAX_TITLE = 200;
const MAX_SUBTITLE = 200;
const MAX_SUMMARY = 400;
const MAX_BODY = 16 * 1024;

function clip(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const t = String(s).replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, " ").trim();
  if (t.length === 0) return null;
  if (t.length <= max) return t;
  return t.slice(0, Math.max(1, max - 1)) + "…";
}

export type IndexArtifactResult =
  | { ok: true; documentId: string; created: boolean }
  | {
      ok: false;
      reason: string;
      // Same Prisma-error pass-through as IndexResult — surface
      // error.code / error.meta / error.message instead of
      // collapsing to "upsert_failed", so the CLI + reconcile route
      // can tell the operator which column failed.
      prismaCode?: string;
      prismaMeta?: Record<string, unknown>;
      prismaMessage?: string;
    };

// ----------------------------------------------------------------------------
// REPORT
// ----------------------------------------------------------------------------

export type IndexReportInput = { reportId: string };

export async function indexReport(
  input: IndexReportInput,
  client: PrismaClient = defaultPrisma,
): Promise<IndexArtifactResult> {
  let row;
  try {
    row = await client.report.findUnique({
      where: { id: input.reportId },
      select: {
        id: true,
        evidenceId: true,
        version: true,
        displayTitleSnapshot: true,
        displayDescriptionSnapshot: true,
        generatedAtUtc: true,
        verificationStatusSnapshot: true,
        evidence: {
          select: {
            teamId: true,
            caseId: true,
            title: true,
            displayFileName: true,
            originalFileName: true,
            deletedAt: true,
          },
        },
      },
    });
  } catch {
    return { ok: false, reason: "report_load_failed" };
  }
  if (!row) return await deleteByKey(client, "REPORT", input.reportId);
  if (!row.evidence?.teamId) {
    return { ok: false, reason: "report_team_missing" };
  }
  // Skip indexing reports whose evidence has been deleted (defense
  // in depth: the search engine wouldn't surface them anyway).
  if (row.evidence.deletedAt) {
    await client.evidenceSearchDocument.deleteMany({
      where: {
        teamId: row.evidence.teamId,
        documentType: "REPORT",
        sourceId: row.id,
      },
    });
    return { ok: false, reason: "report_evidence_deleted" };
  }

  const titleSource =
    row.displayTitleSnapshot ??
    row.evidence.title ??
    row.evidence.displayFileName ??
    row.evidence.originalFileName ??
    `Report v${row.version}`;
  const title = clip(titleSource, MAX_TITLE) ?? `Report v${row.version}`;
  const subtitle = clip(`Report · v${row.version}`, MAX_SUBTITLE);
  const summary = clip(row.displayDescriptionSnapshot, MAX_SUMMARY);
  const searchableText = clip(
    [
      row.displayTitleSnapshot ?? "",
      row.displayDescriptionSnapshot ?? "",
      row.evidence.title ?? "",
      row.evidence.displayFileName ?? "",
      row.evidence.originalFileName ?? "",
    ]
      .filter((s) => s.length > 0)
      .join("\n"),
    MAX_BODY,
  );

  return await upsert(client, {
    teamId: row.evidence.teamId,
    documentType: "REPORT",
    sourceId: row.id,
    title,
    subtitle,
    summary,
    searchableText,
    evidenceId: row.evidence ? row.evidenceId : null,
    caseId: row.evidence.caseId ?? null,
    workflowState: row.verificationStatusSnapshot ?? null,
    metadata: {
      reportVersion: row.version,
      generatedAtUtc: row.generatedAtUtc.toISOString(),
    },
    tags: ["report"],
    sourceUpdatedAtUtc: row.generatedAtUtc,
  });
}

// ----------------------------------------------------------------------------
// PACKAGE
// ----------------------------------------------------------------------------

export type IndexPackageInput = { packageId: string };

export async function indexPackage(
  input: IndexPackageInput,
  client: PrismaClient = defaultPrisma,
): Promise<IndexArtifactResult> {
  let row;
  try {
    row = await client.verificationPackage.findUnique({
      where: { id: input.packageId },
      select: {
        id: true,
        evidenceId: true,
        version: true,
        packageType: true,
        generatedAtUtc: true,
        evidence: {
          select: {
            teamId: true,
            caseId: true,
            title: true,
            displayFileName: true,
            originalFileName: true,
            deletedAt: true,
          },
        },
      },
    });
  } catch {
    return { ok: false, reason: "package_load_failed" };
  }
  if (!row) return await deleteByKey(client, "PACKAGE", input.packageId);
  if (!row.evidence?.teamId) {
    return { ok: false, reason: "package_team_missing" };
  }
  if (row.evidence.deletedAt) {
    await client.evidenceSearchDocument.deleteMany({
      where: {
        teamId: row.evidence.teamId,
        documentType: "PACKAGE",
        sourceId: row.id,
      },
    });
    return { ok: false, reason: "package_evidence_deleted" };
  }

  // Phase SEARCH-REMEDIATION-2 — packages don't have a `title`
  // column; we synthesise a meaningful display name from the
  // backing evidence's filename + the package version. So
  // searching "v1(9).pdf" still hits the package, and searching
  // "verification package v2" also works.
  const evidenceName =
    row.evidence.title ??
    row.evidence.displayFileName ??
    row.evidence.originalFileName ??
    "(unnamed evidence)";
  const title = clip(`${evidenceName} — Verification Package v${row.version}`, MAX_TITLE) ?? "Verification Package";
  const subtitle = clip(
    row.packageType
      ? `Package · ${row.packageType} · v${row.version}`
      : `Package · v${row.version}`,
    MAX_SUBTITLE,
  );
  const searchableText = clip(
    [
      "verification package",
      evidenceName,
      `v${row.version}`,
      row.packageType ?? "",
    ]
      .filter((s) => s.length > 0)
      .join("\n"),
    MAX_BODY,
  );

  return await upsert(client, {
    teamId: row.evidence.teamId,
    documentType: "PACKAGE",
    sourceId: row.id,
    title,
    subtitle,
    summary: null,
    searchableText,
    evidenceId: row.evidenceId,
    caseId: row.evidence.caseId ?? null,
    workflowState: null,
    metadata: {
      packageVersion: row.version,
      packageType: row.packageType,
      generatedAtUtc: row.generatedAtUtc.toISOString(),
    },
    tags: ["package", row.packageType ?? "verification"].filter(Boolean),
    sourceUpdatedAtUtc: row.generatedAtUtc,
  });
}

// ----------------------------------------------------------------------------
// NOTE (case comment)
// ----------------------------------------------------------------------------

export type IndexNoteInput = { noteId: string };

export async function indexNote(
  input: IndexNoteInput,
  client: PrismaClient = defaultPrisma,
): Promise<IndexArtifactResult> {
  let row;
  try {
    row = await client.caseComment.findUnique({
      where: { id: input.noteId },
      select: {
        id: true,
        teamId: true,
        caseId: true,
        body: true,
        visibility: true,
        resolvedAtUtc: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch {
    return { ok: false, reason: "note_load_failed" };
  }
  if (!row) {
    // We don't know the teamId, so try to delete across the whole
    // table — there will be at most one row for this sourceId.
    try {
      await client.evidenceSearchDocument.deleteMany({
        where: { documentType: "NOTE", sourceId: input.noteId },
      });
    } catch {
      /* non-fatal */
    }
    return { ok: false, reason: "note_not_found" };
  }
  if (!row.teamId) return { ok: false, reason: "note_team_missing" };

  // Notes don't have a separate title. First-sentence-ish snippet
  // is the display title; the full body goes into searchableText.
  const firstLine = row.body.split(/\r?\n/, 1)[0] ?? row.body;
  const title = clip(firstLine, MAX_TITLE) ?? "Note";
  const subtitle = clip(
    row.resolvedAtUtc ? "Note · Resolved" : "Note",
    MAX_SUBTITLE,
  );
  const searchableText = clip(row.body, MAX_BODY);

  return await upsert(client, {
    teamId: row.teamId,
    documentType: "NOTE",
    sourceId: row.id,
    title,
    subtitle,
    summary: null,
    searchableText,
    evidenceId: null,
    caseId: row.caseId,
    workflowState: row.resolvedAtUtc ? "RESOLVED" : "OPEN",
    metadata: { visibility: row.visibility },
    tags: ["note", row.resolvedAtUtc ? "resolved" : "open"],
    sourceUpdatedAtUtc: row.updatedAt,
  });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

type UpsertInput = {
  teamId: string;
  documentType: "REPORT" | "PACKAGE" | "NOTE";
  sourceId: string;
  title: string;
  subtitle: string | null;
  summary: string | null;
  searchableText: string | null;
  evidenceId: string | null;
  caseId: string | null;
  workflowState: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  sourceUpdatedAtUtc: Date;
};

async function upsert(
  client: PrismaClient,
  input: UpsertInput,
): Promise<IndexArtifactResult> {
  try {
    const data = {
      title: input.title,
      subtitle: input.subtitle,
      summary: input.summary,
      searchableText: input.searchableText,
      searchableMetadataJson: input.metadata as prismaPkg.Prisma.InputJsonValue,
      searchableTagsJson: input.tags as prismaPkg.Prisma.InputJsonValue,
      visibilityScopeJson: undefined,
      governanceScopeJson: undefined,
      reviewState: null,
      workflowState: input.workflowState,
      exportState: null,
      retentionState: null,
      legalHoldState: null,
      contributorScoped: false,
      reviewerRestricted: false,
      evidenceId: input.evidenceId,
      workflowInstanceId: null,
      workflowStepInstanceId: null,
      caseId: input.caseId,
      claimRef: null,
      matterRef: null,
      sourceUpdatedAtUtc: input.sourceUpdatedAtUtc,
    };
    const existing = await client.evidenceSearchDocument.findUnique({
      where: {
        teamId_documentType_sourceId: {
          teamId: input.teamId,
          documentType: input.documentType,
          sourceId: input.sourceId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      const row = await client.evidenceSearchDocument.update({
        where: { id: existing.id },
        data,
      });
      return { ok: true, documentId: row.id, created: false };
    }
    const row = await client.evidenceSearchDocument.create({
      data: {
        teamId: input.teamId,
        documentType: input.documentType,
        sourceId: input.sourceId,
        ...data,
      },
    });
    return { ok: true, documentId: row.id, created: true };
  } catch (err) {
    bump("search_indexing_failed_total");
    const detail = extractPrismaErrorDetail(err);
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "search_indexing_drift_detected",
      severity: "WARNING",
      details: {
        reason: detail.prismaMessage?.slice(0, 200) ?? "unknown",
        prismaCode: detail.prismaCode ?? null,
        prismaMeta: detail.prismaMeta ?? null,
        documentType: input.documentType,
        sourceId: input.sourceId,
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

async function deleteByKey(
  client: PrismaClient,
  documentType: "REPORT" | "PACKAGE",
  sourceId: string,
): Promise<IndexArtifactResult> {
  try {
    await client.evidenceSearchDocument.deleteMany({
      where: { documentType, sourceId },
    });
  } catch {
    /* non-fatal */
  }
  return { ok: false, reason: `${documentType.toLowerCase()}_not_found` };
}
