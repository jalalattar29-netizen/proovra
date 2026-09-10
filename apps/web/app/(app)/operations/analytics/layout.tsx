"use client";

/**
 * PV-PLACE-001 — the workspace's operational analytics, in Operations.
 *
 * Moved from `/admin/platform/analytics`: every read behind it authorizes on
 * the operator's own workspace, so it never showed the platform. The page
 * keeps its own route gate; this layout only carries the administrative
 * visual system it was designed on.
 */

import type { ReactNode } from "react";

import { AdminVisualSystem } from "../../../../components/admin/AdminVisualSystem";

export default function OperationsAnalyticsLayout({ children }: { children: ReactNode }) {
  return <AdminVisualSystem>{children}</AdminVisualSystem>;
}
