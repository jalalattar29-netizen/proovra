/**
 * UC-0 — the public Verify acquisition projection.
 *
 * Builds `PublicVerifyAcquisition` (@proovra/shared) — the ONE typed shape
 * `GET /public/verify/:id` emits as `acquisition` and the Verify page renders
 * verbatim. It replaced a flat `captureTrust` block that the page read through
 * a nested `chain.*` shape it never received, so every record rendered
 * MISSING / NOT_ATTEMPTED / false.
 *
 * Public-safe by construction: it is assembled from the provenance chain but
 * copies ONLY bounded enums, counts and server timestamps. It never carries a
 * device id, session id, IP, URL path, OCR text, object key, nonce, token or
 * digest. Acquisition is a neutral fact; nothing here is a "verified" signal.
 */

import type { PrismaClient } from "@prisma/client";
import {
  ACQUISITION_GLOBAL_QUALIFIER,
  ACQUISITION_LIMITATION_TEXT,
  PUBLIC_ACQUISITION_SCHEMA_VERSION,
  isPositiveAttestationVerdict,
  type EvidenceArtifactClassCounts,
  type ProvenanceChain,
  type PublicVerifyAcquisition,
} from "@proovra/shared";

import { loadProvenanceChain } from "./provenance-chain.js";

export async function loadEvidenceArtifactClassCounts(
  prisma: PrismaClient,
  evidenceId: string,
): Promise<EvidenceArtifactClassCounts> {
  const [grouped, derived] = await Promise.all([
    prisma.evidencePart.groupBy({
      by: ["artifactClass"],
      where: { evidenceId },
      _count: { _all: true },
    }),
    prisma.evidencePartDerivedAsset.count({
      where: { evidenceId, status: "COMPLETED" },
    }),
  ]);
  let original = 0;
  let captureRecord = 0;
  for (const g of grouped) {
    if (g.artifactClass === "CAPTURE_MANIFEST") captureRecord += g._count._all;
    else original += g._count._all;
  }
  // A single-object record has no part rows: its one stored object is the
  // original.
  if (original === 0 && captureRecord === 0) {
    const ev = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { storageKey: true },
    });
    if (ev?.storageKey) original = 1;
  }
  return { original, captureRecord, derived };
}

/** Pure mapping from the chain — exported so the contract is testable. */
export function toPublicVerifyAcquisition(
  chain: ProvenanceChain,
  input: {
    integrityEstablishedAtUtc: string | null;
    artifacts: EvidenceArtifactClassCounts;
  },
): PublicVerifyAcquisition {
  const a = chain.acquisition;
  const bound = chain.captureSession && chain.captureSession.status === "BOUND"
    ? chain.captureSession
    : null;
  const attestationApplicable = chain.capture.attestationVerdict !== "NOT_ATTEMPTED";
  return {
    schemaVersion: PUBLIC_ACQUISITION_SCHEMA_VERSION,
    acquisition: {
      mode: a.mode,
      category: a.category,
      recorded: a.recorded,
      recordedBy: a.recordedBy,
      label: a.label,
      statement: a.statement,
      isDirectCapture: a.isDirectCapture,
    },
    captureSession: bound
      ? {
          startedAtUtc: bound.startedAtUtc,
          endedAtUtc: bound.endedAtUtc,
          outcome: "BOUND",
          digestsConfirmed: bound.digestsConfirmed,
        }
      : null,
    deviceSignature: {
      applicable: chain.capture.deviceSignatureVerdict !== "MISSING",
      verdict: chain.capture.deviceSignatureVerdict,
    },
    deviceAttestation: {
      applicable: attestationApplicable,
      verdict: chain.capture.attestationVerdict,
      // The chain already passed through the reader gate; this can only be
      // true once a cryptographic verifier exists.
      verified: isPositiveAttestationVerdict(chain.capture.attestationVerdict),
    },
    integrity: {
      establishedAtUtc: input.integrityEstablishedAtUtc,
      establishedBy: "PROOVRA_SERVER_COMPLETION",
    },
    artifacts: input.artifacts,
    limitations: a.limitations.map((code) => ({
      code,
      text: ACQUISITION_LIMITATION_TEXT[code],
    })),
    qualifier: ACQUISITION_GLOBAL_QUALIFIER,
  };
}

export async function loadPublicVerifyAcquisition(
  prisma: PrismaClient,
  evidenceId: string,
): Promise<PublicVerifyAcquisition> {
  const [chain, evidence, artifacts] = await Promise.all([
    loadProvenanceChain(prisma, evidenceId),
    prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { signedAtUtc: true },
    }),
    loadEvidenceArtifactClassCounts(prisma, evidenceId),
  ]);
  return toPublicVerifyAcquisition(chain, {
    integrityEstablishedAtUtc: evidence?.signedAtUtc?.toISOString() ?? null,
    artifacts,
  });
}
