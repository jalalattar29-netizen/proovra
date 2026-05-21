/**
 * Phase C #12 — Extracted artifact-status helper.
 *
 * Side-effect-free reader for "are the post-finalization artifacts ready?".
 * Does NOT touch any custody, audit, view, or download counters. Carries
 * the same contract as the previous inline implementation in
 * services/api/src/routes/evidence.routes.ts so behavior is identical;
 * the goal is to shrink the routes monolith without changing semantics.
 *
 * Phase 32.5 — Verification package availability differentiation.
 * Personal-workspace evidence (no teamId) is deliberately NOT eligible
 * for verification package generation: the gate requires a governance
 * context, and personal workspaces have none. The helper now surfaces
 * this as `unavailable: true` (vs. `pending: true`) so the frontend can
 * render distinct copy:
 *   * `pending: true`      → "Package is being generated…" (poll for completion)
 *   * `unavailable: true`  → "Package not available for personal workspace evidence" (no poll, no retry)
 *   * `available: true`    → "Package ready" (offer download)
 */
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";

export type VerificationPackageUnavailableReason =
  | "personal_workspace_no_team_governance_context";

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
      }
    | {
        available: false;
        version: null;
        generatedAtUtc: null;
        reviewerSummaryVersion: null;
        verificationPackageVersion: null;
        pending: boolean;
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

  // Phase 32.5 — package is "unavailable" (not "pending") when the
  // evidence has no team — the gate would deny on missing governance
  // context, so the worker pre-skip never produced a package row.
  // This distinct state lets the frontend render the right copy
  // without endlessly polling.
  const packageUnavailableForPersonalWorkspace = finalized && !params.evidenceTeamId;

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
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          reviewerSummaryVersion: null,
          verificationPackageVersion: null,
          pending: reportPending,
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
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          packageType: null,
          pending: packagePending,
          unavailable: packageUnavailableForPersonalWorkspace,
          unavailableReason: packageUnavailableForPersonalWorkspace
            ? "personal_workspace_no_team_governance_context"
            : null,
          blocked: packageBlocked,
          blockedOutcome: packageBlocked ? blockedMeta!.outcome : null,
          blockedReason: packageBlocked ? blockedMeta!.reason : null,
          blockedAtUtc: packageBlocked ? blockedMeta!.blockedAtUtc : null,
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
