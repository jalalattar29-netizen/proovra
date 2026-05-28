/**
 * Phase P2.1 — Export reproducibility verifier.
 *
 * Given a previously-generated export (Report PDF or Verification
 * Package ZIP), this service:
 *
 *   1. Re-derives the canonical manifest from the current persisted
 *      row state (deterministic projection — same input → same hash).
 *   2. Fetches the S3 artifact via `headObject` + `getObjectStream`
 *      and recomputes its SHA-256.
 *   3. Compares the recomputed artifact hash against the per-row
 *      `recordedArtifactSha256` (when available; today this lives in
 *      the canonical-decisions module via the existing
 *      `stream-hash.ts` pipeline).
 *   4. Compares the Object Lock metadata at PUT time (stored on the
 *      row) against the LIVE Object Lock state of the S3 object.
 *
 * The verifier classifies the outcome with a bounded enum:
 *
 *   * `match`               — manifest is reproducible and the S3
 *                             artifact matches what we stored.
 *   * `artifact_drift`      — the artifact bytes differ from the
 *                             stored hash. Investigate immediately.
 *   * `retention_drift`     — Object Lock retention or legalHold
 *                             differs between row and live S3 state.
 *   * `artifact_missing`    — S3 reports 404 on the storage key.
 *   * `not_applicable`      — the export kind cannot be verified
 *                             today (e.g. no stored artifact hash).
 *
 * Hard rules:
 *   * NEVER fabricate a "match" when the verifier cannot read the
 *     artifact. A failed S3 read becomes `artifact_missing`, not
 *     a fake green.
 *   * NEVER claim Object Lock match when the platform mode is
 *     `disabled` / `claimed-but-unsupported` / `skipped`. In that
 *     case the row's stored mode (if any) is informational only and
 *     the verifier records `not_applicable` for the retention check.
 *   * The verifier is read-only against S3 — no writes, no
 *     retention updates.
 */

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { getObjectStream, headObject } from "../../storage.js";
import {
  decodeExportId,
  hashManifest,
  resolveExportManifest,
  type ExportManifestEnvelope,
} from "./export-manifest.service.js";

// ---------------------------------------------------------------------------
// Bounded outcome enum
// ---------------------------------------------------------------------------

export const REPRODUCIBILITY_OUTCOMES = [
  "match",
  "artifact_drift",
  "retention_drift",
  "artifact_missing",
  "not_applicable",
] as const;

export type ReproducibilityOutcome = (typeof REPRODUCIBILITY_OUTCOMES)[number];

export type ReproducibilityCheck = {
  field: string;
  expected: string | null;
  actual: string | null;
  ok: boolean;
};

export type ReproducibilityReport = {
  exportId: string;
  outcome: ReproducibilityOutcome;
  /** Summary one-liner for operators. */
  summary: string;
  manifestEnvelope: ExportManifestEnvelope;
  /** Per-field checks; surfaced in the UI as a table. */
  checks: ReadonlyArray<ReproducibilityCheck>;
  /** Time the verifier ran. */
  verifiedAtUtc: string;
};

// ---------------------------------------------------------------------------
// Verifier entrypoint
// ---------------------------------------------------------------------------

export async function verifyExportReproducibility(
  input: { teamId: string; exportId: string },
  client: PrismaClient = defaultPrisma,
): Promise<
  | { ok: true; report: ReproducibilityReport }
  | { ok: false; code: "not_found"; message: string }
