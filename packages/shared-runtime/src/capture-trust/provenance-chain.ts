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

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { canonicalJsonValue } from "@proovra/shared/custody-hash";
import {
  OTS_PROOF_STATUS_LABELS,
  PROVENANCE_CHAIN_SCHEMA_VERSION,
  TSA_PROOF_STATUS_LABELS,
  resolveOtsProofStatus,
  resolveTsaProofStatus,
  selectCaptureManifestFacts,
  type CaptureManifestFacts,
  type OtsProofStatus,
  type TsaProofStatus,
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
  teamId?: string;
  evidenceId?: string | null;
  sequence?: number;
  eventHash?: string;
  prevEventHash?: string | null;
};

// ---------------------------------------------------------------------------
// UC-TRUST-004 — THE TRUST-EVENT SUB-CHAIN, VERIFIED ON READ
// ---------------------------------------------------------------------------

/** The fields a trust-event hash covers. */
export type TrustEventHashInput = {
  teamId: string;
  code: string;
  captureSessionId: string | null;
  evidenceId: string | null;
  deviceId: string | null;
  sequence: number;
  atUtc: Date;
  payload: Record<string, unknown> | null;
  prevEventHash: string | null;
};

/**
 * v1 — the original writer's line: top-level payload keys sorted, nested
 * objects JSON.stringify'd in INSERTION order. A JSONB round-trip reorders
 * nested keys, so v1 is not reproducible from stored rows when a payload
 * nests objects. Kept so existing rows verify where they can.
 */
export function buildTrustEventHashV1(input: TrustEventHashInput): string {
  const payload = input.payload ?? {};
  const sortedPayload: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) sortedPayload[k] = payload[k];
  const line = JSON.stringify({
    teamId: input.teamId,
    code: input.code,
    captureSessionId: input.captureSessionId,
    evidenceId: input.evidenceId,
    deviceId: input.deviceId,
    sequence: input.sequence,
    atUtc: input.atUtc.toISOString(),
    payload: sortedPayload,
    prevEventHash: input.prevEventHash,
  });
  return createHash("sha256").update(line).digest("hex");
}

/**
 * v2 — full-depth canonical JSON (the SAME canon as the custody chain,
 * `canonicalJsonValue`), so a reviewer can recompute every hash from stored
 * rows, nested payloads included. THE formula for new rows.
 */
export function buildTrustEventHashV2(input: TrustEventHashInput): string {
  return createHash("sha256")
    .update(
      canonicalJsonValue({
        v: 2,
        teamId: input.teamId,
        code: input.code,
        captureSessionId: input.captureSessionId,
        evidenceId: input.evidenceId,
        deviceId: input.deviceId,
        sequence: input.sequence,
        atUtc: input.atUtc.toISOString(),
        payload: input.payload ?? {},
        prevEventHash: input.prevEventHash,
      }),
    )
    .digest("hex");
}

export type TrustEventChainVerdict = {
  /** true: every link and every hash checked; false: a break; null: nothing to check. */
  valid: boolean | null;
  checked: number;
  /** v1 rows whose nested payload cannot be recomputed after a JSONB round-trip. */
  unverifiableLegacy: number;
  failures: ReadonlyArray<{ sequence: number; reason: "HASH_MISMATCH" | "PREV_LINK_BROKEN" | "SEQUENCE_GAP" }>;
  formula: "proovra-trust-event-hash/v1|v2";
};

function hasNestedObject(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return Object.values(payload as Record<string, unknown>).some((v) => v !== null && typeof v === "object");
}

/**
 * Walk the sub-chain in sequence order: each row's prevEventHash must be the
 * previous row's eventHash, sequences must be contiguous, and each eventHash
 * must recompute (v2, or v1 for an older row). An edited payload, a deleted
 * middle row or a reordered sequence is a failure.
 */
export function evaluateTrustEventChain(rows: ReadonlyArray<TrustRow>): TrustEventChainVerdict {
  const chain = rows
    .filter((r) => typeof r.sequence === "number" && typeof r.eventHash === "string" && typeof r.teamId === "string")
    .slice()
    .sort((a, b) => (a.sequence as number) - (b.sequence as number));
  const failures: Array<TrustEventChainVerdict["failures"][number]> = [];
  let unverifiableLegacy = 0;
  let prev: TrustRow | null = null;
  for (const row of chain) {
    const seq = row.sequence as number;
    if (prev) {
      if (seq !== (prev.sequence as number) + 1) failures.push({ sequence: seq, reason: "SEQUENCE_GAP" });
      if ((row.prevEventHash ?? null) !== prev.eventHash) failures.push({ sequence: seq, reason: "PREV_LINK_BROKEN" });
    } else if (row.prevEventHash != null && seq === 1) {
      failures.push({ sequence: seq, reason: "PREV_LINK_BROKEN" });
    }
    const input: TrustEventHashInput = {
      teamId: row.teamId as string,
      code: row.code,
      captureSessionId: row.captureSessionId ?? null,
      evidenceId: row.evidenceId ?? null,
      deviceId: row.deviceId ?? null,
      sequence: seq,
      atUtc: row.atUtc ?? new Date(0),
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      prevEventHash: row.prevEventHash ?? null,
    };
    let ok = false;
    try {
      ok = buildTrustEventHashV2(input) === row.eventHash || buildTrustEventHashV1(input) === row.eventHash;
    } catch {
      ok = false;
    }
    if (!ok) {
      if (hasNestedObject(row.payload)) unverifiableLegacy += 1;
      else failures.push({ sequence: seq, reason: "HASH_MISMATCH" });
    }
    prev = row;
  }
  return {
    valid: chain.length === 0 ? null : failures.length === 0,
    checked: chain.length,
    unverifiableLegacy,
    failures: failures.slice(0, 50),
    formula: "proovra-trust-event-hash/v1|v2",
  };
}

