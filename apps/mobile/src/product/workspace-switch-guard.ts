/**
 * B2A-F-22 (Free-user audit 0ea0) — the guard a workspace switch passes first.
 *
 * The web refuses to switch while unsaved work is registered (AppAccountToolbar
 * dirty confirm), and native's own deep-link gate refused to change context
 * during a live capture — but the Spaces screen posted the switch straight
 * away, moving an in-flight capture's context under it. Both native paths now
 * ask this one question. Fails SAFE: an unknown capture state blocks.
 */
import { isCaptureActive } from "../capture/active-capture";

export const WORKSPACE_SWITCH_BLOCKED_TITLE = "Capture in progress";
export const WORKSPACE_SWITCH_BLOCKED_BODY =
  "Finish or pause the current capture before switching workspace. It stays in the workspace it was started in.";

export function workspaceSwitchBlocked(): boolean {
  try {
    return isCaptureActive();
  } catch {
    return true;
  }
}
