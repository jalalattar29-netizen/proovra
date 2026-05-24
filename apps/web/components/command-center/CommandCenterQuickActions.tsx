/**
 * PHASE R3 — Contextual quick-actions row for the dashboard.
 *
 * Renders a bounded row of mode-aware operational shortcuts. Each
 * action links to an EXISTING registered route. The component itself
 * is presentation-only; orchestration (which actions appear) lives
 * in `lib/dashboard/resolveDashboardQuickActions.ts`.
 *
 * NO authorization decisions are made here. If the target route
 * isn't loadable for the user, its own PageRouteGate renders the
 * structured recovery panel — the action remains a shortcut.
 *
 * Uses the existing `.cc-quick-action` CSS class (Phase 32.8C
 * canonical operational link). No new CSS introduced.
 */

import Link from "next/link";

import type { DashboardQuickAction } from "../../lib/dashboard";

export interface CommandCenterQuickActionsProps {
  actions: ReadonlyArray<DashboardQuickAction>;
  mode: string;
}

export function CommandCenterQuickActions({
  actions,
  mode,
}: CommandCenterQuickActionsProps) {
  if (actions.length === 0) return null;
  return (
    <div
      data-cc-quick-actions
      data-cc-quick-actions-mode={mode}
      data-cc-quick-actions-count={actions.length}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        marginTop: 8,
      }}
      aria-label="Operational quick actions"
    >
      {actions.map((action) => (
        <Link
          key={action.id}
          href={action.href}
          data-cc-quick-action-id={action.id}
          data-cc-quick-action-intent={action.intent}
          className={
            action.intent === "primary"
              ? "cc-quick-action is-primary"
              : "cc-quick-action"
          }
        >
          {action.label}
        </Link>
      ))}
    </div>
  );
}
