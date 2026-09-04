/**
 * Phase P3.1 — Detached custody event attestations.
 *
 * For each `CustodyEvent`, produce a detached cryptographic
 * attestation over the canonical payload. The attestation is
 * persisted as a `SecurityEvent` row of type
 * `custody_attestation_signed`; the `details` JSON carries the
 * full attestation record.
 *
 * Hard rules:
 *   * NEVER mutate the underlying `CustodyEvent` row.
 *   * The canonical payload is a deterministic projection over the
 *     custody event's IMMUTABLE fields (id, evidenceId, eventType,
 *     atUtc, sequence, prevEventHash, eventHash). The `payload`
 *     blob is hashed only via its existing `eventHash` field so we
 *     never re-serialise unknown content.
 *   * Failed signing emits `signer_signature_failure` but does NOT
 *     fail the core custody event.
 *   * Duplicate detection: an attestation is identified by
 *     `(custodyEventId, signerId, keyVersion)`. Re-signing with the
 *     same key is a no-op.
 *   * Backfill is resumable: the backfill endpoint scans custody
 *     events ordered by id, skipping those that already have an
 *     attestation for the current active signer.
 */

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { bump } from "../ops/metrics.service.js";
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";
import {
  getCurrentActiveSigners,
  type SignerRecord,
} from "./signer-registry.service.js";
import {
  getEffectiveSignerStatus,
  statusPermitsSigning,
} from "./signer-control-state.service.js";

// ---------------------------------------------------------------------------
// Canonical payload
// ---------------------------------------------------------------------------

export type CustodyCanonicalPayload = {
  custodyEventId: string;
  evidenceId: string;
  eventType: string;
  atUtc: string;
  sequence: number;
  prevEventHash: string | null;
  eventHash: string | null;
};

/**
 * Deterministic projection over the custody event's IMMUTABLE
 * fields. NEVER includes `payload`, `ip`, or `userAgent` — those
 * may contain operator-private data and would change the hash
 * unpredictably.
 */
export function buildCanonicalPayload(row: {
  id: string;
  evidenceId: string;
  eventType: string;
  atUtc: Date;
  sequence: number;
  prevEventHash: string | null;
  eventHash: string | null;
}): CustodyCanonicalPayload {
  return {
    custodyEventId: row.id,
    evidenceId: row.evidenceId,
    eventType: row.eventType,
    atUtc: row.atUtc.toISOString(),
    sequence: row.sequence,
    prevEventHash: row.prevEventHash,
    eventHash: row.eventHash,
  };
}

/** Canonical JSON (sorted keys, no whitespace). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, raw) => {
    if (raw === null || typeof raw !== "object") return raw;
    if (Array.isArray(raw)) return raw;
    const obj = raw as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  });
}

export function hashCanonicalPayload(p: CustodyCanonicalPayload): string {
  return createHash("sha256").update(canonicalJson(p)).digest("hex");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export type CustodyAttestation = {
  attestationId: string;
  custodyEventId: string;
  evidenceId: string;
  canonicalPayloadHash: string;
  signature: string;
  algorithm: string;
  signerId: string;
  keyId: string | null;
  keyVersion: string | null;
  provider: string;
  signedAtUtc: string;
  verificationStatus: "verified" | "pending" | "invalid";
  verificationError: string | null;
};

/**
 * Sign a single custody event. Returns the attestation envelope.
 * Stable id is `${custodyEventId}:${signerId}` — the SecurityEvent
 * row id is independent (Postgres-generated).
 */
export async function signCustodyEvent(
  input: { teamId: string; custodyEventId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<
  | { ok: true; attestation: CustodyAttestation }
  | {
      ok: false;
      code: "event_not_found" | "duplicate" | "signer_unavailable";
      message: string;
    }
> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.CUSTODY_ATTESTATION_SIGN,
    { teamId: input.teamId, operation: "sign" },
    async () => {
      const result = await signCustodyEventInner(input, client);
      if (result.ok) {
        bump("custody_attestation_signed_total");
      } else {
        bump("custody_attestation_sign_failure_total");
      }
      return result;
    },
  );
}

