/**
 * F-23 (review remediation 2026-11-27) — the one channel between the floating
 * assistant (`components/ai/ProovraChatWidget.tsx`, mounted once by the app
 * layout) and an INLINE assistant entry a page renders in its own header
 * (`components/ai/AssistantInlineEntry.tsx`).
 *
 * The floating launcher is `position: fixed` bottom-right. On the Review pages
 * it sat over form content and actions (at 768 px over the decision panel's
 * Rationale field); padding at the page foot only helped at the very end of
 * the scroll. A page that renders the inline entry opts out of the floating
 * launcher instead: while at least one entry is mounted the document carries
 * `data-assistant-inline="true"` on <html>, the widget stops drawing its
 * launcher, and the entry opens the SAME panel by event. Every page without
 * an entry keeps the floating launcher exactly as before.
 *
 * Everything here is DOM attributes and window events, so the two components
 * stay independent: no context provider is threaded through the layout.
 */

/** The entry asks the widget to open its panel. */
export const ASSISTANT_OPEN_EVENT = "proovra:assistant-open";
/** The entry asks the widget to close its panel. */
export const ASSISTANT_CLOSE_EVENT = "proovra:assistant-close";
/** The widget announces `{ available, open }` (mount, unmount, open/close). */
export const ASSISTANT_STATE_EVENT = "proovra:assistant-state";
/** An inline entry mounted or unmounted (the inline flag may have changed). */
export const ASSISTANT_INLINE_EVENT = "proovra:assistant-inline";

export type AssistantStateDetail = { available: boolean; open: boolean };

const INLINE_COUNT = "assistantInlineCount";
const INLINE_FLAG = "assistantInline";
const AVAILABLE_FLAG = "assistantAvailable";
const OPEN_FLAG = "assistantOpen";

function root(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

/** True while a page renders an inline assistant entry. */
export function isAssistantInline(): boolean {
  return root()?.dataset[INLINE_FLAG] === "true";
}

/**
 * Mark the document as carrying an inline entry; returns the unmark. Counted,
 * so two entries (a loading header replaced by the loaded one) never clear the
 * flag early.
 */
export function markAssistantInline(): () => void {
  const el = root();
  if (!el || typeof window === "undefined") return () => {};
  const next = Number(el.dataset[INLINE_COUNT] ?? "0") + 1;
  el.dataset[INLINE_COUNT] = String(next);
  el.dataset[INLINE_FLAG] = "true";
  window.dispatchEvent(new CustomEvent(ASSISTANT_INLINE_EVENT));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const remaining = Number(el.dataset[INLINE_COUNT] ?? "1") - 1;
    if (remaining > 0) {
      el.dataset[INLINE_COUNT] = String(remaining);
    } else {
      delete el.dataset[INLINE_COUNT];
      delete el.dataset[INLINE_FLAG];
    }
    window.dispatchEvent(new CustomEvent(ASSISTANT_INLINE_EVENT));
  };
}

/** The widget's current state, as last announced (for an entry mounting late). */
export function readAssistantState(): AssistantStateDetail {
  const el = root();
  return {
    available: el?.dataset[AVAILABLE_FLAG] === "true",
    open: el?.dataset[OPEN_FLAG] === "true",
  };
}

/** Called by the widget: record and announce its state. */
export function announceAssistantState(detail: AssistantStateDetail): void {
  const el = root();
  if (!el || typeof window === "undefined") return;
  if (detail.available) el.dataset[AVAILABLE_FLAG] = "true";
  else delete el.dataset[AVAILABLE_FLAG];
  if (detail.open) el.dataset[OPEN_FLAG] = "true";
  else delete el.dataset[OPEN_FLAG];
  window.dispatchEvent(new CustomEvent<AssistantStateDetail>(ASSISTANT_STATE_EVENT, { detail }));
}

/** Called by an entry: ask the widget to open (true) or close (false). */
export function requestAssistant(open: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(open ? ASSISTANT_OPEN_EVENT : ASSISTANT_CLOSE_EVENT));
}
