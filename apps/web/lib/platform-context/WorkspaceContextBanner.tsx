"use client";

/**
 * PHASE 7 §10.5 (2026-07-22) — canonical owning-context banner.
 *
 * Before a high-impact, workspace-scoped submission (capture/finalize,
 * new case, report, share, retention, legal hold, …) the operator must
 * SEE which Workspace / Organization the action will land in — the
 * "I thought I was in workspace A" failure mode. This is the ONE banner
 * every such surface renders; it reads the canonical platform-context
 * envelope, never a per-page copy of the tenant.
 */

import { usePlatformContext } from "./PlatformContextProvider";
import { describeActiveWorkspace } from "./workspaceLabel";

export type WorkspaceContextBannerProps = {
  /** Short operator label for the action, e.g. "Capturing evidence into". */
  action?: string;
  /** Extra className passthrough for host layout. */
  className?: string;
};

export function useOwningContextLabel(): {
  workspaceName: string | null;
  organizationName: string | null;
  kind: "PERSONAL" | "OWNED" | "ORGANIZATION" | null;
  workspaceId: string | null;
} {
  const { envelope, activeWorkspaceId } = usePlatformContext();
  const active = envelope?.contextOptions?.activeContext ?? null;
  const orgs = envelope?.contextOptions?.organizations ?? [];
  const organizationName = active?.organizationId
    ? (orgs.find((o) => o.organizationId === active.organizationId)
        ?.organizationName ?? null)
    : null;
  return {
    workspaceName: active?.displayName ?? envelope?.activeSpace?.displayName ?? null,
    organizationName,
    kind: active?.kind ?? null,
    workspaceId: active?.workspaceId ?? activeWorkspaceId,
  };
}

export function WorkspaceContextBanner({
  action = "This action will apply to",
  className,
}: WorkspaceContextBannerProps) {
  const owning = useOwningContextLabel();
  const { envelope } = usePlatformContext();
  const { organizationName, kind } = owning;
  let workspaceName = owning.workspaceName;

  // Nothing to show before the first READY envelope.
  if (!workspaceName && !organizationName) return null;

  let kindLabel =
    kind === "PERSONAL"
      ? "Personal Space"
      : kind === "ORGANIZATION"
        ? "Organization workspace"
        : kind === "OWNED"
          ? "Workspace"
          : "Workspace";
  // T-115 — a personal workspace is described by the ONE Team-aware label
  // rule (lib/platform-context/workspaceLabel.ts): a Team owner reads their
  // workspace name and "Team workspace"; a member reads the owner workspace
  // name. The kind is never printed when it would repeat the name
  // ("Personal Space · Personal Space").
  if (kind === "PERSONAL") {
    const d = describeActiveWorkspace(envelope);
    if (d.kind !== "UNKNOWN" && d.kind !== "ORGANIZATION") {
      workspaceName = d.name ?? workspaceName;
      kindLabel = d.kindLabel;
    }
  }
  const showKind = kindLabel !== workspaceName;

  return (
    <div
      role="status"
      data-workspace-context-banner
      data-context-kind={kind ?? "unknown"}
      className={className}
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        fontSize: 13,
        padding: "6px 10px",
        borderRadius: 6,
        border: "1px solid rgba(120,120,120,0.25)",
        background: "rgba(120,120,140,0.06)",
      }}
    >
      <span style={{ opacity: 0.75 }}>{action}</span>
      <strong data-context-workspace>{workspaceName ?? "—"}</strong>
      {showKind ? (
        <span data-context-kind-label style={{ opacity: 0.55 }}>
          · {kindLabel}
        </span>
      ) : null}
      {organizationName ? (
        <span data-context-organization style={{ opacity: 0.75 }}>
          · {organizationName}
        </span>
      ) : null}
    </div>
  );
}
