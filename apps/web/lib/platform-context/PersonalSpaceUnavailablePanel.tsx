"use client";

/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23) — canonical "Personal Space
 * unavailable" surface.
 *
 * Rendered by AppShellV2 whenever `usePersonalSpaceGate()` reports
 * "blocked" — the active context is a Personal Space this identity is no
 * longer allowed to operate (managed-enterprise identity under an
 * Organization policy), and either no alternative workspace exists to heal
 * into, or the heal attempt is still in flight. Every (app) route is
 * wrapped by AppShellV2, so this ONE panel protects capture, evidence,
 * billing, settings, and any deep link alike — the client never silently
 * continues to render Personal content.
 *
 * Copy is deliberately bounded: it explains WHY in plain language without
 * exposing policy internals (identity mode, SSO requirement, org id, etc).
 */

import { ProovraSystemState } from "../../components/feedback/ProovraSystemState";
import type { SystemStateAction } from "../../components/feedback/ProovraSystemState";
import { useHealWithheld, requestHealRelease } from "./personalSpaceHealLatch";

export const PERSONAL_SPACE_UNAVAILABLE_MESSAGE =
  "Personal Space is unavailable under managed Organization policy. Your existing Personal evidence is preserved and untouched. Ask your organization administrator to assign you an Organization workspace to continue.";

/**
 * PHASE 10 CLOSURE FIX 3 — copy for the case where a valid workspace IS
 * available to continue in, but the automatic switch was WITHHELD because
 * unsaved workspace-scoped work would otherwise be crossed silently over the
 * workspace boundary. The operator resolves it explicitly.
 */
export const PERSONAL_SPACE_WITHHELD_MESSAGE =
  "Personal Space is no longer available under managed Organization policy. You have unsaved work here — nothing has been moved or deleted. Discard it to continue in your available workspace, or open Help & support.";

export function PersonalSpaceUnavailablePanel() {
  // The gate publishes here when it WITHHELD the automatic heal because
  // unsaved workspace-scoped work (per the canonical dirty-work registry)
  // was present. In that case a real destination workspace exists — the ONLY
  // thing standing between the operator and it is their own unsaved work.
  const withheld = useHealWithheld();

  const actions: SystemStateAction[] = [];
  if (withheld.withheld) {
    actions.push({
      label: "Discard unsaved work and continue",
      onClick: requestHealRelease,
      variant: "primary",
      testId: "personal-space-discard-continue",
    });
  }
  actions.push({
    label: "Help & support",
    href: "/support",
    variant: "secondary",
    external: true,
    testId: "personal-space-unavailable-support",
  });

  const message = withheld.withheld
    ? PERSONAL_SPACE_WITHHELD_MESSAGE
    : PERSONAL_SPACE_UNAVAILABLE_MESSAGE;

  return (
    <div
      data-personal-space-unavailable-panel
      data-heal-withheld={withheld.withheld ? "true" : "false"}
    >
      <ProovraSystemState
        kind="workspace-unavailable"
        context="authenticated"
        presentation="full-page"
        minHeight="70vh"
        testId="personal-space-unavailable"
        statusLabel="Personal Space"
        title="Personal Space isn't available right now"
        message={message}
        actions={actions}
      />
      {withheld.withheld && withheld.labels.length > 0 ? (
        <ul data-personal-space-withheld-work>
          {withheld.labels.map((label, index) => (
            <li key={`${label}-${index}`}>{label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
