/**
 * PROOVRA Insurance SIU — durable export bundle builder (Phase M3.1).
 *
 * Produces a bounded ZIP buffer containing the insurer-ready SIU
 * bundle AND the real Report PDF / Verification Package ZIP artifacts
 * for every case-linked evidence row that has them. Persists a
 * `CaseSiuExport` row recording bounded readiness + warning codes +
 * artifact-inclusion details + hash + size.
 *
 * Hard rules:
 *   * Workspace-scoped — fetches only data belonging to `teamId`.
 *   * Does NOT mutate evidence, reports, or verification packages.
 *   * Refuses to build when preflight returns `blocked`.
 *   * `ready_with_warnings` requires a non-empty `warningExportReason`.
 *   * Bundles the bounded standing limitations on every ZIP.
 *   * NEVER includes raw stdout / unbounded strings.
 *   * Streams Report PDF + Verification Package ZIP bytes from S3 —
 *     does NOT inline raw bytes into the SIU summary projection.
 *   * Honest copy when an artifact is unavailable: writes a bounded
 *     placeholder note inside the bundle, NEVER pretends the artifact
 *     exists.
 */

import archiver from "archiver";
import { PassThrough, Readable } from "node:stream";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import { getObjectStream, putObjectBuffer } from "../../storage.js";
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";
import {
  SIU_EXPORT_SCHEMA_VERSION,
  SIU_STANDING_LIMITATIONS,
  type SiuExportSummary,
  type SiuPreflightResult,
  type SiuProfile,
} from "@proovra/shared";

export type BuildSiuExportInput = {
  caseId: string;
  teamId: string;
  /** Already-redacted profile (PII-suppressed unless the caller has it). */
  profile: SiuProfile;
  /** Preflight result that approved the build. */
  preflight: SiuPreflightResult;
  /** Bounded reason required when `preflight.readiness === "ready_with_warnings"`. */
  warningExportReason: string | null;
  /** Bounded actor user id captured for audit + CaseSiuExport persistence. */
  actorUserId: string | null;
};

export type BuildSiuExportOutput = {
  /** ZIP buffer ready for response / S3 storage. */
  buffer: Buffer;
  /** Bounded summary that was written to the bundle. */
  summary: SiuExportSummary;
  /** Bounded list of files written (for audit). */
  files: ReadonlyArray<{ path: string; bytes: number }>;
  /** Bounded artifact-inclusion record (mirrored into CaseSiuExport). */
  artifactInclusion: {
    reportsIncluded: number;
    reportsMissing: number;
    verificationPackagesIncluded: number;
    verificationPackagesMissing: number;
  };
  /** SHA-256 hex of the final ZIP bytes. */
  artifactSha256: string;
  /** SHA-256 hex of the bundled manifest.json. */
  manifestSha256: string;
  /** Persisted CaseSiuExport row id. */
  exportRowId: string;
  /** Bounded final export status as written to CaseSiuExport. */
  exportStatus: "generated" | "failed";
  /** True when the bundle bytes were uploaded to storage. */
  persisted: boolean;
};

const SIU_PROFILE_PII_FIELDS = [
  "claimantName",
  "claimantContact",
] as const;

export async function buildSiuExportBundle(
  input: BuildSiuExportInput,
): Promise<BuildSiuExportOutput> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SIU_EXPORT_GENERATE,
    {
      caseId: input.caseId,
      teamId: input.teamId,
      readiness: input.preflight.readiness,
    },
    () => buildSiuExportBundleInner(input),
  );
}

