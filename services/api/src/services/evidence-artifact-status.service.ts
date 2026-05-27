/**
 * Phase C #12 — Extracted artifact-status helper.
 *
 * Side-effect-free reader for "are the post-finalization artifacts ready?".
 * Does NOT touch any custody, audit, view, or download counters.
 *
 * Phase 32.5 (historical) — Used to mark personal-workspace evidence as
 *   `unavailable: true` because the worker pre-skipped generation. That
 *   pre-skip was incorrect product semantics; see Phase 32.6.6 below.
 *
 * Phase 32.6.6 — Personal-workspace evidence now generates a PERSONAL
 *   BASIC verification package. The `unavailable` field is therefore
 *   always `false` for the personal-workspace case; personal packages
 *   transition the same `pending → available` flow as team packages.
 *   The field is retained in the public shape for backward compatibility
 *   with the Phase 32.6.4 frontend mapping (which already handles
 *   `unavailable: false` as the common case). The
 *   `unavailableReason` enum stays declared but is currently never
 *   produced; reserved for future cases (e.g., a workspace plan that
 *   genuinely excludes packages).
 *
 * State machine:
 *   * `pending: true`     → worker is generating; client should poll
 *   * `available: true`   → package ready; offer download
 *   * `blocked: true`     → team governance gate denied (legal hold /
 *                             destruction review / etc.); may unblock
 *                             when the governance condition resolves
 *   * `unavailable: true` → reserved; not produced by current code
 */
import * as prismaPkg from "@prisma/client";
import {
  PDF_SIGNING_UNAVAILABLE_COPY,
  PDF_UNSIGNED_OPT_OUT_WARNING_COPY,
  type PdfSignatureStatus,
  type ReportPdfSignatureProjection,
  type VerificationPackageSignatureProjection,
  type VerificationPackageSignatureStatus,
} from "@proovra/shared";
import { prisma } from "../db.js";

/**
 * Phase A2 — Bounded set of artifact signature status strings the
 * frontend may consume. Backed by the shared `PdfSignatureStatus`
 * union so the type system catches any drift.
 */
const PDF_STATUSES_RUNTIME: ReadonlySet<PdfSignatureStatus> = new Set([
  "SIGNED",
  "UNSIGNED_OPT_OUT",
  "SIGNING_UNAVAILABLE",
  "SIGNING_FAILED",
  "NOT_APPLICABLE",
]);

function normalizePdfSignatureStatus(
  raw: string | null,
): PdfSignatureStatus | null {
  if (!raw) return null;
  return PDF_STATUSES_RUNTIME.has(raw as PdfSignatureStatus)
    ? (raw as PdfSignatureStatus)
    : null;
}

/**
 * Resolve the operator-facing warning copy from a stored
 * pdf_signing_warning column. When the column is null and we know the
 * status, fall back to the canonical shared copy so the wire is
 * deterministic.
 */
function resolveWarningCopy(
  status: PdfSignatureStatus,
  stored: string | null,
): string | null {
  if (status === "SIGNED" || status === "NOT_APPLICABLE") return null;
  if (stored && stored.trim().length > 0) return stored;
  if (status === "UNSIGNED_OPT_OUT") return PDF_UNSIGNED_OPT_OUT_WARNING_COPY;
  if (status === "SIGNING_UNAVAILABLE") return PDF_SIGNING_UNAVAILABLE_COPY;
  return null;
}

/**
 * Phase 32.6.6 — Currently no value is produced for this enum (personal
 * evidence is now first-class). Kept declared for future use (e.g., a
 * plan-tier exclusion) and for backward-compat with the Phase 32.6.4
 * frontend mapping.
 */
export type VerificationPackageUnavailableReason = never;