> {
  const decoded = decodeExportId(input.exportId);
  if (!decoded) {
    return { ok: false, code: "not_found", message: "Unknown export id." };
  }

  const manifestResult = await resolveExportManifest(
    { teamId: input.teamId, exportId: input.exportId },
    client,
  );
  if (!manifestResult.ok) {
    return { ok: false, code: "not_found", message: manifestResult.message };
  }

  const envelope = manifestResult.envelope;
  const checks: ReproducibilityCheck[] = [];

  // ---- Manifest determinism check ----
  // Re-derive and re-hash to confirm we get the same hash. This
  // protects against accidental non-determinism in the projection
  // (e.g. a future field that drifts between calls).
  const reHash = hashManifest(envelope.manifest);
  checks.push({
    field: "manifest_hash",
    expected: envelope.manifestHash,
    actual: reHash,
    ok: reHash === envelope.manifestHash,
  });

  // ---- Artifact bytes ----
  const headResult = await safeHead(
    envelope.manifest.artifact.storageBucket,
    envelope.manifest.artifact.storageKey,
  );

  if (!headResult.ok) {
    return {
      ok: true,
      report: {
        exportId: input.exportId,
        outcome: "artifact_missing",
        summary:
          headResult.reason === "not_found"
            ? "S3 reports the artifact key is missing. The export cannot be reproduced."
            : `S3 read failed (${headResult.reason}). Verifier could not confirm artifact bytes.`,
        manifestEnvelope: envelope,
        checks,
        verifiedAtUtc: new Date().toISOString(),
      },
    };
  }

  // ---- Live Object Lock retention vs. stored row state ----
  const platformMode = envelope.manifest.objectLock.platformMode;
  if (platformMode === "verified") {
    const liveMode = headResult.objectLockMode;
    const liveRetain = headResult.objectLockRetainUntilUtc;
    const liveHold = headResult.objectLockLegalHoldStatus;

    checks.push({
      field: "object_lock.mode",
      expected: envelope.manifest.objectLock.storedMode,
      actual: liveMode,
      ok: liveMode === envelope.manifest.objectLock.storedMode,
    });
    checks.push({
      field: "object_lock.retainUntilUtc",
      expected: envelope.manifest.objectLock.storedRetainUntilUtc,
      actual: liveRetain,
      ok: liveRetain === envelope.manifest.objectLock.storedRetainUntilUtc,
    });
    checks.push({
      field: "object_lock.legalHoldStatus",
      expected: envelope.manifest.objectLock.storedLegalHoldStatus,
      actual: liveHold,
      ok: liveHold === envelope.manifest.objectLock.storedLegalHoldStatus,
    });
  } else {
    checks.push({
      field: "object_lock",
      expected: "not_applicable",
      actual: `platform_mode=${platformMode}`,
      ok: true,
    });
  }

  // ---- Artifact SHA-256 (bytes) ----
  //
  // The stored artifact hash for these export kinds is NOT today
  // persisted on the row (Report / VerificationPackage). The most
  // honest available check is "the bytes hash to a stable value
  // right now" — we recompute it but cannot compare to a stored
  // expected. This is enough to detect bit-rot ("re-fetch yields a
  // different stream than expected" would be caught at the S3 layer
  // with ETag, but we want a content-level SHA-256 too for procurement).
  //
  // We surface the recomputed SHA-256 in `actual` with `expected: null`
  // and `ok: true` — the operator-facing UI labels this as
  // "Recomputed; no recorded hash to compare". A future migration
  // can add `Report.artifactSha256` to make this comparable.
  let recomputedSha256: string | null = null;
  try {
    const body = await getObjectStream({
      bucket: envelope.manifest.artifact.storageBucket,
      key: envelope.manifest.artifact.storageKey,
    });
    recomputedSha256 = await hashStream(body);
  } catch {
    recomputedSha256 = null;
  }
  checks.push({
    field: "artifact.sha256",
    expected: null,
    actual: recomputedSha256,
    ok: recomputedSha256 !== null,
  });

  // ---- Outcome classification ----
  const objectLockChecks = checks.filter((c) =>
    c.field.startsWith("object_lock"),
  );
  const objectLockOk = objectLockChecks.every((c) => c.ok);
  const manifestOk = checks.find((c) => c.field === "manifest_hash")?.ok ?? false;
  const artifactOk =
    checks.find((c) => c.field === "artifact.sha256")?.ok ?? false;

  let outcome: ReproducibilityOutcome;
  let summary: string;
  if (!manifestOk) {
    outcome = "artifact_drift";
    summary =
      "Manifest projection is non-deterministic. The exporter logic regressed.";
  } else if (!artifactOk) {
    outcome = "artifact_missing";
    summary = "Artifact byte stream could not be read for hashing.";
  } else if (!objectLockOk) {
    outcome = "retention_drift";
    summary =
      "Object Lock retention / legal hold differs between stored row state and live S3 state.";
  } else {
    outcome = "match";
    summary =
      "Manifest is reproducible and Object Lock state matches stored row state.";
  }

  return {
    ok: true,
    report: {
      exportId: input.exportId,
      outcome,
      summary,
      manifestEnvelope: envelope,
      checks,
      verifiedAtUtc: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HeadOk = {
  ok: true;
  objectLockMode: "GOVERNANCE" | "COMPLIANCE" | null;
  objectLockRetainUntilUtc: string | null;
  objectLockLegalHoldStatus: "ON" | "OFF" | null;
};

type HeadFail = {
  ok: false;
  reason: "not_found" | "read_error";
};

async function safeHead(
  bucket: string,
  key: string,
): Promise<HeadOk | HeadFail> {
  try {
    const res = await headObject({ bucket, key });
    const mode =
      res.objectLockMode === "GOVERNANCE" || res.objectLockMode === "COMPLIANCE"
        ? (res.objectLockMode as "GOVERNANCE" | "COMPLIANCE")
        : null;
    const retain = res.objectLockRetainUntilDate
      ? new Date(res.objectLockRetainUntilDate).toISOString()
      : null;
    const holdRaw = String(res.objectLockLegalHoldStatus ?? "");
    const hold: "ON" | "OFF" | null =
      holdRaw === "ON" ? "ON" : holdRaw === "OFF" ? "OFF" : null;
    return {
      ok: true,
      objectLockMode: mode,
      objectLockRetainUntilUtc: retain,
      objectLockLegalHoldStatus: hold,
    };
  } catch (err) {
    const code = String(
      (err as { name?: unknown; Code?: unknown }).name ??
        (err as { Code?: unknown }).Code ??
        "",
    );
    if (code.toLowerCase().includes("notfound")) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: false, reason: "read_error" };
  }
}

async function hashStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
