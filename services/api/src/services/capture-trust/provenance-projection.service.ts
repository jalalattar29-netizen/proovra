/**
 * Phase 1B — Provenance Chain projection.
 *
 * Single read API that assembles the bounded `ProvenanceChain`
 * (see `@proovra/shared/capture-trust`) for an evidence row. Consumed
 * by:
 *
 *   * Public Verify page (renders chain status + bounded limitations).
 *   * Reports aggregator (renders chain summary in PDF + Verification
 *     Package).
 *   * Verification Package builder (writes `provenance/chain.json`).
 *   * Trust pillar in-product surface.
 *
 * Hard rules:
 *   * The projection is bounded — every field is in the bounded enum
 *     vocabulary declared in `@proovra/shared/capture-trust`.
 *   * Class C (bulk import) reads NEVER fabricate capture-side
 *     primitives — the projection honestly returns NOT_ATTEMPTED.
 *   * Reads are workspace-anchored (when teamId provided) OR
 *     public-token-anchored (when called from the verify page). The
 *     caller is responsible for authorisation.
 *   * The projection is read-only — it NEVER emits trust events. The
 *     `PROVENANCE_PROJECTION_GENERATED` event is emitted by the
 *     caller (route / report builder) if persistence is desired.
 *
 * Read budget: ≤ 6 small Prisma queries per projection. Designed for
 * the verify-page hot path (cached upstream).
 */

import type { PrismaClient } from "@prisma/client";
import {
  PROVENANCE_CHAIN_SCHEMA_VERSION,
  STANDING_PROVENANCE_LIMITATIONS,
  describeDeviceSignatureVerdict,
  type CaptureMode,
  type CaptureProvenanceClass,
  type CaptureSignatureVerdict,
  type DeviceAttestationProvider,
  type DeviceAttestationVerdict,
  type ProvenanceChain,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export type ProvenanceProjectionInput = {
  prisma?: PrismaClient;
  evidenceId: string;
  /**
   * Reliable intake signal from the caller. Required because
   * `completeEvidence` overwrites `evidence.capture_method` to the structure
   * enum MULTIPART_PACKAGE, so the persisted capture method cannot identify
   * intake. When omitted, intake is inferred from
   * `capture_environment.uploadSource`.
   */
  isIntake?: boolean;
};

export async function projectProvenanceChain(
  input: ProvenanceProjectionInput,
): Promise<ProvenanceChain> {
  const prisma = input.prisma ?? defaultPrisma;
  const evidenceId = input.evidenceId;
  const generatedAtUtc = new Date().toISOString();

  // ----- Evidence root + certification fields ---------------------------
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, captureMethod: true, captureEnvironment: true },
  });
  if (!evidence) {
    return emptyProjection(evidenceId, generatedAtUtc, "BULK_IMPORT", "C");
  }

  // ----- Capture-trust events for this evidence -------------------------
  const trustEvents = await prisma.captureTrustEventRecord.findMany({
    where: { evidenceId },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      code: true,
      sequence: true,
      atUtc: true,
      deviceId: true,
      captureSessionId: true,
      payload: true,
    },
    take: 200,
  });

  // ----- Resolve capture-side mode, class, session, device, sig verdict --
  // We derive these from the trust-event timeline + the most-recent
  // attestation row. The verifier writes these as payload fields when
  // it emits CAPTURE_ARTIFACT_RECEIVED / CAPTURE_ARTIFACT_SIGNED_AT_SOURCE.
  // `completeEvidence` overwrites capture_method to the structure enum
  // MULTIPART_PACKAGE, so intake is detected from the caller-supplied signal
  // first, then the persisted capture_environment.uploadSource, and only then
  // the (pre-completion) capture_method.
  const uploadSource = String(
    (evidence.captureEnvironment as { uploadSource?: string } | null)
      ?.uploadSource ?? "",
  ).toUpperCase();
  const isIntakeEvidence =
    input.isIntake === true ||
    uploadSource === "INTAKE_LINK" ||
    String(evidence.captureMethod ?? "").toUpperCase() ===
      "EXTERNAL_INTAKE_UPLOAD";
  let mode: CaptureMode = isIntakeEvidence ? "SECURE_INTAKE_LINK" : "BULK_IMPORT";
  let provenanceClass: CaptureProvenanceClass = "C";
  let sessionId: string | null = null;
  let deviceId: string | null = null;
  let signatureVerdict: CaptureSignatureVerdict = "MISSING";
  let signedAtUtc: string | null = null;

  for (const ev of trustEvents) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.code === "CAPTURE_ARTIFACT_RECEIVED" || ev.code === "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE") {
      if (typeof payload["captureMode"] === "string") {
        mode = payload["captureMode"] as CaptureMode;
      }
      if (typeof payload["provenanceClass"] === "string") {
        provenanceClass = payload["provenanceClass"] as CaptureProvenanceClass;
      }
      if (typeof payload["signatureVerdict"] === "string") {
        signatureVerdict = payload["signatureVerdict"] as CaptureSignatureVerdict;
      }
      if (typeof payload["signedAtUtc"] === "string") {
        signedAtUtc = payload["signedAtUtc"] as string;
      }
    }
    sessionId = sessionId ?? ev.captureSessionId;
    deviceId = deviceId ?? ev.deviceId;
  }

  // ----- Most-recent attestation verdict for the session ----------------
  let attestationVerdict: DeviceAttestationVerdict = "NOT_ATTEMPTED";
  let attestationProvider: DeviceAttestationProvider = "NONE";
  if (sessionId !== null) {
    const att = await prisma.captureDeviceAttestation.findFirst({
      where: { captureSessionId: sessionId },
      orderBy: { verifiedAtUtc: "desc" },
      select: { verdict: true, provider: true },
    });
    if (att) {
      attestationVerdict = att.verdict as DeviceAttestationVerdict;
      attestationProvider = att.provider as DeviceAttestationProvider;
    }
  }

  // ----- Server countersignature + time anchoring -----------------------
  // The existing custody chain records SIGNATURE_APPLIED + TIMESTAMP_APPLIED
  // + OTS_APPLIED + ANCHOR_PUBLISHED events. We read those bounded events
  // to fill the projection.
  const custodyEvents = await prisma.custodyEvent.findMany({
    where: {
      evidenceId,
      eventType: {
        in: [
          "SIGNATURE_APPLIED",
          "TIMESTAMP_APPLIED",
          "OTS_APPLIED",
          "ANCHOR_PUBLISHED",
        ] as never,
      },
    },
    orderBy: { sequence: "asc" },
    select: {
      eventType: true,
      atUtc: true,
      payload: true,
    },
    take: 50,
  });

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
    if (ce.eventType === "SIGNATURE_APPLIED") {
      countersigned = true;
      countersignKeyId =
        typeof p["keyId"] === "string"
          ? (p["keyId"] as string)
          : countersignKeyId;
      countersignedAtUtc = ce.atUtc.toISOString();
    } else if (ce.eventType === "TIMESTAMP_APPLIED") {
      rfc3161Applied = true;
      rfc3161TsaUrl =
        typeof p["tsaUrl"] === "string"
          ? (p["tsaUrl"] as string)
          : rfc3161TsaUrl;
      rfc3161AtUtc = ce.atUtc.toISOString();
    } else if (ce.eventType === "OTS_APPLIED" || ce.eventType === "ANCHOR_PUBLISHED") {
      otsApplied = true;
      otsTxId =
        typeof p["txId"] === "string" ? (p["txId"] as string) : otsTxId;
      otsAtUtc = ce.atUtc.toISOString();
      if (typeof p["confirmations"] === "number") {
        otsConfirmations = p["confirmations"] as number;
      }
    }
  }

  // ----- Derivations (parent→derived edges) -----------------------------
  const derivations: Array<{
    derivedEvidenceId: string;
    transformLabel: string;
    derivedAtUtc: string;
  }> = [];
  try {
    const derivationEvents = await prisma.captureTrustEventRecord.findMany({
      where: { evidenceId, code: "CAPTURE_DERIVATION_CREATED" },
      orderBy: { sequence: "asc" },
      select: { atUtc: true, payload: true },
      take: 50,
    });
    for (const d of derivationEvents) {
      const p = (d.payload ?? {}) as Record<string, unknown>;
      derivations.push({
        derivedEvidenceId:
          typeof p["derivedEvidenceId"] === "string"
            ? (p["derivedEvidenceId"] as string)
            : "",
        transformLabel:
          typeof p["transform"] === "string" ? (p["transform"] as string) : "",
        derivedAtUtc: d.atUtc != null ? d.atUtc.toISOString() : new Date(0).toISOString(),
      });
    }
  } catch {
    // Optional surface.
  }

  // ----- Trust event summary --------------------------------------------
  const failures = trustEvents.filter((e) => isFailureCode(e.code)).length;
  const last = trustEvents[trustEvents.length - 1] ?? null;

  return {
    schemaVersion: PROVENANCE_CHAIN_SCHEMA_VERSION,
    generatedAtUtc,
    evidenceId,

    capture: {
      mode,
      provenanceClass,
      sessionId,
      deviceId,
      deviceSignatureVerdict: signatureVerdict,
      deviceSignatureNote: describeDeviceSignatureVerdict(signatureVerdict),
      attestationVerdict,
      attestationProvider,
      signedAtUtc,
    },

    server: {
      countersigned,
      countersignKeyId,
      countersignedAtUtc,
    },

    time: {
      rfc3161: {
        applied: rfc3161Applied,
        tsaUrl: rfc3161TsaUrl,
        appliedAtUtc: rfc3161AtUtc,
      },
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
      lastEventAtUtc: last?.atUtc != null ? last.atUtc.toISOString() : null,
    },

    limitations: STANDING_PROVENANCE_LIMITATIONS,
  };
}

