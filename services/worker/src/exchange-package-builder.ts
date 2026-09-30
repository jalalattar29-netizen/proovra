/**
 * PROOVRA Phase 4B Final Closure — C5: Exchange Package Builder Worker.
 *
 * buildExchangePackage(packageId):
 *   1. Loads EvidenceExchangePackage row (workspace-anchored).
 *   2. Upserts EvidenceExchangePackageBuild row state=BUILDING via raw SQL
 *      (model not yet promoted into the Prisma-generated client).
 *   3. Streams a ZIP using archiver (same lib as verification-package.ts — no
 *      new deps).
 *   4. Per-kind content per KIND_CONTENT_MAP below.
 *   5. Caps at MAX_EVIDENCE_PER_PACKAGE; sets manifest.limited=true when exceeded.
 *   6. Uploads ZIP to S3 at "exchange-packages/<teamId>/<packageId>/<attempt>.zip"
 *      (ET-SEC-27: attempt-scoped, so a late builder never overwrites the
 *      object a winner committed READY with its sha).
 *   7. Computes streaming SHA-256 of final buffer.
 *   8. Updates EvidenceExchangePackage → state=READY + storageKey + sha256 + sizeBytes.
 *   9. Updates EvidenceExchangePackageBuild → state=UPLOADED via raw SQL.
 *  10. On failure: marks both rows FAILED; never rethrows (loop stays alive).
 *
 * KIND_CONTENT_MAP (per-kind zip paths):
 *   ALL kinds:
 *     package-manifest.json          — schema, kind, evidenceIds, limited flag
 *     package-checksums.json         — SHA-256 per file
 *     lifecycle/*                    — buildLifecycleAndExchangeManifests
 *
 *   EVIDENCE:
 *     evidence/<id>/metadata.json    — title, type, sha256, captureMethod
 *     evidence/<id>/custody-chain.json — CustodyEvent rows ordered by sequence
 *
 *   CASE:
 *     cases/<caseId>/metadata.json   — evidenceIds + count
 *     reviews/<eid>/workflows.json   — EvidenceReviewWorkflow rows
 *     redactions/<eid>/projects.json — RedactionProject rows
 *
 *   REVIEW:
 *     reviews/<eid>/workflows.json   — EvidenceReviewWorkflow rows
 *
 *   REDACTION:
 *     redactions/<eid>/projects.json — RedactionProject rows
 *
 *   INTELLIGENCE:
 *     intelligence/<eid>/metadata.json — EvidenceIntelligenceJob latest row
 *
 *   GOVERNANCE:
 *     governance/governance-manifest.json — active retention policies + legal hold count
 *
 *   AUDIT:
 *     audit/audit-manifest.json      — custody event counts + note
 *
 *   VERIFICATION:
 *     verification/<eid>/metadata.json — verificationStatus + fileSha256
 *
 *   REPORT:
 *     reports/<eid>/metadata.json    — latest Report version row
 *
 * pollExchangePackageBuilds():
 *   Polls state=BUILDING packages every 10s; dispatches up to 2 concurrent builds.
 *   One failure never breaks the loop.
 */

import archiver from "archiver";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db.js";
import { deleteObject, putObjectBuffer } from "./storage.js";
import { env } from "./config.js";
import { buildLifecycleAndExchangeManifests } from "./verification-package-lifecycle.js";
import { logger } from "./logger.js";
// The ONE export-package meter writer, shared with the API's completion route.
import { recordExportPackageUsage, workspaceEvidenceWhere } from "@proovra/shared-runtime";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * That check exists because the weaker one — "the declared file exists" —
 * passed three false declarations in a row: UPGRADE_OTS and
 * PURGE_DELETED_EVIDENCE both named a module containing no such code, and
 * EMBED_SEMANTIC_CHUNKS named one whose every scan keyed on a table the embed
 * chain never writes. All three resolved to a real file. None of them was true.
 *
 * Keys, not values: the registry addresses work through `JOB_NAMES` /
 * `SWEEP_NAMES`, and a literal string here would be a second spelling of a
 * name the shared authority already owns.
 */
export const RECOVERED_WORK_TYPES = [
  "EXCHANGE_PACKAGE_BUILDER",
] as const;


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVIDENCE_PER_PACKAGE = 1000;
const MAX_CONCURRENT_BUILDS = 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PackageEntry = { name: string; buffer: Buffer; contentType?: string };

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function appendEntry(
  archive: archiver.Archiver,
  entries: PackageEntry[],
  name: string,
  buffer: Buffer,
  contentType?: string,
): void {
  entries.push(contentType ? { name, buffer, contentType } : { name, buffer });
  archive.append(buffer, { name });
}