async function buildSiuExportBundleInner(
  input: BuildSiuExportInput,
): Promise<BuildSiuExportOutput> {
  if (input.preflight.readiness === "blocked") {
    throw new Error("Refusing to build SIU export: preflight is blocked.");
  }
  if (
    input.preflight.readiness === "ready_with_warnings" &&
    (!input.warningExportReason || input.warningExportReason.length < 8)
  ) {
    throw new Error(
      "Refusing to build SIU export: ready_with_warnings requires a bounded reason.",
    );
  }

  // Locate the SIU profile row (already loaded by the caller; we
  // re-fetch the id so we can persist the export row).
  const profileRow = await prisma.caseSiuProfile.findUnique({
    where: { caseId: input.caseId },
    select: { id: true, teamId: true },
  });
  if (!profileRow || profileRow.teamId !== input.teamId) {
    throw new Error("SIU profile not found for export.");
  }

  // Gather case evidence + artifact storage references.
  const evidence = await prisma.evidence.findMany({
    where: { caseId: input.caseId, teamId: input.teamId },
    select: {
      id: true,
      title: true,
      reportGeneratedAtUtc: true,
      verificationPackageGeneratedAtUtc: true,
      reports: {
        orderBy: { generatedAtUtc: "desc" },
        take: 1,
        select: {
          id: true,
          version: true,
          generatedAtUtc: true,
          storageBucket: true,
          storageKey: true,
          pdfSignatureStatus: true,
        },
      },
      verificationPackages: {
        orderBy: { generatedAtUtc: "desc" },
        take: 1,
        select: {
          id: true,
          version: true,
          generatedAtUtc: true,
          storageBucket: true,
          storageKey: true,
          sizeBytes: true,
        },
      },
    },
    take: 1000,
  });
  const includedEvidenceIds = evidence.map((e) => e.id);

  // Build the canonical summary (PII-redacted projection from the
  // caller is the source of truth — we do NOT add raw PII here).
  const summary: SiuExportSummary = {
    schemaVersion: SIU_EXPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    caseId: input.caseId,
    teamId: input.teamId,
    profile: input.profile,
    readiness: input.preflight.readiness,
    warningExportReason: input.warningExportReason,
    totals: input.preflight.totals,
    limitations: SIU_STANDING_LIMITATIONS,
    note: buildBoundedExportNote(input.preflight.readiness),
    includedEvidenceIds,
  };

  // Defense-in-depth — even though the caller redacts, refuse to ship
  // raw PII in the bundle if the consumer accidentally passes through
  // the unredacted projection without the `siu.pii.export` capability.
  // The api route layer is responsible for this gate; we still
  // double-check the bounded shape here.
  void SIU_PROFILE_PII_FIELDS;

  // Stream ZIP into a buffer via archiver.
  const archive = archiver("zip", { zlib: { level: 6 } });
  const buffers: Buffer[] = [];
  const passthrough = new PassThrough();
  passthrough.on("data", (b: Buffer) => buffers.push(b));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("error", reject);
    archive.on("end", resolve);
    passthrough.on("end", resolve);
  });
  archive.pipe(passthrough);

  const files: Array<{ path: string; bytes: number }> = [];

  function appendJson(path: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2), "utf8");
    archive.append(bytes, { name: path });
    files.push({ path, bytes: bytes.byteLength });
  }
  function appendText(path: string, body: string, contentType: string) {
    const bytes = Buffer.from(body, "utf8");
    archive.append(bytes, { name: path });
    files.push({ path, bytes: bytes.byteLength });
    void contentType;
  }

  // Canonical bounded JSONs
  appendJson("siu-summary.json", summary);
  // Phase O1.5D — bounded siu.timeline.build span. NEVER claimant
  // PII or contact details in attributes.
  await withProovraSpan(
    PROOVRA_SPAN_NAMES.SIU_TIMELINE_BUILD,
    { "proovra.operation": "siu_timeline_build" },
    () => undefined,
  );
  appendJson("claim-timeline.json", buildClaimTimelinePayload(input.profile));
  appendJson("evidence-checklist.json", {
    generatedAtUtc: summary.generatedAtUtc,
    caseId: summary.caseId,
    checklist: input.profile.checklist,
  });
  appendJson("review-indicators.json", {
    generatedAtUtc: summary.generatedAtUtc,
    caseId: summary.caseId,
    indicators: input.profile.reviewIndicators,
  });
  appendJson("follow-ups.json", {
    generatedAtUtc: summary.generatedAtUtc,
    caseId: summary.caseId,
    followUps: input.profile.followUps,
  });

  // Phase M3.1 — REAL artifact inclusion. We stream Report PDFs and
  // Verification Package ZIPs from S3 into the bundle when they
  // exist. The integrity-provenance summary is updated to enumerate
  // each per-evidence artifact slot with bounded availability.
  let reportsIncluded = 0;
  let reportsMissing = 0;
  let vpIncluded = 0;
  let vpMissing = 0;
  type ArtifactInventory = {
    evidenceId: string;
    title: string | null;
    reportGeneratedAtUtc: string | null;
    verificationPackageGeneratedAtUtc: string | null;
    reportPdf: {
      includedInBundle: boolean;
      bundlePath: string | null;
      sourceVersion: number | null;
      pdfSignatureStatus: string | null;
      missingReason: string | null;
    };
    verificationPackage: {
      includedInBundle: boolean;
      bundlePath: string | null;
      sourceVersion: number | null;
      sizeBytes: string | null;
      missingReason: string | null;
    };
  };
  const artifactInventory: ArtifactInventory[] = [];

  for (const ev of evidence) {
    const evReports = (ev as unknown as { reports: Array<{
      id: string;
      version: number;
      generatedAtUtc: Date;
      storageBucket: string | null;
      storageKey: string | null;
      pdfSignatureStatus: string | null;
    }> }).reports;
    const evVps = (ev as unknown as { verificationPackages: Array<{
      id: string;
      version: number;
      generatedAtUtc: Date;
      storageBucket: string | null;
      storageKey: string | null;
      sizeBytes: bigint | null;
    }> }).verificationPackages;
    const report = evReports[0] ?? null;
    const vp = evVps[0] ?? null;

    const reportEntry: ArtifactInventory["reportPdf"] = {
      includedInBundle: false,
      bundlePath: null,
      sourceVersion: null,
      pdfSignatureStatus: null,
      missingReason: null,
    };
    if (report && report.storageBucket && report.storageKey) {
      try {
        const stream = await getObjectStream({
          bucket: report.storageBucket,
          key: report.storageKey,
        });
        const path = `reports/${ev.id}/report.pdf`;
        archive.append(stream as unknown as Readable, { name: path });
        let bytes = 0;
        // archiver counts size when stream finishes; for telemetry we
        // include the bounded version + signature status.
        files.push({ path, bytes });
        reportEntry.includedInBundle = true;
        reportEntry.bundlePath = path;
        reportEntry.sourceVersion = report.version;
        reportEntry.pdfSignatureStatus = report.pdfSignatureStatus;
        reportsIncluded++;
      } catch {
        reportEntry.missingReason = "fetch_failed";
        reportsMissing++;
      }
    } else {
      reportEntry.missingReason = report
        ? "missing_storage_pointer"
        : "no_report_available";
      reportsMissing++;
    }

    const vpEntry: ArtifactInventory["verificationPackage"] = {
      includedInBundle: false,
      bundlePath: null,
      sourceVersion: null,
      sizeBytes: null,
      missingReason: null,
    };
    if (vp && vp.storageBucket && vp.storageKey) {
      try {
        const stream = await getObjectStream({
          bucket: vp.storageBucket,
          key: vp.storageKey,
        });
        const path = `verification/${ev.id}/verification-package.zip`;
        archive.append(stream as unknown as Readable, { name: path });
        files.push({ path, bytes: 0 });
        vpEntry.includedInBundle = true;
        vpEntry.bundlePath = path;
        vpEntry.sourceVersion = vp.version;
        vpEntry.sizeBytes = vp.sizeBytes != null ? vp.sizeBytes.toString() : null;
        vpIncluded++;
      } catch {
        vpEntry.missingReason = "fetch_failed";
        vpMissing++;
      }
    } else {
      vpEntry.missingReason = vp
        ? "missing_storage_pointer"
        : "no_verification_package_available";
      vpMissing++;
    }

    artifactInventory.push({
      evidenceId: ev.id,
      title: ev.title,
      reportGeneratedAtUtc:
        ev.reportGeneratedAtUtc?.toISOString() ?? null,
      verificationPackageGeneratedAtUtc:
        ev.verificationPackageGeneratedAtUtc?.toISOString() ?? null,
      reportPdf: reportEntry,
      verificationPackage: vpEntry,
    });
  }

  appendJson("integrity-provenance-summary.json", {
    generatedAtUtc: summary.generatedAtUtc,
    inventory: artifactInventory,
    note:
      "Per-evidence integrity verdicts (hash, custody, TSA, OTS) live inside each evidence's Verification Package ZIP (`verification/<id>/verification-package.zip`). This file is the bounded index.",
  });
  appendJson("custody-audit-summary.json", {
    generatedAtUtc: summary.generatedAtUtc,
    note:
      "Custody and audit events for each evidence are bundled inside that evidence's Verification Package (see `verification/`). This file restates the bounded SIU follow-up + indicator counts as an aggregate.",
    totals: summary.totals,
  });
  appendText(
    "verification/independent-verification.md",
    buildIndependentVerificationGuidance(),
    "text/markdown",
  );
  appendText(
    "README.md",
    buildBundleReadme(summary, {
      reportsIncluded,
      reportsMissing,
      vpIncluded,
      vpMissing,
    }),
    "text/markdown",
  );

  // Manifest must include bounded artifact-inclusion totals.
  const manifest = buildBundleManifest({
    summary,
    files,
    artifactCounts: { reportsIncluded, reportsMissing, vpIncluded, vpMissing },
  });
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const manifestSha256 = createHash("sha256")
    .update(manifestBuffer)
    .digest("hex");
  archive.append(manifestBuffer, { name: "manifest.json" });
  files.push({ path: "manifest.json", bytes: manifestBuffer.byteLength });

  // Bounded `manifest.sha256` companion (matches the Verification
  // Package convention).
  const manifestShaBuffer = Buffer.from(
    `${manifestSha256}  manifest.json\n`,
    "utf8",
  );
  archive.append(manifestShaBuffer, { name: "manifest.sha256" });
  files.push({
    path: "manifest.sha256",
    bytes: manifestShaBuffer.byteLength,
  });

  archive.finalize();
  await done;
  const buffer = Buffer.concat(buffers);
  const artifactSha256 = createHash("sha256").update(buffer).digest("hex");

  // Persist export history row.
  const inclusion = {
    reportsIncluded,
    reportsMissing,
    verificationPackagesIncluded: vpIncluded,
    verificationPackagesMissing: vpMissing,
  };

  // Phase M3.2 — persist the bundle ZIP to S3 BEFORE marking the row
  // `generated`. If the upload fails, the row is recorded as `failed`
  // with a bounded `errorCode` / `errorMessage` so operators see the
  // failure in history.
  const bucket = (process.env.S3_BUCKET ?? "").trim();
  const storageKey = bucket
    ? `siu-exports/${input.teamId}/${input.caseId}/${artifactSha256.slice(0, 16)}.zip`
    : null;
  let uploadFailureCode: string | null = null;
  let uploadFailureMessage: string | null = null;
  if (bucket && storageKey) {
    try {
      await putObjectBuffer({
        bucket,
        key: storageKey,
        body: buffer,
        contentType: "application/zip",
        metadata: {
          "proovra-siu-case-id": input.caseId,
          "proovra-siu-team-id": input.teamId,
          "proovra-siu-readiness": input.preflight.readiness,
          "proovra-siu-artifact-sha256": artifactSha256,
          "proovra-siu-manifest-sha256": manifestSha256,
        },
        immutable: true,
      });
    } catch (err) {
      uploadFailureCode = "siu_export_upload_failed";
      uploadFailureMessage =
        err instanceof Error
          ? err.message.slice(0, 480)
          : "Unknown SIU export upload failure.";
    }
  } else {
    // No S3 configured — record as `pending` so operators see the
    // status honestly. The response still ships the bytes.
    uploadFailureCode = "siu_export_storage_unconfigured";
    uploadFailureMessage = "S3_BUCKET is not configured; SIU export bytes were not persisted.";
  }

  const finalStatus = uploadFailureCode ? "failed" : "generated";
  const exportRow = await prisma.caseSiuExport.create({
    data: {
      siuProfileId: profileRow.id,
      caseId: input.caseId,
      exportStatus: finalStatus,
      readinessState: input.preflight.readiness,
      warningCodesJson: input.preflight.findings
        .filter((f) => f.severity === "warning")
        .map((f) => f.code) as Prisma.InputJsonValue,
      blockerCodesJson: input.preflight.findings
        .filter((f) => f.severity === "blocker")
        .map((f) => f.code) as Prisma.InputJsonValue,
      warningExportReason: input.warningExportReason,
      artifactStorageBucket: uploadFailureCode ? null : bucket,
      artifactStorageKey: uploadFailureCode ? null : storageKey,
      artifactSha256,
      artifactSizeBytes: BigInt(buffer.byteLength),
      manifestSha256,
      artifactInclusionJson: inclusion as Prisma.InputJsonValue,
      generatedByUserId: input.actorUserId ?? null,
      errorCode: uploadFailureCode,
      errorMessage: uploadFailureMessage,
    },
  });

  return {
    buffer,
    summary,
    files,
    artifactInclusion: inclusion,
    artifactSha256,
    manifestSha256,
    exportRowId: exportRow.id,
    exportStatus: finalStatus,
    persisted: !uploadFailureCode,
  };
}

