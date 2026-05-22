"use client";

/**
 * Phase 32.8 Foundation cleanup — `useTeamWorkspaceGate`.
 *
 * A NON-AUTHORITATIVE, READ-ONLY derivation of the canonical
 * `usePlatformContext()` value, shaped for pages that need to know:
 *
 *   - whether the active workspace is a TEAM workspace (some
 *     surfaces only operate in team mode), AND
 *   - what that team's id + role are for the API query string.
 *
 * Hard rules — enforced by F-7 / cleanup drift tests:
 *
 *   1. This hook MUST NOT fetch anything. It reads the canonical
 *      envelope only.
 *   2. This hook MUST NOT derive role / scope locally — it surfaces
 *      whatever the envelope reports.
 *   3. Returning `status: "no-team-workspace"` is a STRUCTURED state
 *      — pages render the canonical `CapabilityDegradedPanel`, NOT
 *      a plain-text "switch to a workspace" page.
 *   4. The shape mirrors the legacy `useActiveWorkspaceId` return
 *      type for minimal migration friction — but the legacy hook is
 *      now deleted; this is the canonical helper.
 */

import { usePlatformContext } from "./PlatformContextProvider";
import type { WorkspaceRole } from "./types";

export type TeamWorkspaceGateState =
  | { status: "loading" }
  | {
      status: "ready";
      workspaceId: string;
      role: WorkspaceRole | null;
    }
  | {
      status: "no-workspace";
      /**
       * Bounded reason — drives the UX of the structured panel.
       * `"personal"` ⇒ render CapabilityDegradedPanel; `"no-workspace"`
       * ⇒ render the workspace-switcher CTA.
       */
      reason: "personal" | "no-workspace";
    }
  | {
      status: "error";
      code: "auth_required" | "permission_denied" | "operational";
      message: string;
      requestId?: string | null;
    };

/**
 * Convenience reader — returns just the team workspace id (or null
 * when the active workspace is personal / unavailable). Pages that
 * scope their team-only API calls by `teamId` query parameter
 * should consume THIS hook, NOT a hand-rolled `/v1/users/me` fetch.
 *
 * Returns `null` while loading, in personal mode, or on failure —
 * pages must handle the null case (typically: render a structured
 * empty state or do not enqueue the dependent API call).
 */
export function useTeamId(): string | null {
  const state = useTeamWorkspaceGate();
  return state.status === "ready" ? state.workspaceId : null;
}

/**
 * Phase EMERGENCY-RECOVERY — `useWorkspaceId` returns the
 * canonical workspace id REGARDLESS of scope.
 *
 * After the personal-workspace bootstrap, every authenticated user
 * has a real `Team` row (with `isPersonal = true` for personal
 * mode). This hook is the right choice for pages that operate on
 * "whatever workspace the user is in" — Reports, Search, Cases
 * (overview), Capture, etc.
 *
 * For pages that genuinely require a TEAM workspace (Reviewer Ops,
 * Governance actions, Matter Operations Queue), use the existing
 * `useTeamWorkspaceGate()` so personal users get a structured
 * `CapabilityDegradedPanel` instead of an empty operator surface.
 */
export function useWorkspaceId(): string | null {
  const { envelope } = usePlatformContext();
  if (!envelope) return null;
  if (envelope.workspace.status !== "active") return null;
  return envelope.workspace.id ?? null;
}

/**
 * Returns the team-workspace gate state derived from the canonical
 * PlatformContextEnvelope. Pages should render the
 * `CapabilityDegradedPanel` when the status is `no-workspace`.
 */
export function useTeamWorkspaceGate(): TeamWorkspaceGateState {
  const { state, envelope } = usePlatformContext();

  if (state.name === "IDLE" || state.name === "LOADING_CONTEXT") {
    return { status: "loading" };
  }

  if (state.name === "FAILED") {
    const code =
      state.errorCode === "AUTH_REQUIRED"
        ? "auth_required"
        : state.errorCode === "PERMISSION_DENIED" ||
            state.errorCode === "WORKSPACE_MEMBERSHIP_REQUIRED"
          ? "permission_denied"
          : "operational";
    return {
      status: "error",
      code,
      message: state.message,
      requestId: state.requestId,
    };
  }

  // READY or SWITCHING — read from envelope.
  if (!envelope) {
    return { status: "no-workspace", reason: "no-workspace" };
  }

  const ws = envelope.workspace;
  if (ws.status !== "active") {
    return { status: "no-workspace", reason: "no-workspace" };
  }
  if (ws.scope !== "TEAM" || !ws.id) {
    return { status: "no-workspace", reason: "personal" };
  }

  return {
    status: "ready",
    workspaceId: ws.id,
    role: ws.membership.role,
  };
}
