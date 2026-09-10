"use client";

/**
 * PV-PLACE-001 — the workspace's automation rules, in Operations.
 *
 * Moved from `/admin/platform/automation`: the rules and runs belong to the
 * operator's own workspace (`requireTeamCapability`). The page keeps its own
 * route gate; this layout only carries the administrative visual system.
 */

import type { ReactNode } from "react";

import { AdminVisualSystem } from "../../../../components/admin/AdminVisualSystem";

export default function OperationsAutomationLayout({ children }: { children: ReactNode }) {
  return <AdminVisualSystem>{children}</AdminVisualSystem>;
}
