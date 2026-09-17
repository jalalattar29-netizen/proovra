/**
 * Full-page tile PLAN — pure and unit-tested. The chrome-touching capture code
 * consumes this plan; keeping the arithmetic pure means the deterministic tile
 * ordering, overlap handling and bounds are testable without a browser.
 */

export type TilePlan = {
  /** Scroll offsets (px from top), in deterministic top-to-bottom order. */
  offsets: number[];
  /** True when the page was taller than the bound and the plan is truncated. */
  truncated: boolean;
};

/**
 * Plan the scroll offsets for a full-page tiled capture.
 *
 * - Deterministic top-to-bottom ordering.
 * - The last tile is clamped so it does not scroll past the page end (its
 *   overlap with the previous tile is expected and recorded, not hidden).
 * - Bounded by `maxTiles` and `maxPageHeightPx`; exceeding either truncates
 *   the plan and marks it, so the capture is represented as PARTIAL rather than
 *   silently clipped.
 */
export function planFullPageTiles(input: {
  pageHeightPx: number;
  viewportHeightPx: number;
  maxTiles: number;
  maxPageHeightPx: number;
}): TilePlan {
  const vh = Math.max(1, Math.floor(input.viewportHeightPx));
  const rawHeight = Math.max(vh, Math.floor(input.pageHeightPx));
  const boundedHeight = Math.min(rawHeight, input.maxPageHeightPx);
  const truncatedByHeight = rawHeight > input.maxPageHeightPx;

  const offsets: number[] = [];
  let y = 0;
  while (y < boundedHeight && offsets.length < input.maxTiles) {
    // Clamp the final tile to the page end so we never scroll past it.
    const clamped = Math.min(y, Math.max(0, boundedHeight - vh));
    if (offsets.length === 0 || offsets[offsets.length - 1] !== clamped) {
      offsets.push(clamped);
    }
    if (clamped >= boundedHeight - vh) break;
    y += vh;
  }
  if (offsets.length === 0) offsets.push(0);

  const truncatedByTiles = boundedHeight - vh > offsets[offsets.length - 1]!;
  return { offsets, truncated: truncatedByHeight || truncatedByTiles };
}
