/**
 * Phase 1B — Worker-local ProvenanceChain projection.
 *
 * Pure Prisma-driven projection that assembles the bounded
 * `ProvenanceChain` (see `@proovra/shared/capture-trust`) for an
 * evidence row. Used by the worker's verification-package builder via
 * `load-provenance-chain.ts` so that `provenance/chain.json` can be
 * emitted into the verification ZIP.
 *
 * Why duplicated from `services/api/src/services/capture-trust/`:
 *   The worker is shipped as a SEPARATE Docker image
 *   (`services/worker/Dockerfile`). The API service's `src/` tree is
 *   NOT copied into that image — that would couple two services at
 *   image-build time and break the layered Dockerfile contract. Cross-
 *   service `../../../api/src/...` imports also fail TS resolution in
 *   any clean checkout because the worker's `tsconfig` doesn't include
 *   the API source roots.
 *
 *   The projection is small and PURE: it only reads from Prisma + the
 *   shared contract types. It has no Fastify, no auth, no route, no
 *   audit-event side effects. Both services already depend on
 *   `@prisma/client` + `@proovra/shared`, so the only "cost" of
 *   duplication is keeping the two copies in lockstep. The contract
 *   tests pin the output shape via `ProvenanceChain` from
 *   `@proovra/shared`, so any drift between the two copies surfaces
 *   immediately as a typecheck or contract-test failure.
 *
 * Hard rules (same as the API copy):
 *   * The projection is bounded — every field is in the bounded enum
 *     vocabulary declared in `@proovra/shared/capture-trust`.
 *   * Class C (bulk import) reads NEVER fabricate capture-side
 *     primitives — the projection honestly returns NOT_ATTEMPTED.
 *   * The projection is read-only — it NEVER emits trust events or
 *     mutates the DB.
 *   * Reads are bounded (≤ 6 small Prisma queries per projection).
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

import { prisma as defaultPrisma } from "../db.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export type ProvenanceProjectionInput = {
  prisma?: PrismaClient;
  evidenceId: string;
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
    select: { id: true, captureMethod: true },
  });
  if (!evidence) {
    return emptyProjection(evidenceId, generatedAtUtc, "BULK_IMPORT", "C");
  }

  // Intake evidence (submitted through a Secure Intake Link) never carries a
  // capture-trust device signature, so the capture-side mode must reflect the
  // intake workflow rather than defaulting to the misleading BULK_IMPORT.
  const isIntakeEvidence =
    String(evidence.captureMethod ?? "").toUpperCase() ===
    "EXTERNAL_INTAKE_UPLOAD";

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
  let mode: CaptureMode = isIntakeEvidence ? "SECURE_INTAKE_LINK" : "BULK_IMPORT";
  let provenanceClass: CaptureProvenanceClass = "C";
  let sessionId: string | null = null;
  let deviceId: string | null = null;
  let signatureVerdict: CaptureSignatureVerdict = "MISSING";
  let signedAtUtc: string | null = null;

  for (const ev of trustEvents) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    if (
      ev.code === "CAPTURE_ARTIFACT_RECEIVED" ||
      ev.code === "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE"
    ) {
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
    } else if (
      ce.eventType === "OTS_APPLIED" ||
      ce.eventType === "ANCHOR_PUBLISHED"
    ) {
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
          typeof p["transform"] === "string"
            ? (p["transform"] as string)
            : "",
        derivedAtUtc:
          d.atUtc != null ? d.atUtc.toISOString() : new Date(0).toISOString(),
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