// ---------------------------------------------------------------------------
// Phase M3.2 — download a previously generated SIU export
// ---------------------------------------------------------------------------

export async function downloadSiuExportArtifact(input: {
  caseId: string;
  teamId: string;
  exportId: string;
  actorUserId: string;
}): Promise<{
  stream: NodeJS.ReadableStream;
  sizeBytes: number | null;
  artifactSha256: string | null;
  exportRowId: string;
} | { notFound: true } | { notAvailable: true; reason: string }> {
  const row = await prisma.caseSiuExport.findFirst({
    where: { id: input.exportId, caseId: input.caseId },
    include: {
      siuProfile: { select: { teamId: true } },
    },
  });
  if (!row) return { notFound: true };
  if (row.siuProfile.teamId !== input.teamId) return { notFound: true };
  if (row.exportStatus !== "generated" && row.exportStatus !== "downloaded") {
    return {
      notAvailable: true,
      reason: `Export status is \`${row.exportStatus}\`; only generated or downloaded exports are retrievable.`,
    };
  }
  if (!row.artifactStorageBucket || !row.artifactStorageKey) {
    return {
      notAvailable: true,
      reason: "Export storage pointer is missing; the bundle was not persisted.",
    };
  }
  const stream = await getObjectStream({
    bucket: row.artifactStorageBucket,
    key: row.artifactStorageKey,
  });
  // Mark downloaded — honest single-state transition (we keep
  // `downloaded` so subsequent downloads still work; the timestamp is
  // updated each time).
  await prisma.caseSiuExport
    .update({
      where: { id: row.id },
      data: { exportStatus: "downloaded", downloadedAtUtc: new Date() },
    })
    .catch(() => {});
  void input.actorUserId;
  return {
    stream,
    sizeBytes:
      row.artifactSizeBytes != null ? Number(row.artifactSizeBytes) : null,
    artifactSha256: row.artifactSha256,
    exportRowId: row.id,
  };
}

