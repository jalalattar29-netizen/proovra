/**
 * PROOVRA Feedback System — sanctioned way to toast an API/backend error.
 *
 * Instead of `addToast(err.message, "error")` (which leaks raw backend
 * text and request ids), call:
 *
 *   const { addToast } = useToast();
 *   notifyApiError(addToast, error);
 *
 * It runs the error through `toSafeUserError` so the user only ever sees
 * calm, mapped copy, and the request id is attached as a copyable support
 * reference (never inline in the sentence).
 */

import { toSafeUserError, type SafeErrorFallback } from "./toSafeUserError";

type AddToast = (
  message: string,
  type?: "success" | "error" | "info" | "warning",
  duration?: number,
  options?: {
    title?: string;
    supportReference?: string;
    action?: { label: string; href?: string; onClick?: () => void };
  },
) => void;

/**
 * Toast a sanitized API/backend error. Optional `fallback` supplies
 * action-specific copy used only when the error is otherwise unmapped
 * (e.g. `{ message: "We couldn't save your settings." }`).
 */
export function notifyApiError(
  addToast: AddToast,
  error: unknown,
  fallback?: SafeErrorFallback,
): void {
  const safe = toSafeUserError(error, fallback);
  addToast(safe.message, safe.severity, undefined, {
    title: safe.title,
    supportReference: safe.supportReference,
    action: safe.actionLabel
      ? { label: safe.actionLabel, href: safe.actionHref }
      : undefined,
  });
}
