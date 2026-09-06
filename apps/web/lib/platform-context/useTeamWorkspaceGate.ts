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

import { activeWorkspaceIdFromEnvelope } from "./activeWorkspace";
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
 * Convenience reader — returns just the workspace id (or null
 * when the active workspace is personal / unavailable). Pages that
 * scope their team-only API calls by `teamId` query parameter
 * should consume THIS hook, NOT a hand-rolled `/v1/users/me` fetch.
 *
 * Returns `null` while loading, in personal mode, or on failure —
 * pages must handle the null case (typically: render a structured
 * empty state or do not enqueue the dependent API call).
 *
 * @deprecated PHASE 3 — Returns `null` for personal-mode users even
 *   when they have a healthy Personal Workspace, which causes pages
 *   that should support personal users to fall into the
 *   "no-workspace" branch incorrectly. Prefer
 *   {@link useActiveWorkspaceId} for new code. This alias is
 *   retained because ~44 call sites still consume it for genuinely
 *   team-only surfaces (Reviewer Ops, Governance actions, MFA
 *   Recovery) where personal users SHOULD see a structured panel.
 *   See docs/architecture/phase-3-runtime-refactor-readiness.md.
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
 *
 * @deprecated PHASE 3 — This hook reads only `envelope.workspace`
 *   (the legacy field) and returns `null` if `workspace.status` is
 *   not active, even when `envelope.personalSpace.id` is set. The
 *   canonical Phase 3 hook is {@link useActiveWorkspaceId}, which
 *   falls back to `personalSpace.id` for personal-aware surfaces.
 *   Migrate new code to `useActiveWorkspaceId`. This alias is
 *   retained for existing call sites that need the legacy semantics.
 */
export function useWorkspaceId(): string | null {
  const { envelope } = usePlatformContext();
  if (!envelope) return null;
  if (envelope.workspace.status !== "active") return null;
  return envelope.workspace.id ?? null;
}

/**
 * PHASE 3 CANONICAL — `useActiveWorkspaceId` returns the canonical
 * workspace id for personal-aware pages that should work in BOTH
 * team and personal mode (e.g. /cases overview, where personal
 * users with CASES_VIEW + CASES_MANAGE should see their own matters).
 *
 * This is THE canonical workspace-id hook for new code. The other
 * three hooks in this file (`useTeamId`, `useWorkspaceId`,
 * and the `useActiveSpaceId` in `useTenantModel.ts`) are deprecated
 * aliases retained for backward compatibility with existing call
 * sites. See `docs/architecture/architecture-invariants.md` (INV-3)
 * and `docs/architecture/phase-3-runtime-refactor-readiness.md`.
 *
 * Resolution order:
 *   1. `envelope.workspace.id` when `workspace.status === "active"`
 *      (covers TEAM workspaces and the legacy team row backing
 *      the current runtime workspace).
 *   2. `envelope.personalSpace.id` when `personalSpace.status === "active"`
 *      (covers the canonical Personal Space).
 *   3. `null` when neither is healthy — pages should render a
 *      structured CapabilityDegradedPanel for the genuine
 *      no-workspace case.
 *
 * This hook is NON-AUTHORITATIVE — it reads the canonical envelope
 * and never fetches. Capability gating still flows through
 * `useCan(...)` / the capability map.
 *
 * The returned id is, today, a `Team.id` (Phase 2 legacy debt:
 * `Team` table backs the runtime Workspace). Future phases will
 * rename the FK target without changing this hook's signature.
 */
export function useActiveWorkspaceId(): string | null {
  const { envelope } = usePlatformContext();
  return activeWorkspaceIdFromEnvelope(envelope);
}

// =============================================================================
// Phase G4 / personal-first-rescue helpers — bounded envelope fragments
// =============================================================================

/**
 * Bounded `{ id, status }` projection of `envelope.workspace`, returned
 * so callers (route gates, command palette, tools page) can pass it to
 * `resolveRouteAccess` for the PERSONAL-FIRST RESCUE fallback WITHOUT
 * reading `envelope.workspace.*` directly outside `lib/platform-context/`.
 *
 * The Phase G4.3 frontend contract pins that `envelope.workspace.*` is
 * read ONLY from inside `lib/platform-context/`. This hook is that
 * canonical reader.
 *
 * Returns `null` when no envelope is loaded yet.
 */
export function useWorkspaceFragment():
  | { id: string | null; status: string | null }
  | null {
  const { envelope } = usePlatformContext();
  if (!envelope?.workspace) return null;
  return {
    id: envelope.workspace.id ?? null,
    status: envelope.workspace.status ?? null,
  };
}

/**
 * Bounded `{ id, status }` projection of `envelope.personalSpace` for
 * the same rescue-fallback purpose. Returns `null` when no envelope
 * or no personal space is present.
 */
export function usePersonalSpaceFragment():
  | { id: string | null; status: string | null }
  | null {
  const { envelope } = usePlatformContext();
  if (!envelope?.personalSpace) return null;
  return {
    id: envelope.personalSpace.id ?? null,
    status: envelope.personalSpace.status ?? null,
  };
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
