/**
 * PHASE R3 — Canonical dashboard quick-actions orchestrator.
 *
 * Pure function. Returns the bounded list of contextual quick actions
 * for the current experience mode. Every action's `href` is a
 * registered application route — the orchestrator never invents a
 * destination.
 *
 * Authorization is NOT consulted here. The target route's own
 * PageRouteGate / route-access resolver renders the structured
 * recovery panel if the user can't load the destination. The action
 * appears either way (because hiding it would be a permission fork —
 * forbidden by R3).
 */

import { MODE_QUICK_ACTIONS } from "./dashboardModeRules";
import type {
  DashboardQuickAction,
  DashboardQuickActionsInput,
} from "./types";

/** Max actions allowed per mode (bounded to keep the surface focused). */
export const QUICK_ACTIONS_MAX_PER_MODE = 4;

export function resolveDashboardQuickActions(
  input: DashboardQuickActionsInput,
): ReadonlyArray<DashboardQuickAction> {
  const actions = MODE_QUICK_ACTIONS[input.mode] ?? [];
  // Defensive bound — the rules file enforces this at definition
  // time, but the slice protects against future drift.
  return actions.slice(0, QUICK_ACTIONS_MAX_PER_MODE);
}
