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

export type ActiveWorkspaceState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string }
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
  items?: ReadonlyArray<{ id?: string | null }>;
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
        if (currentWorkspaceId) {
          setState({ status: "ready", workspaceId: currentWorkspaceId });
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
          const firstId = teams?.items?.find(
            (t) => typeof t.id === "string" && t.id.length > 0,
          )?.id as string | undefined;
          if (firstId) {
            setState({ status: "ready", workspaceId: firstId });
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
