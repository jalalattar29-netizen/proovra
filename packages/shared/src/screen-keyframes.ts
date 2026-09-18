/**
 * UC-4 — bounded, deterministic KEYFRAME SELECTION policy.
 *
 * The media-free decision layer over keyframe extraction: given ordered candidate
 * frames (each with a timestamp and a visual CHANGE score relative to the last kept
 * frame), it selects a BOUNDED subset to persist as DERIVED keyframes. It never
 * decodes media and never persists every frame — a candidate is kept only when
 * enough time has passed OR the screen changed materially, capped at maxKeyframes
 * per source. Excess degrades to a PARTIAL selection (a bound, never an OOM).
 *
 * Selected keyframes become ordinary EvidencePartDerivedAsset rows (assetKind
 * `video_keyframe`), one per `variantKey`, carrying their `sourceOffsetMs` — so
 * destruction, storage accounting and lineage already cover them.
 *
 * NO biometric/identity/face analysis — the change score is a bounded technical
 * signal (frame difference), nothing more.
 */

export const KEYFRAME_SELECTION_BOUNDS = {
  /** Hard ceiling on persisted keyframes per source part (bounded derived set). */
  maxKeyframes: 240,
  /** Minimum spacing between kept keyframes (ms), even with no visual change. */
  minIntervalMs: 1500,
  /** Change score in [0,1] at/above which a frame is kept regardless of interval. */
  changeThreshold: 0.35,
} as const;

export type KeyframeSelectionBounds = typeof KEYFRAME_SELECTION_BOUNDS;

export type KeyframeCandidate = {
  /** Milliseconds into the source media. */
  offsetMs: number;
  /** Visual difference from the previously kept frame, 0 (identical) … 1 (fully changed). */
  changeScore: number;
  fingerprint?: string | null;
};

export type SelectedKeyframe = {
  offsetMs: number;
  /** Deterministic per-part variant key for the derived-asset row. */
  variantKey: string;
  changeScore: number;
  fingerprint?: string | null;
  /** Why it was kept — for auditable, honest derivation metadata. */
  reason: "first" | "interval" | "change";
};

export type KeyframeSelection = {
  keyframes: SelectedKeyframe[];
  /** True when candidates were dropped for the bound — the derived set is PARTIAL. */
  boundsReached: boolean;
  candidateCount: number;
};

/** Zero-padded variant key so keyframes sort/scan deterministically (kf-0000…). */
export function keyframeVariantKey(index: number): string {
  return `kf-${String(index).padStart(4, "0")}`;
}

/**
 * PURE: select a bounded subset of candidate frames as keyframes. Deterministic —
 * same input, same output. Always keeps the first candidate; thereafter keeps a
 * candidate when it is far enough in time from the last kept frame OR the screen
 * changed at/above the threshold, up to the maxKeyframes bound.
 */
export function selectKeyframes(
  candidates: KeyframeCandidate[],
  bounds: KeyframeSelectionBounds = KEYFRAME_SELECTION_BOUNDS,
): KeyframeSelection {
  const ordered = [...candidates].sort((a, b) => a.offsetMs - b.offsetMs);
  const keyframes: SelectedKeyframe[] = [];
  let lastKeptOffset = Number.NEGATIVE_INFINITY;
  let boundsReached = false;

  for (const c of ordered) {
    if (keyframes.length >= bounds.maxKeyframes) {
      boundsReached = true;
      break;
    }
    const isFirst = keyframes.length === 0;
    const farEnough = c.offsetMs - lastKeptOffset >= bounds.minIntervalMs;
    const changed = c.changeScore >= bounds.changeThreshold;
    if (isFirst || farEnough || changed) {
      keyframes.push({
        offsetMs: c.offsetMs,
        variantKey: keyframeVariantKey(keyframes.length),
        changeScore: c.changeScore,
        fingerprint: c.fingerprint ?? null,
        reason: isFirst ? "first" : changed && !farEnough ? "change" : "interval",
      });
      lastKeptOffset = c.offsetMs;
    }
  }

  return { keyframes, boundsReached, candidateCount: ordered.length };
}