export interface EvidenceArtifactStatus {
  evidenceId: string;
  status: prismaPkg.EvidenceStatus | null;
  finalized: boolean;
  report:
    | {
        available: true;
        version: number;
        generatedAtUtc: string;
        reviewerSummaryVersion: number | null;
        verificationPackageVersion: number | null;
        pending: false;
        // Phase A2 — explicit PDF artifact signature projection. The
        // frontend renders signed/unsigned badges ONLY from this
        // block. NEVER from labels or copy strings.
        pdfSignature: ReportPdfSignatureProjection;
      }
    | {
        available: false;
        version: null;
        generatedAtUtc: null;
        reviewerSummaryVersion: null;
        verificationPackageVersion: null;
        pending: boolean;
        pdfSignature: null;
      };
  // Phase 32.6.1 — `blocked` state distinct from pending / unavailable.
  //   pending     — worker is still working; client should poll
  //   ready       — `available: true`
  //   unavailable — won't ever generate (personal workspace, no team)
  //   blocked     — gate denied (legal hold / destruction review / etc.);
  //                  may become available later if gate condition resolves
  verificationPackage:
    | {
        available: true;
        version: number;
        generatedAtUtc: string;
        packageType: string | null;
        pending: false;
        unavailable: false;
        unavailableReason: null;
        blocked: false;
        blockedOutcome: null;
        blockedReason: null;
        blockedAtUtc: null;
        // Phase A2 — package manifest signature projection. Distinct
        // from PDF signature. Today the worker always signs the
        // manifest with Ed25519 (status SIGNED). Reserved values
        // exist in the union so a future opt-out can record them.
        manifestSignature: VerificationPackageSignatureProjection;
      }
    | {
        available: false;
        version: null;
        generatedAtUtc: null;
        packageType: null;
        pending: boolean;
        unavailable: boolean;
        unavailableReason: VerificationPackageUnavailableReason | null;
        // Phase 32.6.1 — gate-denial state. Reads from the bounded
        // `evidence.verificationPackageMetadata.blocked` shape the
        // worker writes after a PackageGateDeniedError.
        blocked: boolean;
        blockedOutcome: string | null;
        blockedReason: string | null;
        blockedAtUtc: string | null;
        manifestSignature: null;
      };
}

