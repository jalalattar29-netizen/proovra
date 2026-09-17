/**
 * UC-0 — THE provenance-chain projection (PROOVRA_PROVENANCE_CHAIN_V2).
 *
 * One implementation for both hosts. The API used to carry one copy and the
 * Worker another, kept "in lockstep" by hand, and both inferred the capture
 * mode from `captureEnvironment.uploadSource` — which was inverted for the
 * mobile and citizen routes — or from `captureMethod`, which completion
 * overwrites with a structure value. Both are gone:
 *
 *   * `capture.mode` and `acquisition` come ONLY from
 *     `resolveEvidenceAcquisition(Evidence.acquisitionMode, …Source)`. A trust
 *     event payload can never change the mode.
 *   * the session is the server-issued CaptureSession bound to the record
 *     (`finalizedEvidenceId`); its pre-bind events are read by session id.
 *   * an attestation verdict passes through the reader gate
 *     (`projectRecordedAttestationVerdict`), so no verdict written by the old
 *     metadata-trusting verifier can surface as verified.
 *   * derived review materials come from `EvidencePartDerivedAsset`.
 *
 * Read-only. Callers authorize.
 */

import type { PrismaClient } from "@prisma/client";
import {
  PROVENANCE_CHAIN_SCHEMA_VERSION,
  STANDING_PROVENANCE_LIMITATIONS,
  derivedAssetTransformationForKind,
  describeDeviceSignatureVerdict,
  projectRecordedAttestationVerdict,
  resolveEvidenceAcquisition,
  type CaptureProvenanceClass,
  type CaptureSignatureVerdict,
  type DeviceAttestationProvider,
  type DeviceAttestationVerdict,
  type ProvenanceChain,
} from "@proovra/shared";

const SIGNATURE_VERDICTS: ReadonlyArray<string> = [
  "VALID",
  "INVALID_SIGNATURE",
  "INVALID_HASH",
  "INVALID_CANONICAL_JSON",
  "UNKNOWN_DEVICE",
  "MISSING",
  "ALGORITHM_UNSUPPORTED",
];

const ATTESTATION_PROVIDERS: ReadonlyArray<string> = [
  "APPLE_APP_ATTEST",
  "GOOGLE_PLAY_INTEGRITY",
  "TEE_ONLY",
  "NONE",
];

const FAILURE_CODES: ReadonlySet<string> = new Set([
  "ATTESTATION_FAILED",
  "ATTESTATION_REPLAY_DETECTED",
  "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
  "CAPTURE_POLICY_DEGRADED",
  "CAPTURE_SESSION_INTERRUPTED",
]);

const SIGNATURE_BEARING_CODES: ReadonlySet<string> = new Set([
  "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE",
  "CAPTURE_ARTIFACT_RECEIVED",
]);

type TrustRow = {
  code: string;
  atUtc: Date | null;
  deviceId: string | null;
  captureSessionId: string | null;
  payload: unknown;
};

