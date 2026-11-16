/**
 * B5A-F-03 / A2-14 — what the signed-in actor may do to ONE record (native).
 *
 * Mirrors apps/web/lib/evidence/record-actor-capabilities.ts. The lifecycle
 * projection says what the RECORD allows; this says what the CALLER may do, so
 * a VIEWER is not offered Lock / Archive / Move to trash / Edit name / Restore
 * and a MEMBER not Archive / Move to trash — each of which the server refuses
 * with a concealed "not found".
 *
 * Authority order: the server's `actorCapabilities` when sent (requested
 * cross-lane); otherwise the canonical role matrix over the caller's role in
 * the record's OWN workspace, read from the platform-context envelope; a role
 * the envelope cannot name leaves every control offered (visibility gate only —
 * the server still decides). A personal-scope record (`teamId` null) belongs to
 * its owner, who holds every operation.
 */
import { mapTeamRoleToCanonical, roleHasPermission } from "@proovra/shared";

export type RecordActorCapabilities = {
  /** Edit name, Lock (server: evidence.update_metadata). */
  canEditMetadata: boolean;
  /** Archive, Restore archived, Unlock (server: evidence.archive). */
  canArchive: boolean;
  /** Move to trash (server: evidence.delete). */
  canTrash: boolean;
  /** Restore from trash (server: evidence.restore_from_trash). */
  canRestoreFromTrash: boolean;
  source: "server" | "role" | "unknown";
};

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
const ROLES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

const ALL: RecordActorCapabilities = {
  canEditMetadata: true,
  canArchive: true,
  canTrash: true,
  canRestoreFromTrash: true,
  source: "unknown",
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function list(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.map(obj) : [];
}
function asRole(v: unknown): Role | null {
  return typeof v === "string" && ROLES.has(v) ? (v as Role) : null;
}

/** The caller's role in workspace `teamId`, as the raw envelope states it. */
export function roleInWorkspace(envelope: unknown, teamId: string): Role | null {
  const env = obj(envelope);
  const workspace = obj(env["workspace"]);
  if (workspace["id"] === teamId) {
    const role = asRole(obj(workspace["membership"])["role"]);
    if (role) return role;
  }
  const options = obj(env["contextOptions"]);
  if (obj(options["personalSpace"])["workspaceId"] === teamId) return "OWNER";
  for (const w of [...list(options["ownedWorkspaces"]), ...list(options["sharedWorkspaces"])]) {
    if (w["workspaceId"] === teamId) return asRole(w["role"]);
  }
  for (const org of list(options["organizations"])) {
    for (const w of list(org["workspaces"])) {
      if (w["workspaceId"] === teamId) return asRole(w["workspaceRole"]);
    }
  }
  for (const w of list(env["availableWorkspaces"])) {
    if (w["id"] === teamId) return asRole(w["role"]);
  }
  return null;
}

export function resolveRecordActorCapabilities(input: {
  envelope: unknown;
  /** null = personal scope; undefined = not loaded. */
  recordTeamId: string | null | undefined;
  server?: unknown;
}): RecordActorCapabilities {
  if (input.server && typeof input.server === "object") {
    const s = obj(input.server);
    return {
      canEditMetadata: s["updateMetadata"] === true,
      canArchive: s["archive"] === true,
      canTrash: s["delete"] === true,
      canRestoreFromTrash: s["restoreFromTrash"] === true,
      source: "server",
    };
  }
  if (!input.recordTeamId) return ALL;
  const role = roleInWorkspace(input.envelope, input.recordTeamId);
  if (!role) return ALL;
  const canonical = mapTeamRoleToCanonical(role);
  return {
    canEditMetadata: roleHasPermission(canonical, "evidence.update_metadata"),
    canArchive: roleHasPermission(canonical, "evidence.archive"),
    canTrash: roleHasPermission(canonical, "evidence.delete"),
    canRestoreFromTrash: roleHasPermission(canonical, "evidence.restore_from_trash"),
    source: "role",
  };
}
