/**
 * THE CANONICAL PROVENANCE TIME MODEL (UC-PROV-001, 2026-10-01).
 *
 * A record carries several clocks, each saying something different. The
 * column `Evidence.capturedAtUtc` is NOT a capture time: it is the PROOVRA
 * server's clock when the record was created (upload, intake submission or the
 * reservation of a direct-capture session — after the capture ran). Surfaces
 * used to print it as "Captured At", "Captured & Signed" and even "declared by
 * the capturing device".
 *
 * Every surface that states a time about a record's origin builds it here,
 * and names each time by WHAT observed it:
 *
 *   SOURCE_DECLARED_CAPTURE  a time written into the file by its source
 *                            (e.g. EXIF DateTimeOriginal) — file metadata
 *   DEVICE_OBSERVED          the capturing device's own clock, as the client
 *                            reported it (deviceTimeIso)
 *   APPLICATION_OBSERVED     the capture window the PROOVRA capture client
 *                            reported in its manifest (start / end)
 *   SERVER_RECEIVED          the PROOVRA server clock when the record was
 *                            created from the submission (capturedAtUtc)
 *   UPLOAD_STARTED           the server clock when the capture session /
 *                            upload was opened
 *   RECORD_CREATED           the record row's creation time
 *   FINALIZED                the server clock when the record was sealed and
 *                            signed
 *   TSA                      the RFC 3161 authority's genTime — independently
 *                            established ONLY when the token was validated
 *   OTS                      the Bitcoin anchoring time — independently
 *                            established ONLY when verified against the chain
 *
 * A capture time is stated only from SOURCE_DECLARED_CAPTURE,
 * DEVICE_OBSERVED or APPLICATION_OBSERVED, always labelled with who declared
 * it. Server times are never presented as capture times. When none exists the
 * answer is "Capture time not available". Legacy records project what they
 * have — normally the server-received time only; no history is fabricated.
 */
import { resolveOtsProofStatus, resolveTsaProofStatus } from "./ots-status.js";

export const PROVENANCE_TIME_KINDS = [
  "SOURCE_DECLARED_CAPTURE",
  "DEVICE_OBSERVED",
  "APPLICATION_OBSERVED",
  "SERVER_RECEIVED",
  "UPLOAD_STARTED",
  "RECORD_CREATED",
  "FINALIZED",
  "TSA",
  "OTS",
] as const;
export type ProvenanceTimeKind = (typeof PROVENANCE_TIME_KINDS)[number];

export type ProvenanceTimeSource =
  | "FILE_METADATA"
  | "CAPTURE_DEVICE_CLOCK"
  | "CAPTURE_CLIENT"
  | "PROOVRA_SERVER"
  | "RFC3161_AUTHORITY"
  | "BITCOIN_ANCHOR";

/**
 * How far the time can be relied on:
 *   CLIENT_REPORTED           declared by the file or the client; not proven
 *   SERVER_OBSERVED           PROOVRA's own clock at the named event
 *   INDEPENDENTLY_VALIDATED   an independent authority's time, validated
 *   RECORDED_NOT_VALIDATED    an independent authority's time kept without
 *                             validation (legacy RFC 3161 token, unchecked
 *                             anchor)
 */
export type ProvenanceTimeConfidence =
  | "CLIENT_REPORTED"
  | "SERVER_OBSERVED"
  | "INDEPENDENTLY_VALIDATED"
  | "RECORDED_NOT_VALIDATED";

export type ProvenanceTimeEntry = {
  kind: ProvenanceTimeKind;
  atUtc: string;
  /** Present for APPLICATION_OBSERVED: the end of the reported window. */
  endAtUtc?: string | null;
  source: ProvenanceTimeSource;
  confidence: ProvenanceTimeConfidence;
  label: string;
};

export const PROVENANCE_TIME_LABELS: Readonly<Record<ProvenanceTimeKind, string>> = {
  SOURCE_DECLARED_CAPTURE: "Capture time declared in the file's metadata",
  DEVICE_OBSERVED: "Device-declared capture time",
  APPLICATION_OBSERVED: "Capture window reported by the capture app",
  SERVER_RECEIVED: "Server received at",
  UPLOAD_STARTED: "Upload started (server)",
  RECORD_CREATED: "Record created",
  FINALIZED: "Finalized and signed",
  TSA: "RFC 3161 timestamp time",
  OTS: "Bitcoin anchor time",
};

/** The one sentence for "no capture time is known". */
export const CAPTURE_TIME_NOT_AVAILABLE = "Capture time not available";

export type ProvenanceTimeInput = {
  /** Evidence.capturedAtUtc — the server clock at record creation. */
  serverReceivedAtUtc?: Date | string | null;
  /** Evidence.createdAt. */
  recordCreatedAtUtc?: Date | string | null;
  /** Server clock when the capture session / upload was opened. */
  uploadStartedAtUtc?: Date | string | null;
  /** Evidence.signedAtUtc. */
  finalizedAtUtc?: Date | string | null;
  /** Evidence.deviceTimeIso — the capturing device's clock, client-reported. */
  deviceTimeIso?: string | null;
  /** The capture client's manifest window (client-reported). */
  applicationCaptureStartedAtUtc?: Date | string | null;
  applicationCaptureEndedAtUtc?: Date | string | null;
  /** A capture time embedded in the file (e.g. EXIF DateTimeOriginal). */
  sourceDeclaredCaptureAtUtc?: Date | string | null;
  tsa?: {
    status: string | null | undefined;
    validatedAtUtc?: Date | string | null;
    genTimeUtc?: Date | string | null;
  } | null;
  ots?: {
    status: string | null | undefined;
    anchoredAtUtc?: Date | string | null;
    anchorCheck?: string | null;
    bitcoinTxid?: string | null;
  } | null;
};

