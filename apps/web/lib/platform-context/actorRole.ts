/**
 * The caller's role in workspace `teamId`, as the envelope states it (Free-user
 * audit 0ea0: B2A-F-11, B7B-F08). `roleInWorkspace` reads the membership and
 * the context options; an envelope that only labels the ACTIVE space
 * (`activeSpace.roleLabel`, "Owner" for the caller's own Personal Space) is
 * read too. Null when the envelope names no role — callers then offer nothing
 * that needs one.
 *
 * Integration fix-up (2026-11-16): `roleInWorkspace` moved here, verbatim,
 * from `lib/evidence/record-actor-capabilities.ts` (B5A-F-03). It reads the
 * envelope's tenancy fields (`workspace.membership`, the deprecated
 * `availableWorkspaces` fallback), and those reads belong to this module —
 * the Phase G4.3 / 37.95 guards keep them inside `lib/platform-context/`.
 * record-actor-capabilities re-exports it for its existing callers.
 */
import type { PlatformContextEnvelope, WorkspaceRole } from "./types";

const ROLES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

function asRole(value: unknown): WorkspaceRole | null {
  return typeof value === "string" && ROLES.has(value) ? (value as WorkspaceRole) : null;
}

/** The caller's role in workspace `teamId`, as the envelope states it, or null. */
export function roleInWorkspace(
  envelope: PlatformContextEnvelope | null | undefined,
  teamId: string,
): WorkspaceRole | null {
  if (!envelope) return null;
  if (envelope.workspace?.id === teamId) {
    const role = asRole(envelope.workspace.membership?.role);
    if (role) return role;
  }
  const options = envelope.contextOptions;
  if (options?.personalSpace?.workspaceId === teamId) return "OWNER";
  for (const w of options?.ownedWorkspaces ?? []) {
    if (w.workspaceId === teamId) return asRole(w.role);
  }
  for (const w of options?.sharedWorkspaces ?? []) {
    if (w.workspaceId === teamId) return asRole(w.role);
  }
  for (const org of options?.organizations ?? []) {
    for (const w of org.workspaces ?? []) {
      if (w.workspaceId === teamId) return asRole(w.workspaceRole);
    }
  }
  for (const w of envelope.availableWorkspaces ?? []) {
    if (w.id === teamId) return asRole(w.role);
  }
  return null;
}

export function actorRoleIn(
  envelope: PlatformContextEnvelope | null | undefined,
  teamId: string | null | undefined,
): WorkspaceRole | null {
  if (!envelope || !teamId) return null;
  const stated = roleInWorkspace(envelope, teamId);
  if (stated) return stated;
  const active = envelope.activeSpace;
  if (active?.id !== teamId) return null;
  const label = String(active.roleLabel ?? "").toUpperCase();
  return ROLES.has(label) ? (label as WorkspaceRole) : null;
}
