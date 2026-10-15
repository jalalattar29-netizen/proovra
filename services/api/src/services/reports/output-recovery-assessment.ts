/**
 * THE OUTPUT RECOVERY ASSESSMENT — one decision for `status`, the recovery
 * dry run and `recover --apply` (2026-10-13).
 *
 * WHY. The operator CLI decided "package recovery" from the existence of a
 * Report ROW. Production record 7eddb7d6 has a report row whose object is
 * gone (objectExists=false); package recovery would have read nothing, or —
 * worse — packaged bytes nobody can vouch for. `status` HEADed the objects but
 * `recover` never looked, so the two commands could disagree about the same
 * record. Both now read this one assessment, and `recover` only executes the
 * operation it names.
 *
 * Read-only: it never writes, never enqueues and never reads object BODIES —
 * a HEAD of each referenced object (by its recorded VersionId) is the storage
 * evidence. The worker still verifies the full bytes before it packages them
 * (readVerifiedStoredReport); this decides only what may be ASKED for.
 */
import {
  MAX_TERMINAL_SUPERSESSIONS,
  classifyTerminalReason,
} from "@proovra/shared";
import {
  asPublishedPackage,
  buildReportGenerationIdempotencyKey,
  primaryPublishedPackageWhere,
} from "@proovra/shared-runtime/reports";

import { prisma } from "../../db.js";
import { classifyStorageFailure, headRecordedObject } from "../../storage.js";
import { resolveEvidenceOutputEligibility } from "../billing/evidence-output-eligibility.service.js";
import { supersessionOrdinalOf } from "./output-recovery.service.js";

export const OUTPUT_RECOVERY_ASSESSMENTS = [
  "COMPLETE",
  "FIRST_ISSUANCE_REQUIRED",
  "PACKAGE_RECOVERY_REQUIRED",
  "REPORT_REGENERATION_REQUIRED",
  "ACTIVE_REQUEST",
  "TERMINAL_FAILURE_REQUIRES_SUPERSESSION",
  "NOT_ENTITLED",
  "NOT_APPLICABLE",
  /**
   * AUD-011 — the store did not answer about an output object (transient), or
   * refused us (permission / configuration). Nothing is known to be missing;
   * nothing is requested. Re-run status; a permission failure is an alert.
   */
  "STORAGE_UNAVAILABLE",
  "REFUSED_INTEGRITY_FAILURE",
] as const;
export type OutputRecoveryAssessmentKind = (typeof OUTPUT_RECOVERY_ASSESSMENTS)[number];

/** What a HEAD proves about the latest report's object. */
export type ReportObjectFinding =
  | "VERIFIABLE" // present, size as recorded, and at least one trusted hash source exists
  | "MISSING" // the store answered not-found for the recorded version
  | "UNAVAILABLE" // the store did not answer (transient): retry, never "missing"
  | "ACCESS_DENIED" // the store refused us or was addressed wrongly (permission / configuration)
  | "SIZE_MISMATCH" // present at another size than recorded
  | "HASH_MISMATCH" // two trusted hash sources disagree
  | "UNVERIFIABLE"; // present, but nothing can vouch for its bytes

export type OutputRecoveryAssessment = {
  evidenceId: string;
  assessment: OutputRecoveryAssessmentKind;
  /** Bounded reason — why this assessment, in a code an operator can grep. */
  reason: string;
  status: string | null;
  lifecycleState: string | null;
  latestReportVersion: number | null;
  latestReport: { version: number; finding: ReportObjectFinding; pdfSha256: string | null } | null;
  /** The package paired with the latest report, when one is published. */
  pairedPackage: {
    version: number;
    objectExists: boolean;
    /** AUD-011 — what the HEAD of its recorded version answered. */
    object: "PRESENT" | "NOT_FOUND" | "ACCESS_DENIED" | "TRANSIENT";
  } | null;
  /** The request a recovery would collapse onto or supersede. */
  request: { id: string; state: string; terminalReasonCode: string | null; ordinal: number } | null;
  /** The newest live (QUEUED / PROCESSING / FAILED_RETRYABLE) request of the record, if any. */
  activeRequestId: string | null;
  eligibility: { plan: string | null; report: string; package: string; reason: string | null };
  complete: boolean;
};

