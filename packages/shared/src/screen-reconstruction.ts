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
  // UC-DER-004 — a block seen in ONE frame whose normalised text matches a
  // block in an adjacent frame that the overlap analysis could not prove to be
  // the same row. It is kept (never merged on text alone) and LABELLED, so a
  // reviewer does not read an unproven repeat as a repeated message.
  "RECONSTRUCTION_POSSIBLE_DUPLICATE",
  // UC-DER-014 — at least one ORIGINAL source part was larger than the bounded
  // read, so the derivation saw only its first bytes.
  "RECONSTRUCTION_SOURCE_TRUNCATED",
  // UC-DER-008 — OCR was permitted by the workspace but the local OCR runtime
  // was unavailable on the worker, so no text was extracted.
  "RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE",
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
  /**
   * UC-DER-004 — optional on-screen geometry, NORMALISED to the OCR input frame
   * (0..1 of width/height). When both sides of a comparison carry it, it is the
   * geometry that corroborates "same rendered screen" (a row that did not move)
   * and pins fixed header/composer rows to their position.
   */
  bbox?: NormalisedBox | null;
};

/** A box normalised to its frame: every coordinate is a fraction in [0, 1]. */
export type NormalisedBox = { top: number; left: number; width: number; height: number };

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
  /**
   * UC-DER-004 — set when this single-frame block has the same normalised text
   * as a block in an ADJACENT frame that overlap analysis could not prove to be
   * the same on-screen row. It may be a repeat of that block or a genuinely
   * repeated message; the reconstruction cannot tell and says so.
   */
  possibleDuplicateOf: string | null;
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

/**
 * UC-DER-004 — OCR-tolerant text normalisation: Unicode compatibility form,
 * zero-width characters dropped, typographic quotes folded, whitespace
 * collapsed, case folded. Used only to COMPARE rows; the block text shown to a
 * reviewer is always the machine-extracted original.
 */
