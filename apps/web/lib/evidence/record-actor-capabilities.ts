/**
 * B5A-F-03 / A2-14 — WHAT THE SIGNED-IN ACTOR MAY DO TO ONE RECORD.
 *
 * The record-detail lifecycle projection is evidence-only: it says what the
 * RECORD allows (locked, held, archived …), not what the CALLER may do. So a
 * VIEWER was offered Lock, Archive, Move to trash, Edit name and Restore, and a
 * MEMBER Archive and Move to trash, and every one of them failed with the
 * server's concealed "not found".
 *
 * Authority order:
 *   1. a server-projected `actorCapabilities` on the record or review
 *      workspace, when the API sends one (requested cross-lane, from
 *      `resolveEvidenceRecordAccess`) — taken verbatim;
 *   2. otherwise the canonical role matrix (`roleHasPermission` over
 *      `mapTeamRoleToCanonical`), with the caller's role in the record's OWN
 *      workspace read from the platform-context envelope — the same matrix the
 *      server's `evaluateMemberAccess` enforces;
 *   3. a role the envelope cannot name leaves every control offered: this is a
 *      visibility gate, and the server still decides. Hiding an owner's
 *      controls on a degraded envelope would be the worse failure.
 *
 * Personal-scope records (`teamId === null`) are readable only by their owner,
 * who holds every operation.
 */
import { mapTeamRoleToCanonical, roleHasPermission } from "@proovra/shared";
import { useOptionalPlatformContext } from "../platform-context/PlatformContextProvider";
import { roleInWorkspace } from "../platform-context/actorRole";
import type { PlatformContextEnvelope } from "../platform-context/types";

export type RecordActorCapabilities = {
  /** Edit name, Lock (server: evidence.update_metadata). */
  canEditMetadata: boolean;
  /** Archive, Restore archived, Unlock (server: evidence.archive). */
  canArchive: boolean;
  canTrash: boolean;
  canRestoreFromTrash: boolean;
  /** PRO-E2-09 — Open / Download original (server: evidence.download_original). */
  canDownloadOriginal: boolean;
  /** "server" | "role" | "unknown" — where the answer came from. */
  source: "server" | "role" | "unknown";
};

/** The optional server projection (CROSS-LANE request B5A-F-03). */
export type ServerActorCapabilities = {
  updateMetadata?: boolean;
  archive?: boolean;
  delete?: boolean;
  restoreFromTrash?: boolean;
  /** PRO-E2-09 (WS-ENT) — absent on an older API: the role matrix answers. */
  downloadOriginal?: boolean;
};

const ALL: RecordActorCapabilities = {
  canEditMetadata: true,
  canArchive: true,
  canTrash: true,
  canRestoreFromTrash: true,
  canDownloadOriginal: true,
  source: "unknown",
};

// The envelope tenancy read lives in lib/platform-context (Phase G4.3 / 37.95);
// re-exported here for the existing callers.
export { roleInWorkspace };

export function resolveRecordActorCapabilities(input: {
  envelope: PlatformContextEnvelope | null | undefined;
  /** The record's persisted workspace; null = personal scope; undefined = not loaded. */
  recordTeamId: string | null | undefined;
  server?: ServerActorCapabilities | null;
}): RecordActorCapabilities {
  const server = input.server;
  // The role matrix answer, used whole when the server sends nothing and for a
  // field an older server does not send (downloadOriginal).
  const roleAnswer = ((): RecordActorCapabilities => {
    if (input.recordTeamId === undefined || input.recordTeamId === null) return ALL;
    const role = roleInWorkspace(input.envelope, input.recordTeamId);
    if (!role) return ALL;
    const canonical = mapTeamRoleToCanonical(role);
    return {
      canEditMetadata: roleHasPermission(canonical, "evidence.update_metadata"),
      canArchive: roleHasPermission(canonical, "evidence.archive"),
      canTrash: roleHasPermission(canonical, "evidence.delete"),
      canRestoreFromTrash: roleHasPermission(canonical, "evidence.restore_from_trash"),
      canDownloadOriginal: roleHasPermission(canonical, "evidence.download_original"),
      source: "role",
    };
  })();
  if (server && typeof server === "object") {
    return {
      canEditMetadata: server.updateMetadata === true,
      canArchive: server.archive === true,
      canTrash: server.delete === true,
      canRestoreFromTrash: server.restoreFromTrash === true,
      canDownloadOriginal:
        typeof server.downloadOriginal === "boolean" ? server.downloadOriginal : roleAnswer.canDownloadOriginal,
      source: "server",
    };
  }
  return roleAnswer;
}

/**
 * The record's actor capabilities for the signed-in caller. `record` is the
 * loaded evidence row (its persisted `teamId`, and the server's
 * `actorCapabilities` when the API sends it); null/undefined while loading.
 */
export function useRecordActorCapabilities(
  record: { teamId?: string | null; actorCapabilities?: ServerActorCapabilities | null } | null | undefined,
): RecordActorCapabilities {
  const platform = useOptionalPlatformContext();
  return resolveRecordActorCapabilities({
    envelope: platform?.envelope ?? null,
    recordTeamId: record ? (record.teamId ?? null) : undefined,
    server: record?.actorCapabilities ?? null,
  });
}