/**
 * UC-TRUST-002 / 004 / UC-DER-007 / UC-PROV-003 — what this projection adds to
 * the shared ProvenanceChain shape. The time layers carry the CANONICAL proof
 * status (only VERIFIED is "anchored"; only VALIDATED is an applied RFC 3161
 * timestamp); the trust-event sub-chain carries its verdict; the derived
 * lineage states when it was bounded.
 */
export type ProvenanceChainTrustExtensions = {
  time: {
    rfc3161: { status: TsaProofStatus; statusLabel: string };
    ots: { status: OtsProofStatus; statusLabel: string };
  };
  trustEventChain: TrustEventChainVerdict;
  derivedArtifactsTotalCount: number;
  /** UC-DER-007 — COMPLETED derivatives, counted (not the bounded list length). */
  derivedArtifactsCompletedCount: number;
  derivedArtifactsTruncated: boolean;
  /** Validated capture-manifest facts the capture client reported (private projection). */
  captureManifestFacts: CaptureManifestFacts | null;
  /** Present only when asked for: the rows, with hashes, so the sub-chain can be recomputed. */
  trustEventRecords?: ReadonlyArray<{
    teamId: string;
    code: string;
    captureSessionId: string | null;
    evidenceId: string | null;
    deviceId: string | null;
    sequence: number;
    atUtc: string | null;
    payload: unknown;
    eventHash: string;
    prevEventHash: string | null;
  }>;
};

export type ProvenanceChainProjection = ProvenanceChain & ProvenanceChainTrustExtensions;

