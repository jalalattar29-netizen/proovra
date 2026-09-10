"use client";

/**
 * PV-PLACE-001 — the workspace's upload reliability, in Operations.
 *
 * Moved from `/admin/platform/reliability`: the summary and the stalled
 * upload sessions are one workspace's, read behind `requireAdminMember`. The
 * page keeps its own route gate; this layout only carries the administrative
 * visual system.
 */

import type { ReactNode } from "react";

import { AdminVisualSystem } from "../../../../components/admin/AdminVisualSystem";

export default function OperationsReliabilityLayout({ children }: { children: ReactNode }) {
  return <AdminVisualSystem>{children}</AdminVisualSystem>;
}