function emptyProjection(
  evidenceId: string,
  generatedAtUtc: string,
  mode: CaptureMode,
  cls: CaptureProvenanceClass,
): ProvenanceChain {
  return {
    schemaVersion: PROVENANCE_CHAIN_SCHEMA_VERSION,
    generatedAtUtc,
    evidenceId,
    capture: {
      mode,
      provenanceClass: cls,
      sessionId: null,
      deviceId: null,
      deviceSignatureVerdict: "MISSING",
      deviceSignatureNote: describeDeviceSignatureVerdict("MISSING"),
      attestationVerdict: "NOT_ATTEMPTED",
      attestationProvider: "NONE",
      signedAtUtc: null,
    },
    server: {
      countersigned: false,
      countersignKeyId: null,
      countersignedAtUtc: null,
    },
    time: {
      rfc3161: { applied: false, tsaUrl: null, appliedAtUtc: null },
      ots: {
        applied: false,
        anchorTxId: null,
        appliedAtUtc: null,
        confirmations: null,
      },
    },
    derivations: [],
    trustEventSummary: { total: 0, failures: 0, lastEventAtUtc: null },
    limitations: STANDING_PROVENANCE_LIMITATIONS,
  };
}

function isFailureCode(code: string): boolean {
  return (
    code === "ATTESTATION_FAILED" ||
    code === "ATTESTATION_REPLAY_DETECTED" ||
    code === "CAPTURE_ARTIFACT_VERIFICATION_FAILED" ||
    code === "CAPTURE_POLICY_DEGRADED"
  );
}
