/**
 * 2026-10-29 — which ORIGINAL parts a combined recording is built from, and
 * why each is trusted. PURE: the handler reads the rows and the manifest bytes;
 * this decides.
 *
 *   * The manifest is the record's CAPTURE_MANIFEST part named by the seal's
 *     own trust facts (manifestPartIndex + manifestSha256 in the
 *     CAPTURE_ARTIFACT_RECEIVED manifest-facts record). Its stored digest must
 *     equal the facts' digest, and the bytes read must hash to it (checked by
 *     the caller before parsing).
 *   * A segment is admitted only when its part exists, is a video, and its
 *     sealed digest (EvidencePart.sha256) equals the manifest's expectedSha256
 *     and its size equals the manifest's sizeBytes. A disagreement is NOT a gap
 *     to paper over — the whole combine fails closed.
 *   * A segment the manifest lists that the record does not hold is a missing
 *     segment (PARTIAL), never an error.
 *   * A SINGLE_FILE recording (wire contract A) is already one file: there is
 *     nothing to combine.
 */

import {
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  SCREEN_RECORDING_COMBINE_ACQUISITION_MODES,
} from "@proovra/shared";

import type { CombineManifestFacts } from "./combine-recording.js";

export type CombinePartRow = {
  id: string;
  partIndex: number;
  storageBucket: string | null;
  storageKey: string | null;
  storageVersionId: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  sha256: string | null;
  artifactClass: string | null;
};

export type CombineSourcePart = CombinePartRow & {
  storageBucket: string;
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  sequence: number;
  startedAtOffsetMs: number;
  durationMs: number;
};

export type CombineInputsDecision =
  | {
      ok: true;
      manifest: CombineManifestFacts;
      sources: CombineSourcePart[];
      missingInRecord: number[];
    }
  | { ok: false; outcome: "unsupported" | "failed"; reason: string };

/** Step 1 — is this record a candidate at all, and which part is its manifest? */
export function locateCombineManifest(input: {
  acquisitionMode: string | null;
  facts: { kind: string; manifestPartIndex: number; manifestSha256: string } | null;
  parts: ReadonlyArray<CombinePartRow>;
}):
  | { ok: true; manifestPart: CombinePartRow & { sha256: string }; manifestSha256: string }
  | { ok: false; outcome: "unsupported" | "failed"; reason: string } {
  if (!(SCREEN_RECORDING_COMBINE_ACQUISITION_MODES as ReadonlyArray<string>).includes(input.acquisitionMode ?? "")) {
    return { ok: false, outcome: "unsupported", reason: "not_a_continuous_screen_recording" };
  }
  if (!input.facts || input.facts.kind !== "SCREEN_CONTINUOUS") {
    return { ok: false, outcome: "unsupported", reason: "no_continuous_manifest_facts" };
  }
  const digest = input.facts.manifestSha256.toLowerCase();
  const part = input.parts.find((p) => p.partIndex === input.facts!.manifestPartIndex);
  if (!part || !part.sha256 || !part.storageBucket || !part.storageKey) {
    return { ok: false, outcome: "failed", reason: "manifest_part_missing" };
  }
  if (part.sha256.toLowerCase() !== digest) return { ok: false, outcome: "failed", reason: "manifest_digest_mismatch" };
  return { ok: true, manifestPart: part as CombinePartRow & { sha256: string }, manifestSha256: digest };
}

const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Step 2 — the digest-verified manifest JSON + the record's parts → the sources. */
export function decideCombineInputs(input: {
  manifestJson: unknown;
  manifestPartIndex: number;
  manifestSha256: string;
  parts: ReadonlyArray<CombinePartRow>;
}): CombineInputsDecision {
  const m = input.manifestJson as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || m["schemaVersion"] !== SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, outcome: "failed", reason: "manifest_unreadable" };
  }
  if (m["recordingLayout"] === "SINGLE_FILE") {
    return { ok: false, outcome: "unsupported", reason: "single_file_recording" };
  }
  if (!Array.isArray(m["segments"])) return { ok: false, outcome: "failed", reason: "manifest_unreadable" };

  const byIndex = new Map(input.parts.map((p) => [p.partIndex, p]));
  const sources: CombineSourcePart[] = [];
  const missingInRecord: number[] = [];
  const seen = new Set<number>();
  for (const raw of m["segments"] as unknown[]) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (!isInt(s["partIndex"]) || !isInt(s["sequence"]) || !isInt(s["startedAtOffsetMs"]) || !isInt(s["durationMs"])) {
      return { ok: false, outcome: "failed", reason: "manifest_segment_malformed" };
    }
    const expected = typeof s["expectedSha256"] === "string" ? s["expectedSha256"].toLowerCase() : "";
    if (!HEX64.test(expected) || !isInt(s["sizeBytes"])) {
      return { ok: false, outcome: "failed", reason: "manifest_segment_malformed" };
    }
    if (seen.has(s["sequence"] as number)) return { ok: false, outcome: "failed", reason: "manifest_sequence_duplicated" };
    seen.add(s["sequence"] as number);
    const part = byIndex.get(s["partIndex"] as number);
    if (!part) {
      missingInRecord.push(s["sequence"] as number);
      continue;
    }
    if (part.partIndex === input.manifestPartIndex) return { ok: false, outcome: "failed", reason: "segment_is_manifest" };
    if (!part.sha256 || part.sha256.toLowerCase() !== expected) {
      return { ok: false, outcome: "failed", reason: `segment_digest_mismatch:${s["sequence"]}` };
    }
    if (part.sizeBytes == null || part.sizeBytes !== s["sizeBytes"]) {
      return { ok: false, outcome: "failed", reason: `segment_size_mismatch:${s["sequence"]}` };
    }
    if (!(part.mimeType ?? "").toLowerCase().startsWith("video/") || !part.storageBucket || !part.storageKey) {
      return { ok: false, outcome: "failed", reason: `segment_not_stored_video:${s["sequence"]}` };
    }
    sources.push({
      ...part,
      storageBucket: part.storageBucket,
      storageKey: part.storageKey,
      sizeBytes: part.sizeBytes,
      sha256: part.sha256.toLowerCase(),
      sequence: s["sequence"] as number,
      startedAtOffsetMs: s["startedAtOffsetMs"] as number,
      durationMs: s["durationMs"] as number,
    });
  }
  sources.sort((a, b) => a.sequence - b.sequence);
  if (sources.length < 2) return { ok: false, outcome: "unsupported", reason: "fewer_than_two_segments" };
  const limitations = Array.isArray(m["limitations"])
    ? (m["limitations"] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 64)
    : [];
  return {
    ok: true,
    manifest: {
      partIndex: input.manifestPartIndex,
      sha256: input.manifestSha256,
      schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
      recordedSegmentCount: isInt(m["recordedSegmentCount"]) ? (m["recordedSegmentCount"] as number) : null,
      totalDurationMs: isInt(m["totalDurationMs"]) ? (m["totalDurationMs"] as number) : null,
      sessionCompleteness: typeof m["sessionCompleteness"] === "string" ? (m["sessionCompleteness"] as string) : "UNKNOWN",
      limitations,
    },
    sources,
    missingInRecord: missingInRecord.sort((a, b) => a - b),
  };
}
