/**
 * WHERE A WORKSPACE'S LIFECYCLE IS ACTUALLY CONTROLLED (members experience D).
 *
 * `/teams/[id]/lifecycle` renders the server's lifecycle policy. For an OWNED
 * Workspace that page holds real controls: the closure request with its
 * cancellation window, and ownership transfer. For a Personal Workspace it
 * held one sentence and a button to Settings → Privacy → Close account — a
 * page that existed only to forward to another button. A Personal Workspace
 * has no independent lifecycle: it closes with its account, every plan change
 * keeps the same Workspace, and evidence stays governed by retention and legal
 * hold.
 *
 *   PERSONAL      the canonical account-closure surface, directly
 *   OWNED         the Workspace lifecycle page (closure, transfer)
 *   ORGANIZATION  none here — it ends only through Organization offboarding;
 *                 never routed into anyone's personal account closure
 *   UNKNOWN       none
 *
 * Presentation only. Who may close an account, request a closure or transfer
 * ownership is decided by the server, with step-up, on every request.
 */
import type { WorkspaceLifecyclePolicy } from "@proovra/shared";

/** The canonical account-closure surface: Settings → Privacy & data. */
export const ACCOUNT_CLOSURE_HREF = "/settings#privacy";

export type WorkspaceLifecycleDestination =
  | { kind: "ACCOUNT_CLOSURE"; href: string; label: string }
  | { kind: "WORKSPACE_LIFECYCLE"; href: string; label: string }
  | { kind: "NONE" };

export function workspaceLifecycleDestination(
  policy: Pick<WorkspaceLifecyclePolicy, "kind"> | null | undefined,
  workspaceId: string,
): WorkspaceLifecycleDestination {
  switch (policy?.kind) {
    case "PERSONAL":
      return { kind: "ACCOUNT_CLOSURE", href: ACCOUNT_CLOSURE_HREF, label: "Close account" };
    case "OWNED":
      return {
        kind: "WORKSPACE_LIFECYCLE",
        href: `/teams/${encodeURIComponent(workspaceId)}/lifecycle`,
        label: "Manage workspace lifecycle",
      };
    default:
      return { kind: "NONE" };
  }
}
