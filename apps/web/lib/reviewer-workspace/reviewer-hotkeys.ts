"use client";

/**
 * PROOVRA Phase 2A — Reviewer hotkey hook.
 *
 * Binds the bounded `REVIEWER_HOTKEY_CODES` to a callback map. Hotkeys
 * are intentionally modifier-light (single chars) to maximise
 * throughput. Cmd/Ctrl+S is the only modifier binding.
 *
 * Hard rules:
 *   * Bounded vocabulary — codes come from `@proovra/shared`.
 *   * NEVER intercepts keys when an input/textarea/contentEditable
 *     element is focused (so coding values are still typeable).
 *   * Passive — the hook returns the binding map for the cheat sheet.
 */

import { useEffect, useMemo } from "react";

import {
  REVIEWER_DEFAULT_HOTKEYS,
  REVIEWER_HOTKEY_CODES,
  type ReviewerHotkeyCode,
} from "@proovra/shared";

export type ReviewerHotkeyHandlers = Partial<
  Record<ReviewerHotkeyCode, (e: KeyboardEvent) => void>
>;

export function useReviewerHotkeys(
  handlers: ReviewerHotkeyHandlers,
  enabled = true,
): ReadonlyArray<{ code: ReviewerHotkeyCode; key: string }> {
  const bindings = useMemo(
    () =>
      REVIEWER_HOTKEY_CODES.map((code) => ({
        code,
        key: REVIEWER_DEFAULT_HOTKEYS[code],
      })),
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    function isEditable(t: EventTarget | null): boolean {
      if (!t || !(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (isEditable(e.target)) return;
      const wantedMod =
        e.metaKey || e.ctrlKey ? "Mod+" : "";
      const key = `${wantedMod}${e.key.toLowerCase()}`;
      for (const b of bindings) {
        if (key === b.key.toLowerCase()) {
          const handler = handlers[b.code];
          if (handler) {
            e.preventDefault();
            handler(e);
            return;
          }
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers, enabled, bindings]);

  return bindings;
}