export async function loadProvenanceChain(
  prisma: PrismaClient,
  evidenceId: string,
  now: Date = new Date(),
  opts: { includeTrustEventRecords?: boolean } = {},
): Promise<ProvenanceChainProjection> {
  const generatedAtUtc = now.toISOString();
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      acquisitionMode: true,
      acquisitionModeSource: true,
      // UC-TRUST-002 — the time layers come from the record's own proof state.
      signedAtUtc: true,
      tsaStatus: true,
      tsaValidatedAtUtc: true,
      tsaGenTimeUtc: true,
      tsaUrl: true,
      otsStatus: true,
      otsAnchoredAtUtc: true,
      otsAnchorCheck: true,
      otsBitcoinTxid: true,
      otsUpgradedAtUtc: true,
      otsProofBase64: true,
    },
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
          // UC-TRUST-004 — the sub-chain is verified on read.
          teamId: true,
          evidenceId: true,
          sequence: true,
          eventHash: true,
          prevEventHash: true,
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

  // UC-TRUST-004 — an edited, deleted or reordered trust event is detected:
  // a broken sub-chain can vouch for nothing captured on it.
  const trustEventChain = evaluateTrustEventChain(trustEvents);

  const signatureVerdict: CaptureSignatureVerdict = !sawSignature
    ? "MISSING"
    : allSignaturesValid
      ? "VALID"
      : (firstNonValid ?? "INVALID_SIGNATURE");

  const provenanceClass: CaptureProvenanceClass =
    trustEventChain.valid === false
      ? "C"
      : session && signatureVerdict === "VALID"
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
  // UC-TRUST-002 — custody event TYPES are not states. "OTS_APPLIED" is
  // written with the proof still PENDING, and "TIMESTAMP_APPLIED" was written
  // for legacy tokens nobody validated. The layers are read from the record's
  // proof state through the canonical resolvers instead.
  let rfc3161TsaUrl: string | null = evidence?.tsaUrl ?? null;
  for (const ce of custodyEvents) {
    const p = (ce.payload ?? {}) as Record<string, unknown>;
    const type = String(ce.eventType);
    if (type === "SIGNATURE_APPLIED") {
      countersigned = true;
      const keyId = p["signingKeyId"] ?? p["keyId"];
      if (typeof keyId === "string") countersignKeyId = keyId;
      countersignedAtUtc = ce.atUtc.toISOString();
    } else if (type === "TIMESTAMP_APPLIED") {
      const url = p["tsaUrl"];
      if (typeof url === "string" && !rfc3161TsaUrl) rfc3161TsaUrl = url;
    }
  }
  const tsaStatus = resolveTsaProofStatus({
    tsaStatus: evidence?.tsaStatus ?? null,
    tsaValidatedAtUtc: evidence?.tsaValidatedAtUtc ?? null,
  });
  const otsStatus = resolveOtsProofStatus({
    status: evidence?.otsStatus ?? null,
    anchoredAtUtc: evidence?.otsAnchoredAtUtc ?? null,
    anchorCheck: evidence?.otsAnchorCheck ?? null,
    bitcoinTxid: evidence?.otsBitcoinTxid ?? null,
    proofPresent: Boolean(evidence?.otsProofBase64),
    upgradedAtUtc: evidence?.otsUpgradedAtUtc ?? null,
    submittedAtUtc: evidence?.signedAtUtc ?? null,
    now,
  });
  const otsRecordedAnchor = otsStatus === "VERIFIED" || otsStatus === "ANCHORED_UNVERIFIED";

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
  // UC-PROV-003 — the facts of the manifest that SEALED (a retried seal may
  // have recorded facts for a manifest that did not).
  const sealedManifestSha256 = evidence
    ? ((
        await prisma.evidencePart.findFirst({
          where: { evidenceId, artifactClass: "CAPTURE_MANIFEST" },
          orderBy: { partIndex: "desc" },
          select: { sha256: true },
        })
      )?.sha256 ?? null)
    : null;
  // UC-DER-007 — the lineage is bounded; its true size is counted, not inferred.
  const derivedArtifactsTotalCount = evidence
    ? await prisma.evidencePartDerivedAsset.count({ where: { evidenceId } })
    : 0;
  const derivedArtifactsCompletedCount = evidence
    ? await prisma.evidencePartDerivedAsset.count({ where: { evidenceId, status: "COMPLETED" } })
    : 0;

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
      rfc3161: {
        // Only a VALIDATED token is an applied trusted timestamp.
        applied: tsaStatus === "VALIDATED",
        tsaUrl: rfc3161TsaUrl,
        appliedAtUtc:
          tsaStatus === "VALIDATED" || tsaStatus === "RECORDED_NOT_VALIDATED"
            ? (evidence?.tsaGenTimeUtc?.toISOString() ?? null)
            : null,
        status: tsaStatus,
        statusLabel: TSA_PROOF_STATUS_LABELS[tsaStatus],
      },
      ots: {
        // Only an anchor VERIFIED against the Bitcoin chain is "applied".
        applied: otsStatus === "VERIFIED",
        anchorTxId: otsRecordedAnchor ? (evidence?.otsBitcoinTxid ?? null) : null,
        appliedAtUtc: otsRecordedAnchor ? (evidence?.otsAnchoredAtUtc?.toISOString() ?? null) : null,
        // Not recorded by any writer; never invented.
        confirmations: null,
        status: otsStatus,
        statusLabel: OTS_PROOF_STATUS_LABELS[otsStatus],
      },
    },
    trustEventChain,
    derivedArtifactsTotalCount,
    derivedArtifactsCompletedCount,
    derivedArtifactsTruncated: derivedArtifactsTotalCount > derivedArtifacts.length,
    // UC-PROV-003 — the manifest facts the capture client reported and the
    // server validated (persisted as a trust event at seal).
    captureManifestFacts: selectCaptureManifestFacts(trustEvents, { manifestSha256: sealedManifestSha256 }),
    ...(opts.includeTrustEventRecords
      ? {
          trustEventRecords: trustEvents
            .filter((e) => typeof e.sequence === "number" && typeof e.eventHash === "string")
            .map((e) => ({
              teamId: e.teamId as string,
              code: e.code,
              captureSessionId: e.captureSessionId ?? null,
              evidenceId: e.evidenceId ?? null,
              deviceId: e.deviceId ?? null,
              sequence: e.sequence as number,
              atUtc: e.atUtc ? e.atUtc.toISOString() : null,
              payload: e.payload ?? null,
              eventHash: e.eventHash as string,
              prevEventHash: e.prevEventHash ?? null,
            })),
        }
      : {}),
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

/**
 * UC-TRUST-004 — the trust-event rows WITH their hashes, for the verification
 * package (provenance/chain.json), so a reviewer can recompute the capture
 * sub-chain with buildTrustEventHashV2 / V1.
 */
export async function loadTrustEventRecords(
  prisma: PrismaClient,
  evidenceId: string,
): Promise<NonNullable<ProvenanceChainTrustExtensions["trustEventRecords"]>> {
  const chain = await loadProvenanceChain(prisma, evidenceId, new Date(), { includeTrustEventRecords: true });
  return chain.trustEventRecords ?? [];
}