export type AssessmentIo = {
  head: (p: { bucket: string; key: string; versionId?: string | null }) => Promise<{
    sizeBytes: number | null;
    checksumSha256?: string | null;
  }>;
};

const LIVE_LIFECYCLE = new Set(["ACTIVE", "UNDER_REVIEW", "ON_HOLD", "RETENTION_LOCKED"]);
const ACTIVE_STATES = new Set(["QUEUED", "PROCESSING", "FAILED_RETRYABLE"]);

/** HEAD the object and grade what it proves. Never reads the body. */
export async function inspectReportObject(
  report: {
    storageBucket: string;
    storageKey: string;
    s3VersionId: string | null;
    sizeBytes: bigint | null;
    pdfSha256: string | null;
  },
  issuanceSha256: string | null,
  io: AssessmentIo,
): Promise<ReportObjectFinding> {
  let head: Awaited<ReturnType<AssessmentIo["head"]>>;
  try {
    head = await io.head({ bucket: report.storageBucket, key: report.storageKey, versionId: report.s3VersionId });
  } catch (err) {
    // THE shared classifier (status + error name, the bucket confirmed): a
    // transport or permission failure is never "missing".
    switch (classifyStorageFailure(err)) {
      case "NOT_FOUND":
        return "MISSING";
      case "ACCESS_DENIED":
        return "ACCESS_DENIED";
      default:
        return "UNAVAILABLE";
    }
  }
  if (report.sizeBytes != null && head.sizeBytes != null && BigInt(head.sizeBytes) !== report.sizeBytes) {
    return "SIZE_MISMATCH";
  }
  const sources = new Set<string>();
  if (report.pdfSha256) sources.add(report.pdfSha256.toLowerCase());
  if (issuanceSha256 && /^[0-9a-f]{64}$/i.test(issuanceSha256)) sources.add(issuanceSha256.toLowerCase());
  const stored = head.checksumSha256 ?? null;
  if (stored && !stored.includes("-")) sources.add(Buffer.from(stored, "base64").toString("hex"));
  if (sources.size > 1) return "HASH_MISMATCH";
  return sources.size === 1 ? "VERIFIABLE" : "UNVERIFIABLE";
}

/** The head of a request chain at one idempotency base key (ordinal-aware). */
async function chainHead(evidenceId: string, baseKey: string) {
  const rows = await prisma.reportGenerationRequest.findMany({
    where: {
      evidenceId,
      OR: [{ idempotencyKey: baseKey }, { idempotencyKey: { startsWith: `${baseKey}:s` } }],
    },
    select: { id: true, state: true, terminalReasonCode: true, idempotencyKey: true },
  });
  let head: (typeof rows)[number] | null = null;
  let headOrdinal = -1;
  for (const r of rows) {
    const ordinal = supersessionOrdinalOf(r.idempotencyKey);
    if (ordinal >= headOrdinal) {
      head = r;
      headOrdinal = ordinal;
    }
  }
  return head ? { id: head.id, state: head.state, terminalReasonCode: head.terminalReasonCode, ordinal: headOrdinal } : null;
}

