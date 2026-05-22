"use client";

/**
 * Phase 32.8 Foundation cleanup — Reviewer Ops gate renderer.
 *
 * Renders the canonical structured states for reviewer-ops sub-routes
 * (SLA, escalations, review detail) using only the canonical
 * platform-context model:
 *
 *   - `loading`        → muted placeholder
 *   - `no-workspace`
 *      + reason "personal"      → CapabilityDegradedPanel
 *      + reason "no-workspace"  → "Switch to a workspace" CTA
 *   - `error`         → auth / permission / operational error panels
 *
 * Hard rules:
 *   - This component consumes `TeamWorkspaceGateState` from the
 *     canonical platform-context module. It does NOT import the
 *     legacy `useActiveWorkspaceId` shape.
 *   - Personal-workspace state renders the structured
 *     `CapabilityDegradedPanel` — never a plain-text wall.
 *   - `surface` + `requiredCapability` together describe what is
 *     being gated, for analytics and a11y.
 */

import {
  CapabilityDegradedPanel,
  type CapabilityKey,
  type TeamWorkspaceGateState,
} from "../../../lib/platform-context";

const wrap: React.CSSProperties = {
  maxWidth: 880,
  margin: "0 auto",
  padding: "48px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const muted: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const title: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 6,
};
const errorBox: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const requestIdStyle: React.CSSProperties = {
  fontSize: 11,
  marginTop: 6,
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  color: "#7f1d1d",
};

type GateSurface =
  | "Reviewer Ops"
  | "SLA"
  | "Escalations"
  | "Review Policy"
  | "Governance Policy";

const REASON_BY_SURFACE: Record<GateSurface, string> = {
  "Reviewer Ops":
    "Reviewer Ops coordinates work across a team — queue triage, SLA pressure, escalations, and reviewer capacity. It activates when you switch into a team workspace.",
  SLA: "SLA tracking measures reviewer performance and overdue pressure across a team. It activates when you switch into a team workspace.",
  Escalations:
    "Escalations route reviewer-flagged risk to the right responder across a team. They activate when you switch into a team workspace.",
  "Review Policy":
    "Review policy editing controls reviewer routing, SLA thresholds, and escalation rules for a team. It activates in a team workspace.",
  "Governance Policy":
    "Governance policy editing controls preservation, retention, destruction, and export gates for a team. It activates in a team workspace.",
};

export function WorkspaceGateState({
  state,
  surface,
  requiredCapability,
}: {
  state: Exclude<TeamWorkspaceGateState, { status: "ready" }>;
  surface: GateSurface;
  requiredCapability: CapabilityKey;
}) {
  if (state.status === "loading") {
    return (
      <main style={wrap}>
        <p style={muted}>Loading {surface}…</p>
      </main>
    );
  }
  if (state.status === "no-workspace") {
    // Personal workspace → structured CapabilityDegradedPanel.
    if (state.reason === "personal") {
      return (
        <main style={wrap}>
          <CapabilityDegradedPanel
            surface={surface}
            requiredCapability={requiredCapability}
            reason={REASON_BY_SURFACE[surface]}
            alternatives={[
              { label: "Manage your evidence", href: "/evidence" },
              { label: "Open your cases", href: "/cases" },
              { label: "Generate a report", href: "/reports" },
            ]}
          />
        </main>
      );
    }
    // True "no membership" → CTA to switch / accept invite.
    return (
      <main style={wrap}>
        <h1 style={title}>No workspace selected</h1>
        <p style={muted}>
          Switch to a workspace to use {surface}. If you belong to a workspace
          and still see this, open the Teams page and confirm membership.
        </p>
      </main>
    );
  }
  // status: error
  const heading =
    state.code === "auth_required"
      ? "Sign in required"
      : state.code === "permission_denied"
        ? "Permission required"
        : "Unable to load";
  const body =
    state.code === "permission_denied"
      ? `You do not have permission to view ${surface}. Ask a workspace administrator to grant access.`
      : state.message;
  return (
    <main style={wrap}>
      <h1 style={title}>{heading}</h1>
      <div style={errorBox}>{body}</div>
      {state.requestId ? (
        <div style={requestIdStyle}>Request ID: {state.requestId}</div>
      ) : null}
    </main>
  );
}
