"use client";

/**
 * Capability-degraded canonical panel.
 *
 * Used by ReviewerOps and Governance pages when the active workspace
 * lacks the capability required for the surface (e.g. personal
 * workspaces lacking REVIEWER_OPS_VIEW or GOVERNANCE_VIEW).
 *
 * It tells the user what they're looking at, why it isn't available in
 * their current workspace, and what they can do about it.
 *
 * Hard rules:
 *   - NO raw UUID leaks. Reads workspace.name + scope, never workspace.id.
 *   - NO local role / capability derivation. The page determined this
 *     state via ctx.can(capability) === false BEFORE rendering.
 *
 * (2026-07-21) Migrated off the legacy dark-gradient card onto the
 * canonical `ProovraDenialState` (light, tokenized, one visual system).
 */

import { ProovraDenialState } from "../../components/feedback/ProovraDenialState";
import type { SystemStateAction } from "../../components/feedback/ProovraSystemState";
import { usePlatformContext } from "./PlatformContextProvider";

export type CapabilityDegradedPanelProps = {
  /** Page title (e.g. "Reviewer Ops"). */
  surface: string;
  /** Short why-line. */
  reason: string;
  /** Capability key the page is gated on (for diagnostics). */
  requiredCapability: string;
  /**
   * Optional list of features that DO work in the current workspace
   * — surfaces the "enterprise-lite" alternative paths.
   */
  alternatives?: ReadonlyArray<{ label: string; href: string }>;
};

export function CapabilityDegradedPanel({
  surface,
  reason,
  requiredCapability,
  alternatives,
}: CapabilityDegradedPanelProps) {
  const { envelope } = usePlatformContext();

  // Workspace name fallback is the canonical scope label — NEVER a
  // raw workspace.id.
  const workspaceLabel =
    envelope?.workspace.name ??
    (envelope?.workspace.scope === "PERSONAL"
      ? "your personal workspace"
      : "your active workspace");

  const actions: SystemStateAction[] = [
    {
      label: "Switch or create a workspace",
      href: "/workspaces",
      variant: "primary",
      testId: "capability-degraded-switch",
    },
    { label: "Review plan", href: "/billing", variant: "secondary" },
    // "Available here instead" alternatives become quiet continuation
    // links rather than a competing button row.
    ...(alternatives ?? []).map<SystemStateAction>((a) => ({
      label: a.label,
      href: a.href,
      variant: "text",
    })),
  ];

  return (
    <section
      data-capability-degraded-panel
      data-surface={surface}
      data-required-capability={requiredCapability}
      data-capability-degraded-alternatives={
        alternatives && alternatives.length > 0 ? "true" : undefined
      }
    >
      <ProovraDenialState
        kind="capability-unavailable"
        statusLabel={surface}
        title={`Not available in ${workspaceLabel}`}
        message={reason}
        actions={actions}
        testId={`capability-degraded-${surface}`}
      />
    </section>
  );
}
