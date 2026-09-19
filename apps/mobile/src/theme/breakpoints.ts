/**
 * Content-driven responsive classes (Phase 3). Pure — no imports — so it is
 * unit-testable and reusable by the hook in responsive.ts. Classes are keyed on
 * available width, not device model:
 *   compact  < 600  (phones)
 *   medium   600–839 (small tablets / split windows)
 *   expanded >= 840 (large tablets, landscape)
 */
export type Breakpoint = "compact" | "medium" | "expanded";

export const BREAKPOINTS = { medium: 600, expanded: 840 } as const;

/** Readable content column clamp on wide layouts. */
export const CONTENT_MAX_WIDTH = 720;

/**
 * Narrower clamp for single-column forms (auth, create, reset). A full 720px
 * form column reads poorly on a tablet; forms want a tighter measure. Canonical
 * so screens never invent per-file magic widths (Master Program §22, Law of One).
 */
export const FORM_MAX_WIDTH = 480;

export function resolveBreakpoint(width: number): Breakpoint {
  if (width >= BREAKPOINTS.expanded) return "expanded";
  if (width >= BREAKPOINTS.medium) return "medium";
  return "compact";
}

export function isTabletWidth(width: number): boolean {
  return width >= BREAKPOINTS.medium;
}

/** Tablets get a persistent rail; phones get bottom navigation. */
export function navModeFor(width: number): "bottom" | "rail" {
  return isTabletWidth(width) ? "rail" : "bottom";
}