export async function buildEvidenceArtifactStatus(params: {
  evidenceId: string;
  evidenceStatus: prismaPkg.EvidenceStatus | null;
  /** Phase 32.5 — Required for verification-package availability
   *  reasoning. When null, the evidence belongs to a personal
   *  workspace and verification package generation is intentionally
   *  skipped (no governance context). */
  evidenceTeamId: string | null;
  /** Phase 32.6.1 — bounded JSON blob the worker writes after a
   *  PackageGateDeniedError. Shape:
   *    { blocked: true, outcome: string, reason: string,
   *      label: string, blockedAtUtc: ISO8601 }
   *  When null/undefined or `blocked !== true`, the package is
   *  treated as "not blocked" (either pending, available, or
   *  unavailable for personal workspace). */
  evidenceVerificationPackageMetadata?: prismaPkg.Prisma.JsonValue | null;
}): Promise<EvidenceArtifactStatus> {
  const { evidenceId } = params;
  const [latestReport, latestPackage] = await Promise.all([
    prisma.report.findFirst({
      where: { evidenceId },
      orderBy: { version: "desc" },
      select: {
        version: true,
        generatedAtUtc: true,
        verificationPackageVersion: true,
        reviewerSummaryVersion: true,
        // Phase A2 — explicit PDF signature columns.
        pdfSignatureStatus: true,
        pdfSignedAtUtc: true,
        pdfSignerKeyId: true,
        pdfSigningWarning: true,
      },
    }),
    prisma.verificationPackage.findFirst({
      where: { evidenceId },
      orderBy: { version: "desc" },
      select: {
        version: true,
        generatedAtUtc: true,
        packageType: true,
      },
    }),
  ]);

  const finalized =
    params.evidenceStatus === prismaPkg.EvidenceStatus.SIGNED ||
    params.evidenceStatus === prismaPkg.EvidenceStatus.REPORTED;

  const reportPending = finalized && !latestReport;

  // Phase 32.6.6 — personal-workspace evidence is now first-class.
  // The worker generates a PERSONAL BASIC package (no governance
  // gate); the personal-workspace `unavailable` derivation is
  // therefore retired. The field is retained on the response shape
  // for backward-compat with the Phase 32.6.4 frontend mapping but
  // always set to `false`.
  const packageUnavailableForPersonalWorkspace = false;

  // Phase 32.6.1 — read the bounded gate-denial metadata the worker
  // persists after PackageGateDeniedError. Distinguishes "blocked by
  // governance" from "still pending" so the frontend doesn't poll
  // forever for a package that will only become available when the
  // governance condition resolves.
  const blockedMeta = readBlockedMetadata(
    params.evidenceVerificationPackageMetadata ?? null,
  );
  const packageBlocked = finalized && !latestPackage && blockedMeta !== null;

  const packagePending =
    finalized &&
    !latestPackage &&
    !packageUnavailableForPersonalWorkspace &&
    !packageBlocked;

  // Phase A2 — project the PDF signature block. When the Report row
  // pre-dates A2, `pdfSignatureStatus` is NULL — we surface this as
  // `SIGNING_UNAVAILABLE` with the canonical operator warning copy
  // so the frontend never accidentally renders a signed badge on a
  // legacy row.
  const pdfSignature: ReportPdfSignatureProjection | null = latestReport
    ? (() => {
        const status: PdfSignatureStatus =
          normalizePdfSignatureStatus(latestReport.pdfSignatureStatus) ??
          "SIGNING_UNAVAILABLE";
        return {
          status,
          signedAtUtc:
            status === "SIGNED" && latestReport.pdfSignedAtUtc
              ? latestReport.pdfSignedAtUtc.toISOString()
              : null,
          signerKeyId:
            status === "SIGNED" ? (latestReport.pdfSignerKeyId ?? null) : null,
          warning: resolveWarningCopy(
            status,
            latestReport.pdfSigningWarning ?? null,
          ),
        };
      })()
    : null;

  // Phase A2 — manifest signature block. Today the worker always
  // signs the Verification Package manifest with Ed25519 (the
  // `MANIFEST.json.sig` artifact + the offline_verifier.html
  // bundle); the package is SIGNED whenever it exists. The bounded
  // union reserves UNSIGNED for a future opt-out path so we don't
  // ship a status the contract cannot describe.
  const manifestSignature: VerificationPackageSignatureProjection | null =
    latestPackage
      ? {
          status: "SIGNED" as VerificationPackageSignatureStatus,
          signerKeyId:
            (process.env.PACKAGE_SIGNING_KEY_ID ?? "").trim() || null,
        }
      : null;

  return {
    evidenceId,
    status: params.evidenceStatus,
    finalized,
    report: latestReport
      ? {
          available: true,
          version: latestReport.version,
          generatedAtUtc: latestReport.generatedAtUtc.toISOString(),
          reviewerSummaryVersion: latestReport.reviewerSummaryVersion ?? null,
          verificationPackageVersion:
            latestReport.verificationPackageVersion ?? null,
          pending: false,
          pdfSignature: pdfSignature!,
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          reviewerSummaryVersion: null,
          verificationPackageVersion: null,
          pending: reportPending,
          pdfSignature: null,
        },
    verificationPackage: latestPackage
      ? {
          available: true,
          version: latestPackage.version,
          generatedAtUtc: latestPackage.generatedAtUtc.toISOString(),
          packageType: latestPackage.packageType ?? null,
          pending: false,
          unavailable: false,
          unavailableReason: null,
          blocked: false,
          blockedOutcome: null,
          blockedReason: null,
          blockedAtUtc: null,
          manifestSignature: manifestSignature!,
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          packageType: null,
          pending: packagePending,
          // Phase 32.6.6 — always false for personal-workspace path
          // (personal evidence now generates a BASIC package). The
          // field is retained for backward-compat with the Phase
          // 32.6.4 frontend mapping.
          unavailable: packageUnavailableForPersonalWorkspace,
          unavailableReason: null,
          blocked: packageBlocked,
          blockedOutcome: packageBlocked ? blockedMeta!.outcome : null,
          blockedReason: packageBlocked ? blockedMeta!.reason : null,
          blockedAtUtc: packageBlocked ? blockedMeta!.blockedAtUtc : null,
          manifestSignature: null,
        },
  };
}

/**
 * Phase 32.6.1 — bounded reader for the gate-denial JSON the worker
 * writes after a PackageGateDeniedError. Returns null when the blob
 * is absent / malformed / not a denial record.
 *
 * Defensive: NEVER throws. The shape is purely informational; if
 * fields are missing, return null and the caller treats the package
 * as not-blocked.
 */
function readBlockedMetadata(
  raw: prismaPkg.Prisma.JsonValue | null,
): { outcome: string; reason: string; label: string | null; blockedAtUtc: string | null } | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.blocked !== true) return null;
  const outcome = typeof obj.outcome === "string" ? obj.outcome : null;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  if (!outcome || !reason) return null;
  return {
    outcome,
    reason,
    label: typeof obj.label === "string" ? obj.label : null,
    blockedAtUtc:
      typeof obj.blockedAtUtc === "string" ? obj.blockedAtUtc : null,
  };
}
