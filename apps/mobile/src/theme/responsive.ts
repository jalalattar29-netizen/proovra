/**
 * Responsive hook (Phase 3) — runtime width → breakpoint + layout decisions.
 * Re-derives on rotation via useWindowDimensions (no locked orientation). The
 * pure logic lives in breakpoints.ts; this only binds it to the RN runtime.
 */
import { useWindowDimensions } from "react-native";
import {
  CONTENT_MAX_WIDTH,
  navModeFor,
  resolveBreakpoint,
  type Breakpoint,
} from "./breakpoints";

export interface Responsive {
  width: number;
  height: number;
  breakpoint: Breakpoint;
  isTablet: boolean;
  isLandscape: boolean;
  navMode: "bottom" | "rail";
  /** Max content width to clamp readable columns on wide layouts. */
  contentMaxWidth: number;
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const breakpoint = resolveBreakpoint(width);
  return {
    width,
    height,
    breakpoint,
    isTablet: breakpoint !== "compact",
    isLandscape: width > height,
    navMode: navModeFor(width),
    contentMaxWidth: breakpoint === "compact" ? width : CONTENT_MAX_WIDTH,
  };
}

export { CONTENT_MAX_WIDTH, resolveBreakpoint } from "./breakpoints";
export type { Breakpoint } from "./breakpoints";
