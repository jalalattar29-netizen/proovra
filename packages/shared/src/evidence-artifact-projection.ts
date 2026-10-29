/**
 * WIRE CONTRACT D (2026-10-29) — the ONE projection of an Evidence record's
 * stored artifacts into what a USER calls evidence and what is TECHNICAL.
 *
 * A record stores N `EvidencePart` rows. Every user-facing count used to be
 * `N` — so one continuous screen recording read "7 items" (six segments and the
 * capture manifest) and the manifest was printed as "Supporting · Text
 * Evidence". The stored rows, their hashes, ordering, package seals and
 * signatures are unchanged by this module: it is presentation only.
 *
 *   - A continuous screen recording (`DIRECT_SCREEN_CAPTURE_IOS`,
 *     `DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS`; SEGMENTED or SINGLE_FILE) is
 *     ONE user item, "Screen recording". Its segments and its manifest are
 *     technical parts.
 *   - A `CAPTURE_MANIFEST` part is NEVER user evidence, on any record, in any
 *     output: it is a "Capture record (system-generated)".
 *   - Every other record keeps one user item per ORIGINAL part (unchanged).
 *
 * Callers that only hold counts (list rows) use `countEvidenceUserItems`;
 * callers that hold the parts use `projectEvidenceArtifacts`. Both apply the
 * same rule, so the list, the detail page, public verify, the PDF and the
 * package README cannot disagree.
 */

import {
  readContinuousRecordingFacts,
  type ContinuousRecordingFacts,
} from "./screen-continuous-manifest.js";

/** The acquisition modes whose ORIGINAL parts together form ONE recording. */
export const CONTINUOUS_SCREEN_RECORDING_MODES = [
  "DIRECT_SCREEN_CAPTURE_IOS",
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
] as const;

export function isContinuousScreenRecordingMode(
  mode: string | null | undefined,
): boolean {
  return (
    typeof mode === "string" &&
    (CONTINUOUS_SCREEN_RECORDING_MODES as readonly string[]).includes(mode)
  );
}

export const SCREEN_RECORDING_ITEM_LABEL = "Screen recording" as const;
export const CAPTURE_RECORD_SYSTEM_LABEL = "Capture record (system-generated)" as const;
export const RECORDING_TECHNICAL_PART_LABEL = "Recording part (technical)" as const;
export const COMBINED_RECORDING_DERIVED_LABEL = "Combined recording (derived)" as const;

/** "Combined recording (derived from 6 original segments)". */
export function combinedRecordingDerivedLabel(originalSegmentCount: number): string {
  const n = Math.max(0, Math.floor(originalSegmentCount || 0));
  return `Combined recording (derived from ${n} original segment${n === 1 ? "" : "s"})`;
}

/**
 * The derived-asset kind of the historical combined recording of a SEGMENTED
 * session (COMBINE implementer). A derived copy is review material, never an
 * original and never part of the sealed evidence.
 */
export const COMBINED_RECORDING_ASSET_KIND = "screen_recording_combined" as const;

export type EvidenceRecordingLayout = "SINGLE_FILE" | "SEGMENTED";

/** How ONE stored part is presented. */
export type EvidencePartPresentation =
  /** A user-facing evidence item in its own right (one per ORIGINAL part). */
  | "user_item"
  /** A technical part of ONE recording (a segment, or the single recording file). */
  | "recording_part"
  /** A system-generated capture record (CAPTURE_MANIFEST). Never user evidence. */
  | "capture_record";

export function classifyEvidencePartPresentation(input: {
  acquisitionMode: string | null | undefined;
  artifactClass: string | null | undefined;
}): EvidencePartPresentation {
  if (input.artifactClass === "CAPTURE_MANIFEST") return "capture_record";
  return isContinuousScreenRecordingMode(input.acquisitionMode)
    ? "recording_part"
    : "user_item";
}

export type EvidenceArtifactProjectionPart = {
  partIndex: number;
  mimeType?: string | null;
  sizeBytes?: number | string | bigint | null;
  sha256?: string | null;
  artifactClass?: string | null;
  clientReportedSource?: string | null;
  originalFileName?: string | null;
};

export type EvidenceArtifactProjectionDerived = {
  assetKind: string;
  status: string;
  [key: string]: unknown;
};

export type EvidenceUserItemKind = "recording" | "file";

export type EvidenceUserItem = {
  kind: EvidenceUserItemKind;
  label: string;
  /** The ORIGINAL parts that make up this item, in part order. */
  partIndexes: number[];
  primaryPartIndex: number;
  /** Recording layout; null for an ordinary file item. */
  layout: EvidenceRecordingLayout | null;
  /**
   * The derived combined recording (review copy) of a SEGMENTED recording,
   * when one exists in any state; `available` only when it is COMPLETED.
   */
  combined?: {
    status: string;
    available: boolean;
    label: string;
    asset: EvidenceArtifactProjectionDerived;
  } | null;
};

export type EvidenceArtifactProjection = {
  userItems: EvidenceUserItem[];
  technical: {
    /** Every ORIGINAL part (the files in evidence-parts/). */
    originalPartCount: number;
    /** CAPTURE_MANIFEST parts ("Capture record (system-generated)"). */
    captureRecordCount: number;
    derivedCount: number;
    /** originalPartCount + captureRecordCount — every stored part row. */
    storedPartCount: number;
    captureRecordPartIndexes: number[];
  };
  counts: { userItems: number };
};

