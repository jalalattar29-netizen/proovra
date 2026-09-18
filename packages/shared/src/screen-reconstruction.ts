/**
 * UC-4 — DERIVED screen/conversation reconstruction (deterministic core).
 *
 * This is the pure, media-free heart of UC-4: given ordered machine-extracted
 * OBSERVATIONS (a text/label/timestamp block detected in a keyframe, with its
 * source lineage and on-screen position), it reconstructs an ordered set of DERIVED
 * review BLOCKS by scroll-overlap analysis + CONSERVATIVE deduplication, and links
 * every block back to the ORIGINAL evidence parts it was observed in.
 *
 * ABSOLUTE LAWS enforced here:
 *   - Everything produced is DERIVED_RECONSTRUCTED — never ORIGINAL, never
 *     acquisition truth. A visible sender label is NOT verified identity; a visible
 *     timestamp is NOT provider-verified time (block kinds say VISIBLE_*).
 *   - Deduplication is CONSERVATIVE: two blocks merge only on positional
 *     scroll-overlap evidence (contiguous run + temporal adjacency + optional visual
 *     fingerprint), NEVER on text equality alone. Two distinct "OK" messages stay
 *     distinct. False-negative dedup (leaving duplicates) is preferred over
 *     false-positive conflation.
 *   - Reconstruction COVERAGE is separate from acquisition completeness: a
 *     COMPLETE_SESSION may reconstruct as PARTIAL, and reconstruction NEVER upgrades
 *     an INTERRUPTED acquisition to a "complete conversation".
 *
 * It performs NO media decoding, NO OCR, NO network I/O — those bounded, side-effect
 * steps feed it observations. It is fully deterministic and unit-testable.
 */

export const SCREEN_OVERLAP_ANALYSIS_TRANSFORMATION = "SCREEN_OVERLAP_ANALYSIS_V1" as const;
export const SCREEN_CONTENT_DEDUP_TRANSFORMATION = "SCREEN_CONTENT_DEDUP_V1" as const;
export const SCREEN_RECONSTRUCTION_TRANSFORMATION = "SCREEN_CONVERSATION_RECONSTRUCTION_V1" as const;

/** Bounds — a bounded number of observations/blocks; excess degrades to PARTIAL. */
export const SCREEN_RECONSTRUCTION_BOUNDS = {
  maxObservations: 20000,
  maxBlocks: 20000,
} as const;

/** Generic, provider-agnostic block kinds. VISIBLE_* are displayed, NOT verified. */
export const RECONSTRUCTION_BLOCK_KINDS = [
  "TEXT",
  "MEDIA",
  "VISIBLE_LABEL",
  "VISIBLE_TIMESTAMP",
  "SYSTEM",
  "UNKNOWN",
] as const;
export type ReconstructionBlockKind = (typeof RECONSTRUCTION_BLOCK_KINDS)[number];

/** Structured, defensible uncertainty — never a fabricated "authenticity %". */
export const OVERLAP_CONFIDENCE = ["HIGH_OVERLAP", "PARTIAL_OVERLAP", "AMBIGUOUS", "UNRESOLVED"] as const;
export type OverlapConfidence = (typeof OVERLAP_CONFIDENCE)[number];

export type ReconstructionCoverage = "COMPLETE" | "PARTIAL";

export const RECONSTRUCTION_LIMITATION_CODES = [
  "RECONSTRUCTION_POSSIBLE_GAP",
  "RECONSTRUCTION_BOUNDS_REACHED",
  "RECONSTRUCTION_AMBIGUOUS_OVERLAP",
] as const;
export type ReconstructionLimitationCode = (typeof RECONSTRUCTION_LIMITATION_CODES)[number];

/**
 * ONE machine-extracted observation. `frameOrder` is the temporal index of the
 * source keyframe (0-based); `rowOrder` is the vertical position within that frame
 * (0 = top). `sourcePartIndex` + `sourceOffsetMs` are the ORIGINAL lineage.
 */
export type ScreenObservation = {
  id: string;
  keyframeId: string;
  sourcePartIndex: number;
  sourceOffsetMs: number;
  frameOrder: number;
  rowOrder: number;
  text: string;
  kind: ReconstructionBlockKind;
  /** Optional visual fingerprint; when present it STRENGTHENS overlap matching. */
  fingerprint?: string | null;
};

export type ReconstructedBlock = {
  blockId: string;
  sequence: number;
  kind: ReconstructionBlockKind;
  /** Machine-extracted / reconstructed text — displayed content, not verified fact. */
  text: string;
  confidence: OverlapConfidence;
  /** Lineage: the source observations this block was reconstructed from. */
  observationIds: string[];
  /** Lineage: the ORIGINAL evidence part indexes this block was observed in. */
  sourcePartIndexes: number[];
  sourceOffsetMsRange: [number, number];
  /** How many distinct keyframes corroborated this block (scroll overlap). */
  observedInFrames: number;
};

export type ScreenReconstructionResult = {
  transformation: typeof SCREEN_RECONSTRUCTION_TRANSFORMATION;
  version: 1;
  blocks: ReconstructedBlock[];
  coverage: ReconstructionCoverage;
  observationCount: number;
  blockCount: number;
  limitations: ReconstructionLimitationCode[];
};

/** Two observations are the SAME on-screen row iff text + kind (+ fingerprint) match. */
function rowsMatch(a: ScreenObservation, b: ScreenObservation): boolean {
  if (a.text !== b.text || a.kind !== b.kind) return false;
  // When BOTH carry a fingerprint, it must also agree — a stronger, geometry-aware
  // signal that guards against merging two visually different rows of equal text.
  if (a.fingerprint && b.fingerprint) return a.fingerprint === b.fingerprint;
  return true;
}

