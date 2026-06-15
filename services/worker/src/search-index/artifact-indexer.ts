/**
 * Phase SEARCH-REMEDIATION-CI-FIX — worker-local mirror of the
 * Report / Package projection writers.
 *
 * Why this exists as a worker-local file instead of an import from
 * `services/api/src`:
 *
 *   - The worker's tsconfig.build.json rootDir is
 *     `services/worker/src`, so `../../api/src/...` imports both
 *     fail TS resolution AND would never be packaged into the
 *     worker container (the Dockerfile only copies the worker
 *     subtree). This is the same pattern used by
 *     `provenance-projection.ts`, `governance/notification-
 *     emitter.ts`, `object-lock-bootstrap.ts`, and `otel.ts` —
 *     small, self-contained mirrors kept tightly scoped to the
 *     worker's needs.
 *
 *   - The full API service (`services/api/src/services/search/
 *     artifact-indexing.service.ts`) has wider responsibilities:
 *     it covers Report + Package + Note, emits security events
 *     through the API's `safeEmitSecurityEvent`, and increments
 *     API-only metrics. The worker only needs Report + Package
 *     finalization indexing, and it has its own logger + Prisma
 *     client — so this mirror is intentionally minimal.
 *
 * Hard invariants (same as the API service):
 *
 *   - Best-effort: every failure is caught and logged via the
 *     worker's existing logger. NEVER throw to the caller — the
 *     report/package generation pipeline must stay green even if
 *     the search index is unavailable.
 *   - Upsert by `(teamId, documentType, sourceId)` so re-running
 *     this for the same (evidenceId, version) is a no-op.
 *   - Strictly workspace-scoped: every projection row carries the
 *     evidence's `teamId`. The search engine filters every query
 *     by `teamId`, so the per-row column is the security boundary.
 *   - The shape of the `evidence_search_documents` row written
 *     here MUST stay byte-equal to what the API service writes
 *     for the same source row — the API's
 *     `POST /v1/search/reconcile` endpoint and the
 *     `scripts/backfill-search-index.ts` script overwrite via the
 *     same upsert key, and a drifted column would cause flapping
 *     row updates.
 */

import type { PrismaClient } from "@prisma/client";
import type * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../db.js";
import { logger } from "../logger.js";

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
  | { ok: false; reason: string };

/**
 * Index a Report row into `evidence_search_documents`.
 * Mirrors the API's `indexReport` from
 * `services/api/src/services/search/artifact-indexing.service.ts`.
 */
export async function indexReport(
  input: { reportId: string },
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
  } catch (err) {
    logger.warn(
      {
        reportId: input.reportId,
        err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      "worker.search_index.report_load_failed",
    );
    return { ok: false, reason: "report_load_failed" };
  }
  if (!row) return { ok: false, reason: "report_not_found" };
  if (!row.evidence?.teamId) {
    return { ok: false, reason: "report_team_missing" };
  }
  if (row.evidence.deletedAt) {
    try {
      await client.evidenceSearchDocument.deleteMany({
        where: {
          teamId: row.evidence.teamId,
          documentType: "REPORT",
          sourceId: row.id,
        },
      });
    } catch {
      /* non-fatal */
    }
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

  return upsert(client, {
    teamId: row.evidence.teamId,
    documentType: "REPORT",
    sourceId: row.id,
    title,
    subtitle,
    summary,
    searchableText,
    evidenceId: row.evidenceId,
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

/**
 * Index a VerificationPackage row into `evidence_search_documents`.
 * Mirrors the API's `indexPackage`.
 */
export async function indexPackage(
  input: { packageId: string },
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
  } catch (err) {
    logger.warn(
      {
        packageId: input.packageId,
        err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      "worker.search_index.package_load_failed",
    );
    return { ok: false, reason: "package_load_failed" };
  }
  if (!row) return { ok: false, reason: "package_not_found" };
  if (!row.evidence?.teamId) {
    return { ok: false, reason: "package_team_missing" };
  }
  if (row.evidence.deletedAt) {
    try {
      await client.evidenceSearchDocument.deleteMany({
        where: {
          teamId: row.evidence.teamId,
          documentType: "PACKAGE",
          sourceId: row.id,
        },
      });
    } catch {
      /* non-fatal */
    }
    return { ok: false, reason: "package_evidence_deleted" };
  }

  const evidenceName =
    row.evidence.title ??
    row.evidence.displayFileName ??
    row.evidence.originalFileName ??
    "(unnamed evidence)";
  const title =
    clip(
      `${evidenceName} — Verification Package v${row.version}`,
      MAX_TITLE,
    ) ?? "Verification Package";
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

  return upsert(client, {
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

type UpsertInput = {
  teamId: string;
  documentType: "REPORT" | "PACKAGE";
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
      const updated = await client.evidenceSearchDocument.update({
        where: { id: existing.id },
        data,
      });
      return { ok: true, documentId: updated.id, created: false };
    }
    const created = await client.evidenceSearchDocument.create({
      data: {
        teamId: input.teamId,
        documentType: input.documentType,
        sourceId: input.sourceId,
        ...data,
      },
    });
    return { ok: true, documentId: created.id, created: true };
  } catch (err) {
    logger.warn(
      {
        documentType: input.documentType,
        sourceId: input.sourceId,
        err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      "worker.search_index.upsert_failed",
    );
    return {
      ok: false,
      reason: err instanceof Error ? err.message.slice(0, 200) : "upsert_failed",
    };
  }
}
