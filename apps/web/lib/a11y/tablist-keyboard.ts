/**
 * B2A-F-18 (Free-user audit 0ea0) — the WAI-ARIA tabs keyboard contract for a
 * `role="tablist"` of `role="tab"` buttons: Left/Right (and Up/Down) move to
 * the previous/next tab, Home/End to the first/last, wrapping, and the tab
 * that receives focus is selected (automatic activation). Only the selected
 * tab is in the Tab order (`tabIndex` 0, the others -1), so Tab moves from
 * the tablist into the panel.
 *
 * Ids: `tabId(prefix, id)` names the tab and `panelId(prefix, id)` its panel,
 * so a tab carries `aria-controls` and the panel `aria-labelledby`.
 */
import type { KeyboardEvent } from "react";

export function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}

export function panelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

/** The tab a key press moves to, or null when the key is not a tab key. */
export function nextTabForKey<T extends string>(key: string, ids: ReadonlyArray<T>, current: T): T | null {
  if (ids.length === 0) return null;
  const i = Math.max(0, ids.indexOf(current));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return ids[(i + 1) % ids.length];
    case "ArrowLeft":
    case "ArrowUp":
      return ids[(i - 1 + ids.length) % ids.length];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
    default:
      return null;
  }
}

/** onKeyDown for a tablist: selects and focuses the tab the key names. */
export function handleTablistKeyDown<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  prefix: string,
  ids: ReadonlyArray<T>,
  current: T,
  select: (id: T) => void,
): void {
  const next = nextTabForKey(event.key, ids, current);
  if (next === null) return;
  event.preventDefault();
  select(next);
  const doc = event.currentTarget.ownerDocument;
  doc?.getElementById(tabId(prefix, next))?.focus();
}
