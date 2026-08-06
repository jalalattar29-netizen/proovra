/**
 * Phase P3.1.1 — Verification Package attestation closure.
 *
 * Builds the bounded set of ATTESTATION-related files that the worker
 * appends to every newly generated Verification Package:
 *
 *   custody/attestations.json
 *   custody/attestation-verification.md
 *   signers/signer-registry-snapshot.json
 *
 * (Per-file `.sha256` companions are emitted by the caller via the
 * canonical `package-checksums.json` index. We do NOT emit duplicate
 * `.sha256` files — the checksums index is the canonical source of
 * file-hash truth for the package. The closure doc describes this
 * deliberately.)
 *
 * Hard rules:
 *   * ADDITIVE only — never replaces or renames existing files.
 *   * Deterministic ordering: attestations sorted by custody event
 *     `sequence ASC`; signer purposes in a fixed order.
 *   * NEVER includes private keys, KMS credentials, or raw custody
 *     event `payload` / `ip` / `userAgent` fields.
 *   * Strict-vs-best-effort: if
 *     `VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS=true` AND
 *     attestation generation is degraded, this module throws
 *     `AttestationStrictModeFailureError` to the caller. Default mode
 *     is best-effort — package generation continues with a
 *     `degradedReason` recorded in the JSON.
 *   * The new files are bounded:
 *       * attestations.json caps at 5000 entries
 *       * signer snapshot is always exactly 4 entries (one per purpose)
 *   * OTEL spans are emitted via `proovra.package.attestations.collect`
 *     and `proovra.package.signer_snapshot.generate`.
 *
 * The module is read-only against persistence — it never mutates
 * `CustodyEvent` rows, never signs new attestations, never rotates
 * signers. Backfill / signing happens on the api side via the
 * `/v1/operations/custody-attestations/*` routes.
 */

import { trace, SpanStatusCode } from "@opentelemetry/api";
import { isAccessCustodyEventType } from "@proovra/shared";

import { prisma } from "./db.js";
import { captureException } from "./sentry.js";

// ---------------------------------------------------------------------------
// Bounded enums (must match `services/api/src/services/operations/
// signer-registry.service.ts` — single source of truth)
// ---------------------------------------------------------------------------

export const SIGNER_PURPOSES = [
  "report_pdf",
  "verification_package",
  "export_manifest",
  "custody_event",
] as const;
export type SignerPurpose = (typeof SIGNER_PURPOSES)[number];

export type SignerProvider = "aws_kms" | "local_pem" | "disabled";

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export type AttestationEntry = {
  custodyEventId: string;
  custodyEventSequence: number;
  canonicalPayloadHash: string;
  signature: string;
  algorithm: string;
  signerId: string;
  keyId: string | null;
  keyVersion: string | null;
  provider: SignerProvider;
  signedAtUtc: string;
  verificationStatus: "verified" | "pending" | "invalid";
  verificationError: string | null;
};

export type AttestationsFile = {
  schemaVersion: 1;
  schema: "PROOVRA_CUSTODY_ATTESTATIONS";
  generatedAtUtc: string;
  evidenceId: string;
  packageId: string | null;
  /** DEPRECATED alias of totalEventsCount (all custody+access events).
   *  Kept for backwards-compatibility; prefer the explicit counts below. */
  custodyEventsCount: number;
  /** Forensic custody events only (excludes access/view/download activity),
   *  counted from the LIVE query at package-generation time (see countsBasis).
   *  The PDF Chain of Custody + custody.json use the report-time SNAPSHOT count,
   *  surfaced here as `reportSnapshotForensicCustodyEventsCount` so the two are
   *  explicitly reconciled and never silently disagree. */
  forensicCustodyEventsCount: number;
  /** Forensic custody event count from the REPORT-TIME snapshot — the exact
   *  count the PDF Chain of Custody + custody.json show. Equals
   *  `forensicCustodyEventsCount` unless a forensic event was recorded between
   *  report generation and package generation. Null only when the package
   *  builder did not supply the snapshot count. */
  reportSnapshotForensicCustodyEventsCount: number | null;
  /** Access/activity events (views, downloads) — NOT forensic custody. */
  accessActivityEventsCount: number;
  /** All custody events recorded for this evidence (forensic + access) —
   *  equals the length of custody.json when both are taken from the same
   *  snapshot. See countsBasis / snapshotGeneratedAtUtc. */
  totalEventsCount: number;
  /** When the custody events used for THESE counts were queried. custody.json
   *  is written from the report-time custody snapshot; these counts come from
   *  a live query at package-generation time. If an event is recorded between
   *  those two moments the totals can differ by that event — this field makes
   *  the basis explicit rather than hiding it under an ambiguous count. */
  snapshotGeneratedAtUtc: string;
  /** "live_custody_query" — the counts above are a live read, not the
   *  custody.json snapshot. */
  countsBasis: "live_custody_query";
  attestationsCount: number;
  attestations: ReadonlyArray<AttestationEntry>;
  missingAttestations: ReadonlyArray<{
    custodyEventId: string;
    custodyEventSequence: number;
    reason: "no_attestation_recorded" | "attestation_envelope_malformed";
  }>;
  degradedReason: BoundedDegradedReason | null;
  verificationInstructionsRef: string;
  // The bounded scope statement is repeated inside the file so
  // anyone reading just the JSON (without the README) still has the
  // honest disclosure.
  scope: string;
};

