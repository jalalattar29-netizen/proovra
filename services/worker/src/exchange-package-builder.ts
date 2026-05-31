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
 *   6. Uploads ZIP to S3 at "exchange-packages/<teamId>/<packageId>.zip".
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
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db.js";
import { putObjectBuffer } from "./storage.js";
import { env } from "./config.js";
import { buildLifecycleAndExchangeManifests } from "./verification-package-lifecycle.js";
import { logger } from "./logger.js";

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
  },
): Promise<void> {
  try {
    if (state === "BUILDING") {
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
      await prisma.$executeRaw`
        UPDATE evidence_exchange_package_builds
        SET state = 'UPLOADED',
            completed_at_utc = ${extra?.completedAtUtc ?? new Date()},
            storage_key = ${extra?.storageKey ?? null},
            payload_sha256 = ${extra?.payloadSha256 ?? null},
            size_bytes = ${extra?.sizeBytes !== undefined ? String(extra.sizeBytes) : null}::bigint,
            failure_reason = NULL
        WHERE package_id = ${packageId}
      `;
    } else if (state === "FAILED") {
      await prisma.$executeRaw`
        UPDATE evidence_exchange_package_builds
        SET state = 'FAILED',
            completed_at_utc = NOW(),
            failure_reason = ${(extra?.failureReason ?? "").slice(0, 590)}
        WHERE package_id = ${packageId}
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
}): Promise<void> {
  const { prisma, archive, entries, kind, teamId, evidenceIds, caseId } = params;

  const safeIds = evidenceIds.slice(0, MAX_EVIDENCE_PER_PACKAGE);

  switch (kind) {
    case "EVIDENCE": {
      for (const eid of safeIds) {
        try {
          const ev = await prisma.evidence.findFirst({
            where: { id: eid, teamId },
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
            }),
            "application/json",
          );

          const custody = await prisma.custodyEvent
            .findMany({
              where: { evidenceId: eid },
              orderBy: { sequence: "asc" },
              take: 500,
              select: {
                sequence: true,
                eventType: true,
                atUtc: true,
                eventHash: true,
                prevEventHash: true,
              },
            })
            .catch(() => []);
          appendEntry(
            archive,
            entries,
            `evidence/${eid}/custody-chain.json`,
            jsonBuffer({
              schema: "PROOVRA_EXCHANGE_CUSTODY_CHAIN",
              evidenceId: eid,
              generatedAtUtc: new Date().toISOString(),
              events: custody,
            }),
            "application/json",
          );
        } catch {
          // per-evidence failure is non-fatal
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
              where: { evidenceId: eid, teamId },
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
              where: { evidenceId: eid, teamId },
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
              where: { evidenceId: eid, teamId },
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
              where: { evidenceId: eid, teamId },
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
              where: { evidenceId: eid, teamId },
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
        const legalHoldCount = await prisma.legalHold
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
          .count({ where: { evidence: { teamId } } })
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
            where: { id: eid, teamId },
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
  const evidenceIds = rawIds.slice(0, MAX_EVIDENCE_PER_PACKAGE);

  // Upsert build tracker row → BUILDING.
  await upsertBuildRow(prisma, pkg.id, teamId, "BUILDING");

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
        limited,
        limitCap: MAX_EVIDENCE_PER_PACKAGE,
        caseId: pkg.caseId ?? null,
        scopeNote: pkg.scopeNote ?? null,
        createdByUserId: pkg.createdByUserId,
        createdAt: pkg.createdAt.toISOString(),
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

    // Upload to S3.
    const storageKey = `exchange-packages/${teamId}/${packageId}.zip`;
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

    // Mark package READY.
    await prisma.evidenceExchangePackage.update({
      where: { id: pkg.id },
      data: {
        state: "READY",
        storageKey: storageKey.slice(0, 400),
        packageSha256: zipSha256.slice(0, 64),
        packageSizeBytes: BigInt(zipSizeBytes),
        readyAtUtc: new Date(),
      },
    });

    // Mark build UPLOADED.
    await upsertBuildRow(prisma, pkg.id, teamId, "UPLOADED", {
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

    // Revert package to DRAFT so operators can retry.
    try {
      await prisma.evidenceExchangePackage.update({
        where: { id: pkg.id },
        data: { state: "DRAFT" },
      });
    } catch {
      // ignore
    }

    // Mark build FAILED.
    await upsertBuildRow(prisma, pkg.id, teamId, "FAILED", {
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