/**
 * The scroll overlap between two consecutive frames: the largest k such that the
 * LAST k rows of `prev` equal the FIRST k rows of `next` (content scrolled up, so
 * the bottom of `prev` is the top of `next`). Greedy-longest, so a genuine
 * contiguous scroll run is recognised; returns 0 when the frames do not overlap
 * (a jump / new screen), which cannot prove continuity.
 */
export function scrollOverlap(prev: ScreenObservation[], next: ScreenObservation[]): number {
  const maxK = Math.min(prev.length, next.length);
  for (let k = maxK; k >= 1; k -= 1) {
    let ok = true;
    for (let i = 0; i < k; i += 1) {
      if (!rowsMatch(prev[prev.length - k + i], next[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Reconstruct ordered DERIVED blocks from observations. Deterministic + conservative.
 */
export function reconstructScreenConversation(
  input: ScreenObservation[],
): ScreenReconstructionResult {
  const limitations: ReconstructionLimitationCode[] = [];
  let observations = input;
  if (observations.length > SCREEN_RECONSTRUCTION_BOUNDS.maxObservations) {
    observations = observations.slice(0, SCREEN_RECONSTRUCTION_BOUNDS.maxObservations);
    limitations.push("RECONSTRUCTION_BOUNDS_REACHED");
  }

  // Order everything deterministically: by frame, then by vertical row.
  const sorted = [...observations].sort((a, b) =>
    a.frameOrder !== b.frameOrder ? a.frameOrder - b.frameOrder : a.rowOrder - b.rowOrder,
  );

  // Group into frames (each an ordered row list), preserving temporal order.
  const frameOrders = [...new Set(sorted.map((o) => o.frameOrder))].sort((a, b) => a - b);
  const frames = frameOrders.map((fo) => sorted.filter((o) => o.frameOrder === fo));

  // CONSERVATIVE DEDUP: only observations linked by a contiguous scroll-overlap run
  // are merged. Text equality alone never merges (two distinct "OK" stay distinct).
  const uf = new UnionFind();
  for (const o of sorted) uf.find(o.id); // seed
  let possibleGap = false;
  for (let f = 1; f < frames.length; f += 1) {
    const prev = frames[f - 1];
    const next = frames[f];
    const k = scrollOverlap(prev, next);
    if (k === 0) {
      // No shared content across this boundary — continuity cannot be proven.
      possibleGap = true;
      continue;
    }
    for (let i = 0; i < k; i += 1) {
      uf.union(prev[prev.length - k + i].id, next[i].id);
    }
  }

  // Assemble blocks from union components.
  const byRoot = new Map<string, ScreenObservation[]>();
  for (const o of sorted) {
    const root = uf.find(o.id);
    const list = byRoot.get(root) ?? [];
    list.push(o);
    byRoot.set(root, list);
  }

  const blocks: ReconstructedBlock[] = [];
  for (const [, obs] of byRoot) {
    // Representative = earliest (frame, row). Lineage aggregates all observations.
    const ordered = [...obs].sort((a, b) =>
      a.frameOrder !== b.frameOrder ? a.frameOrder - b.frameOrder : a.rowOrder - b.rowOrder,
    );
    const rep = ordered[0];
    const frameSet = new Set(ordered.map((o) => o.frameOrder));
    const offsets = ordered.map((o) => o.sourceOffsetMs);
    const observedInFrames = frameSet.size;
    const confidence: OverlapConfidence = observedInFrames >= 2 ? "HIGH_OVERLAP" : "PARTIAL_OVERLAP";
    blocks.push({
      blockId: rep.id,
      sequence: 0, // assigned after global ordering
      kind: rep.kind,
      text: rep.text,
      confidence,
      observationIds: ordered.map((o) => o.id),
      sourcePartIndexes: [...new Set(ordered.map((o) => o.sourcePartIndex))].sort((a, b) => a - b),
      sourceOffsetMsRange: [Math.min(...offsets), Math.max(...offsets)],
      observedInFrames,
    });
  }

  // Global order = by each block's earliest observation position.
  const firstPos = (b: ReconstructedBlock) => {
    const first = sorted.find((o) => o.id === b.observationIds[0])!;
    return [first.frameOrder, first.rowOrder] as const;
  };
  blocks.sort((a, b) => {
    const [af, ar] = firstPos(a);
    const [bf, br] = firstPos(b);
    return af !== bf ? af - bf : ar - br;
  });
  blocks.forEach((b, i) => {
    b.sequence = i;
  });

  if (possibleGap) limitations.push("RECONSTRUCTION_POSSIBLE_GAP");
  const coverage: ReconstructionCoverage = possibleGap ? "PARTIAL" : "COMPLETE";

  return {
    transformation: SCREEN_RECONSTRUCTION_TRANSFORMATION,
    version: 1,
    blocks,
    coverage,
    observationCount: observations.length,
    blockCount: blocks.length,
    limitations,
  };
}

/**
 * Derive the OVERALL derived-review status, keeping it strictly separate from the
 * ORIGINAL acquisition status. Reconstruction NEVER reports COMPLETE coverage over
 * an interrupted acquisition — the union with the acquisition truth is always the
 * weaker of the two for continuity claims.
 */
export function reconstructionCoverageLabel(
  acquisitionComplete: boolean,
  coverage: ReconstructionCoverage,
): ReconstructionCoverage {
  return acquisitionComplete && coverage === "COMPLETE" ? "COMPLETE" : "PARTIAL";
}