function buildPackageChecksums(entries: PackageEntry[]): unknown {
  return {
    schema: "PROOVRA_EXCHANGE_PACKAGE_CHECKSUMS",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    algorithm: "SHA-256",
    fileCount: entries.length,
    files: entries
      .map((e) => ({
        path: e.name,
        sizeBytes: e.buffer.length,
        sha256: sha256Hex(e.buffer),
        contentType: e.contentType ?? null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

// ---------------------------------------------------------------------------
// Build tracker via raw SQL (EvidenceExchangePackageBuild not yet in
// the Prisma generated client — schema row exists but client not regenerated)
// ---------------------------------------------------------------------------

/**
 * How long a claimed build may run before another instance may take it over.
 *
 * A package build is a ZIP assembled in memory and uploaded; thirty minutes is
 * far past any legitimate run, so a row still BUILDING after that had its
 * worker die.
 */
export const EXCHANGE_BUILD_LEASE_MS = 30 * 60 * 1000;

/**
 * PHASE 12 POINT 5 — take exclusive ownership of one package build.
 *
 * The poller's only concurrency control was `_inFlight`, an in-process `Set`.
 * That is not a claim: it is per-PROCESS, so two worker instances each held
 * their own empty set, both selected the same BUILDING package, and both
 * assembled the ZIP, both uploaded it to object storage and both wrote a
 * terminal state — duplicate artifact bytes, duplicate storage cost, and a
 * `payload_sha256` recorded by whichever finished last.
 *
 * The arbiter is now the database, via the existing UNIQUE on `package_id`:
 * the conditional `ON CONFLICT ... DO UPDATE ... WHERE` updates zero rows when
 * another instance holds a LIVE claim, and one row when the slot is free or
 * the previous holder's lease has expired.
 *
 * Returns `true` when this caller owns the build.
 */
async function claimPackageBuild(
  prisma: PrismaClient,
  packageId: string,
  teamId: string,
): Promise<Date | null> {
  const leaseCutoff = new Date(Date.now() - EXCHANGE_BUILD_LEASE_MS);
  // ET-SEC-27 — the claim's started_at_utc is this attempt's FENCING TOKEN: a
  // re-claim is only possible after the lease expired, so the value names one
  // attempt, and every later write of this attempt is conditional on it.
  const attemptAt = new Date();
  const claimed = await prisma.$executeRaw`
    INSERT INTO evidence_exchange_package_builds
      (id, team_id, package_id, state, started_at_utc, created_at)
    VALUES
      (${randomUUID()}, ${teamId}::uuid, ${packageId}::uuid, 'BUILDING', ${attemptAt}, NOW())
    ON CONFLICT (package_id) DO UPDATE
      SET state = 'BUILDING',
          started_at_utc = ${attemptAt},
          failure_reason = NULL
      WHERE evidence_exchange_package_builds.state <> 'BUILDING'
         OR evidence_exchange_package_builds.started_at_utc IS NULL
         OR evidence_exchange_package_builds.started_at_utc < ${leaseCutoff}
  `;
  return claimed === 1 ? attemptAt : null;
}

/**
 * ET-SEC-27 — true while THIS attempt still owns the build (nobody re-claimed
 * it after its lease expired). Taken with FOR UPDATE inside the READY
 * transaction so the ownership read and the commit are one decision.
 */
async function attemptStillOwnsBuild(
  tx: Pick<PrismaClient, "$queryRaw">,
  packageId: string,
  attemptAt: Date,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM evidence_exchange_package_builds
     WHERE package_id = ${packageId}::uuid
       AND state = 'BUILDING'
       AND started_at_utc = ${attemptAt}
     FOR UPDATE
  `;
  return rows.length === 1;
}

async function upsertBuildRow(
  prisma: PrismaClient,
  packageId: string,
  teamId: string,
  state: "BUILDING" | "UPLOADED" | "FAILED",
  extra?: {
    storageKey?: string;
    payloadSha256?: string;
    sizeBytes?: bigint;
    failureReason?: string;
    completedAtUtc?: Date;
    /** ET-SEC-27 — the claiming attempt; UPLOADED / FAILED are fenced by it. */
    attemptAt?: Date;
  },
): Promise<void> {
  try {
    if (state === "BUILDING") {
      // Kept for callers that only need the row to exist. The CLAIM is
      // `claimPackageBuild` below; this path is not one.
      await prisma.$executeRaw`
        INSERT INTO evidence_exchange_package_builds
          (id, team_id, package_id, state, started_at_utc, created_at)
        VALUES
          (${randomUUID()}, ${teamId}::uuid, ${packageId}, 'BUILDING', NOW(), NOW())
        ON CONFLICT (package_id) DO UPDATE
          SET state = 'BUILDING',
              started_at_utc = NOW(),
              failure_reason = NULL
      `;
    } else if (state === "UPLOADED") {
      // ET-SEC-27 — fenced by the attempt that claimed the build.
      await prisma.$executeRaw`
        UPDATE evidence_exchange_package_builds
        SET state = 'UPLOADED',
            completed_at_utc = ${extra?.completedAtUtc ?? new Date()},
            storage_key = ${extra?.storageKey ?? null},
            payload_sha256 = ${extra?.payloadSha256 ?? null},
            size_bytes = ${extra?.sizeBytes !== undefined ? String(extra.sizeBytes) : null}::bigint,
            failure_reason = NULL
        WHERE package_id = ${packageId}
          AND started_at_utc = ${extra?.attemptAt ?? null}
      `;
    } else if (state === "FAILED") {
      // ET-SEC-27 — a late attempt's failure never marks the live build FAILED.
      await prisma.$executeRaw`
        UPDATE evidence_exchange_package_builds
        SET state = 'FAILED',
            completed_at_utc = NOW(),
            failure_reason = ${(extra?.failureReason ?? "").slice(0, 590)}
        WHERE package_id = ${packageId}
          AND started_at_utc = ${extra?.attemptAt ?? null}
      `;
    }
  } catch {
    // Build tracker is advisory — never fail the main operation.
  }
}

// ---------------------------------------------------------------------------
// Per-kind content loader
// ---------------------------------------------------------------------------

async function appendKindContent(params: {
  prisma: PrismaClient;
  archive: archiver.Archiver;
  entries: PackageEntry[];
  kind: string;
  teamId: string;
  evidenceIds: string[];
  caseId: string | null;
  /**
   * Phase 6 — per-evidence template-identity provenance, resolved once
   * by the caller. Used to enrich per-evidence metadata.json with the
   * trio. Missing entries surface as NULL members.
   */
  provenanceByEvidenceId?: Map<string, TemplateProvenance>;
}): Promise<void> {
  const { prisma, archive, entries, kind, teamId, evidenceIds, caseId } = params;
  const provenanceByEvidenceId =
    params.provenanceByEvidenceId ?? new Map<string, TemplateProvenance>();

  /*
   * TENANT BOUND AT THE SOURCE (2026-09-29).
   *
   * The ids come from the package row, which came from a request body. Some
   * kinds filtered by team per lookup; the REPORT kind did not, so another
   * tenant's report id, version and issue time could be exported by naming its
   * evidence id, and the AUDIT kind echoed ids verbatim. Every kind now reads
   * only ids that belong to THIS workspace.
   */
  const requestedIds = evidenceIds.slice(0, MAX_EVIDENCE_PER_PACKAGE);
  // The canonical workspace scope (a personal workspace's records may carry
  // team_id NULL), never a bare teamId.
  const workspaceScope = await workspaceEvidenceWhere(teamId, prisma);
  const ownedIds = new Set(
    (
      await prisma.evidence.findMany({
        where: { AND: [{ id: { in: requestedIds } }, workspaceScope] },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const safeIds = requestedIds.filter((id) => ownedIds.has(id));
  /*
   * EVERY ITEM READS THROUGH THE SAME SCOPE (2026-09-29). The id gate above
   * used the canonical scope, but each kind then re-read with a bare
   * `teamId`, so a Personal record stored with team_id NULL passed the gate
   * and silently vanished from the ZIP. Evidence reads use the workspace
   * scope; rows that hang off an in-scope record are bound by that record
   * (evidenceId) and may carry this workspace or none — never another one.
   */
  const inScope = (eid: string): Prisma.EvidenceWhereInput => ({ AND: [{ id: eid }, workspaceScope] });
  // Redaction projects and intelligence jobs always carry their workspace id
  // (a Personal workspace's own team id); review workflows may carry none.
  const childOf = (eid: string) => ({ evidenceId: eid, teamId });
  const reviewOf = (eid: string): Prisma.EvidenceReviewWorkflowWhereInput => ({
    evidenceId: eid,
    OR: [{ teamId }, { teamId: null }],
  });

  switch (kind) {
    case "EVIDENCE": {
      for (const eid of safeIds) {
        try {
          const ev = await prisma.evidence.findFirst({
            where: inScope(eid),
            select: {
              id: true,
              title: true,
              type: true,
              status: true,
              mimeType: true,
              sizeBytes: true,
              fileSha256: true,
              captureMethod: true,
              originalFileName: true,
              createdAt: true,
            },
          });
          if (!ev) continue;
          // Phase 6 — per-evidence template-identity provenance. NULL
          // members on legacy rows are surfaced as-is.
          const evidenceProvenance: TemplateProvenance =
            provenanceByEvidenceId.get(eid) ?? {
              templateSlug: null,
              templateVersion: null,
              templateDbId: null,
            };
          appendEntry(
            archive,
            entries,
            `evidence/${eid}/metadata.json`,
            jsonBuffer({
              evidenceId: ev.id,
              title: ev.title ?? null,
              type: ev.type,
              status: ev.status,
              mimeType: ev.mimeType ?? null,
              sizeBytes: ev.sizeBytes !== null ? Number(ev.sizeBytes) : null,
              fileSha256: ev.fileSha256 ?? null,
              captureMethod: ev.captureMethod ?? null,
              originalFileName: ev.originalFileName ?? null,
              createdAt: ev.createdAt.toISOString(),
              // Phase 6 — surface template-identity trio in
              // per-evidence metadata for downstream traceability.
              provenance: evidenceProvenance,
            }),
            "application/json",
          );

          // ET-CUS-09: the COMPLETE chain with every payload exactly as
          // hashed, so a recipient can recompute each eventHash (the formula is
          // stated in the file). It used to omit payloads, stop at 500 events,
          // and turn a database error into an empty chain; a read failure now
          // fails the package instead of shipping a chain that is not one.
          const custody = await prisma.custodyEvent.findMany({
            where: { evidenceId: eid },
            orderBy: { sequence: "asc" },
            select: {
              sequence: true,
              eventType: true,
              atUtc: true,
              payload: true,
              eventHash: true,
              prevEventHash: true,
            },
          });
          appendEntry(
            archive,
            entries,
            `evidence/${eid}/custody-chain.json`,
            jsonBuffer({
              schema: "PROOVRA_EXCHANGE_CUSTODY_CHAIN",
              version: 2,
              evidenceId: eid,
              generatedAtUtc: new Date().toISOString(),
              eventCount: custody.length,
              hashFormula:
                "eventHash = lowercase hex SHA-256 of the UTF-8 canonical JSON of {v:1, evidenceId, sequence, eventType, atUtc (ISO-8601), payload (or null), prevEventHash (or null)}; object keys sorted by code point at every level, no whitespace.",
              events: custody.map((e) => ({ ...e, atUtc: e.atUtc.toISOString() })),
            }),
            "application/json",
          );
        } catch (err) {
          // ET-CUS-09: a record whose metadata or custody chain cannot be read
          // fails the build (the job retries) instead of shipping a package
          // that silently omits it.
          throw Object.assign(new Error("EXCHANGE_EVIDENCE_READ_FAILED"), { cause: err, evidenceId: eid });
        }
      }
      break;
    }

    case "CASE": {
      if (caseId) {
        appendEntry(
          archive,
          entries,
          `cases/${caseId}/metadata.json`,
          jsonBuffer({
            schema: "PROOVRA_EXCHANGE_CASE_METADATA",
            caseId,
            teamId,
            evidenceCount: safeIds.length,
            evidenceIds: safeIds,
            generatedAtUtc: new Date().toISOString(),
          }),
          "application/json",
        );
      }
      for (const eid of safeIds.slice(0, 200)) {
        try {
          const workflows = await prisma.evidenceReviewWorkflow
            .findMany({
              where: reviewOf(eid),
              take: 5,
              select: { id: true, workspaceType: true },
            })
            .catch(() => []);
          if (workflows.length > 0) {
            appendEntry(
              archive,
              entries,
              `reviews/${eid}/workflows.json`,
              jsonBuffer({
                schema: "PROOVRA_EXCHANGE_REVIEW_WORKFLOWS",
                evidenceId: eid,
                generatedAtUtc: new Date().toISOString(),
                workflows,
              }),
              "application/json",
            );
          }
        } catch {
          // advisory
        }
        try {
          const projects = await prisma.redactionProject
            .findMany({
              where: childOf(eid),
              take: 5,
              select: { id: true, createdAt: true },
            })
            .catch(() => []);
          if (projects.length > 0) {
            appendEntry(
              archive,
              entries,
              `redactions/${eid}/projects.json`,
              jsonBuffer({
                schema: "PROOVRA_EXCHANGE_REDACTION_PROJECTS",
                evidenceId: eid,
                generatedAtUtc: new Date().toISOString(),
                projects,
              }),
              "application/json",
            );
          }
        } catch {
          // advisory
        }
      }
      break;
    }

    case "REVIEW": {
      for (const eid of safeIds.slice(0, 500)) {
        try {
          const workflows = await prisma.evidenceReviewWorkflow
            .findMany({
              where: reviewOf(eid),
              take: 5,
              select: { id: true, workspaceType: true },
            })
            .catch(() => []);
          if (workflows.length === 0) continue;
          appendEntry(
            archive,
            entries,
            `reviews/${eid}/workflows.json`,
            jsonBuffer({
              schema: "PROOVRA_EXCHANGE_REVIEW_WORKFLOWS",
              evidenceId: eid,
              generatedAtUtc: new Date().toISOString(),
              workflows,
            }),
            "application/json",
          );
        } catch {
          // advisory
        }
      }
      break;
    }

    case "REDACTION": {
      for (const eid of safeIds.slice(0, 500)) {
        try {
          const projects = await prisma.redactionProject
            .findMany({
              where: childOf(eid),
              take: 5,
              select: { id: true, createdAt: true },
            })
            .catch(() => []);
          if (projects.length === 0) continue;
          appendEntry(
            archive,
            entries,
            `redactions/${eid}/projects.json`,
            jsonBuffer({
              schema: "PROOVRA_EXCHANGE_REDACTION_METADATA",
              evidenceId: eid,
              generatedAtUtc: new Date().toISOString(),
              projects,
            }),
            "application/json",
          );
        } catch {
          // advisory
        }
      }
      break;
    }

    case "INTELLIGENCE": {
      for (const eid of safeIds.slice(0, 500)) {
        try {
          const job = await prisma.evidenceIntelligenceJob
            .findFirst({
              where: childOf(eid),
              orderBy: { createdAt: "desc" },
              select: {
                id: true,
                status: true,
                kind: true,
                createdAt: true,
              },
            })
            .catch(() => null);
          if (!job) continue;
          appendEntry(
            archive,
            entries,
            `intelligence/${eid}/metadata.json`,
            jsonBuffer({
              schema: "PROOVRA_EXCHANGE_INTELLIGENCE_METADATA",
              evidenceId: eid,
              generatedAtUtc: new Date().toISOString(),
              job: {
                id: job.id,
                status: job.status,
                kind: job.kind,
                createdAt: job.createdAt.toISOString(),
              },
            }),
            "application/json",
          );
        } catch {
          // advisory
        }
      }
      break;
    }

    case "GOVERNANCE": {
      try {
        const policies = await prisma.retentionPolicyConfig
          .findMany({
            where: { teamId },
            take: 50,
            select: { id: true, name: true, template: true, years: true },
          })
          .catch(() => []);
        const legalHoldCount = await prisma.evidenceLegalHold
          .count({ where: { teamId } })
          .catch(() => 0);
        appendEntry(
          archive,
          entries,
          "governance/governance-manifest.json",
          jsonBuffer({
            schema: "PROOVRA_EXCHANGE_GOVERNANCE_MANIFEST",
            teamId,
            generatedAtUtc: new Date().toISOString(),
            activePolicies: policies,
            legalHoldCount,
          }),
          "application/json",
        );
      } catch {
        // advisory
      }
      break;
    }

    case "AUDIT": {
      try {
        const totalCustody = await prisma.custodyEvent
          .count({ where: { evidence: workspaceScope } })
          .catch(() => 0);
        appendEntry(
          archive,
          entries,
          "audit/audit-manifest.json",
          jsonBuffer({
            schema: "PROOVRA_EXCHANGE_AUDIT_MANIFEST",
            teamId,
            generatedAtUtc: new Date().toISOString(),
            totalCustodyEvents: totalCustody,
            evidenceIds: safeIds,
            note: "Full audit log available via the PROOVRA audit export API.",
          }),
          "application/json",
        );
      } catch {
        // advisory
      }
      break;
    }

    case "VERIFICATION": {
      for (const eid of safeIds.slice(0, 500)) {
        try {
          const ev = await prisma.evidence.findFirst({
            where: inScope(eid),
            select: {
              id: true,
              verificationStatus: true,
              fileSha256: true,
              createdAt: true,
            },
          });
          if (!ev) continue;
          appendEntry(
            archive,
            entries,
            `verification/${eid}/metadata.json`,
            jsonBuffer({
              schema: "PROOVRA_EXCHANGE_VERIFICATION_METADATA",
              evidenceId: eid,
              generatedAtUtc: new Date().toISOString(),
              verificationStatus: ev.verificationStatus ?? null,
              fileSha256: ev.fileSha256 ?? null,
              createdAt: ev.createdAt.toISOString(),
            }),
            "application/json",
          );
        } catch {
          // advisory
        }
      }
      break;
    }

    case "REPORT": {
      for (const eid of safeIds.slice(0, 500)) {
        try {
          const report = await prisma.report
            .findFirst({
              where: { evidenceId: eid },
              orderBy: { version: "desc" },
              select: {
                id: true,
                version: true,
                generatedAtUtc: true,
              },
            })
            .catch(() => null);
          if (!report) continue;
          appendEntry(
            archive,
            entries,
            `reports/${eid}/metadata.json`,
            jsonBuffer({
              schema: "PROOVRA_EXCHANGE_REPORT_METADATA",
              evidenceId: eid,
              generatedAtUtc: new Date().toISOString(),
              report: {
                id: report.id,
                version: report.version,
                generatedAtUtc: report.generatedAtUtc.toISOString(),
              },
            }),
            "application/json",
          );
        } catch {
          // advisory
        }
      }
      break;
    }

    default:
      // Unknown kind — manifest + lifecycle only.
      break;
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — template-identity provenance trio helper.
//
// Reads the canonical Evidence trio for a bounded set of evidence ids
// and returns:
//   * `byEvidenceId` map of trio per id (used by per-evidence
//     metadata.json),
//   * `distinct` array of unique provenances (used by the package-
//     manifest provenance array).
//
// Identity propagation only — never drives any policy decision.
// Wrapped at the call site in try/catch so a propagation failure
// never breaks the package-build lifecycle.
// ---------------------------------------------------------------------------

type TemplateProvenance = {
  templateSlug: string | null;
  templateVersion: number | null;
  templateDbId: string | null;
};

async function resolveProvenanceForEvidenceIds(
  prisma: PrismaClient,
  teamId: string,
  evidenceIds: readonly string[],
): Promise<{
  byEvidenceId: Map<string, TemplateProvenance>;
  distinct: TemplateProvenance[];
}> {
  const byEvidenceId = new Map<string, TemplateProvenance>();
  const distinctMap = new Map<string, TemplateProvenance>();

  if (evidenceIds.length === 0) {
    return { byEvidenceId, distinct: [] };
  }

  const scope = await workspaceEvidenceWhere(teamId, prisma);
  const rows = await prisma.evidence.findMany({
    where: { AND: [{ id: { in: evidenceIds.slice(0, MAX_EVIDENCE_PER_PACKAGE) } }, scope] },
    select: {
      id: true,
      templateSlug: true,
      templateVersion: true,
      templateDbId: true,
    },
  });

  for (const row of rows) {
    const trio: TemplateProvenance = {
      templateSlug: row.templateSlug ?? null,
      templateVersion: row.templateVersion ?? null,
      templateDbId: row.templateDbId ?? null,
    };
    byEvidenceId.set(row.id, trio);
    // Distinct-key collapses NULL trios into a single "legacy" sentinel
    // so a workspace mixing legacy + Phase-T evidence reports both.
    const key = `${trio.templateSlug ?? ""}|${trio.templateVersion ?? ""}|${trio.templateDbId ?? ""}`;
    if (!distinctMap.has(key)) distinctMap.set(key, trio);
  }

  return { byEvidenceId, distinct: Array.from(distinctMap.values()) };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export async function buildExchangePackage(
  packageId: string,
  prismaOverride?: PrismaClient,
): Promise<void> {
  const prisma = prismaOverride ?? defaultPrisma;

  const pkg = await prisma.evidenceExchangePackage.findFirst({
    where: { id: packageId, state: "BUILDING" },
    select: {
      id: true,
      teamId: true,
      kind: true,
      evidenceIds: true,
      caseId: true,
      scopeNote: true,
      createdByUserId: true,
      createdAt: true,
    },
  });
  if (!pkg) {
    logger.warn(
      { packageId },
      "exchange.package_builder.not_found_or_not_building",
    );
    return;
  }

  const teamId = pkg.teamId;
  const rawIds: string[] = Array.isArray(pkg.evidenceIds)
    ? (pkg.evidenceIds as string[])
    : [];
  const limited = rawIds.length > MAX_EVIDENCE_PER_PACKAGE;
  /*
   * ONE SCOPED ID LIST FOR THE WHOLE PACKAGE (2026-09-29). The manifest used to
   * echo the row's RAW ids, so a stale or forged row could place another
   * tenant's evidence id in the ZIP even though every kind then skipped it.
   * Out-of-scope ids are now dropped here — from the manifest and every kind —
   * and only their COUNT is recorded, never the ids.
   */
  const candidateIds = rawIds.slice(0, MAX_EVIDENCE_PER_PACKAGE);
  const inScope = new Set(
    (
      await prisma.evidence.findMany({
        where: { AND: [{ id: { in: candidateIds } }, await workspaceEvidenceWhere(teamId, prisma)] },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const evidenceIds = candidateIds.filter((id) => inScope.has(id));
  const excludedOutOfScope = candidateIds.length - evidenceIds.length;

  // THE CLAIM. A caller that does not win it does nothing at all — no ZIP is
  // assembled, no object is uploaded and no terminal state is written, so the
  // holder's outcome is the only one that can be recorded.
  const attemptAt = await claimPackageBuild(prisma, pkg.id, teamId);
  if (!attemptAt) {
    logger.info(
      { packageId, teamId },
      "exchange.package_builder.claim_held_by_another_worker",
    );
    return;
  }

  const startedAt = Date.now();

  try {
    // Build the ZIP in-memory (archiver — same dep as verification-package.ts).
    const buffers: Buffer[] = [];
    const hashStream = createHash("sha256");
    const pass = new PassThrough();

    pass.on("data", (chunk: Buffer) => {
      buffers.push(chunk);
      hashStream.update(chunk);
    });

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(pass);

    const entries: PackageEntry[] = [];

    // Phase 6 — Resolve template-identity provenance for the included
    // evidence set so the manifest can surface the trio for downstream
    // traceability. Identity-only; never drives any policy. Wrapped
    // in try/catch so a propagation failure cannot break the package
    // build lifecycle — legacy rows yield NULL trio members and a
    // workspace with no Phase-T stamping yields a single "all-NULL"
    // distinct provenance.
    let provenanceCache: {
      byEvidenceId: Map<string, TemplateProvenance>;
      distinct: TemplateProvenance[];
    } = { byEvidenceId: new Map(), distinct: [] };
    try {
      provenanceCache = await resolveProvenanceForEvidenceIds(
        prisma,
        teamId,
        evidenceIds,
      );
    } catch (err) {
      logger.warn(
        { packageId, teamId, err },
        "exchange.package_builder.provenance_resolve_failed",
      );
    }

    // Package manifest — always included.
    appendEntry(
      archive,
      entries,
      "package-manifest.json",
      jsonBuffer({
        schema: "PROOVRA_EXCHANGE_PACKAGE_MANIFEST",
        version: 1,
        packageId: pkg.id,
        teamId,
        kind: pkg.kind,
        generatedAtUtc: new Date().toISOString(),
        evidenceCount: evidenceIds.length,
        evidenceIds,
        // How many requested ids were not in this workspace's scope (never which).
        excludedOutOfScope,
        limited,
        limitCap: MAX_EVIDENCE_PER_PACKAGE,
        caseId: pkg.caseId ?? null,
        scopeNote: pkg.scopeNote ?? null,
        createdByUserId: pkg.createdByUserId,
        createdAt: pkg.createdAt.toISOString(),
        // Phase 6 — distinct template-identity provenances across the
        // included evidence set. Identity-only; never drives policy.
        // Empty array when no rows resolved (legacy / unknown ids).
        provenance: provenanceCache.distinct,
      }),
      "application/json",
    );

    // Lifecycle manifests — always included.
    const lifecycleEntries = await buildLifecycleAndExchangeManifests({
      prisma,
      teamId,
    }).catch(() => []);
    for (const le of lifecycleEntries) {
      appendEntry(archive, entries, le.path, jsonBuffer(le.json), "application/json");
    }

    // Kind-specific content.
    await appendKindContent({
      prisma,
      archive,
      entries,
      kind: pkg.kind,
      teamId,
      evidenceIds,
      caseId: pkg.caseId ?? null,
      // Phase 6 — per-evidence template-identity provenance map,
      // resolved once above for the package manifest. Identity-only.
      provenanceByEvidenceId: provenanceCache.byEvidenceId,
    });

    // Checksums — computed after all other entries are appended.
    archive.append(jsonBuffer(buildPackageChecksums(entries)), {
      name: "package-checksums.json",
    });

    // Finalize and wait for all data.
    await new Promise<void>((resolve, reject) => {
      pass.on("finish", resolve);
      pass.on("error", reject);
      archive.on("error", reject);
      archive.finalize();
    });

    const zipBuffer = Buffer.concat(buffers);
    const zipSha256 = hashStream.digest("hex");
    const zipSizeBytes = zipBuffer.length;

    // Upload to S3 — at an ATTEMPT-SCOPED key (ET-SEC-27). A fixed key let a
    // late builder whose lease expired overwrite the object a winner had
    // already committed READY with its own sha; the pointer now moves only in
    // the conditional READY transition below.
    const storageKey = `exchange-packages/${teamId}/${packageId}/${attemptAt.getTime()}-${randomUUID()}.zip`;
    await putObjectBuffer({
      bucket: env.S3_BUCKET,
      key: storageKey,
      body: zipBuffer,
      contentType: "application/zip",
      metadata: {
        "proovra-package-id": packageId,
        "proovra-team-id": teamId,
        "proovra-kind": pkg.kind,
        "proovra-sha256": zipSha256,
      },
    });

    const durationMs = Date.now() - startedAt;

    // Mark package READY and meter it — ONE transaction. This is the
    // completion every product-created package goes through, so it is where
    // the monthly export-package allowance is consumed. The transition is
    // conditional on BUILDING so a package revoked mid-build is not
    // resurrected and one package is metered exactly once; the meter throws,
    // rolling READY back, so a metering failure lands in the FAILED path
    // below instead of committing an unmetered READY package.
    const completed = await prisma.$transaction(async (tx) => {
      // ET-SEC-27 — only the attempt that still owns the build commits.
      if (!(await attemptStillOwnsBuild(tx, pkg.id, attemptAt))) return false;
      const transition = await tx.evidenceExchangePackage.updateMany({
        where: { id: pkg.id, teamId, state: "BUILDING" },
        data: {
          state: "READY",
          storageKey: storageKey.slice(0, 400),
          packageSha256: zipSha256.slice(0, 64),
          packageSizeBytes: BigInt(zipSizeBytes),
          readyAtUtc: new Date(),
        },
      });
      if (transition.count !== 1) return false;
      await recordExportPackageUsage({ prisma: tx, teamId });
      return true;
    });
    if (!completed) {
      // The package left BUILDING while we built it (e.g. revoked), or this
      // attempt lost its claim (ET-SEC-27). Nothing was metered; this
      // attempt's own object is removed (best effort) — no pointer names it.
      await deleteObject({ bucket: env.S3_BUCKET, key: storageKey }).catch(() => null);
      throw new Error("package_left_building_state_during_build");
    }

    // Mark build UPLOADED.
    await upsertBuildRow(prisma, pkg.id, teamId, "UPLOADED", {
      attemptAt,
      storageKey: storageKey.slice(0, 600),
      payloadSha256: zipSha256.slice(0, 64),
      sizeBytes: BigInt(zipSizeBytes),
      completedAtUtc: new Date(),
    });

    logger.info(
      {
        packageId,
        teamId,
        kind: pkg.kind,
        storageKey,
        zipSha256,
        zipSizeBytes,
        evidenceCount: evidenceIds.length,
        limited,
        durationMs,
      },
      "exchange.package_builder.completed",
    );
  } catch (err) {
    const reason =
      err instanceof Error ? err.message.slice(0, 590) : "unknown error";

    logger.error(
      { packageId, teamId, kind: pkg.kind, err },
      "exchange.package_builder.failed",
    );

    // Revert package to DRAFT so operators can retry — ONLY while this attempt
    // still owns the build (ET-SEC-27): a late attempt whose lease was
    // re-claimed must not pull the live build's package out from under it.
    try {
      await prisma.$transaction(async (tx) => {
        if (!(await attemptStillOwnsBuild(tx, pkg.id, attemptAt))) return;
        // Conditional: only a package still BUILDING returns to DRAFT, so a
        // package revoked during the build stays REVOKED.
        await tx.evidenceExchangePackage.updateMany({
          where: { id: pkg.id, state: "BUILDING" },
          data: { state: "DRAFT" },
        });
      });
    } catch {
      // ignore
    }

    // Mark build FAILED (fenced by the attempt).
    await upsertBuildRow(prisma, pkg.id, teamId, "FAILED", {
      attemptAt,
      failureReason: reason,
    });
  }
}

// ---------------------------------------------------------------------------
// Poller — called from the 10-second scheduler in index.ts.
// ---------------------------------------------------------------------------

const _inFlight = new Set<string>();

export async function pollExchangePackageBuilds(
  prismaOverride?: PrismaClient,
): Promise<void> {
  const prisma = prismaOverride ?? defaultPrisma;

  try {
    const available = MAX_CONCURRENT_BUILDS - _inFlight.size;
    if (available <= 0) return;

    const pending = await prisma.evidenceExchangePackage.findMany({
      where: { state: "BUILDING" },
      take: MAX_CONCURRENT_BUILDS + 5,
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    const toStart = pending
      .filter((p) => !_inFlight.has(p.id))
      .slice(0, available);

    for (const p of toStart) {
      _inFlight.add(p.id);
      void buildExchangePackage(p.id, prisma).finally(() => {
        _inFlight.delete(p.id);
      });
    }
  } catch (err) {
    // Poll failures must never crash the scheduler loop.
    logger.warn({ err }, "exchange.package_builder.poll_failed");
  }
}