export async function loadProvenanceChain(
  prisma: PrismaClient,
  evidenceId: string,
  now: Date = new Date(),
): Promise<ProvenanceChain> {
  const generatedAtUtc = now.toISOString();
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, acquisitionMode: true, acquisitionModeSource: true },
  });
  const acquisition = resolveEvidenceAcquisition({
    acquisitionMode: evidence?.acquisitionMode ?? null,
    acquisitionModeSource: evidence?.acquisitionModeSource ?? null,
  });

  const session = evidence
    ? await prisma.captureSession.findFirst({
        where: { finalizedEvidenceId: evidenceId, acquisitionMode: { not: null } },
        select: {
          id: true,
          status: true,
          deviceId: true,
          startedAtUtc: true,
          endedAtUtc: true,
        },
      })
    : null;

  const trustEvents: TrustRow[] = evidence
    ? await prisma.captureTrustEventRecord.findMany({
        where: session
          ? { OR: [{ evidenceId }, { captureSessionId: session.id }] }
          : { evidenceId },
        orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
        select: {
          code: true,
          atUtc: true,
          deviceId: true,
          captureSessionId: true,
          payload: true,
        },
        take: 400,
      })
    : [];

  // ----- capture-side facts ---------------------------------------------
  let sawSignature = false;
  let allSignaturesValid = true;
  let firstNonValid: CaptureSignatureVerdict | null = null;
  let signedAtUtc: string | null = null;
  let legacyClass: CaptureProvenanceClass | null = null;
  let deviceId: string | null = session?.deviceId ?? null;
  let sessionIdFromEvents: string | null = null;
  let digestsConfirmed = 0;
  let trustChainHeadHash: string | null = null;

  for (const ev of trustEvents) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (SIGNATURE_BEARING_CODES.has(ev.code)) {
      const v = typeof p["signatureVerdict"] === "string" ? p["signatureVerdict"] : null;
      if (v && SIGNATURE_VERDICTS.includes(v) && v !== "MISSING") {
        sawSignature = true;
        if (v !== "VALID") {
          allSignaturesValid = false;
          firstNonValid = firstNonValid ?? (v as CaptureSignatureVerdict);
        }
      }
      if (typeof p["signedAtUtc"] === "string" && !signedAtUtc) {
        signedAtUtc = p["signedAtUtc"];
      }
      // Pre-UC-0 rows carried a class; it is INTERNAL ordering only and can
      // never be A (no attestation was ever cryptographically verified).
      if (p["provenanceClass"] === "B" || p["provenanceClass"] === "C") {
        legacyClass = legacyClass ?? p["provenanceClass"];
      }
    }
    if (ev.code === "CAPTURE_SESSION_BOUND") {
      if (typeof p["digestsConfirmed"] === "number") digestsConfirmed = p["digestsConfirmed"];
      if (typeof p["trustChainHeadHash"] === "string") trustChainHeadHash = p["trustChainHeadHash"];
    }
    deviceId = deviceId ?? ev.deviceId;
    sessionIdFromEvents = sessionIdFromEvents ?? ev.captureSessionId;
  }

  const signatureVerdict: CaptureSignatureVerdict = !sawSignature
    ? "MISSING"
    : allSignaturesValid
      ? "VALID"
      : (firstNonValid ?? "INVALID_SIGNATURE");

  const provenanceClass: CaptureProvenanceClass =
    session && signatureVerdict === "VALID"
      ? "B"
      : legacyClass === "B" && signatureVerdict === "VALID"
        ? "B"
        : "C";

  const sessionId = session?.id ?? sessionIdFromEvents;

  // ----- attestation (reader-gated) -------------------------------------
  let attestationVerdict: DeviceAttestationVerdict = "NOT_ATTEMPTED";
  let attestationProvider: DeviceAttestationProvider = "NONE";
  if (sessionId !== null) {
    const att = await prisma.captureDeviceAttestation.findFirst({
      where: { captureSessionId: sessionId },
      orderBy: { createdAt: "desc" },
      select: { verdict: true, provider: true, verifierVersion: true },
    });
    if (att) {
      attestationVerdict = projectRecordedAttestationVerdict(att);
      attestationProvider = ATTESTATION_PROVIDERS.includes(att.provider)
        ? (att.provider as DeviceAttestationProvider)
        : "NONE";
    }
  }

  // ----- server countersignature + time anchoring -----------------------
  const custodyEvents = evidence
    ? await prisma.custodyEvent.findMany({
        where: {
          evidenceId,
          eventType: {
            in: ["SIGNATURE_APPLIED", "TIMESTAMP_APPLIED", "OTS_APPLIED", "ANCHOR_PUBLISHED"] as never,
          },
        },
        orderBy: { sequence: "asc" },
        select: { eventType: true, atUtc: true, payload: true },
        take: 50,
      })
    : [];

  let countersigned = false;
  let countersignKeyId: string | null = null;
  let countersignedAtUtc: string | null = null;
  let rfc3161Applied = false;
  let rfc3161TsaUrl: string | null = null;
  let rfc3161AtUtc: string | null = null;
  let otsApplied = false;
  let otsTxId: string | null = null;
  let otsAtUtc: string | null = null;
  let otsConfirmations: number | null = null;
  for (const ce of custodyEvents) {
    const p = (ce.payload ?? {}) as Record<string, unknown>;
    const type = String(ce.eventType);
    if (type === "SIGNATURE_APPLIED") {
      countersigned = true;
      const keyId = p["signingKeyId"] ?? p["keyId"];
      if (typeof keyId === "string") countersignKeyId = keyId;
      countersignedAtUtc = ce.atUtc.toISOString();
    } else if (type === "TIMESTAMP_APPLIED") {
      rfc3161Applied = true;
      const url = p["tsaUrl"];
      if (typeof url === "string") rfc3161TsaUrl = url;
      rfc3161AtUtc = ce.atUtc.toISOString();
    } else {
      otsApplied = true;
      if (typeof p["txId"] === "string") otsTxId = p["txId"];
      otsAtUtc = ce.atUtc.toISOString();
      if (typeof p["confirmations"] === "number") otsConfirmations = p["confirmations"];
    }
  }

  // ----- V1 record-level derivation edges -------------------------------
  const derivations = trustEvents
    .filter((e) => e.code === "CAPTURE_DERIVATION_CREATED")
    .slice(0, 50)
    .map((d) => {
      const p = (d.payload ?? {}) as Record<string, unknown>;
      return {
        derivedEvidenceId: typeof p["derivedEvidenceId"] === "string" ? p["derivedEvidenceId"] : "",
        transformLabel: typeof p["transform"] === "string" ? p["transform"] : "",
        derivedAtUtc: (d.atUtc ?? new Date(0)).toISOString(),
      };
    });

  // ----- V2 part-level derived review materials -------------------------
  const derivedArtifacts = evidence ? await loadDerivedArtifacts(prisma, evidenceId) : [];

  const failures = trustEvents.filter((e) => FAILURE_CODES.has(e.code)).length;
  const last = trustEvents[trustEvents.length - 1] ?? null;

  return {
    schemaVersion: PROVENANCE_CHAIN_SCHEMA_VERSION,
    generatedAtUtc,
    evidenceId,
    acquisition,
    captureSession: session
      ? {
          sessionId: session.id,
          status: String(session.status),
          startedAtUtc: session.startedAtUtc?.toISOString() ?? null,
          endedAtUtc: session.endedAtUtc?.toISOString() ?? null,
          digestsConfirmed,
          trustChainHeadHash,
        }
      : null,
    derivedArtifacts,
    capture: {
      mode: acquisition.mode,
      provenanceClass,
      sessionId,
      deviceId,
      deviceSignatureVerdict: signatureVerdict,
      deviceSignatureNote: describeDeviceSignatureVerdict(signatureVerdict),
      attestationVerdict,
      attestationProvider,
      signedAtUtc,
    },
    server: { countersigned, countersignKeyId, countersignedAtUtc },
    time: {
      rfc3161: { applied: rfc3161Applied, tsaUrl: rfc3161TsaUrl, appliedAtUtc: rfc3161AtUtc },
      ots: {
        applied: otsApplied,
        anchorTxId: otsTxId,
        appliedAtUtc: otsAtUtc,
        confirmations: otsConfirmations,
      },
    },
    derivations,
    trustEventSummary: {
      total: trustEvents.length,
      failures,
      lastEventAtUtc: last?.atUtc ? last.atUtc.toISOString() : null,
    },
    limitations: STANDING_PROVENANCE_LIMITATIONS,
  };
}

