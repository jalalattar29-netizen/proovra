/**
 * PHASE 12B (Evidence Operations) — Public-safe redaction projection
 * for the token-bound Verify product.
 *
 * REPLACES the anonymous `GET /v1/redaction/public/verify/:evidenceId`
 * route, which was a bare evidenceId existence probe: no rate limit, no
 * publication-state gate, no integrity gate, no destroyed-record gate,
 * no finalization gate, no audit row. That shape let an unauthenticated
 * caller enumerate the UUID space for "does a published redaction exist
 * for this id" against records the canonical Verify product would have
 * refused outright.
 *
 * The capability itself is preserved in full and moves behind the
 * canonical token-bound authority `GET /public/verify/:id`
 * (services/api/src/routes/evidence.routes.ts), which already enforces:
 *   * two-bucket rate limiting (per-IP and per-evidence),
 *   * `publicVerifyState === "PUBLISHED"` publication gate,
 *   * FAILED_HASH_MISMATCH integrity gate (404, anti-enumeration),
 *   * DESTROYED lifecycle gate (404, anti-enumeration),
 *   * finalization gate (SIGNED / REPORTED only),
 *   * `verification.page_opened` audit on every outcome.
 * Every field the deleted route emitted is carried below, verbatim in
 * meaning: hasPublishedDerivative, publishedVersionOrdinal,
 * publishedAtUtc, approvalCount, videoProvenance{totalFrames,
 * acceptedTracks}, and the four standing redaction limitation codes.
 *
 * Public-safety rules (unchanged from the deleted route, and tightened):
 *   * NEVER region geometry, NEVER detection text, NEVER rationale,
 *     NEVER approver identity, NEVER project/version ids.
 *   * Counts + bounded enum codes only.
 *   * Workspace-anchored: the redaction project must belong to the SAME
 *     workspace as the evidence being verified. The deleted route did
 *     not anchor at all — it matched on evidenceId across every tenant.
 *   * Never throws. Returns null when there is nothing surfaceable, so
 *     the verify response shape is unaffected for non-redacted records.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export const REDACTION_PUBLIC_VERIFY_LIMITATIONS = [
  "REDACTION_NEVER_MODIFIES_ORIGINAL",
  "REDACTION_DERIVATIVE_IS_NOT_ORIGINAL",
  "REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT",
  "REDACTION_TRACKING_IS_PROVENANCE_ONLY",
] as const;

export type RedactionPublicVerifyLimitation =
  (typeof REDACTION_PUBLIC_VERIFY_LIMITATIONS)[number];

export type VerifyRedactionProjection = {
  /** True when a PUBLISHED redaction version exists for this evidence. */
  hasPublishedDerivative: boolean;
  /** Ordinal of the most recently published version. */
  publishedVersionOrdinal: number | null;
  /** UTC ISO publication timestamp of that version. */
  publishedAtUtc: string | null;
  /** How many human approvals that version carries. Count only. */
  approvalCount: number;
  /**
   * Bounded video provenance counts. Null when this evidence has no
   * extracted frames (i.e. it is not a tracked video redaction).
   */
  videoProvenance: {
    totalFrames: number;
    acceptedTracks: number;
  } | null;
  /** Standing bounded limitation codes — always present. */
  limitations: ReadonlyArray<RedactionPublicVerifyLimitation>;
};

export async function projectVerifyRedaction(
  input: {
    /** Workspace that owns the evidence being verified. */
    teamId: string | null;
    evidenceId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<VerifyRedactionProjection | null> {
  if (!input.teamId) return null;
  try {
    const project = await client.redactionProject.findFirst({
      // Workspace anchoring — the deleted public route had none.
      where: { evidenceId: input.evidenceId, teamId: input.teamId },
      select: {
        id: true,
        versions: {
          where: { state: "PUBLISHED" },
          select: {
            versionOrdinal: true,
            publishedAtUtc: true,
            approvals: { select: { id: true } },
          },
          orderBy: { publishedAtUtc: "desc" },
          take: 1,
        },
      },
    });

    const totalFramesCount = await client.videoFrame.count({
      where: { evidenceId: input.evidenceId, teamId: input.teamId },
    });

    // Nothing surfaceable: no redaction project AND no extracted video
    // frames. Keep the verify payload clean for the common case.
    if (!project && totalFramesCount === 0) return null;

    const published = project?.versions[0] ?? null;
    const acceptedTracksCount =
      totalFramesCount > 0
        ? await client.videoTrack.count({
            where: {
              evidenceId: input.evidenceId,
              teamId: input.teamId,
              state: "ACCEPTED",
            },
          })
        : 0;

    return {
      hasPublishedDerivative: published !== null,
      publishedVersionOrdinal: published?.versionOrdinal ?? null,
      publishedAtUtc: published?.publishedAtUtc?.toISOString() ?? null,
      approvalCount: published?.approvals.length ?? 0,
      videoProvenance:
        totalFramesCount > 0
          ? {
              totalFrames: totalFramesCount,
              acceptedTracks: acceptedTracksCount,
            }
          : null,
      limitations: REDACTION_PUBLIC_VERIFY_LIMITATIONS,
    };
  } catch {
    // Never break the verify response on a redaction-side read failure.
    return null;
  }
}
