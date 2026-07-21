"use client";

/**
 * Workspace recovery panel.
 *
 * Rendered when `envelope.recoveryActions` is non-empty (the server
 * couldn't assemble a healthy workspace). NEVER a blank shell — it
 * surfaces a title, a bounded explanation, the server-provided recovery
 * CTAs (create personal workspace / create team / open settings / retry),
 * and the requestId for support correlation.
 *
 * (2026-07-21) Migrated off the bespoke `cc-page` chrome + raw <code>
 * requestId onto the canonical `ProovraSystemState`. The requestId now
 * flows through `ProovraSupportReference` (the only sanctioned trace-id
 * surface) instead of an ad-hoc <code> element.
 */

import { ProovraSystemState } from "../../components/feedback/ProovraSystemState";
import type { SystemStateAction } from "../../components/feedback/ProovraSystemState";
import { usePlatformContext } from "./PlatformContextProvider";

export function WorkspaceRecoveryPanel() {
  const { envelope, state, refresh } = usePlatformContext();
  const recoveryActions = envelope?.recoveryActions ?? [];
  const requestId = envelope?.diagnostics?.requestId ?? null;
  const message =
    state.name === "FAILED"
      ? state.message
      : "Workspace setup is required to continue. Pick an option below or retry the request.";

  const actions: SystemStateAction[] = recoveryActions.map((action, i) => {
    const variant = i === 0 ? "primary" : "secondary";
    if (action.id === "retry") {
      return {
        label: action.label,
        onClick: () => void refresh(),
        variant,
        testId: `workspace-recovery-action-${action.id}`,
      };
    }
    return {
      label: action.label,
      href: action.href ?? undefined,
      variant,
      testId: `workspace-recovery-action-${action.id}`,
    };
  });

  return (
    <div data-workspace-recovery-panel>
      <ProovraSystemState
        kind="workspace-unavailable"
        context="authenticated"
        presentation="full-page"
        minHeight="70vh"
        testId="workspace-recovery"
        statusLabel="Workspace setup required"
        title="Let's get you back into the product"
        message={message}
        actions={actions}
        supportReference={requestId}
      />
    </div>
  );
}
