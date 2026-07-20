"use client";

/**
 * PHASE R6 — Hub quick-actions bar.
 *
 * Bounded shared component that renders a hub's title + subtitle +
 * mode-aware help copy + ≤4 quick actions. Mounted at the top of
 * each canonical hub page (investigation / governance / reviewer /
 * operations).
 *
 * NO authorization. NO fetches. Pure presentation wrapper around
 * the R6 orchestration library + R5 disclosure help.
 *
 * The component is bounded by design:
 *
 *   - max 4 quick actions (rendered through the orchestration
 *     library's bound)
 *   - title + subtitle copy from `HUB_DEFINITIONS`
 *   - one help line from `resolveDisclosureHelp(mode).primary`
 *
 * No "everything dashboard" bloat — this is a hub HEADER, not a
 * second dashboard.
 */

import Link from "next/link";

import { resolveHubContext, type HubId } from "../../lib/hubs";
import { resolveDisclosureHelp } from "../../lib/navigation/disclosureHelp";
import { resolveWorkspaceExperience } from "../../lib/workspace-experience";
import { usePlatformContext } from "../../lib/platform-context";

export interface HubQuickActionsBarProps {
  hubId: HubId;
}

export function HubQuickActionsBar({ hubId }: HubQuickActionsBarProps) {
  const ctx = usePlatformContext();
  const experience = resolveWorkspaceExperience({
    activeSpaceType: ctx.envelope?.activeSpace?.type ?? null,
    capabilities: ctx.envelope?.capabilities ?? {},
  });
  const help = resolveDisclosureHelp(experience.mode);
  const { definition, quickActions } = resolveHubContext({ hubId });

  return (
    <header
      data-hub-bar
      data-hub-id={hubId}
      data-hub-experience-mode={experience.mode}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "16px 24px",
        borderBottom: "1px solid #e2e8f0",
        background: "#f8fafc",
      }}
    >
      <div>
        <h1
          data-hub-title
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#0f172a",
            margin: 0,
          }}
        >
          {definition.title}
        </h1>
        <p
          data-hub-subtitle
          style={{
            fontSize: 13,
            color: "#475569",
            marginTop: 4,
            marginBottom: 0,
          }}
        >
          {definition.subtitle}
        </p>
        <p
          data-hub-help
          style={{
            fontSize: 12,
            color: "#64748b",
            marginTop: 6,
            marginBottom: 0,
          }}
        >
          {help.primary}
        </p>
      </div>
      {quickActions.length > 0 ? (
        <div
          data-hub-quick-actions
          data-hub-quick-actions-count={quickActions.length}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 4,
          }}
          aria-label={`${definition.title} quick actions`}
        >
          {quickActions.map((action) => (
            <Link
              key={action.id}
              href={action.href}
              data-hub-quick-action-id={action.id}
              data-hub-quick-action-intent={action.intent}
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
      ) : null}
    </header>
  );
}