export async function assessEvidenceOutputRecovery(
  ev: { id: string; ownerUserId: string; teamId: string | null },
  io: AssessmentIo = { head: (p) => headRecordedObject({ ...p, withChecksum: true }) },
): Promise<OutputRecoveryAssessment> {
  const row = await prisma.evidence.findUnique({
    where: { id: ev.id },
    select: { status: true, lifecycleState: true },
  });
  const eligibility = await resolveEvidenceOutputEligibility({
    evidenceId: ev.id,
    ownerUserId: ev.ownerUserId,
    teamId: ev.teamId,
  });
  const latest = await prisma.report.findFirst({
    where: { evidenceId: ev.id },
    orderBy: { version: "desc" },
    select: {
      version: true,
      storageBucket: true,
      storageKey: true,
      s3VersionId: true,
      sizeBytes: true,
      pdfSha256: true,
    },
  });
  const issuance = latest
    ? await prisma.custodyEvent.findFirst({
        where: {
          evidenceId: ev.id,
          eventType: "REPORT_GENERATED",
          payload: { path: ["reportVersion"], equals: latest.version },
        },
        orderBy: { sequence: "asc" },
        select: { payload: true },
      })
    : null;
  const issuanceSha = (issuance?.payload as { pdfSha256?: unknown } | null)?.pdfSha256;
  const finding = latest
    ? await inspectReportObject(latest, typeof issuanceSha === "string" ? issuanceSha : null, io)
    : null;

  const paired = latest
    ? await prisma.verificationPackage
        .findMany({
          where: primaryPublishedPackageWhere({ evidenceId: ev.id, reportVersion: latest.version }),
          select: { version: true, reportVersion: true, storageBucket: true, storageKey: true, packageSha256: true, s3VersionId: true },
          orderBy: { version: "desc" },
          take: 1,
        })
        .then((rows) => rows.map(asPublishedPackage)[0] ?? null)
    : null;
  // The paired package's RECORDED version, classified like the report's: a
  // transient or permission failure is not a missing package (AUD-011).
  let pairedObject: "PRESENT" | "NOT_FOUND" | "ACCESS_DENIED" | "TRANSIENT" = "PRESENT";
  if (paired) {
    try {
      const head = await io.head({
        bucket: paired.storageBucket,
        key: paired.storageKey,
        versionId: (paired as { s3VersionId?: string | null }).s3VersionId ?? null,
      });
      if (head.sizeBytes != null && head.sizeBytes <= 0) pairedObject = "NOT_FOUND";
    } catch (err) {
      pairedObject = classifyStorageFailure(err);
    }
  }
  const pairedExists = paired != null && pairedObject === "PRESENT";

  // The chain a recovery would act on: the package at the latest version, or
  // the record's first report.
  const baseKey = latest
    ? buildReportGenerationIdempotencyKey({
        artifactType: "VERIFICATION_PACKAGE",
        evidenceId: ev.id,
        baselineVersion: latest.version,
        forceRegenerate: false,
      })
    : buildReportGenerationIdempotencyKey({
        artifactType: "REPORT",
        evidenceId: ev.id,
        baselineVersion: 0,
        forceRegenerate: false,
      });
  const head = await chainHead(ev.id, baseKey);
  // Any live request for this record (whatever its key) is work in flight.
  const live = await prisma.reportGenerationRequest.findFirst({
    where: { evidenceId: ev.id, state: { in: [...ACTIVE_STATES] as never } },
    orderBy: { createdAtUtc: "desc" },
    select: { id: true, state: true, terminalReasonCode: true, idempotencyKey: true, artifactType: true },
  });

  const complete =
    row?.status === "REPORTED" && finding === "VERIFIABLE" && paired != null && pairedExists;

  const base = {
    evidenceId: ev.id,
    status: row?.status ?? null,
    lifecycleState: row?.lifecycleState ?? null,
    latestReportVersion: latest?.version ?? null,
    latestReport: latest ? { version: latest.version, finding: finding!, pdfSha256: latest.pdfSha256 } : null,
    pairedPackage: paired ? { version: paired.version, objectExists: pairedExists, object: pairedObject } : null,
    request: head,
    activeRequestId: live?.id ?? null,
    eligibility: {
      plan: eligibility.plan ?? null,
      report: String(eligibility.reportEligibility),
      package: String(eligibility.packageEligibility),
      reason: eligibility.ineligibilityReason ?? null,
    },
    complete,
  };
  const decide = (assessment: OutputRecoveryAssessmentKind, reason: string): OutputRecoveryAssessment => ({
    ...base,
    assessment,
    reason,
  });

  if (complete) return decide("COMPLETE", "PAIR_PUBLISHED");
  if (!row || !LIVE_LIFECYCLE.has(String(row.lifecycleState))) {
    return decide("NOT_APPLICABLE", `LIFECYCLE_${String(row?.lifecycleState ?? "UNKNOWN")}`);
  }

  // A regeneration already in flight is the answer to an unusable report.
  if (live && live.artifactType === "REPORT") return decide("ACTIVE_REQUEST", `REQUEST_${live.state}`);

  // ---- The report the package would embed must be one we can vouch for ----
  if (row.status === "REPORTED" && latest) {
    switch (finding) {
      case "MISSING":
      case "UNVERIFIABLE":
        // Never package unknown bytes. The canonical way forward is a new,
        // verified report version (and its package) — when entitled.
        return eligibility.reportEligibility === "ELIGIBLE" && eligibility.packageEligibility === "ELIGIBLE"
          ? decide("REPORT_REGENERATION_REQUIRED", finding === "MISSING" ? "REPORT_OBJECT_MISSING" : "REPORT_INTEGRITY_UNVERIFIABLE")
          : decide("NOT_ENTITLED", `REPORT_${finding}_AND_${String(eligibility.reportEligibility)}`);
      case "SIZE_MISMATCH":
      case "HASH_MISMATCH":
        // Altered bytes are a person's matter: neither packaged nor replaced.
        return decide("REFUSED_INTEGRITY_FAILURE", `REPORT_${finding}`);
      case "UNAVAILABLE":
        return decide("STORAGE_UNAVAILABLE", "REPORT_OBJECT_STORAGE_TRANSIENT_RETRY_STATUS");
      case "ACCESS_DENIED":
        return decide("STORAGE_UNAVAILABLE", "REPORT_OBJECT_STORAGE_ACCESS_DENIED");
      default:
        break;
    }
  }

  if (live) {
    return decide("ACTIVE_REQUEST", `REQUEST_${live.state}`);
  }

  if (head?.state === "FAILED_TERMINAL") {
    const cls = classifyTerminalReason(head.terminalReasonCode);
    if (cls === "INTEGRITY") return decide("REFUSED_INTEGRITY_FAILURE", head.terminalReasonCode ?? "INTEGRITY");
    if (cls === "TECHNICAL") {
      return head.ordinal >= MAX_TERMINAL_SUPERSESSIONS
        ? decide("REFUSED_INTEGRITY_FAILURE", "SUPERSESSION_BUDGET_EXHAUSTED")
        : decide("TERMINAL_FAILURE_REQUIRES_SUPERSESSION", head.terminalReasonCode ?? "TECHNICAL");
    }
    // COMMERCIAL / POLICY terminals are superseded by the writer itself once
    // their cause is gone; entitlement below decides.
  }

  if (row.status === "SIGNED" && !latest) {
    return eligibility.reportEligibility === "ELIGIBLE"
      ? decide("FIRST_ISSUANCE_REQUIRED", "SIGNED_WITHOUT_REPORT")
      : decide("NOT_ENTITLED", String(eligibility.reportEligibility));
  }
  if (row.status === "REPORTED" && latest && paired && !pairedExists) {
    // AUD-011 — the store did not answer, or refused us: nothing is known to
    // be missing. Never an integrity refusal for a transport failure.
    if (pairedObject === "TRANSIENT") return decide("STORAGE_UNAVAILABLE", "PAIRED_PACKAGE_STORAGE_TRANSIENT_RETRY_STATUS");
    if (pairedObject === "ACCESS_DENIED") return decide("STORAGE_UNAVAILABLE", "PAIRED_PACKAGE_STORAGE_ACCESS_DENIED");
    // A PUBLISHED package row whose recorded version is GONE: the worker counts
    // the pair complete from its row, so a package-only request would build
    // nothing, and the row is immutable history. The recovery is one new,
    // verified, correctly paired version — when entitled.
    return eligibility.reportEligibility === "ELIGIBLE" && eligibility.packageEligibility === "ELIGIBLE"
      ? decide("REPORT_REGENERATION_REQUIRED", "PAIRED_PACKAGE_OBJECT_MISSING")
      : decide("NOT_ENTITLED", `PAIRED_PACKAGE_MISSING_AND_${String(eligibility.packageEligibility)}`);
  }
  if (row.status === "REPORTED" && latest && !paired) {
    return eligibility.packageEligibility === "ELIGIBLE"
      ? decide("PACKAGE_RECOVERY_REQUIRED", "NO_PACKAGE_FOR_LATEST_REPORT")
      : decide("NOT_ENTITLED", String(eligibility.packageEligibility));
  }
  if (row.status === "REPORTED" && !latest) return decide("REFUSED_INTEGRITY_FAILURE", "REPORT_MISSING_FOR_REPORTED_EVIDENCE");
  return decide("NOT_APPLICABLE", `STATUS_${String(row.status)}`);
}