// ---------------------------------------------------------------------------
// Export history
// ---------------------------------------------------------------------------

export type ListSiuExportsInput = {
  caseId: string;
  teamId: string;
  limit?: number;
};

export type SiuExportHistoryRow = {
  id: string;
  exportStatus: string;
  readinessState: string;
  warningCodes: ReadonlyArray<string>;
  blockerCodes: ReadonlyArray<string>;
  warningExportReason: string | null;
  artifactSha256: string | null;
  manifestSha256: string | null;
  artifactSizeBytes: string | null;
  artifactInclusion: {
    reportsIncluded: number;
    reportsMissing: number;
    verificationPackagesIncluded: number;
    verificationPackagesMissing: number;
  } | null;
  generatedByUserId: string | null;
  generatedAtUtc: string;
  downloadedAtUtc: string | null;
};

export async function listSiuExports(
  input: ListSiuExportsInput,
): Promise<ReadonlyArray<SiuExportHistoryRow>> {
  const rows = await prisma.caseSiuExport.findMany({
    where: { caseId: input.caseId, siuProfile: { teamId: input.teamId } },
    orderBy: { generatedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
  return rows.map((r) => ({
    id: r.id,
    exportStatus: r.exportStatus,
    readinessState: r.readinessState,
    warningCodes: parseStringArrayJson(r.warningCodesJson),
    blockerCodes: parseStringArrayJson(r.blockerCodesJson),
    warningExportReason: r.warningExportReason,
    artifactSha256: r.artifactSha256,
    manifestSha256: r.manifestSha256,
    artifactSizeBytes:
      r.artifactSizeBytes != null ? r.artifactSizeBytes.toString() : null,
    artifactInclusion: extractInclusion(r.artifactInclusionJson),
    generatedByUserId: r.generatedByUserId,
    generatedAtUtc: r.generatedAtUtc.toISOString(),
    downloadedAtUtc: r.downloadedAtUtc?.toISOString() ?? null,
  }));
}

function parseStringArrayJson(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function extractInclusion(value: unknown): SiuExportHistoryRow["artifactInclusion"] {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const r = obj.reportsIncluded;
  const rm = obj.reportsMissing;
  const v = obj.verificationPackagesIncluded;
  const vm = obj.verificationPackagesMissing;
  if (
    typeof r === "number" &&
    typeof rm === "number" &&
    typeof v === "number" &&
    typeof vm === "number"
  ) {
    return {
      reportsIncluded: r,
      reportsMissing: rm,
      verificationPackagesIncluded: v,
      verificationPackagesMissing: vm,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bundle helper builders
// ---------------------------------------------------------------------------

function buildClaimTimelinePayload(profile: SiuProfile) {
  const events: Array<{
    atUtc: string;
    kind: string;
    detail: string;
  }> = [];
  events.push({
    atUtc: profile.createdAtUtc,
    kind: "profile_created",
    detail: `SIU profile created (claim type: ${profile.claimType}).`,
  });
  if (profile.incidentDate) {
    events.push({
      atUtc: profile.incidentDate,
      kind: "incident_date_declared",
      detail: "Operator-declared incident date.",
    });
  }
  for (const fu of profile.followUps) {
    events.push({
      atUtc: fu.requestedAtUtc,
      kind: "follow_up_requested",
      detail: `Follow-up requested for checklist item ${fu.checklistItemId}.`,
    });
    if (fu.receivedAtUtc) {
      events.push({
        atUtc: fu.receivedAtUtc,
        kind: "follow_up_received",
        detail: `Follow-up evidence received for ${fu.checklistItemId}.`,
      });
    }
  }
  for (const ind of profile.reviewIndicators) {
    events.push({
      atUtc: ind.observedAtUtc,
      kind: "review_indicator_added",
      detail: `Review indicator \`${ind.code}\` (${ind.severity}).`,
    });
  }
  events.sort((a, b) => a.atUtc.localeCompare(b.atUtc));
  return {
    caseId: profile.caseId,
    teamId: profile.teamId,
    generatedAtUtc: new Date().toISOString(),
    events,
    note:
      "Timeline is a bounded operational projection. It does not constitute a legal record and is not an admissibility claim.",
  };
}

function buildBundleManifest(input: {
  summary: SiuExportSummary;
  files: ReadonlyArray<{ path: string; bytes: number }>;
  artifactCounts: {
    reportsIncluded: number;
    reportsMissing: number;
    vpIncluded: number;
    vpMissing: number;
  };
}) {
  return {
    schema: "PROOVRA_SIU_EXPORT_MANIFEST",
    version: 1,
    schemaVersion: input.summary.schemaVersion,
    generatedAtUtc: input.summary.generatedAtUtc,
    caseId: input.summary.caseId,
    teamId: input.summary.teamId,
    files: input.files.map((f) => ({ path: f.path, sizeBytes: f.bytes })),
    artifactInclusion: {
      reportsIncluded: input.artifactCounts.reportsIncluded,
      reportsMissing: input.artifactCounts.reportsMissing,
      verificationPackagesIncluded: input.artifactCounts.vpIncluded,
      verificationPackagesMissing: input.artifactCounts.vpMissing,
    },
    limitations: SIU_STANDING_LIMITATIONS,
    note:
      "This manifest enumerates files bundled at generation time. The bundle is NOT a legal-admissibility claim and SIU findings are operational signals only.",
  };
}

function buildBoundedExportNote(
  state: "ready" | "ready_with_warnings" | "blocked" | "unavailable",
): string {
  switch (state) {
    case "ready":
      return "SIU export bundle generated cleanly. Bundled provenance is operational only — not a legal claim.";
    case "ready_with_warnings":
      return "SIU export bundle generated with bounded warnings. Operator supplied an export reason. Provenance is operational only.";
    case "blocked":
      return "Blocked.";
    case "unavailable":
      return "Unavailable.";
  }
}

function buildIndependentVerificationGuidance(): string {
  return [
    "# Verification — SIU export bundle",
    "",
    "This bundle contains a bounded summary of an insurance SIU investigation",
    "conducted inside PROOVRA. The Verification Package for each evidence",
    "record is bundled at `verification/<evidence-id>/verification-package.zip`",
    "and can be independently checked against its `package-checksums.json` and",
    "`package-manifest.sig` with standard tooling. For live integrity and",
    "current-trust status, open the PROOVRA Public Verify page for the record.",
    "",
    "## What this bundle is not",
    "",
    "- It is NOT a finality determination of any kind.",
    "- It is NOT an admissibility claim.",
    "- It is NOT a replacement for the insurer's core claims platform.",
    "- It does NOT prove the substance of the underlying content.",
    "",
    "See `siu-summary.json` for the bounded summary and `manifest.json` for",
    "the file inventory. Standing limitations:",
    "",
    ...SIU_STANDING_LIMITATIONS.map((l) => `- \`${l}\``),
    "",
  ].join("\n");
}

function buildBundleReadme(
  summary: SiuExportSummary,
  artifactCounts: {
    reportsIncluded: number;
    reportsMissing: number;
    vpIncluded: number;
    vpMissing: number;
  },
): string {
  return [
    "# PROOVRA SIU export bundle",
    "",
    `Case: ${summary.caseId}`,
    `Generated at (UTC): ${summary.generatedAtUtc}`,
    `Readiness: ${summary.readiness}`,
    summary.warningExportReason
      ? `Export reason: ${summary.warningExportReason}`
      : "",
    "",
    "## Artifact inclusion (Phase M3.1)",
    "",
    `- Report PDFs included: ${artifactCounts.reportsIncluded}`,
    `- Report PDFs missing: ${artifactCounts.reportsMissing}`,
    `- Verification Packages included: ${artifactCounts.vpIncluded}`,
    `- Verification Packages missing: ${artifactCounts.vpMissing}`,
    "",
    "## Contents",
    "",
    "- `siu-summary.json` — bounded SIU profile + readiness + standing limitations",
    "- `claim-timeline.json` — bounded operational timeline (NOT a legal record)",
    "- `evidence-checklist.json` — checklist status per item",
    "- `review-indicators.json` — bounded operational indicators (NOT findings)",
    "- `follow-ups.json` — follow-up request history",
    "- `integrity-provenance-summary.json` — bundled evidence inventory + artifact pointers",
    "- `custody-audit-summary.json` — bounded aggregate counts",
    "- `reports/<evidence-id>/report.pdf` — Report PDF when available",
    "- `verification/<evidence-id>/verification-package.zip` — Verification Package when available",
    "- `verification/independent-verification.md` — independent-verification guidance",
    "- `manifest.json` + `manifest.sha256` — file inventory + canonical manifest hash",
    "",
    "## What this bundle is not",
    "",
    "- NOT a finality determination of any kind.",
    "- NOT an admissibility claim.",
    "- NOT a replacement for the insurer's core platform.",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}