export function normaliseObservationText(text: string): string {
  return (text ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Bounded Levenshtein distance (returns max+1 as soon as it cannot fit). */
function editDistanceWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * OCR-jitter tolerance. Two renders of the same line may differ by a few
 * characters. Short lines ("OK", "12:04") must match exactly after
 * normalisation — one slipped character there is a different line. Longer
 * lines may differ by at most `maxEditRatio` of their length.
 */
export const OBSERVATION_TEXT_MATCH_POLICY = {
  exactBelowLength: 8,
  maxEditRatio: 0.12,
} as const;

export function observationTextsMatch(a: string, b: string): boolean {
  const na = normaliseObservationText(a);
  const nb = normaliseObservationText(b);
  if (na === nb) return true;
  if (Math.min(na.length, nb.length) < OBSERVATION_TEXT_MATCH_POLICY.exactBelowLength) {
    return false;
  }
  const max = Math.floor(
    Math.max(na.length, nb.length) * OBSERVATION_TEXT_MATCH_POLICY.maxEditRatio,
  );
  return editDistanceWithin(na, nb, max) <= max;
}

/** Tolerance (fraction of the frame) within which a row "did not move". */
const SAME_POSITION_TOLERANCE = { top: 0.012, left: 0.03 } as const;

/** True/false when both rows carry geometry; null when either lacks it. */
function samePosition(a: ScreenObservation, b: ScreenObservation): boolean | null {
  if (!a.bbox || !b.bbox) return null;
  return (
    Math.abs(a.bbox.top - b.bbox.top) <= SAME_POSITION_TOLERANCE.top &&
    Math.abs(a.bbox.left - b.bbox.left) <= SAME_POSITION_TOLERANCE.left
  );
}

/**
 * Two observations are the SAME on-screen row iff the kind matches, the text
 * matches under the OCR-tolerant policy, and — when BOTH carry one — the visual
 * fingerprint agrees.
 */
function rowsMatch(a: ScreenObservation, b: ScreenObservation): boolean {
  if (a.kind !== b.kind) return false;
  if (!observationTextsMatch(a.text, b.text)) return false;
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

/**
 * Does geometry corroborate that a full-frame overlap is genuinely the SAME
 * rendered screen (rather than two screens with identical text)? True only when
 * every one of the `k` overlapped rows carries geometry on BOTH sides and it
 * agrees: a matching visual fingerprint, or — for OCR regions — the same
 * position on the frame (the row did not move, so nothing scrolled). Absent
 * geometry, text equality alone never proves it.
 */
function geometryCorroborates(
  prev: ScreenObservation[],
  next: ScreenObservation[],
  k: number,
): boolean {
  for (let i = 0; i < k; i += 1) {
    const a = prev[prev.length - k + i];
    const b = next[i];
    if (a.fingerprint && b.fingerprint) {
      if (a.fingerprint !== b.fingerprint) return false;
      continue;
    }
    if (samePosition(a, b) !== true) return false;
  }
  return true;
}

/**
 * UC-DER-004 — FIXED CHROME. A messaging screen keeps its header (contact name,
 * status bar) and its composer in place while the conversation scrolls between
 * them, so a whole-frame suffix/prefix comparison never finds the scroll (frame
 * A ends with the composer, frame B starts with the header). Count the rows at
 * the TOP and BOTTOM of both frames that are the same row in the same slot —
 * and, when geometry is present, at the same position. They are candidates
 * only: the caller unions them only when the CONTENT between them
 * independently proves continuity, so a coincidentally equal first line of two
 * different screens is never merged on its own.
 */
function fixedChrome(
  prev: ScreenObservation[],
  next: ScreenObservation[],
): { top: number; bottom: number } {
  const limit = Math.min(prev.length, next.length);
  const pinned = (a: ScreenObservation, b: ScreenObservation) =>
    rowsMatch(a, b) && samePosition(a, b) !== false;
  let top = 0;
  while (top < limit && pinned(prev[top], next[top])) top += 1;
  let bottom = 0;
  while (
    bottom < limit - top &&
    pinned(prev[prev.length - 1 - bottom], next[next.length - 1 - bottom])
  ) {
    bottom += 1;
  }
  return { top, bottom };
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
    // CONSERVATIVE DEDUP GUARD (§29). A "full-frame overlap" — the overlap run
    // spans the ENTIRE prev frame AND the ENTIRE next frame — carries no scroll
    // delta: there is no residual content on either side to prove that content
    // actually scrolled. That is indistinguishable from two independent screens
    // that happen to show identical text (two distinct "OK" messages), and text
    // equality is NEVER sufficient to merge. Such a boundary merges ONLY when
    // geometry corroborates it (a visual fingerprint agrees on every overlapped
    // row, or the same on-frame position — the same rendered screen). Otherwise
    // the rows stay distinct and the boundary is flagged as a possible gap,
    // because a full page could have scrolled past between the two keyframes.
    const fullFrameOverlap = k > 0 && k === prev.length && k === next.length;
    if (k > 0 && (!fullFrameOverlap || geometryCorroborates(prev, next, k))) {
      for (let i = 0; i < k; i += 1) {
        uf.union(prev[prev.length - k + i].id, next[i].id);
      }
      continue;
    }

    // UC-DER-004 — the whole-frame comparison found no scroll (or only an
    // uncorroborated full-frame match). Look again with the fixed chrome set
    // aside: a conversation scrolling between a pinned header and composer.
    const chrome = fixedChrome(prev, next);
    if (chrome.top + chrome.bottom > 0) {
      const contentPrev = prev.slice(chrome.top, prev.length - chrome.bottom);
      const contentNext = next.slice(chrome.top, next.length - chrome.bottom);
      const kc = scrollOverlap(contentPrev, contentNext);
      const contentFullOverlap =
        kc > 0 && kc === contentPrev.length && kc === contentNext.length;
      // Continuity must be proven by the CONTENT between the chrome: a scroll
      // run with residual rows on at least one side, or — for a view that only
      // gained rows at the end of the content (a new message arriving before
      // the view is full) — one frame's content entirely empty while at least
      // two pinned rows (header + composer) frame both.
      const contentScrolled = kc > 0 && !contentFullOverlap;
      const contentGrewInPlace =
        kc === 0 &&
        chrome.top + chrome.bottom >= 2 &&
        (contentPrev.length === 0) !== (contentNext.length === 0);
      if (contentScrolled || contentGrewInPlace) {
        for (let i = 0; i < chrome.top; i += 1) uf.union(prev[i].id, next[i].id);
        for (let i = 1; i <= chrome.bottom; i += 1) {
          uf.union(prev[prev.length - i].id, next[next.length - i].id);
        }
        for (let i = 0; i < kc; i += 1) {
          uf.union(contentPrev[contentPrev.length - kc + i].id, contentNext[i].id);
        }
        continue;
      }
    }
    // No proven shared content across this boundary — continuity cannot be proven.
    possibleGap = true;
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
      possibleDuplicateOf: null,
    });
  }

  // Global READING order. Walk the frames in time; a row whose block is already
  // placed moves the cursor to it, a new row is inserted right after the cursor
  // (rows above the first already-placed row of a frame go just before it). So
  // a message scrolled into view lands after the last message it followed —
  // BEFORE a pinned composer that was placed from the first frame — and a frame
  // that shares nothing with what came before (a proven gap) is appended.
  const obsById = new Map(sorted.map((o) => [o.id, o] as const));
  const order: string[] = [];
  const placed = new Set<string>();
  for (const rows of frames) {
    const roots = rows.map((o) => uf.find(o.id));
    const firstKnown = roots.findIndex((r) => placed.has(r));
    let cursor: number;
    let start = 0;
    if (firstKnown < 0) {
      cursor = order.length - 1;
    } else {
      // Rows above the first placed row go immediately before it.
      let at = order.indexOf(roots[firstKnown]);
      for (let i = 0; i < firstKnown; i += 1) {
        if (placed.has(roots[i])) continue;
        order.splice(at, 0, roots[i]);
        placed.add(roots[i]);
        at += 1;
      }
      cursor = at;
      start = firstKnown + 1;
    }
    for (let i = start; i < roots.length; i += 1) {
      const r = roots[i];
      if (placed.has(r)) {
        const idx = order.indexOf(r);
        if (idx > cursor) cursor = idx;
        continue;
      }
      order.splice(cursor + 1, 0, r);
      placed.add(r);
      cursor += 1;
    }
  }
  const position = new Map(order.map((r, i) => [r, i] as const));
  blocks.sort(
    (a, b) => position.get(uf.find(a.blockId))! - position.get(uf.find(b.blockId))!,
  );
  blocks.forEach((b, i) => {
    b.sequence = i;
  });

  // UC-DER-004 — label, never merge, an unproven repeat. A block seen in one
  // frame whose normalised text equals an EARLIER block observed in the adjacent
  // frame is either the same row the overlap analysis could not prove (a jump,
  // heavy OCR noise) or a genuinely repeated message. It stays a separate block
  // and points at its twin so the reviewer is told which reading is open.
  const framesOf = new Map<string, Set<number>>();
  const byTextKind = new Map<string, ReconstructedBlock[]>();
  for (const b of blocks) {
    framesOf.set(b.blockId, new Set(b.observationIds.map((id) => obsById.get(id)!.frameOrder)));
    const key = `${b.kind}\u0000${normaliseObservationText(b.text)}`;
    const list = byTextKind.get(key) ?? [];
    list.push(b);
    byTextKind.set(key, list);
  }
  let possibleDuplicate = false;
  for (const b of blocks) {
    if (b.observedInFrames !== 1 || !normaliseObservationText(b.text)) continue;
    const [frameOfB] = [...framesOf.get(b.blockId)!];
    const twin = (byTextKind.get(`${b.kind}\u0000${normaliseObservationText(b.text)}`) ?? []).find(
      (o) => {
        if (o === b || o.sequence >= b.sequence) return false;
        const frames = framesOf.get(o.blockId)!;
        return !frames.has(frameOfB) && (frames.has(frameOfB - 1) || frames.has(frameOfB + 1));
      },
    );
    if (twin) {
      b.possibleDuplicateOf = twin.blockId;
      possibleDuplicate = true;
    }
  }

  if (possibleGap) limitations.push("RECONSTRUCTION_POSSIBLE_GAP");
  if (possibleDuplicate) limitations.push("RECONSTRUCTION_POSSIBLE_DUPLICATE");
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
