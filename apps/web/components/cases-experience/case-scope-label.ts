import type { PlatformContextEnvelope } from "../../lib/platform-context/types";

/**
 * The leading breadcrumb crumb names the workspace that OWNS the case.
 *
 * It used to test `case.scope === "TEAM"`, a value the server never sends
 * (its vocabulary is SHARED / SINGLE_OCCUPANT), so every case read
 * "Personal Space". The scope is also the wrong field: a Personal Space case
 * carries its personal Team id and is therefore SHARED too. The owner is
 * `case.teamId`, resolved against the server-authorized context options.
 *
 * AUD-0062 — used by BOTH case views. The simple view (every non-Enterprise
 * case, and organization cases opened outside MatterWorkspace) rendered the
 * header default, "Personal Space", for every case.
 */
export function resolveCaseScopeLabel(
  teamId: string | null,
  context: PlatformContextEnvelope | null,
): string {
  if (!teamId) return "Personal Space";
  if (!context) return "Workspace";
  const options = context.contextOptions;
  if (
    options?.personalSpace?.workspaceId === teamId ||
    context.personalSpace?.id === teamId
  ) {
    return "Personal Space";
  }
  const owned = options?.ownedWorkspaces.find((w) => w.workspaceId === teamId);
  if (owned) return owned.name ?? "Workspace";
  // AUD-0047 — a Pro or Team workspace the person joined.
  const shared = options?.sharedWorkspaces?.find((w) => w.workspaceId === teamId);
  if (shared) return shared.name ?? "Workspace";
  for (const org of options?.organizations ?? []) {
    const ws = org.workspaces.find((w) => w.workspaceId === teamId);
    if (ws) return ws.workspaceName ?? org.organizationName ?? "Organization";
  }
  if (context.workspace?.id === teamId) {
    if (context.workspace.workspaceKind === "PERSONAL") return "Personal Space";
    return context.workspace.name ?? "Workspace";
  }
  return "Workspace";
}
