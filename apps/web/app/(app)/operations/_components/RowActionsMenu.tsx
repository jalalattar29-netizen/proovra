"use client";

/**
 * Operations workbench — the row actions menu.
 *
 * A real `role="menu"` on the canonical `AppAnchoredOverlay`, NOT a `<select>`
 * pretending to be one and NOT a strip of buttons. The production console
 * rendered every available mutation inline on every row: an owner picker, a
 * "Take it", an "Unassign", an Acknowledge, a Resolve and a Suppress, wrapping
 * onto three lines and pushing the condition itself out of view. A menu keeps
 * one primary action visible and puts the rest one predictable keystroke away.
 *
 * The overlay is the shared primitive, so the panel escapes the table's
 * clipping context through the same portal the listboxes use — the last row's
 * menu is never truncated by the surface it sits in.
 *
 * Keyboard: Enter/Space/ArrowDown open, ArrowUp/ArrowDown move, Home/End jump,
 * Escape closes and returns focus to the trigger, Tab closes without stealing
 * focus back. Disabled items are skipped by the arrow keys, not merely dimmed.
 */

import * as React from "react";

import { AppAnchoredOverlay } from "../../../../components/app-primitives/AppAnchoredOverlay";
import { IconDots, IconSpinner } from "./icons";

export type RowAction = {
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

export function RowActionsMenu({
  actions,
  label,
  testId,
}: {
  actions: ReadonlyArray<RowAction>;
  /** Accessible name. Must name the CONDITION, not merely say "Actions". */
  label: string;
  testId?: string;
}) {
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
        data-ops-row-menu-trigger
        data-testid={testId}
      >
        <IconDots size={16} />
        {/* The word stands down at medium and narrow widths; `aria-label`
            above keeps the accessible name intact at every width, so the
            compact form is never an unlabelled icon. */}
        <span className="opsw-when-wide">Actions</span>
      </button>

      <AppAnchoredOverlay
        anchorRef={triggerRef}
        open={open}
        onPointerDownOutside={() => setOpen(false)}
        flipThreshold={260}
      >
        <ul
          id={menuId}
          role="menu"
          aria-label={label}
          className="opsw-menu"
          onKeyDown={onMenuKeyDown}
          data-ops-row-menu-panel
        >
          {actions.map((action, i) => (
            <React.Fragment key={action.key}>
              {action.separated ? (
                <li className="opsw-menu__sep" role="separator" />
              ) : null}
              <li role="none">
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitem"
                  className={`opsw-menu__item${
                    action.danger ? " opsw-menu__item--danger" : ""
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
                  data-ops-row-action={action.key}
                >
                  {action.pending ? <IconSpinner size={14} /> : null}
                  <span>{action.pending ? "Working…" : action.label}</span>
                </button>
              </li>
            </React.Fragment>
          ))}
        </ul>
      </AppAnchoredOverlay>
    </div>
  );
}

export default RowActionsMenu;
