"use client";

/**
 * F-23 (review remediation 2026-11-27) — the assistant's INLINE entry.
 *
 * A page that renders this in its header opts out of the floating launcher:
 * while it is mounted the widget draws no `position: fixed` button over the
 * page, and this button opens the same assistant panel (see
 * `lib/ai/assistant-bridge.ts`). It is an ordinary button in the page's tab
 * order, so the assistant stays reachable by keyboard and nothing floats over
 * form content or actions at any scroll position.
 *
 * It renders nothing until the widget has announced itself (a signed-out
 * shell, or a layout that hides the assistant, has no panel to open), so a
 * page never offers a button that does nothing.
 */

import { useEffect, useState } from "react";

import {
  ASSISTANT_STATE_EVENT,
  markAssistantInline,
  readAssistantState,
  requestAssistant,
  type AssistantStateDetail,
} from "../../lib/ai/assistant-bridge";
import "./assistant.css";

export function AssistantInlineEntry({ className }: { className?: string }) {
  const [state, setState] = useState<AssistantStateDetail>({ available: false, open: false });

  useEffect(() => {
    const unmark = markAssistantInline();
    setState(readAssistantState());
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<AssistantStateDetail>).detail;
      setState(detail ?? readAssistantState());
    };
    window.addEventListener(ASSISTANT_STATE_EVENT, onState);
    return () => {
      window.removeEventListener(ASSISTANT_STATE_EVENT, onState);
      unmark();
    };
  }, []);

  if (!state.available) return null;

  return (
    <button
      type="button"
      className={["app-secondary-action", "assistant-inline-entry", className].filter(Boolean).join(" ")}
      data-assistant-inline-entry
      aria-expanded={state.open}
      aria-haspopup="dialog"
      onClick={() => requestAssistant(!state.open)}
    >
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          d="M21 12a8 8 0 0 1-8 8H7l-4 3v-4.6A8 8 0 0 1 13 4a8 8 0 0 1 8 8Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
      Assistant
    </button>
  );
}

export default AssistantInlineEntry;
