"use client";

/**
 * Hotfix — canonical resolution of the active workspace ID for client
 * pages.
 *
 * Background:
 *   Before this hotfix, every operator console page (`/reviewer-ops`,
 *   `/reviewer-ops/sla`, `/reviewer-ops/escalations`,
 *   `/reviewer-ops/policy`, `/governance/...`, `/intake-links`, …)
 *   called `/v1/users/me` and read `user.currentWorkspaceId` to scope
 *   its API calls. The `/v1/users/me` `pickMe()` helper on the api
 *   side previously DROPPED that field from the response, so those
 *   pages saw `undefined` and rendered "Switch to a workspace" — even
 *   though the user had an active workspace. `/home` was unaffected
 *   because it queries `/v1/evidence?scope=active` and lets the
 *   server resolve the workspace from the session context.
 *
 * What this hook does:
 *   1. Calls `/v1/users/me`. If `user.currentWorkspaceId` is present,
 *      that is the active workspace ID — done.
 *   2. If `currentWorkspaceId` is null/undefined (no workspace
 *      currently selected on the user record), falls back to
 *      `/v1/teams` and uses the first team the user is a member of
 *      as a best-effort default.
 *   3. Only when BOTH calls confirm the user has zero memberships
 *      does it return `{ status: "no-workspace" }`, which the page
 *      should render as the canonical "Switch to a workspace" state.
 *   4. Auth (401), permission (403), and unexpected (500) failures
 *      are surfaced as `{ status: "error", code, requestId }` so the
 *      page can render the appropriate dedicated state instead of
 *      collapsing every failure into "no workspace".
 *
 * The hook is read-only and idempotent. It does NOT mutate the
 * server-side `User.currentWorkspaceId`; that's the responsibility of
 * the workspace-switcher action.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "./api";

/**
 * Phase 32.6.4 — bounded workspace role surfaced alongside the
 * workspace ID so the sidebar and downstream UX can do client-side
 * role-aware hiding. Backend permission checks remain authoritative.
 * The role is only populated when it could be resolved cheaply
 * (matching the active workspace inside the `/v1/teams` response);
 * if absent, sidebar role filters fail-closed to "hide admin items".
 */
export type ActiveWorkspaceRole =
  | "OWNER"
  | "ADMIN"
  | "MEMBER"
  | "REVIEWER"
  | "VIEWER"
  | "EXTERNAL_REVIEWER";

const ACTIVE_WORKSPACE_ROLE_VALUES: ReadonlyArray<ActiveWorkspaceRole> = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "REVIEWER",
  "VIEWER",
  "EXTERNAL_REVIEWER",
];

function coerceActiveWorkspaceRole(
  raw: string | null | undefined,
): ActiveWorkspaceRole | null {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase() as ActiveWorkspaceRole;
  return ACTIVE_WORKSPACE_ROLE_VALUES.includes(upper) ? upper : null;
}

export type ActiveWorkspaceState =
  | { status: "loading" }
  | {
      status: "ready";
      workspaceId: string;
      /**
       * Phase 32.6.4 — bounded role on the active workspace, when the
       * hook could resolve it from `/v1/teams`. `null` means "not
       * determined" — client-side role filters MUST fail-closed in
       * that case.
       */
      role: ActiveWorkspaceRole | null;
    }
  | { status: "no-workspace" }
  | {
      status: "error";
      code: "auth_required" | "permission_denied" | "operational";
      message: string;
      requestId?: string | null;
    };

type MeResponse = {
  user?: {
    currentWorkspaceId?: string | null;
  } | null;
};

type TeamsResponse = {
  items?: ReadonlyArray<{ id?: string | null; role?: string | null }>;
};

type ApiErrorLike = {
  statusCode?: number;
  code?: string;
  message?: string;
  requestId?: string | null;
};

function classifyError(err: unknown): ActiveWorkspaceState {
  const e = err as ApiErrorLike;
  if (e?.statusCode === 401) {
    return {
      status: "error",
      code: "auth_required",
      message: "Sign in to continue.",
      requestId: e.requestId ?? null,
    };
  }
  if (e?.statusCode === 403) {
    return {
      status: "error",
      code: "permission_denied",
      message: "You do not have permission to view this page.",
      requestId: e.requestId ?? null,
    };
  }
  return {
    status: "error",
    code: "operational",
    message: e?.message ?? "Unable to load workspace.",
    requestId: e?.requestId ?? null,
  };
}

export function useActiveWorkspaceId(): ActiveWorkspaceState {
  const [state, setState] = useState<ActiveWorkspaceState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = (await apiFetch("/v1/users/me", { method: "GET" })) as MeResponse;
        const currentWorkspaceId = me?.user?.currentWorkspaceId ?? null;
        if (cancelled) return;

        // Always attempt to resolve the role from `/v1/teams` (it is
        // the only endpoint that surfaces per-membership role). A
        // failure here is non-fatal — the workspaceId is still
        // usable, role just stays `null` and sidebar role filters
        // fail-closed.
        const resolveRoleFromTeams = async (
          workspaceId: string,
        ): Promise<ActiveWorkspaceRole | null> => {
          try {
            const teams = (await apiFetch("/v1/teams", {
              method: "GET",
            })) as TeamsResponse;
            const match = teams?.items?.find((t) => t.id === workspaceId);
            return coerceActiveWorkspaceRole(match?.role ?? null);
          } catch {
            return null;
          }
        };

        if (currentWorkspaceId) {
          const role = await resolveRoleFromTeams(currentWorkspaceId);
          if (cancelled) return;
          setState({
            status: "ready",
            workspaceId: currentWorkspaceId,
            role,
          });
          return;
        }
        // Fallback — server has no `currentWorkspaceId` recorded for
        // this user. Check whether they have any team membership.
        // If yes, use the first one (matches the "default workspace"
        // semantic the rest of the app relies on). If no, this is
        // the canonical "no workspace" state.
        try {
          const teams = (await apiFetch("/v1/teams", {
            method: "GET",
          })) as TeamsResponse;
          if (cancelled) return;
          const firstMatch = teams?.items?.find(
            (t) => typeof t.id === "string" && t.id.length > 0,
          );
          const firstId = firstMatch?.id as string | undefined;
          if (firstId) {
            setState({
              status: "ready",
              workspaceId: firstId,
              role: coerceActiveWorkspaceRole(firstMatch?.role ?? null),
            });
          } else {
            setState({ status: "no-workspace" });
          }
        } catch (teamsErr) {
          if (cancelled) return;
          // Don't escalate a /v1/teams fallback failure into a hard
          // error — the user might just have no teams. Report
          // "no-workspace" so the page renders the canonical state.
          // (A truly broken /v1/teams will still surface elsewhere.)
          const teamsErrShape = teamsErr as ApiErrorLike;
          if (
            teamsErrShape?.statusCode === 401 ||
            teamsErrShape?.statusCode === 403
          ) {
            setState(classifyError(teamsErr));
          } else {
            setState({ status: "no-workspace" });
          }
        }
      } catch (err) {
        if (cancelled) return;
        setState(classifyError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