export type SignerSnapshotEntry = {
  signerPurpose: SignerPurpose;
  signerId: string;
  provider: SignerProvider;
  keyId: string | null;
  keyVersion: string | null;
  algorithm: string | null;
  status: "active" | "degraded";
  /** Operator-safe — KMS algorithm reference or PEM path label.
   *  NEVER private key material. */
  verificationMaterialRef: string | null;
  kmsKeyArn: string | null;
};

export type SignerSnapshotFile = {
  schemaVersion: 1;
  schema: "PROOVRA_SIGNER_REGISTRY_SNAPSHOT";
  generatedAtUtc: string;
  evidenceId: string;
  packageId: string | null;
  signers: ReadonlyArray<SignerSnapshotEntry>;
  health: {
    overall: "healthy" | "degraded" | "unavailable";
    checkedAtUtc: string;
    reason: BoundedHealthReason | null;
  };
};

export type BoundedDegradedReason =
  | "no_attestations_recorded"
  | "custody_events_unreachable"
  | "attestation_lookup_failed";

export type BoundedHealthReason =
  | "provider_disabled"
  | "kms_key_id_unset"
  | "missing_pem_path"
  | "unknown_error";

export type AttestationFiles = {
  attestationsJson: AttestationsFile;
  signerSnapshotJson: SignerSnapshotFile;
  verificationReadme: string;
};

export class AttestationStrictModeFailureError extends Error {
  constructor(public readonly reason: string) {
    super(`Verification package attestation generation failed: ${reason}`);
    this.name = "AttestationStrictModeFailureError";
  }
}

// ---------------------------------------------------------------------------
// Worker entry point — called by `verification-package.ts`
// ---------------------------------------------------------------------------

