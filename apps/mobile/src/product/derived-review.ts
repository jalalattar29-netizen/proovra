/**
 * UC-4 DERIVED REVIEW — pure projections for the native derived-review section.
 *
 * Ports `apps/web/lib/media-intelligence/useDerivedReview.ts` and
 * `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab.tsx` over
 * `GET /v1/evidence/:id/derived-review` and
 * `POST /v1/evidence/:id/derived-review/generate`.
 *
 * ===========================================================================
 * UC-4'S DISPOSITION: IT HAS A DIRECT CONTROL, AND IT BELONGS HERE
 * ===========================================================================
 * The canonical web surface is a TAB ON EVIDENCE DETAIL, shown only when the
 * record's own acquisition category is DIRECT_SCREEN_CAPTURE:
 *
 *   apps/web/app/(app)/evidence/[id]/page.tsx
 *     "UC-4 — Derived Review is a RECORD property (screen-capture originals
 *      only), never a workspace-kind gate: the tab set stays kind-invariant."
 *     !(t.id === "derived" &&
 *       workspace?.sourceContext?.acquisition?.category !== "DIRECT_SCREEN_CAPTURE")
 *
 * So there is no question of whether Native should have a control: it should,
 * on the same surface, under the same record-property gate. It matters more on
 * Native than on the web, because UC-2, UC-3 and UC-5 are the capture modes
 * that PRODUCE DIRECT_SCREEN_CAPTURE records — the device that made the
 * recording is the one that could not read what was reconstructed from it.
 *
 * The gate reads the SAME projection Evidence Detail already loads
 * (`projectProvenance(...).category`). It introduces no second source for
 * "is this a screen capture".
 *
 * ===========================================================================
 * EVERYTHING HERE IS DERIVED, AND MUST SAY SO
 * ===========================================================================
 * This is machine-extracted text reconstructed from keyframes. It is not the
 * evidence and it is not a transcript of truth — the projection carries
 * `provenance`, `coverage`, `limitations` and a per-block `confidence`
 * precisely so a reader is never left to assume. A surface that renders the
 * blocks and drops those is worse than no surface, so `derivedReviewCaveats`
 * exists and the section renders what it returns.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const strList = (v: unknown): string[] =>
  rows(v).filter((x): x is string => typeof x === "string" && x.length > 0);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The acquisition category that makes a record eligible. */
export const DERIVED_REVIEW_CATEGORY = "DIRECT_SCREEN_CAPTURE";

/**
 * Whether this record has a derived review at all.
 *
 * Takes the category the Evidence Detail projection already resolved, so
 * eligibility is decided once and in one place.
 */
