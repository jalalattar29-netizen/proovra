/**
 * Phase 1B — Public-safe capture trust projection for the Verify page.
 *
 * Public-side projection of the ProvenanceChain (see
 * `provenance-projection.service.ts`). This module is the equivalent
 * of `verify-projection.service` but for capture-trust signals.
 *
 * Hard public-safety rules:
 *
 *   * NEVER exposes the device id, capture session id, location, or
 *     any operator-internal identifier. The public verify page only
 *     surfaces bounded vocabulary the visitor needs to understand
 *     "what PROOVRA recorded about this artifact's capture".
 *   * EMITS ONLY bounded enums + counts. No raw provider metadata.
 *   * NEVER asserts authenticity / admissibility. Phase 0 P6.
 *   * Standing limitations are ALWAYS included so the visitor sees
 *     the bounded disclaimer alongside any positive signal.
 *
 * Bounded shape:
 *   - provenanceClassLabel: human-readable label (e.g. "Class A — Verified at source").
 *   - captureMethod: one of CAPTURE_MODES.
 *   - signatureVerdict: one of CAPTURE_SIGNATURE_VERDICTS.
 *   - attestation: { provider, verdict } — bounded enums.
 *   - timeAnchors: { rfc3161Applied, otsApplied, otsConfirmations }.
 *   - countersigned: boolean.
 *   - trustEventCounts: { total, failures }.
 *   - limitations: standing bounded list.
 *   - advisory: bounded disclaimer string.
 */

import type { PrismaClient } from "@prisma/client";
import {
  PROVENANCE_CHAIN_SCHEMA_VERSION,
  STANDING_PROVENANCE_LIMITATIONS,
  provenanceClassLabel,
  type CaptureMode,
  type CaptureSignatureVerdict,
  type DeviceAttestationProvider,
  type DeviceAttestationVerdict,
  type ProvenanceLimitationCode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { projectProvenanceChain } from "./provenance-projection.service.js";

const PUBLIC_ADVISORY =
  "PROOVRA records the integrity primitives observed at capture: a hash, an optional at-source signature, an optional device attestation, and a server-side countersignature with trusted time. PROOVRA does not assert truth, authenticity, or legal admissibility about the recorded content. Independent verification is possible — see the methodology disclosure linked from the Trust hub.";

export type VerifyTrustProjection = {
  schemaVersion: typeof PROVENANCE_CHAIN_SCHEMA_VERSION;
  generatedAtUtc: string;
  evidenceId: string;
  provenanceClassLabel: string;
  captureMethod: CaptureMode;
  signatureVerdict: CaptureSignatureVerdict;
  attestation: {
    provider: DeviceAttestationProvider;
    verdict: DeviceAttestationVerdict;
  };
  timeAnchors: {
    rfc3161Applied: boolean;
    otsApplied: boolean;
    otsConfirmations: number | null;
  };
  countersigned: boolean;
  trustEventCounts: {
    total: number;
    failures: number;
  };
  limitations: ReadonlyArray<ProvenanceLimitationCode>;
  advisory: string;
};

export type VerifyTrustInput = {
  teamId: string;
  evidenceId: string;
  prisma?: PrismaClient;
};

/**
 * Build the public-safe trust projection. Returns null when there's
 * no surfaceable capture-trust data and no time anchors — i.e. the
 * artifact entered PROOVRA via the legacy non-trust path and there
 * is nothing meaningful to surface.
 */
export async function projectVerifyCaptureTrust(
  input: VerifyTrustInput,
): Promise<VerifyTrustProjection | null> {
  const prisma = input.prisma ?? defaultPrisma;
  if (!input.teamId || !input.evidenceId) return null;

  // Workspace-anchor the evidence read so cross-tenant leaks are impossible.
  const evidence = await prisma.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { id: true },
  });
  if (!evidence) return null;

  const chain = await projectProvenanceChain({ prisma, evidenceId: input.evidenceId });
  // If there is genuinely nothing to surface, return null so the
  // visitor sees no capture-trust block.
  const nothingToSay =
    chain.capture.signatureVerdict === "MISSING" &&
    chain.capture.attestationVerdict === "NOT_ATTEMPTED" &&
    !chain.server.countersigned &&
    !chain.time.rfc3161.applied &&
    !chain.time.ots.applied;
  if (nothingToSay) return null;

  return {
    schemaVersion: PROVENANCE_CHAIN_SCHEMA_VERSION,
    generatedAtUtc: chain.generatedAtUtc,
    evidenceId: chain.evidenceId,
    provenanceClassLabel: provenanceClassLabel(chain.capture.provenanceClass),
    captureMethod: chain.capture.mode,
    signatureVerdict: chain.capture.signatureVerdict,
    attestation: {
      provider: chain.capture.attestationProvider,
      verdict: chain.capture.attestationVerdict,
    },
    timeAnchors: {
      rfc3161Applied: chain.time.rfc3161.applied,
      otsApplied: chain.time.ots.applied,
      otsConfirmations: chain.time.ots.confirmations,
    },
    countersigned: chain.server.countersigned,
    trustEventCounts: {
      total: chain.trustEventSummary.total,
      failures: chain.trustEventSummary.failures,
    },
    limitations: STANDING_PROVENANCE_LIMITATIONS,
    advisory: PUBLIC_ADVISORY,
  };
}

export const VERIFY_CAPTURE_TRUST_ADVISORY = PUBLIC_ADVISORY;
