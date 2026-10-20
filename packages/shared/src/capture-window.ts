/**
 * THE CLIENT CAPTURE WINDOW, CHECKED (2026-10-20, AUD-22).
 *
 * A web or screen capture manifest states when the client captured
 * (captureStartedAtUtc .. captureEndedAtUtc). The validators only checked that
 * each parsed — not even that the start precedes the end. The window is a
 * client claim, and stays one; what PROOVRA can refuse is a window that cannot
 * be true:
 *
 *   - the start is after the end;
 *   - the end is in the future beyond clock skew;
 *   - the start is long before the server-issued session was opened. A capture
 *     may precede its session (the extension captures, then opens the session
 *     to deliver), so a bounded pre-session allowance applies.
 */
export const CAPTURE_WINDOW_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const CAPTURE_PRE_SESSION_ALLOWANCE_MS = 15 * 60 * 1000;

export function captureWindowProblem(
  startedAtUtc: string,
  endedAtUtc: string,
  opts: { sessionStartedAtUtc?: Date | string | null; now?: Date } = {},
): string | null {
  const start = Date.parse(startedAtUtc);
  const end = Date.parse(endedAtUtc);
  if (Number.isNaN(start) || Number.isNaN(end)) return "capture window is not a pair of times";
  if (start > end) return "captureStartedAtUtc is after captureEndedAtUtc";
  const now = (opts.now ?? new Date()).getTime();
  if (end > now + CAPTURE_WINDOW_CLOCK_SKEW_MS) return "captureEndedAtUtc is in the future";
  if (opts.sessionStartedAtUtc != null) {
    const opened = opts.sessionStartedAtUtc instanceof Date ? opts.sessionStartedAtUtc.getTime() : Date.parse(opts.sessionStartedAtUtc);
    if (Number.isFinite(opened) && start < opened - CAPTURE_PRE_SESSION_ALLOWANCE_MS) {
      return "captureStartedAtUtc is too long before the capture session was opened";
    }
  }
  return null;
}