export function isDerivedReviewEligible(acquisitionCategory: string | null): boolean {
  return acquisitionCategory === DERIVED_REVIEW_CATEGORY;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildDerivedReviewPath(
  evidenceId: string,
  teamId: string,
  offset = 0,
  limit = 100,
): string {
  return (
    `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-review` +
    `?teamId=${encodeURIComponent(teamId)}&offset=${offset}&limit=${limit}`
  );
}

export function buildDerivedReviewGeneratePath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-review/generate`;
}

export function buildGenerateBody(teamId: string, regenerate = false) {
  return { teamId, regenerate };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type DerivedRunStatus =
  | "NOT_REQUESTED"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "DISMISSED";

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "NOT_REQUESTED",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "DISMISSED",
]);

export interface DerivedRun {
  requested: boolean;
  status: DerivedRunStatus;
  lastError: string | null;
  updatedAtIso: string | null;
  hasDescriptor: boolean;
}

export type BlockConfidence =
  | "HIGH_OVERLAP"
  | "PARTIAL_OVERLAP"
  | "AMBIGUOUS"
  | "UNRESOLVED";

export interface DerivedBlock {
  blockId: string;
  sequence: number;
  kind: string;
  text: string;
  confidence: BlockConfidence;
  observedInFrames: number;
  keyframeIds: string[];
}

export interface DerivedProjection {
  coverage: "COMPLETE" | "PARTIAL" | null;
  acquisitionComplete: boolean;
  ocrEnabled: boolean;
  limitations: string[];
  provenance: { reconstructed: string | null; machineExtracted: string | null };
  generatedAtIso: string | null;
  blockTotal: number;
  blocks: DerivedBlock[];
  stats: {
    sourcePartCount: number;
    keyframeCount: number;
    ocrRegionCount: number;
    ocrFailedKeyframes: number;
    blockCount: number;
  };
}

export interface DerivedReview {
  evidenceId: string | null;
  run: DerivedRun;
  projection: DerivedProjection | null;
  /** keyframeId → absolute bytes URL, or null where the server had none. */
  keyframeUrls: Record<string, string | null>;
}

function parseRun(v: unknown): DerivedRun {
  const s = obj(v);
  const raw = str(s.status) ?? "NOT_REQUESTED";
  return {
    requested: s.requested === true,
    // An unrecognised status is NOT_REQUESTED rather than silently treated as
    // COMPLETED, which would render a half-finished reconstruction as final.
    status: (RUN_STATUSES.has(raw) ? raw : "NOT_REQUESTED") as DerivedRunStatus,
    lastError: str(s.lastError),
    updatedAtIso: str(s.updatedAtUtc) ?? str(s.updatedAt),
    hasDescriptor: s.hasDescriptor === true,
  };
}

const CONFIDENCES: ReadonlySet<string> = new Set([
  "HIGH_OVERLAP",
  "PARTIAL_OVERLAP",
  "AMBIGUOUS",
  "UNRESOLVED",
]);

function parseBlocks(v: unknown): DerivedBlock[] {
  return rows(v)
    .map((raw, i) => {
      const b = obj(raw);
      const blockId = str(b.blockId);
      if (!blockId) return null;
      const conf = str(b.confidence) ?? "UNRESOLVED";
      return {
        blockId,
        sequence: num(b.sequence) ?? i,
        kind: str(b.kind) ?? "UNKNOWN",
        text: typeof b.text === "string" ? b.text : "",
        // An unknown confidence is UNRESOLVED, never the strongest value.
        confidence: (CONFIDENCES.has(conf) ? conf : "UNRESOLVED") as BlockConfidence,
        observedInFrames: num(b.observedInFrames) ?? 0,
        keyframeIds: rows(b.sources).flatMap((s) => strList(obj(s).keyframeIds)),
      };
    })
    .filter((b): b is DerivedBlock => b !== null)
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Make the server's root-relative keyframe URLs absolute.
 *
 * The server returns a bytes PROXY path, never a storage key. Native has no
 * page origin to resolve a root-relative URL against, so it is joined to the
 * API base the app is already talking to — the same normalisation the web hook
 * performs, for the same reason.
 */
export function normalizeKeyframeUrls(
  urls: unknown,
  apiBase: string,
): Record<string, string | null> {
  const base = apiBase.replace(/\/+$/, "");
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(obj(urls))) {
    const url = str(v);
    out[k] = url ? (url.startsWith("/") ? `${base}${url}` : url) : null;
  }
  return out;
}

export function parseDerivedReview(payload: unknown, apiBase: string): DerivedReview {
  const env = obj(payload);
  const p = obj(env.projection);

  const projection: DerivedProjection | null =
    Object.keys(p).length === 0
      ? null
      : {
          coverage:
            str(p.coverage) === "COMPLETE"
              ? "COMPLETE"
              : str(p.coverage) === "PARTIAL"
                ? "PARTIAL"
                : null,
          acquisitionComplete: p.acquisitionComplete === true,
          ocrEnabled: p.ocrEnabled === true,
          limitations: strList(p.limitations),
          provenance: {
            reconstructed: str(obj(p.provenance).reconstructed),
            machineExtracted: str(obj(p.provenance).machineExtracted),
          },
          generatedAtIso: str(p.generatedAtUtc) ?? str(p.generatedAt),
          blockTotal: num(p.blockTotal) ?? rows(p.blocks).length,
          blocks: parseBlocks(p.blocks),
          stats: {
            sourcePartCount: num(obj(p.stats).sourcePartCount) ?? 0,
            keyframeCount: num(obj(p.stats).keyframeCount) ?? 0,
            ocrRegionCount: num(obj(p.stats).ocrRegionCount) ?? 0,
            ocrFailedKeyframes: num(obj(p.stats).ocrFailedKeyframes) ?? 0,
            blockCount: num(obj(p.stats).blockCount) ?? 0,
          },
        };

  return {
    evidenceId: str(env.evidenceId),
    run: parseRun(env.status),
    projection,
    keyframeUrls: normalizeKeyframeUrls(env.keyframeBytesUrls, apiBase),
  };
}

// ---------------------------------------------------------------------------
// Presentation decisions
// ---------------------------------------------------------------------------

/** Poll only while a run is in flight, and stop the moment it settles. */
export function shouldPoll(run: DerivedRun): boolean {
  return run.status === "PENDING" || run.status === "PROCESSING";
}

export function runStatusLabel(run: DerivedRun): string {
  switch (run.status) {
    case "NOT_REQUESTED":
      return "Not generated";
    case "PENDING":
      return "Queued";
    case "PROCESSING":
      return "Generating";
    case "COMPLETED":
      return "Generated";
    case "FAILED":
      return "Failed";
    case "DISMISSED":
      return "Dismissed";
  }
}

export function runStatusTone(run: DerivedRun): ProovraStatusTone {
  switch (run.status) {
    case "COMPLETED":
      return "verified";
    case "FAILED":
      return "risk";
    case "PENDING":
    case "PROCESSING":
      return "pending";
    default:
      return "neutral";
  }
}

export function confidenceLabel(confidence: BlockConfidence): string {
  switch (confidence) {
    case "HIGH_OVERLAP":
      return "Consistent across frames";
    case "PARTIAL_OVERLAP":
      return "Partly consistent";
    case "AMBIGUOUS":
      return "Ambiguous";
    case "UNRESOLVED":
      return "Unresolved";
  }
}

export function confidenceTone(confidence: BlockConfidence): ProovraStatusTone {
  switch (confidence) {
    case "HIGH_OVERLAP":
      return "verified";
    case "PARTIAL_OVERLAP":
      return "pending";
    case "AMBIGUOUS":
    case "UNRESOLVED":
      return "risk";
  }
}

/**
 * The caveats that must appear beside the reconstructed text.
 *
 * Derived from the projection — this invents none of them. Rendering blocks
 * without these would present a machine reconstruction as a record of what was
 * on screen, which is the claim the whole descriptor exists to avoid making.
 */
export function derivedReviewCaveats(projection: DerivedProjection): string[] {
  const out: string[] = [];

  if (projection.provenance.reconstructed) {
    out.push(projection.provenance.reconstructed);
  }
  if (projection.provenance.machineExtracted) {
    out.push(projection.provenance.machineExtracted);
  }
  if (projection.coverage === "PARTIAL") {
    out.push("Coverage is partial: not every frame of the recording was read.");
  }
  if (!projection.acquisitionComplete) {
    out.push(
      "The acquisition this was derived from is incomplete, so the reconstruction may be missing sections.",
    );
  }
  if (!projection.ocrEnabled) {
    out.push("Text extraction was not enabled for this record.");
  }
  if (projection.stats.ocrFailedKeyframes > 0) {
    out.push(
      `${projection.stats.ocrFailedKeyframes} keyframe(s) could not be read, so text from them is absent.`,
    );
  }

  return [...out, ...projection.limitations];
}
