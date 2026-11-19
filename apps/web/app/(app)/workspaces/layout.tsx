"use client";

import type { ReactNode } from "react";

/**
 * PRO-PW-02 (WS-ENT) — /workspaces is an ACCOUNT-domain route (tier CORE in
 * lib/surface/tiers.ts): the page gates itself with PageRouteGate
 * (admin.teams), so this layout no longer re-exports EnterpriseSurfaceLayout,
 * whose redirect sent every non-Enterprise account to /collaboration-teams.
 */
export default function WorkspacesLayout({ children }: { children: ReactNode }) {
  return children;
}
