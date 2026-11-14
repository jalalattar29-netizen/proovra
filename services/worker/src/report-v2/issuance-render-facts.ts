import type { ReportV2Input } from "./types.js";

/**
 * F-05 (2026-11-13) — the three issuance facts every PUBLISHED report is
 * rendered with. They used to reach only a provisional render whose bytes were
 * discarded, so the issued PDF printed a QR for a withdrawn page and omitted
 * the certification and capture-manifest statements.
 */
export type ReportIssuanceRenderFacts = {
  publicVerificationPublished: boolean;
  certifiedOriginal: ReportV2Input["certifiedOriginal"];
  captureManifest: ReportV2Input["captureManifest"];
};

/**
 * The canonical page opens without login and without owner publication. Only
 * a legal/privacy/security withdrawal makes it unavailable; a temporarily
 * unavailable page keeps its printed link (the reference will answer again).
 */
export function verificationPageOpensAtIssuance(verificationAccessState: string | null | undefined): boolean {
  return verificationAccessState !== "WITHDRAWN";
}

/**
 * The issuance facts from what preparation established. The report certifies
 * the original only for the recorded digest the stored bytes were re-read and
 * matched against; without one it makes no certification statement.
 */
export function buildReportIssuanceRenderFacts(input: {
  verificationAccessState: string | null | undefined;
  rereadMatchedDigest: string | null | undefined;
  objectVersionIds: ReadonlyArray<string | null>;
  rereadAtUtc: Date;
  captureManifest: ReportIssuanceRenderFacts["captureManifest"] | undefined;
}): ReportIssuanceRenderFacts {
  const digest = typeof input.rereadMatchedDigest === "string" ? input.rereadMatchedDigest.trim() : "";
  return {
    publicVerificationPublished: verificationPageOpensAtIssuance(input.verificationAccessState),
    certifiedOriginal: /^[0-9a-f]{64}$/i.test(digest)
      ? { recordedSha256: digest, objectVersionIds: input.objectVersionIds, rereadAtUtc: input.rereadAtUtc.toISOString() }
      : null,
    captureManifest: input.captureManifest ?? null,
  };
}