function isOriginal(part: EvidenceArtifactProjectionPart): boolean {
  return part.artifactClass !== "CAPTURE_MANIFEST";
}

function pickCombined(
  derived: ReadonlyArray<EvidenceArtifactProjectionDerived> | undefined,
  segmentCount: number,
): EvidenceUserItem["combined"] {
  const rows = (derived ?? []).filter(
    (d) => d.assetKind === COMBINED_RECORDING_ASSET_KIND && d.status !== "SUPERSEDED",
  );
  if (rows.length === 0) return null;
  const best = rows.find((d) => d.status === "COMPLETED") ?? rows[0]!;
  return {
    status: best.status,
    available: best.status === "COMPLETED",
    label: combinedRecordingDerivedLabel(segmentCount),
    asset: best,
  };
}

export function projectEvidenceArtifacts(input: {
  acquisitionMode: string | null | undefined;
  parts: ReadonlyArray<EvidenceArtifactProjectionPart>;
  derived?: ReadonlyArray<EvidenceArtifactProjectionDerived>;
  /** The manifest's `recordingLayout` when the caller has read it. */
  recordingLayout?: EvidenceRecordingLayout | null;
}): EvidenceArtifactProjection {
  const parts = [...input.parts].sort((a, b) => a.partIndex - b.partIndex);
  const originals = parts.filter(isOriginal);
  const captureRecords = parts.filter((p) => !isOriginal(p));
  const technical = {
    originalPartCount: originals.length,
    captureRecordCount: captureRecords.length,
    derivedCount: (input.derived ?? []).length,
    storedPartCount: parts.length,
    captureRecordPartIndexes: captureRecords.map((p) => p.partIndex),
  };

  let userItems: EvidenceUserItem[];
  if (isContinuousScreenRecordingMode(input.acquisitionMode) && originals.length > 0) {
    // Absent a manifest-stated layout, one original IS one complete file; a
    // legacy session's several segments are SEGMENTED.
    const layout: EvidenceRecordingLayout =
      input.recordingLayout ?? (originals.length === 1 ? "SINGLE_FILE" : "SEGMENTED");
    userItems = [
      {
        kind: "recording",
        label: SCREEN_RECORDING_ITEM_LABEL,
        partIndexes: originals.map((p) => p.partIndex),
        primaryPartIndex: originals[0]!.partIndex,
        layout,
        combined: layout === "SEGMENTED" ? pickCombined(input.derived, originals.length) : null,
      },
    ];
  } else {
    userItems = originals.map((p, i) => ({
      kind: "file" as const,
      label: p.originalFileName?.trim() || `Item ${i + 1}`,
      partIndexes: [p.partIndex],
      primaryPartIndex: p.partIndex,
      layout: null,
    }));
  }

  return { userItems, technical, counts: { userItems: userItems.length } };
}

/**
 * The user-item count from counts alone (list rows). `originalPartCount` is
 * the number of ORIGINAL parts; a record with no part rows (legacy single
 * file) is one item.
 */
export function countEvidenceUserItems(input: {
  acquisitionMode: string | null | undefined;
  originalPartCount: number;
}): number {
  const n = Math.max(0, Math.floor(input.originalPartCount || 0));
  if (n === 0) return 1;
  return isContinuousScreenRecordingMode(input.acquisitionMode) ? 1 : n;
}

/** "3 technical parts" — technical sections only, never a user count. */
export function technicalPartCountLabel(n: number): string {
  return `${n} technical part${n === 1 ? "" : "s"}`;
}

/** The download action for a record whose original is several stored files. */
export function downloadOriginalFilesLabel(technicalPartCount: number): string {
  return `Download original files (${technicalPartCountLabel(technicalPartCount)})`;
}

/**
 * RFC 6266 / RFC 5987 `Content-Disposition: attachment` for a stored file
 * name: an ASCII-only, quote-safe `filename=` fallback plus the UTF-8
 * `filename*=`. Path separators, control characters and quotes never reach
 * the header; an empty result falls back to `fallback`.
 */
export function safeAttachmentContentDisposition(
  fileName: string | null | undefined,
  fallback = "evidence-original",
): string {
  const cleaned = String(fileName ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\/]+/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 180);
  const name = cleaned || fallback;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[;%]/g, "_") || fallback;
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The continuous-recording facts (layout, audio tracks, …) recorded in the
 * custody chain's CAPTURE_ARTIFACT_RECEIVED manifest-facts event, or null for
 * any record without them. Pairs with `continuousRecordingAcquisitionText` so
 * every output states the layout and audio exactly as the manifest did.
 */
export function continuousRecordingFactsFromCustody(
  events: ReadonlyArray<{ eventType?: unknown; payload?: unknown }> | null | undefined,
): ContinuousRecordingFacts | null {
  for (const event of events ?? []) {
    if (String(event?.eventType ?? "") !== "CAPTURE_ARTIFACT_RECEIVED") continue;
    const facts = readContinuousRecordingFacts(event.payload);
    if (facts) return facts;
  }
  return null;
}
