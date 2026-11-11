"use client";

/**
 * AUD-0064 — the keyboard contract of a menu button, for a menu whose panel
 * the caller renders itself.
 *
 * `AppRowMenu` already implements this contract for a flat list of actions,
 * but its keys live inside its own renderer. The header's workspace switcher
 * and account menu render grouped, heterogeneous panels (headers, group
 * labels, an in-panel dirty-work confirmation), so they cannot be an
 * AppRowMenu; they share this hook instead, with the same behaviour:
 *
 *   - Enter / Space / ArrowDown on the trigger open the menu and focus the
 *     first item; ArrowUp opens it and focuses the last.
 *   - Opening by pointer also focuses the first item: a menu that opens with
 *     focus left on its trigger cannot be driven from the keyboard.
 *   - ArrowDown / ArrowUp move between items (wrapping), Home / End jump.
 *   - Escape from anywhere in the panel closes it and returns focus to the
 *     trigger.
 *   - Focus leaving the trigger + panel (e.g. Tab past the last item) closes
 *     the menu without pulling focus back.
 *
 * Items are the panel's `[role="menuitem"]` descendants that are not
 * disabled, read from the DOM at key time, so conditional sections need no
 * bookkeeping.
 */

import * as React from "react";

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

export function useMenuButtonKeyboard({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  // Which item to focus once the panel has mounted.
  const focusOnOpen = React.useRef<"first" | "last">("first");

  const items = React.useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []),
    [],
  );

  const focusEdge = React.useCallback(
    (edge: "first" | "last") => {
      const list = items();
      (edge === "first" ? list[0] : list[list.length - 1])?.focus();
    },
    [items],
  );

  // The panel mounts in the same commit that sets `open`, so its items exist
  // when this effect runs.
  React.useEffect(() => {
    if (!open) return;
    focusEdge(focusOnOpen.current);
    focusOnOpen.current = "first";
  }, [open, focusEdge]);

  const openTo = (edge: "first" | "last") => {
    if (open) {
      focusEdge(edge);
      return;
    }
    focusOnOpen.current = edge;
    setOpen(true);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    switch (event.key) {
      case "Enter":
      case " ":
      case "ArrowDown":
        // preventDefault also stops Enter's synthesized click, which would
        // toggle the menu straight back closed.
        event.preventDefault();
        openTo("first");
        break;
      case "ArrowUp":
        event.preventDefault();
        openTo("last");
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      default:
        break;
    }
  };

  // Space activates a button on key-UP; without this the click toggles the
  // menu the keydown just opened back closed.
  const onTriggerKeyUp = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === " ") event.preventDefault();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        if (list.length) move(index + 1);
        break;
      case "ArrowUp":
        if (list.length) move(index < 0 ? list.length - 1 : index - 1);
        break;
      case "Home":
        if (list.length) move(0);
        break;
      case "End":
        if (list.length) move(list.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  };

  /** For the element wrapping trigger + panel: close when focus leaves both. */
  const onRootBlur = (event: React.FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    // null: focus went to no element (a click on page background, the window
    // losing focus); the outside-pointer handler owns that case.
    if (open && next && !event.currentTarget.contains(next)) setOpen(false);
  };

  return { triggerRef, menuRef, onTriggerKeyDown, onTriggerKeyUp, onMenuKeyDown, onRootBlur };
}
