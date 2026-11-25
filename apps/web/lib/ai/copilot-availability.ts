"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "../api";

/**
 * Round 2 (2026-11-25, T-091) — whether each copilot may run for the viewer in
 * this workspace, read from the member-safe AI status
 * (`GET /v1/workspaces/ai-assistance-status`, `copilots`). The server evaluates
 * it with the same function the copilot routes apply (master switch, feature
 * switch, allowed roles, plan). Null until known, and on a failed read: the
 * panel then stays available and the route gives its own answer.
 */
export type CopilotAvailability = { reviewer: boolean; case: boolean };

export function useCopilotAvailability(teamId: string | null | undefined): CopilotAvailability | null {
  const [value, setValue] = useState<CopilotAvailability | null>(null);
  useEffect(() => {
    if (!teamId) return;
    let live = true;
    void apiFetch(`/v1/workspaces/ai-assistance-status?teamId=${encodeURIComponent(teamId)}`)
      .then((res) => {
        const c = (res as { copilots?: Partial<CopilotAvailability> } | null)?.copilots;
        if (live && c && typeof c.reviewer === "boolean" && typeof c.case === "boolean") {
          setValue({ reviewer: c.reviewer, case: c.case });
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [teamId]);
  return value;
}