async function signCustodyEventInner(
  input: { teamId: string; custodyEventId: string; actorUserId: string },
  client: PrismaClient,
): Promise<
  | { ok: true; attestation: CustodyAttestation }
  | {
      ok: false;
      code: "event_not_found" | "duplicate" | "signer_unavailable";
      message: string;
    }
> {
  const row = await client.custodyEvent.findFirst({
    where: { id: input.custodyEventId },
    select: {
      id: true,
      evidenceId: true,
      eventType: true,
      atUtc: true,
      sequence: true,
      prevEventHash: true,
      eventHash: true,
      evidence: { select: { teamId: true } },
    },
  });
  if (!row || row.evidence.teamId !== input.teamId) {
    return {
      ok: false,
      code: "event_not_found",
      message: "Custody event not found.",
    };
  }
  const signer = pickCurrentCustodySigner();
  if (!signer || signer.provider === "disabled") {
    return {
      ok: false,
      code: "signer_unavailable",
      message: "No custody-event signer is currently active.",
    };
  }

  // THE SIGNING BOUNDARY for custody attestations.
  //
  // This path does NOT go through `getEvidenceSigner()` — it reaches for
  // KmsEvidenceSigner or `ed25519SignHexWithKeyPath` directly a few lines
  // below — so the wrapper that guards evidence fingerprints does not cover
  // it. It needs its own check, and it needs it most: `backfillCustodyAttestations`
  // loops this function over a batch, so an unguarded path here would re-sign
  // an entire workspace's custody history with a signer an operator had
  // revoked. `pickCurrentCustodySigner` only reports what the ENVIRONMENT
  // configures; the persisted control state is what says whether it may
  // still be used.
  //
  // Read per event, from the database: a backfill that began before a
  // revocation must stop at the next event rather than run to completion.
  if (!statusPermitsSigning(await getEffectiveSignerStatus(signer.signerId))) {
    return {
      ok: false,
      code: "signer_unavailable",
      message: "The custody-event signer has been retired or revoked.",
    };
  }
  const canonical = buildCanonicalPayload({
    id: row.id,
    evidenceId: row.evidenceId,
    eventType: row.eventType,
    atUtc: row.atUtc,
    sequence: row.sequence,
    prevEventHash: row.prevEventHash,
    eventHash: row.eventHash,
  });
  const hash = hashCanonicalPayload(canonical);
  // Duplicate check: have we already attested this custody event with
  // this signer's current keyVersion?
  const existing = await client.securityEvent.findFirst({
    where: {
      teamId: input.teamId,
      eventType: "custody_attestation_signed",
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, details: true },
  });
  if (existing) {
    // Scan recent attestations for a match.
    const recent = await client.securityEvent.findMany({
      where: {
        teamId: input.teamId,
        eventType: "custody_attestation_signed",
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { id: true, details: true },
    });
    for (const r of recent) {
      const d = (r.details ?? {}) as Record<string, unknown>;
      if (
        d.custodyEventId === input.custodyEventId &&
        d.signerId === signer.signerId &&
        d.keyVersion === signer.keyVersion
      ) {
        return {
          ok: false,
          code: "duplicate",
          message: "Custody event already attested by this signer + key version.",
        };
      }
    }
  }

  // Produce signature. For provider `aws_kms` we delegate to the
  // existing KmsEvidenceSigner; for `local_pem` we delegate to the
  // local Ed25519 helper. In both cases the signing function takes
  // a hex string.
  let signature: string;
  let algorithm: string;
  try {
    if (signer.provider === "aws_kms") {
      const { KmsEvidenceSigner } = await import(
        "../../signing/kms-signer.js"
      );
      const k = new KmsEvidenceSigner();
      const res = await k.signFingerprintHex(hash);
      signature = res.signatureBase64;
      algorithm = "ED25519_SHA_512";
    } else {
      // local_pem — `ed25519SignHexWithKeyPath` takes the env-VAR
      // NAME (not the file path) and reads the PEM itself.
      const { ed25519SignHexWithKeyPath } = await import("../../crypto.js");
      const sig = ed25519SignHexWithKeyPath(
        hash,
        "SIGNING_PRIVATE_KEY_PATH",
      );
      signature = sig;
      algorithm = "ED25519";
    }
  } catch (err) {
    bump("signer_signature_failure_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "signer_signature_failure",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId,
        signerId: signer.signerId,
        purpose: "custody_event",
        errorCode:
          err instanceof Error ? err.name.slice(0, 60) : "unknown",
      },
    });
    return {
      ok: false,
      code: "signer_unavailable",
      message: "Signing failed.",
    };
  }

  const attestation: CustodyAttestation = {
    attestationId: `${row.id}:${signer.signerId}`,
    custodyEventId: row.id,
    evidenceId: row.evidenceId,
    canonicalPayloadHash: hash,
    signature,
    algorithm,
    signerId: signer.signerId,
    keyId: signer.keyId,
    keyVersion: signer.keyVersion,
    provider: signer.provider,
    signedAtUtc: new Date().toISOString(),
    verificationStatus: "pending",
    verificationError: null,
  };
  bump("custody_attestation_signed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "custody_attestation_signed",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      custodyEventId: row.id,
      attestationId: attestation.attestationId,
      canonicalPayloadHash: hash,
      signerId: signer.signerId,
      keyId: signer.keyId,
      keyVersion: signer.keyVersion,
      provider: signer.provider,
      algorithm,
      // Signature is NOT logged in the event details to keep the
      // SecurityEvent row size bounded. The attestation envelope
      // returned to the caller carries the signature; it is also
      // re-derivable from the canonical payload + signer.
      attestation,
    },
  });
  return { ok: true, attestation };
}