export async function loadDerivedArtifacts(
  prisma: PrismaClient,
  evidenceId: string,
): Promise<ProvenanceChain["derivedArtifacts"]> {
  const rows = await prisma.evidencePartDerivedAsset.findMany({
    where: { evidenceId },
    orderBy: [{ createdAtUtc: "asc" }],
    select: {
      evidencePartId: true,
      assetKind: true,
      variantKey: true,
      transformation: true,
      engineVersion: true,
      sourceSha256AtGeneration: true,
      derivedSha256: true,
      parametersSha256: true,
      status: true,
      generatedAtUtc: true,
    },
    take: 500,
  });
  if (rows.length === 0) return [];
  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId },
    select: { id: true, partIndex: true },
  });
  const indexById = new Map(parts.map((p) => [p.id, p.partIndex]));
  return rows.map((r) => ({
    artifactClass: "DERIVED" as const,
    sourcePartIndex: indexById.get(r.evidencePartId) ?? null,
    assetKind: r.assetKind,
    variantKey: r.variantKey,
    transformation: r.transformation ?? derivedAssetTransformationForKind(r.assetKind),
    engineVersion: r.engineVersion,
    sourceSha256AtGeneration: r.sourceSha256AtGeneration,
    derivedSha256: r.derivedSha256,
    parametersSha256: r.parametersSha256,
    status: r.status,
    generatedAtUtc: r.generatedAtUtc?.toISOString() ?? null,
  }));
}