export type ProvenanceTimeline = {
  schema: "PROOVRA_PROVENANCE_TIME_V1";
  entries: ProvenanceTimeEntry[];
  /**
   * The best-supported capture time, when any source declared one; null
   * otherwise. Never a server time.
   */
  captureTime: ProvenanceTimeEntry | null;
  /** "Device-declared capture time: …" or "Capture time not available". */
  captureTimeStatement: string;
};

function iso(v: Date | string | null | undefined): string | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function buildProvenanceTimeline(input: ProvenanceTimeInput): ProvenanceTimeline {
  const entries: ProvenanceTimeEntry[] = [];
  const push = (
    kind: ProvenanceTimeKind,
    at: string | null,
    source: ProvenanceTimeSource,
    confidence: ProvenanceTimeConfidence,
    extra: Partial<ProvenanceTimeEntry> = {},
  ) => {
    if (!at) return;
    entries.push({ kind, atUtc: at, source, confidence, label: PROVENANCE_TIME_LABELS[kind], ...extra });
  };

  push("SOURCE_DECLARED_CAPTURE", iso(input.sourceDeclaredCaptureAtUtc), "FILE_METADATA", "CLIENT_REPORTED");
  push("DEVICE_OBSERVED", iso(input.deviceTimeIso), "CAPTURE_DEVICE_CLOCK", "CLIENT_REPORTED");
  push(
    "APPLICATION_OBSERVED",
    iso(input.applicationCaptureStartedAtUtc),
    "CAPTURE_CLIENT",
    "CLIENT_REPORTED",
    { endAtUtc: iso(input.applicationCaptureEndedAtUtc) },
  );
  push("UPLOAD_STARTED", iso(input.uploadStartedAtUtc), "PROOVRA_SERVER", "SERVER_OBSERVED");
  push("SERVER_RECEIVED", iso(input.serverReceivedAtUtc), "PROOVRA_SERVER", "SERVER_OBSERVED");
  push("RECORD_CREATED", iso(input.recordCreatedAtUtc), "PROOVRA_SERVER", "SERVER_OBSERVED");
  push("FINALIZED", iso(input.finalizedAtUtc), "PROOVRA_SERVER", "SERVER_OBSERVED");

  if (input.tsa) {
    const tsaStatus = resolveTsaProofStatus({
      tsaStatus: input.tsa.status,
      tsaValidatedAtUtc: input.tsa.validatedAtUtc ?? null,
    });
    if (tsaStatus === "VALIDATED" || tsaStatus === "RECORDED_NOT_VALIDATED") {
      push(
        "TSA",
        iso(input.tsa.genTimeUtc),
        "RFC3161_AUTHORITY",
        tsaStatus === "VALIDATED" ? "INDEPENDENTLY_VALIDATED" : "RECORDED_NOT_VALIDATED",
      );
    }
  }
  if (input.ots) {
    const otsStatus = resolveOtsProofStatus({
      status: input.ots.status,
      anchoredAtUtc: input.ots.anchoredAtUtc ?? null,
      anchorCheck: input.ots.anchorCheck ?? null,
      ...(input.ots.bitcoinTxid !== undefined ? { bitcoinTxid: input.ots.bitcoinTxid } : {}),
    });
    if (otsStatus === "VERIFIED" || otsStatus === "ANCHORED_UNVERIFIED") {
      push(
        "OTS",
        iso(input.ots.anchoredAtUtc),
        "BITCOIN_ANCHOR",
        otsStatus === "VERIFIED" ? "INDEPENDENTLY_VALIDATED" : "RECORDED_NOT_VALIDATED",
      );
    }
  }

  // Preference among CLIENT-DECLARED capture times: the capture app's own
  // window (it ran the capture), then the device clock, then file metadata.
  const captureTime =
    entries.find((e) => e.kind === "APPLICATION_OBSERVED") ??
    entries.find((e) => e.kind === "DEVICE_OBSERVED") ??
    entries.find((e) => e.kind === "SOURCE_DECLARED_CAPTURE") ??
    null;

  return {
    schema: "PROOVRA_PROVENANCE_TIME_V1",
    entries,
    captureTime,
    captureTimeStatement: captureTime ? `${captureTime.label}: ${captureTime.atUtc}` : CAPTURE_TIME_NOT_AVAILABLE,
  };
}

/** The entry of one kind, when the timeline has it. */
export function provenanceTimeOf(
  timeline: ProvenanceTimeline,
  kind: ProvenanceTimeKind,
): ProvenanceTimeEntry | null {
  return timeline.entries.find((e) => e.kind === kind) ?? null;
}
