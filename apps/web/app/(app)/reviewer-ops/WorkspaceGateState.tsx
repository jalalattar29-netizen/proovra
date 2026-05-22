"use client";

/**
 * Hotfix — Reviewer Ops workspace-gate state renderer.
 *
 * Renders the canonical "no workspace / auth / permission / operational
 * failure" states for the four Reviewer Ops console pages. Centralizes
 * the strings + the visual treatment so:
 *   * "Switch to a workspace" fires ONLY when the user truly has no
 *     workspace membership.
 *   * 401 → auth state.
 *   * 403 → "You do not have permission to view Review Operations."
 *   * 500 / unknown → operational error with optional requestId.
 *   * `loading` is rendered with a muted placeholder so the page
 *     doesn't flash the empty state during the readiness probe.
 *
 * The four reviewer-ops pages all read `useActiveWorkspaceId()`. If
 * the result is anything other than `{status: "ready", ...}`, they
 * render this component and bail out. If `ready`, they render their
 * own content with the resolved `workspaceId`.
 */

import type { ActiveWorkspaceState } from "../../../lib/useActiveWorkspaceId";

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

export function WorkspaceGateState({
  state,
  surface,
}: {
  state: Exclude<ActiveWorkspaceState, { status: "ready" }>;
  surface:
    | "Reviewer Ops"
    | "SLA"
    | "Escalations"
    | "Review Policy"
    | "Governance Policy";
}) {
  if (state.status === "loading") {
    return (
      <main style={wrap}>
        <p style={muted}>Loading {surface}…</p>
      </main>
    );
  }
  if (state.status === "no-workspace") {
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
      ? "You do not have permission to view Review Operations. Ask a workspace administrator to grant access."
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
