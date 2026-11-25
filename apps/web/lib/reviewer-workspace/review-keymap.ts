/**
 * Stage D (team remediation, T-094 / T-077) — THE REVIEW KEYMAPS.
 *
 * The keyboard help is generated from the same binding objects the handlers
 * are registered from (`useKeymap`), so the help can only list a key that
 * does something: a row exists iff the page registered a handler for its
 * action. (The console help used to list E and M, which nothing handled.)
 *
 *   INBOX_KEYMAP        the Inbox (`/review`)
 *   REVIEW_PAGE_KEYMAP  the Review page and its focus mode
 *                       (`/reviewer-ops/[id]`, `?mode=focus`)
 *
 * Shortcuts never fire while typing in a field, never with Ctrl/Cmd/Alt
 * (Ctrl/Cmd+K belongs to the app-wide page palette), and a verdict key only
 * PRESELECTS that choice in the decision form — nothing is ever submitted by a
 * key.
 */

import { useEffect, useMemo, useRef } from "react";

export type KeyBinding<A extends string = string> = {
  action: A;
  /** `KeyboardEvent.key` values (case-insensitive for letters). */
  keys: ReadonlyArray<string>;
  /** How the help shows the key. */
  display: string;
  label: string;
};

export type InboxAction = "next" | "previous" | "open" | "focus" | "assign" | "filter" | "help";

export const INBOX_KEYMAP: ReadonlyArray<KeyBinding<InboxAction>> = [
  { action: "next", keys: ["j"], display: "J", label: "Move to the next review" },
  { action: "previous", keys: ["k"], display: "K", label: "Move to the previous review" },
  { action: "open", keys: ["Enter"], display: "Enter", label: "Open the selected review" },
  { action: "focus", keys: ["f"], display: "F", label: "Open the selected review in focus mode" },
  { action: "assign", keys: ["a"], display: "A", label: "Assign the selected review (when allowed)" },
  { action: "filter", keys: ["/"], display: "/", label: "Focus the filter" },
  { action: "help", keys: ["?"], display: "?", label: "Show or hide this help" },
];

export type ReviewPageAction =
  | "next"
  | "previous"
  | "approve"
  | "reject"
  | "request_info"
  | "start"
  | "escalate"
  | "focus"
  | "help";

export const REVIEW_PAGE_KEYMAP: ReadonlyArray<KeyBinding<ReviewPageAction>> = [
  { action: "next", keys: ["j"], display: "J", label: "Next review in this Inbox view" },
  { action: "previous", keys: ["k"], display: "K", label: "Previous review in this Inbox view" },
  { action: "approve", keys: ["a"], display: "A", label: "Choose Approve in the decision form" },
  { action: "reject", keys: ["r"], display: "R", label: "Choose Reject in the decision form" },
  { action: "request_info", keys: ["i"], display: "I", label: "Choose Request information in the decision form" },
  { action: "start", keys: ["s"], display: "S", label: "Start the review (when allowed)" },
  { action: "escalate", keys: ["e"], display: "E", label: "Escalate (when allowed)" },
  { action: "focus", keys: ["f"], display: "F", label: "Turn focus mode on or off" },
  { action: "help", keys: ["?"], display: "?", label: "Show or hide this help" },
];

export type KeymapHandlers<A extends string> = Partial<Record<A, () => void>>;

/** `true` when the event's target is somewhere a person types. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t || typeof t !== "object") return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return typeof t.getAttribute === "function" && t.getAttribute("role") === "textbox";
}

/** The binding a key event selects, if any. */
export function bindingForEvent<A extends string>(
  keymap: ReadonlyArray<KeyBinding<A>>,
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
): KeyBinding<A> | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return keymap.find((b) => b.keys.some((k) => (k.length === 1 ? k.toLowerCase() : k) === key)) ?? null;
}

/** The help rows: only the bindings that have a registered handler. */
export function keymapHelpRows<A extends string>(
  keymap: ReadonlyArray<KeyBinding<A>>,
  handlers: KeymapHandlers<A>,
): ReadonlyArray<{ key: string; label: string; action: A }> {
  return keymap
    .filter((b) => typeof handlers[b.action] === "function")
    .map((b) => ({ key: b.display, label: b.label, action: b.action }));
}

/**
 * Register the keymap's handlers on window. `enabled=false` (a dialog is
 * open, a request is in flight) silences every key. Returns the help rows.
 */
export function useKeymap<A extends string>(
  keymap: ReadonlyArray<KeyBinding<A>>,
  handlers: KeymapHandlers<A>,
  enabled = true,
): ReadonlyArray<{ key: string; label: string; action: A }> {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const binding = bindingForEvent(keymap, e);
      if (!binding) return;
      const handler = handlersRef.current[binding.action];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keymap, enabled]);
  const actionsKey = keymap.filter((b) => typeof handlers[b.action] === "function").map((b) => b.action).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => keymapHelpRows(keymap, handlers), [keymap, actionsKey]);
}
