"use client";

/**
 * AppAnchoredOverlay — the one way a popup escapes its ancestors.
 *
 * WHY THIS EXISTS
 *
 * A popup positioned `absolute` inside its trigger's panel is at the mercy of
 * every ancestor between it and the page. Any one of these traps it, and the
 * app-primitives surfaces use all of them:
 *
 *   - `backdrop-filter` (every `.app-panel`) creates a stacking context, so a
 *     child's `z-index` is only ordered WITHIN that panel. A later sibling
 *     panel — which paints after it in DOM order — covers the popup no matter
 *     how large the number is.
 *   - `container-type: inline-size` applies `contain: layout style
 *     inline-size`, and `contain: layout` also creates a stacking context.
 *   - `transform`, `filter` and `will-change` do the same, and additionally
 *     become the containing block for `position: fixed` descendants.
 *   - any ancestor `overflow` other than `visible` clips it.
 *
 * None of that is fixable from the popup. It is fixable by not being inside it:
 * the overlay renders through a portal as a direct child of `<body>`, with
 * `position: fixed` and coordinates derived from the anchor's own rect. It then
 * has exactly one ancestor, and one contractual layer
 * (`--layer-anchored-overlay`).
 *
 * This mechanism was written twice before — once inside `AppListbox`, once as
 * an absolutely-positioned dropdown in the Search typeahead that never worked.
 * It lives here once now, and both consume it.
 */

import * as React from "react";
import { createPortal } from "react-dom";

export interface AppAnchoredOverlayProps {
  /** The element the overlay is pinned to. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  children: React.ReactNode;
  /**
   * Called when a pointer goes down outside BOTH the anchor and the overlay.
   * The overlay lives in a portal, so an "inside" click is not a DOM
   * descendant of the anchor — this check has to know about both.
   */
  onPointerDownOutside?: () => void;
  className?: string;
  role?: string;
  id?: string;
  /** Forwarded to the overlay element so callers can focus / measure it. */
  overlayRef?: React.MutableRefObject<HTMLDivElement | null>;
  /**
   * Minimum room below the anchor before the overlay flips above it. Matches
   * the popup's own max height so it never opens into a sliver.
   */
  flipThreshold?: number;
  [dataAttr: `data-${string}`]: unknown;
  [ariaAttr: `aria-${string}`]: unknown;
}

type Coords = { left: number; width: number; top?: number; bottom?: number };

export function AppAnchoredOverlay({
  anchorRef,
  open,
  children,
  onPointerDownOutside,
  className,
  role,
  id,
  overlayRef,
  flipThreshold = 280,
  ...passthrough
}: AppAnchoredOverlayProps) {
  const [coords, setCoords] = React.useState<Coords | null>(null);
  const localRef = React.useRef<HTMLDivElement | null>(null);

  const setOverlayEl = React.useCallback(
    (el: HTMLDivElement | null) => {
      localRef.current = el;
      if (overlayRef) overlayRef.current = el;
    },
    [overlayRef],
  );

  const position = React.useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    // Flip upward only when there is clearly not enough room below AND more
    // room above — otherwise a slightly short viewport makes the menu jump.
    const openUp = spaceBelow < flipThreshold && r.top > spaceBelow;
    setCoords(
      openUp
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 6 }
        : { left: r.left, width: r.width, top: r.bottom + 6 },
    );
  }, [anchorRef, flipThreshold]);

  // Pin to the anchor while open. `true` on the scroll listener catches
  // scrolling inside any ancestor, not just the page.
  React.useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    position();
    const onReflow = () => position();
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, position]);

  React.useEffect(() => {
    if (!open || !onPointerDownOutside) return;
    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (localRef.current?.contains(t)) return;
      onPointerDownOutside();
    };
    document.addEventListener("pointerdown", onDocPointer, true);
    return () => document.removeEventListener("pointerdown", onDocPointer, true);
  }, [open, onPointerDownOutside, anchorRef]);

  if (!open || !coords || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={setOverlayEl}
      id={id}
      role={role}
      className={`app-anchored-overlay${className ? ` ${className}` : ""}`}
      // Coordinates only. The overlay's LOOK comes from `className`; what is
      // set here is measured geometry, which no stylesheet can know.
      style={{
        left: coords.left,
        width: coords.width,
        top: coords.top,
        bottom: coords.bottom,
      }}
      {...passthrough}
    >
      {children}
    </div>,
    document.body,
  );
}

export default AppAnchoredOverlay;
