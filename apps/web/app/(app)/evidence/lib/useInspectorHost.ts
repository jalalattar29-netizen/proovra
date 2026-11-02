import { useCallback, useEffect, useState } from "react";

/** Below this width the Inspector is a dialog over the library. */
export const COMPACT_INSPECTOR_QUERY = "(max-width: 1099.98px)";

/**
 * WHERE THE INSPECTOR LIVES, AND WHETHER IT IS OPEN.
 *
 * At desktop widths the Inspector is a right-hand column beside the queue, so
 * opening it with the first record costs nothing. On a compact screen the same
 * Inspector is a dialog, and opening it on load put a bottom sheet over the
 * whole library and its filters before the person had asked for anything.
 *
 * So the first record is still SELECTED on every width (the desktop column
 * needs it, and the row keeps its highlight), but on a compact screen only a
 * row activation opens the dialog. Crossing the breakpoint restores the default
 * of the layout being entered.
 *
 * Resolved after mount so the server and first client render agree.
 */
export function useInspectorHost() {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [compactInspector, setCompactInspector] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(COMPACT_INSPECTOR_QUERY);
    const sync = () => {
      setCompactInspector(query.matches);
      setInspectorOpen(!query.matches);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const openInspector = useCallback(() => setInspectorOpen(true), []);
  const dismissInspector = useCallback(() => setInspectorOpen(false), []);

  return { inspectorOpen, compactInspector, openInspector, dismissInspector };
}
