/**
 * THE ATTRIBUTES A HORIZONTALLY SCROLLING CONTAINER NEEDS (AUD-0061).
 *
 * A wide table (or rail) inside an `overflow-x: auto` box can only be scrolled
 * with a pointer unless the box itself can take keyboard focus: arrow keys
 * scroll whatever is focused, and a container with no focusable content gives
 * a keyboard user nothing to focus. axe reports it as
 * `scrollable-region-focusable` (WCAG 2.1.1), and the audit found it on 26
 * routes at phone width — legal tables, the pricing comparison, the platform
 * DataTables.
 *
 * So the container is focusable (`tabIndex=0`), and because a focusable
 * element that is not a control must say what it is, it is a named `region`.
 * `data-scroll-region` is what the one shared focus ring in `globals.css`
 * keys on, so every scroll region looks the same when it has focus.
 *
 * Pure and JSX-free, so server components (the legal renderer) and client
 * components (DataTable, pricing) spread the same object.
 */
export type ScrollRegionProps = {
  role: "region";
  tabIndex: 0;
  "aria-label": string;
  "data-scroll-region": "";
};

export function scrollRegionProps(label: string): ScrollRegionProps {
  return {
    role: "region",
    tabIndex: 0,
    "aria-label": label,
    "data-scroll-region": "",
  };
}