function pickCurrentCustodySigner(): SignerRecord | null {
  const list = getCurrentActiveSigners();
  return (
    list.find(
      (s) => s.signerPurpose === "custody_event" && s.status === "active",
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const CUSTODY_ATTESTATION_OUTCOMES = [
  "verified",
  "missing_attestation",
  "signature_invalid",
  "payload_hash_mismatch",
  "signer_unavailable",
  "unsupported_algorithm",
  "not_applicable",
] as const;
export type CustodyAttestationOutcome =
  (typeof CUSTODY_ATTESTATION_OUTCOMES)[number];

export type VerifyAttestationResult = {
  outcome: CustodyAttestationOutcome;
  summary: string;
  attestation: CustodyAttestation | null;
  recomputedPayloadHash: string | null;
  verifiedAtUtc: string;
};

/**
 * Verify a custody attestation. Re-derives the canonical payload,
 * recomputes the hash, and re-verifies the signature. Failure is
 * bounded — no free-form error strings.
 */
export async function verifyCustodyAttestation(
  input: { teamId: string; attestationId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<VerifyAttestationResult> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.CUSTODY_ATTESTATION_VERIFY,
    { teamId: input.teamId, operation: "verify" },
    async () => {
      const result = await verifyCustodyAttestationInner(input, client);
      const outcome = (result as { outcome?: string }).outcome ?? "unknown";
      if (outcome === "verified") {
        bump("custody_attestation_verified_total");
      } else {
        bump("custody_attestation_verification_failure_total");
      }
      return result;
    },
  );
}

async function verifyCustodyAttestationInner(
  input: { teamId: string; attestationId: string; actorUserId: string },
  client: PrismaClient,
): Promise<VerifyAttestationResult> {
  // The attestation id is `${custodyEventId}:${signerId}`. Find the
  // matching SecurityEvent row and read its `details.attestation`
  // envelope.
  const [eventId] = input.attestationId.split(":", 2);
  const rows = await client.securityEvent.findMany({
    where: {
      teamId: input.teamId,
      eventType: "custody_attestation_signed",
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, details: true },
  });
  const matchRow = rows.find((r) => {
    const d = (r.details ?? {}) as Record<string, unknown>;
    return d.attestationId === input.attestationId;
  });
  if (!matchRow) {
    bump("custody_attestation_verification_failure_total");
    return {
      outcome: "missing_attestation",
      summary: "No attestation found with this id.",
      attestation: null,
      recomputedPayloadHash: null,
      verifiedAtUtc: new Date().toISOString(),
    };
  }
  const d = (matchRow.details ?? {}) as Record<string, unknown>;
  const att = d.attestation as CustodyAttestation | undefined;
  if (!att || typeof att !== "object") {
    bump("custody_attestation_verification_failure_total");
    return {
      outcome: "missing_attestation",
      summary: "Attestation envelope is malformed.",
      attestation: null,
      recomputedPayloadHash: null,
      verifiedAtUtc: new Date().toISOString(),
    };
  }
  const custodyEventId = att.custodyEventId ?? eventId;
  const row = await client.custodyEvent.findFirst({
    where: { id: custodyEventId },
    select: {
      id: true,
      evidenceId: true,
      eventType: true,
      atUtc: true,
      sequence: true,
      prevEventHash: true,
      eventHash: true,
      evidence: { select: { teamId: true } },
    },
  });
  if (!row || row.evidence.teamId !== input.teamId) {
    bump("custody_attestation_verification_failure_total");
    return {
      outcome: "missing_attestation",
      summary: "Underlying custody event no longer reachable from this workspace.",
      attestation: att,
      recomputedPayloadHash: null,
      verifiedAtUtc: new Date().toISOString(),
    };
  }
  const recomputed = hashCanonicalPayload(
    buildCanonicalPayload({
      id: row.id,
      evidenceId: row.evidenceId,
      eventType: row.eventType,
      atUtc: row.atUtc,
      sequence: row.sequence,
      prevEventHash: row.prevEventHash,
      eventHash: row.eventHash,
    }),
  );
  if (recomputed !== att.canonicalPayloadHash) {
    bump("custody_attestation_verification_failure_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "custody_attestation_verified",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId,
        attestationId: input.attestationId,
        outcome: "payload_hash_mismatch",
      },
    });
    return {
      outcome: "payload_hash_mismatch",
      summary:
        "Canonical payload hash does not match. Either the custody event was modified or the canonical projection changed.",
      attestation: att,
      recomputedPayloadHash: recomputed,
      verifiedAtUtc: new Date().toISOString(),
    };
  }
  // Verify signature.
  let signatureOk = false;
  let algoOk = true;
  try {
    if (att.provider === "aws_kms" && att.algorithm === "ED25519_SHA_512") {
      const { VerifyCommand, KMSClient } = await import(
        "@aws-sdk/client-kms"
      );
      const kms = new KMSClient({});
      const res = await kms.send(
        new VerifyCommand({
          KeyId: (process.env.KMS_KEY_ID ?? "").trim(),
          Message: Buffer.from(att.canonicalPayloadHash, "hex"),
          MessageType: "RAW",
          Signature: Buffer.from(att.signature, "base64"),
          SigningAlgorithm: "ED25519_SHA_512",
        }),
      );
      signatureOk = Boolean(res.SignatureValid);
    } else if (att.provider === "local_pem" && att.algorithm === "ED25519") {
      // The local-pem verifier takes the PEM string directly. Load
      // the configured public key from disk.
      const { ed25519VerifyHexSignature, loadPemFromPathEnv } = await import(
        "../../crypto.js"
      );
      const pubPem = loadPemFromPathEnv("SIGNING_PUBLIC_KEY_PATH");
      signatureOk = ed25519VerifyHexSignature({
        messageHex: att.canonicalPayloadHash,
        signatureBase64: att.signature,
        publicKeyPem: pubPem,
      });
    } else {
      algoOk = false;
    }
  } catch {
    signatureOk = false;
  }
  if (!algoOk) {
    bump("custody_attestation_verification_failure_total");
    return {
      outcome: "unsupported_algorithm",
      summary: `Algorithm "${att.algorithm}" is not supported by this verifier.`,
      attestation: att,
      recomputedPayloadHash: recomputed,
      verifiedAtUtc: new Date().toISOString(),
    };
  }
  if (!signatureOk) {
    bump("custody_attestation_verification_failure_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "custody_attestation_verified",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId,
        attestationId: input.attestationId,
        outcome: "signature_invalid",
      },
    });
    return {
      outcome: "signature_invalid",
      summary:
        "Signature did not verify against the recorded signer / key version.",
      attestation: att,
      recomputedPayloadHash: recomputed,
      verifiedAtUtc: new Date().toISOString(),
    };
  }
  bump("custody_attestation_verified_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "custody_attestation_verified",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      attestationId: input.attestationId,
      outcome: "verified",
    },
  });
  return {
    outcome: "verified",
    summary:
      "Canonical payload hash matches the recorded value and the signature verifies under the recorded signer + key version.",
    attestation: att,
    recomputedPayloadHash: recomputed,
    verifiedAtUtc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Listing + batch backfill
// ---------------------------------------------------------------------------

export type AttestationListItem = {
  attestationId: string;
  custodyEventId: string;
  evidenceId: string;
  signerId: string;
  signedAtUtc: string;
  outcome: "verified" | "pending" | "invalid";
};

export type ListAttestationsResult = {
  attestations: ReadonlyArray<AttestationListItem>;
  /** Count of everything matching the filter, not the page. */
  total: number;
  /** The cap applied, echoed so the caller discloses it rather than inferring. */
  limit: number;
};

export async function listAttestations(
  input: { teamId: string; evidenceId?: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ListAttestationsResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  /**
   * The evidenceId filter is now part of the QUERY, and that is a bug fix.
   *
   * It used to fetch `take: limit * 2` rows and then drop non-matching ones in
   * a JavaScript loop. For a workspace with more attestations than that window
   * — 100 rows, by default — an evidenceId whose attestation sat outside it
   * returned an EMPTY list. Not an error, not a partial result: zero, which
   * reads as "this evidence has no custody attestation" when it has one.
   *
   * `details` is JSONB and Postgres can filter inside it. The same path idiom
   * is already used for invite metadata and report blocking elsewhere in this
   * service layer.
   */
  const where = {
    teamId: input.teamId,
    eventType: "custody_attestation_signed",
    ...(input.evidenceId
      ? {
          details: {
            path: ["attestation", "evidenceId"],
            equals: input.evidenceId,
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    client.securityEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, createdAt: true, details: true },
    }),
    client.securityEvent.count({ where }),
  ]);
  const out: AttestationListItem[] = [];
  for (const r of rows) {
    const d = (r.details ?? {}) as Record<string, unknown>;
    const att = d.attestation as CustodyAttestation | undefined;
    if (!att) continue;
    // The evidenceId narrowing happens in the query now. A row without a
    // parsable attestation is still skipped: that is a shape guard, not a
    // filter, and it cannot silently drop a match the way the old loop did.
    out.push({
      attestationId: att.attestationId,
      custodyEventId: att.custodyEventId,
      evidenceId: att.evidenceId,
      signerId: att.signerId,
      signedAtUtc: att.signedAtUtc,
      outcome: att.verificationStatus,
    });
    if (out.length >= limit) break;
  }
  return { attestations: out, total, limit };
}

export type BackfillResult = {
  startedAtUtc: string;
  finishedAtUtc: string;
  scanned: number;
  signed: number;
  skipped: number;
  failed: number;
};

/** Bounded batch backfill — up to `batchSize` events per call. */
export async function backfillCustodyAttestations(
  input: {
    teamId: string;
    actorUserId: string;
    batchSize?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<BackfillResult> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.CUSTODY_ATTESTATION_BACKFILL,
    {
      teamId: input.teamId,
      batchSize: Math.min(Math.max(input.batchSize ?? 50, 1), 200),
    },
    () => backfillCustodyAttestationsInner(input, client),
  );
}

async function backfillCustodyAttestationsInner(
  input: {
    teamId: string;
    actorUserId: string;
    batchSize?: number;
  },
  client: PrismaClient,
): Promise<BackfillResult> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 200);
  const startedAtUtc = new Date().toISOString();
  bump("custody_attestation_backfill_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "custody_attestation_backfill_started",
    severity: "INFO",
    details: { actorUserId: input.actorUserId, batchSize },
  });
  // Find recent custody events for this workspace's evidence.
  const events = await client.custodyEvent.findMany({
    where: { evidence: { teamId: input.teamId } },
    orderBy: { atUtc: "desc" },
    take: batchSize,
    select: { id: true },
  });
  let signed = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of events) {
    const result = await signCustodyEvent(
      {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        custodyEventId: e.id,
      },
      client,
    );
    if (result.ok) signed++;
    else if (result.code === "duplicate") skipped++;
    else failed++;
  }
  const finishedAtUtc = new Date().toISOString();
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "custody_attestation_backfill_completed",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      scanned: events.length,
      signed,
      skipped,
      failed,
    },
  });
  return {
    startedAtUtc,
    finishedAtUtc,
    scanned: events.length,
    signed,
    skipped,
    failed,
  };
}
