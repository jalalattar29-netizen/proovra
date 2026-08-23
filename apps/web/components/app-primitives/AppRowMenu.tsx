"use client";

/**
 * THE canonical row-actions menu.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED, AND WHAT IT COST TO LEARN
 * ---------------------------------------------------------------------------
 * Intake Links and Operations each had their own copy: ~100 lines of identical
 * roving-focus keyboard logic over the same `AppAnchoredOverlay`, plus a
 * route-owned stylesheet block for the panel.
 *
 * The behaviour duplication was the obvious cost. The one that actually bit
 * was the PRESENTATION contract. `.app-anchored-overlay` supplies position and
 * z-index and nothing else — the surface is the consumer's job — so the second
 * copy shipped a menu with no background, no border, no radius and no shadow:
 * five items of bare text painted over the table rows beneath them. Every
 * source-shape and jsdom test passed, because jsdom resolves no cascade and
 * a class that styles nothing looks exactly like a class that styles
 * something. Only a real engine could see it, and a screenshot is how it was
 * found.
 *
 * A shared primitive removes the failure mode rather than the instance: a
 * consumer cannot forget the surface, because the surface is not theirs to
 * remember.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT HOOKS STAY PER-ROUTE
 * ---------------------------------------------------------------------------
 * `dataPrefix` keeps each surface's `data-*` names, so existing end-to-end
 * probes are unaffected by the move. Presentation converges; identity does
 * not.
 *
 * Keyboard: Enter/Space/ArrowDown open, ArrowUp/ArrowDown move, Home/End jump,
 * Escape closes and returns focus to the trigger, Tab closes without stealing
 * focus back. Disabled items are skipped by the arrow keys, not merely dimmed.
 */

import * as React from "react";

import { AppAnchoredOverlay } from "./AppAnchoredOverlay";

export type AppRowAction = {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a separator ABOVE this item. */
  separated?: boolean;
  /** The action is committing; the item shows a spinner and cannot re-fire. */
  pending?: boolean;
};

export interface AppRowMenuProps {
  actions: ReadonlyArray<AppRowAction>;
  /** Accessible name. Must name the ROW, not merely say "Actions". */
  label: string;
  /**
   * `data-*` namespace for this surface, e.g. `"ops"` produces
   * `data-ops-row-menu-trigger` / `-panel` / `data-ops-row-action`.
   */
  dataPrefix: string;
  testId?: string;
  /** The word beside the icon. Hidden by the consumer's own media query. */
  triggerLabel?: string;
  /** Class applied to the trigger's optional word, for width-based hiding. */
  triggerLabelClassName?: string;
  icon: React.ReactNode;
  /** Rendered in place of the label while an item is committing. */
  pendingIcon?: React.ReactNode;
  pendingLabel?: string;
}

export function AppRowMenu({
  actions,
  label,
  dataPrefix,
  testId,
  triggerLabel,
  triggerLabelClassName,
  icon,
  pendingIcon,
  pendingLabel = "Working…",
}: AppRowMenuProps) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = React.useId();

  const enabledIndexes = actions
    .map((a, i) => (a.disabled || a.pending ? -1 : i))
    .filter((i) => i >= 0);

  const close = React.useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const focusItem = React.useCallback((index: number) => {
    itemRefs.current[index]?.focus();
  }, []);

  // Focus the first enabled item when the menu opens — a menu that opens with
  // focus still on the trigger cannot be driven from the keyboard.
  React.useEffect(() => {
    if (!open) return;
    const first = enabledIndexes[0];
    if (first === undefined) return;
    const id = window.setTimeout(() => focusItem(first), 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const active = itemRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    const pos = enabledIndexes.indexOf(active);
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next =
          enabledIndexes[(pos + 1 + enabledIndexes.length) % enabledIndexes.length];
        if (next !== undefined) focusItem(next);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev =
          enabledIndexes[(pos - 1 + enabledIndexes.length) % enabledIndexes.length];
        if (prev !== undefined) focusItem(prev);
        break;
      }
      case "Home": {
        e.preventDefault();
        if (enabledIndexes[0] !== undefined) focusItem(enabledIndexes[0]);
        break;
      }
      case "End": {
        e.preventDefault();
        const last = enabledIndexes[enabledIndexes.length - 1];
        if (last !== undefined) focusItem(last);
        break;
      }
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  };

  if (actions.length === 0) return null;

  const d = (suffix: string) => `data-${dataPrefix}-${suffix}`;

  return (
    <div className="app-table__actions">
      <button
        ref={triggerRef}
        type="button"
        className="app-secondary-action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        data-testid={testId}
        {...{ [d("row-menu-trigger")]: "true" }}
      >
        {icon}
        {triggerLabel ? (
          <span className={triggerLabelClassName}>{triggerLabel}</span>
        ) : null}
      </button>

      <AppAnchoredOverlay
        anchorRef={triggerRef}
        open={open}
        onPointerDownOutside={() => setOpen(false)}
        flipThreshold={260}
        /* The menu is WIDER than its trigger, so the overlay must size to the
           menu rather than to the anchor. That is also what lets it pin to
           whichever horizontal edge keeps the panel on screen — a trigger in
           the last column of a wide table would otherwise open a 216px menu
           off the right edge — and what lets its upward flip actually work. */
        matchAnchorWidth={false}
      >
        <ul
          id={menuId}
          role="menu"
          aria-label={label}
          className="app-menu"
          onKeyDown={onMenuKeyDown}
          {...{ [d("row-menu-panel")]: "true" }}
        >
          {actions.map((action, i) => (
            <React.Fragment key={action.key}>
              {action.separated ? (
                <li className="app-menu__sep" role="separator" />
              ) : null}
              <li role="none">
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitem"
                  className={`app-menu__item${
                    action.danger ? " app-menu__item--danger" : ""
                  }`}
                  disabled={action.disabled || action.pending}
                  aria-busy={action.pending || undefined}
                  onClick={() => {
                    // The menu closes FIRST so a slow handler can never be
                    // fired twice from a still-open panel.
                    setOpen(false);
                    triggerRef.current?.focus();
                    action.onSelect();
                  }}
                  {...{ [d("row-action")]: action.key }}
                >
                  {action.pending ? pendingIcon : null}
                  <span>{action.pending ? pendingLabel : action.label}</span>
                </button>
              </li>
            </React.Fragment>
          ))}
        </ul>
      </AppAnchoredOverlay>
    </div>
  );
}

export default AppRowMenu;
