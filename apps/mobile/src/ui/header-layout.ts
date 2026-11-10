/**
 * AUD-0028 — the header's geometry at narrow widths.
 *
 * On a 1080-px Android phone (420 dpi: about 411 dp) the header was wider than
 * the screen: the account control was cut off at the right edge, and the search
 * control rendered as an empty box. Search was `flex: 1` with no minimum, so it
 * was the only control that could shrink and Yoga shrank it to its padding,
 * while the workspace chip (up to 140 dp, never shrinking), bell, avatar,
 * 20 dp side padding and 12 dp gaps took the rest.
 *
 * Now the workspace chip may shrink (to a touch target at least) and search
 * keeps a minimum width (its label ellipsizes), so every control stays inside
 * the screen and visible. Below HEADER_COMPACT_BELOW_DP (small 360 dp phones)
 * the side padding and gaps tighten as well.
 */
import { theme } from "../theme/theme";

export const HEADER_COMPACT_BELOW_DP = 380;
const TOUCH = 44;

export type HeaderMetrics = {
  compact: boolean;
  paddingHorizontal: number;
  gap: number;
  searchMinWidth: number;
  workspaceMaxWidth: number;
  workspaceMinWidth: number;
};

export function headerMetrics(widthDp: number): HeaderMetrics {
  const compact = widthDp < HEADER_COMPACT_BELOW_DP;
  return {
    compact,
    paddingHorizontal: compact ? theme.space.s3 : theme.space.s5,
    gap: compact ? theme.space.s2 : theme.space.s3,
    searchMinWidth: 64,
    workspaceMaxWidth: compact ? 104 : 140,
    workspaceMinWidth: TOUCH,
  };
}

/** Header mark width (header.tsx styles.mark). */
export const HEADER_MARK_WIDTH = 22;

/**
 * The narrowest the header can be laid out: every control at its minimum.
 * Mark, search, workspace, bell, avatar (five items, four gaps), plus the
 * service-status pill and its gap when it is shown.
 */
export function headerMinimumWidth(m: HeaderMetrics, statusPillWidth = 0): number {
  const items = HEADER_MARK_WIDTH + m.searchMinWidth + m.workspaceMinWidth + TOUCH + TOUCH;
  const gaps = 4 * m.gap + (statusPillWidth > 0 ? m.gap : 0);
  return 2 * m.paddingHorizontal + items + gaps + statusPillWidth;
}