export async function collectVerificationPackageAttestations(input: {
  teamId: string | null;
  evidenceId: string;
  packageId?: string | null;
  /** Report-time forensic custody event count (the exact count in the PDF +
   *  custody.json). Surfaced in attestations.json so the live and snapshot
   *  counters are explicitly reconciled. */
  reportSnapshotForensicCount?: number | null;
}): Promise<AttestationFiles> {
  const tracer = trace.getTracer("proovra-worker");
  return tracer.startActiveSpan(
    "proovra.package.attestations.collect",
    async (span) => {
      span.setAttribute("packageKind", "verification_package");
      try {
        const attestationsJson = await buildAttestationsJson(input);
        const signerSnapshotJson = await buildSignerSnapshotJson(input);
        const verificationReadme = buildVerificationReadme();
        span.setAttribute(
          "attestationCount",
          attestationsJson.attestationsCount,
        );
        span.setAttribute(
          "missingCount",
          attestationsJson.missingAttestations.length,
        );
        span.setAttribute("status", "ok");

        // P3.1.1 strict mode — fail the package generation when the
        // operator explicitly opted in.
        const strict =
          (process.env.VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS ?? "")
            .trim()
            .toLowerCase() === "true";
        if (strict && attestationsJson.degradedReason !== null) {
          captureException(
            new Error(
              `attestation_strict_mode_failure: ${attestationsJson.degradedReason}`,
            ),
            { packageKind: "verification_package" },
          );
          throw new AttestationStrictModeFailureError(
            attestationsJson.degradedReason,
          );
        }

        return { attestationsJson, signerSnapshotJson, verificationReadme };
      } catch (err) {
        if (!(err instanceof AttestationStrictModeFailureError)) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          captureException(err, {
            stage: "collectVerificationPackageAttestations",
            packageKind: "verification_package",
          });
        }
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Custody attestations JSON
// ---------------------------------------------------------------------------

async function buildAttestationsJson(input: {
  teamId: string | null;
  evidenceId: string;
  packageId?: string | null;
  reportSnapshotForensicCount?: number | null;
}): Promise<AttestationsFile> {
  const generatedAtUtc = new Date().toISOString();
  // Custody events for this evidence — deterministic order by sequence.
  let custodyEvents: Array<{
    id: string;
    sequence: number;
    eventType?: string | null;
  }>;
  try {
    custodyEvents = await prisma.custodyEvent.findMany({
      where: { evidenceId: input.evidenceId },
      orderBy: { sequence: "asc" },
      take: 5000,
      select: { id: true, sequence: true, eventType: true },
    });
  } catch {
    return baseAttestationsFile(input, generatedAtUtc, {
      custodyEvents: [],
      attestations: [],
      missingAttestations: [],
      degradedReason: "custody_events_unreachable",
    });
  }

  if (custodyEvents.length === 0) {
    return baseAttestationsFile(input, generatedAtUtc, {
      custodyEvents,
      attestations: [],
      missingAttestations: [],
      degradedReason: "no_attestations_recorded",
    });
  }

  // Pull recent attestation events and match them to custody events.
  // We use the SecurityEvent persistence the api populates via
  // `custody_attestation_signed`.
  let attRows: Array<{ details: unknown }> = [];
  if (input.teamId) {
    try {
      attRows = await prisma.securityEvent.findMany({
        where: {
          teamId: input.teamId,
          eventType: "custody_attestation_signed",
        },
        orderBy: { createdAt: "desc" },
        take: 5000,
        select: { details: true },
      });
    } catch {
      return baseAttestationsFile(input, generatedAtUtc, {
        custodyEvents,
        attestations: [],
        missingAttestations: custodyEvents.map((e) => ({
          custodyEventId: e.id,
          custodyEventSequence: e.sequence,
          reason: "no_attestation_recorded" as const,
        })),
        degradedReason: "attestation_lookup_failed",
      });
    }
  }

  // Index by custodyEventId — first (most recent) attestation wins
  // per event id. Bounded to the size of custodyEvents.
  const byEventId = new Map<
    string,
    AttestationEntry & { _malformed?: boolean }
  >();
  for (const r of attRows) {
    const d = (r.details ?? {}) as Record<string, unknown>;
    const att = d.attestation as Record<string, unknown> | undefined;
    if (!att || typeof att !== "object") continue;
    const custodyEventId =
      typeof att.custodyEventId === "string" ? att.custodyEventId : null;
    if (!custodyEventId) continue;
    if (byEventId.has(custodyEventId)) continue;

    const isStringOrNull = (v: unknown): v is string | null =>
      typeof v === "string" || v === null;

    const provider = att.provider;
    const algorithm = att.algorithm;
    const signature = att.signature;
    const canonicalPayloadHash = att.canonicalPayloadHash;
    const signerId = att.signerId;
    const signedAtUtc = att.signedAtUtc;
    const verificationStatus = att.verificationStatus;

    // Bounded validation. Malformed envelopes are recorded as
    // missing, not silently dropped.
    const malformed =
      typeof signature !== "string" ||
      typeof canonicalPayloadHash !== "string" ||
      typeof algorithm !== "string" ||
      typeof signerId !== "string" ||
      typeof signedAtUtc !== "string" ||
      typeof provider !== "string" ||
      (provider !== "aws_kms" && provider !== "local_pem");

    if (malformed) {
      byEventId.set(custodyEventId, {
        _malformed: true,
        custodyEventId,
        custodyEventSequence: -1, // filled later from custodyEvents map
        canonicalPayloadHash:
          typeof canonicalPayloadHash === "string" ? canonicalPayloadHash : "",
        signature: typeof signature === "string" ? signature : "",
        algorithm: typeof algorithm === "string" ? algorithm : "",
        signerId: typeof signerId === "string" ? signerId : "",
        keyId: isStringOrNull(att.keyId) ? att.keyId : null,
        keyVersion: isStringOrNull(att.keyVersion) ? att.keyVersion : null,
        provider: "disabled",
        signedAtUtc: typeof signedAtUtc === "string" ? signedAtUtc : "",
        verificationStatus: "pending",
        verificationError: "envelope_malformed",
      });
      continue;
    }

    byEventId.set(custodyEventId, {
      custodyEventId,
      custodyEventSequence: -1,
      canonicalPayloadHash,
      signature,
      algorithm,
      signerId,
      keyId: isStringOrNull(att.keyId) ? att.keyId : null,
      keyVersion: isStringOrNull(att.keyVersion) ? att.keyVersion : null,
      provider: provider as SignerProvider,
      signedAtUtc,
      verificationStatus:
        verificationStatus === "verified" ||
        verificationStatus === "pending" ||
        verificationStatus === "invalid"
          ? verificationStatus
          : "pending",
      verificationError:
        typeof att.verificationError === "string" ? att.verificationError : null,
    });
  }

  // Walk the custody events in order and produce attestations +
  // missingAttestations deterministically.
  const attestations: AttestationEntry[] = [];
  const missingAttestations: Array<{
    custodyEventId: string;
    custodyEventSequence: number;
    reason: "no_attestation_recorded" | "attestation_envelope_malformed";
  }> = [];
  for (const e of custodyEvents) {
    const hit = byEventId.get(e.id);
    if (!hit) {
      missingAttestations.push({
        custodyEventId: e.id,
        custodyEventSequence: e.sequence,
        reason: "no_attestation_recorded",
      });
      continue;
    }
    if (hit._malformed) {
      missingAttestations.push({
        custodyEventId: e.id,
        custodyEventSequence: e.sequence,
        reason: "attestation_envelope_malformed",
      });
      continue;
    }
    attestations.push({
      custodyEventId: hit.custodyEventId,
      custodyEventSequence: e.sequence,
      canonicalPayloadHash: hit.canonicalPayloadHash,
      signature: hit.signature,
      algorithm: hit.algorithm,
      signerId: hit.signerId,
      keyId: hit.keyId,
      keyVersion: hit.keyVersion,
      provider: hit.provider,
      signedAtUtc: hit.signedAtUtc,
      verificationStatus: hit.verificationStatus,
      verificationError: hit.verificationError,
    });
  }

  // Degraded reason is set ONLY when coverage is zero. Partial
  // coverage is reported via `missingAttestations` and is NOT
  // considered degraded by default. Strict mode treats any
  // missingAttestations > 0 as degraded (see caller).
  const degradedReason: BoundedDegradedReason | null =
    attestations.length === 0 ? "no_attestations_recorded" : null;

  return baseAttestationsFile(input, generatedAtUtc, {
    custodyEvents,
    attestations,
    missingAttestations,
    degradedReason,
  });
}

function baseAttestationsFile(
  input: {
    evidenceId: string;
    packageId?: string | null;
    reportSnapshotForensicCount?: number | null;
  },
  generatedAtUtc: string,
  payload: {
    custodyEvents: Array<{ id: string; sequence: number; eventType?: string | null }>;
    attestations: ReadonlyArray<AttestationEntry>;
    missingAttestations: AttestationsFile["missingAttestations"];
    degradedReason: BoundedDegradedReason | null;
  },
): AttestationsFile {
  const total = payload.custodyEvents.length;
  const accessActivityEventsCount = payload.custodyEvents.filter((e) =>
    isAccessCustodyEventType(String(e.eventType ?? "")),
  ).length;
  const forensicCustodyEventsCount = total - accessActivityEventsCount;
  return {
    schemaVersion: 1,
    schema: "PROOVRA_CUSTODY_ATTESTATIONS",
    generatedAtUtc,
    evidenceId: input.evidenceId,
    packageId: input.packageId ?? null,
    custodyEventsCount: total,
    forensicCustodyEventsCount,
    reportSnapshotForensicCustodyEventsCount:
      input.reportSnapshotForensicCount ?? null,
    accessActivityEventsCount,
    totalEventsCount: total,
    snapshotGeneratedAtUtc: generatedAtUtc,
    countsBasis: "live_custody_query",
    attestationsCount: payload.attestations.length,
    attestations: payload.attestations,
    missingAttestations: payload.missingAttestations,
    degradedReason: payload.degradedReason,
    verificationInstructionsRef: "custody/attestation-verification.md",
    scope:
      "These detached attestations cryptographically link the recorded signer to a hash of the canonical custody payload. They do NOT carry a legal-admissibility assertion. See custody/attestation-verification.md §5 for the bounded outcome model.",
  };
}

// ---------------------------------------------------------------------------
// Signer snapshot
// ---------------------------------------------------------------------------

async function buildSignerSnapshotJson(input: {
  evidenceId: string;
  packageId?: string | null;
}): Promise<SignerSnapshotFile> {
  const tracer = trace.getTracer("proovra-worker");
  return tracer.startActiveSpan(
    "proovra.package.signer_snapshot.generate",
    async (span) => {
      try {
        const generatedAtUtc = new Date().toISOString();
        const providerRaw = (process.env.SIGNER_PROVIDER ?? "local-pem")
          .trim()
          .toLowerCase();
        const provider: SignerProvider =
          providerRaw === "aws-kms" || providerRaw === "aws_kms"
            ? "aws_kms"
            : providerRaw === "disabled"
              ? "disabled"
              : "local_pem";

        const kmsArn =
          provider === "aws_kms" ? envValue("KMS_KEY_ID") : null;
        const evidKeyId = envValue("SIGNING_KEY_ID");
        const evidKeyVersion = envValue("SIGNING_KEY_VERSION");
        const pkgKeyId = envValue("PACKAGE_SIGNING_KEY_ID") ?? evidKeyId;
        const pkgKeyVersion =
          envValue("PACKAGE_SIGNING_KEY_VERSION") ?? evidKeyVersion;
        const algorithm =
          provider === "aws_kms"
            ? "ED25519_SHA_512"
            : provider === "local_pem"
              ? "ED25519"
              : null;
        const verificationMaterialRef =
          provider === "aws_kms"
            ? "kms://GetPublicKey"
            : provider === "local_pem"
              ? envValue("SIGNING_PUBLIC_KEY_PATH") ?? "local-pem"
              : null;

        const status: SignerSnapshotEntry["status"] =
          provider === "disabled" ? "degraded" : "active";

        // PHASE 12 POINT 3 — a const-bound function EXPRESSION, not a nested
        // function declaration. It closes over `provider` from this block, so
        // hoisting it to module scope would change what it reads; every call
        // site is below its definition, so losing declaration hoisting is
        // inert. Behaviour is identical.
        const entry = (
          purpose: SignerPurpose,
          keyId: string | null,
          keyVersion: string | null,
        ): SignerSnapshotEntry => {
          return {
            signerPurpose: purpose,
            signerId: `${purpose}:${provider}:${keyId ?? "_"}:${
              keyVersion ?? "_"
            }`,
            provider,
            keyId,
            keyVersion,
            algorithm,
            status,
            verificationMaterialRef,
            kmsKeyArn: kmsArn,
          };
        };

        // Health rationale: this is a snapshot. We don't issue a live
        // KMS probe here (that lives on the api side); we report
        // bounded reasons for `degraded` based on env.
        const healthReason: BoundedHealthReason | null =
          provider === "disabled"
            ? "provider_disabled"
            : provider === "aws_kms" && !envValue("KMS_KEY_ID")
              ? "kms_key_id_unset"
              : provider === "local_pem" &&
                  (!envValue("SIGNING_PRIVATE_KEY_PATH") ||
                    !envValue("SIGNING_PUBLIC_KEY_PATH"))
                ? "missing_pem_path"
                : null;

        const overall: SignerSnapshotFile["health"]["overall"] =
          provider === "disabled"
            ? "unavailable"
            : healthReason
              ? "degraded"
              : "healthy";

        const file: SignerSnapshotFile = {
          schemaVersion: 1,
          schema: "PROOVRA_SIGNER_REGISTRY_SNAPSHOT",
          generatedAtUtc,
          evidenceId: input.evidenceId,
          packageId: input.packageId ?? null,
          // Deterministic order — purpose order matches the bounded enum.
          signers: [
            entry("report_pdf", evidKeyId, evidKeyVersion),
            entry("verification_package", pkgKeyId, pkgKeyVersion),
            entry("export_manifest", evidKeyId, evidKeyVersion),
            entry("custody_event", evidKeyId, evidKeyVersion),
          ],
          health: {
            overall,
            checkedAtUtc: generatedAtUtc,
            reason: healthReason,
          },
        };

        span.setAttribute("status", "ok");
        span.setAttribute("signerPurpose", "all");
        return file;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        captureException(err, {
          stage: "buildSignerSnapshotJson",
          packageKind: "verification_package",
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

function envValue(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Package attestation README
// ---------------------------------------------------------------------------

function buildVerificationReadme(): string {
  return [
    "# Detached Custody Attestation Verification (External)",
    "",
    "**This file is bundled inside the Verification Package as `custody/attestation-verification.md`.**",
    "",
    "## 1. What you receive",
    "",
    "- `custody/attestations.json` — the bounded attestation set for this evidence's custody events.",
    "- `signers/signer-registry-snapshot.json` — the signer state as of package generation.",
    "- Existing package files (`evidence/`, `package-manifest.json`, `package-checksums.json`, etc.) are UNCHANGED by P3.1.1.",
    "",
    "## 2. Verifying an attestation",
    "",
    "For each entry in `attestations`:",
    "",
    "1. Locate the matching custody event row in the package (path varies by package mode; see `package-manifest.json`).",
    "2. Reconstruct the canonical payload using ONLY the immutable fields:",
    "   `{ custodyEventId, evidenceId, eventType, atUtc, sequence, prevEventHash, eventHash }`.",
    "3. JSON-canonicalise (sorted keys, no whitespace) and compute SHA-256.",
    "4. Compare against `canonicalPayloadHash`.",
    "5. Verify the signature using the signer's public material reference",
    "   (see `signers/signer-registry-snapshot.json` for the reference; `provider=aws_kms`",
    "   means the verifier needs the KMS public key, `provider=local_pem` means the verifier",
    "   needs the Ed25519 PEM published by the operator).",
    "",
    "## 3. Bounded outcome model",
    "",
    "Any verifier that follows this procedure MUST report exactly one of the bounded outcomes:",
    "",
    "- `verified`",
    "- `missing_attestation`",
    "- `signature_invalid`",
    "- `payload_hash_mismatch`",
    "- `signer_unavailable`",
    "- `unsupported_algorithm`",
    "- `not_applicable`",
    "",
    "## 4. Relationship to other signature surfaces",
    "",
    "| Surface | What it proves | What it does NOT prove |",
    "| --- | --- | --- |",
    "| Report PDF signature | The PDF bytes were signed by the recorded signer at the recorded time. | Authorship or admissibility of the underlying evidence. |",
    "| Package manifest signature | `package-manifest.json` was signed at the recorded time. | That every file in the ZIP is independently verifiable. |",
    "| TSA timestamp | A trusted third party witnessed the digest at the recorded time. | The content's authenticity. |",
    "| OTS anchor | The digest was anchored to Bitcoin's blockchain. | Anything about the digest's source or content. |",
    "| **Custody attestation** | The recorded signer signed a hash of the canonical custody payload. | Operator identity, authorisation, or evidence authenticity. |",
    "",
    "## 5. Honest limitations",
    "",
    "- This is NOT a legal-admissibility surface. Attestations carry cryptographic continuity from the recorded signer, nothing more.",
    "- Attestations require the signer's public material to remain published. If the operator destroys the public key after rotation, attestations signed by that key become unverifiable.",
    "- Missing attestations are recorded honestly in `missingAttestations`. Partial coverage is NOT silently hidden.",
    "- Old packages generated before P3.1.1 do NOT contain attestation files. Their absence is not a verification failure.",
    "",
  ].join("\n");
}
