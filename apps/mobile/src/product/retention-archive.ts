/**
 * RETENTION ARCHIVE (owner decision 2026-10-14) — native "Archived evidence".
 *
 * The same server contract the web page reads: GET /v1/evidence/retention-archive
 * and POST /v1/evidence/:id/archive-restore. A record here left the 90-day
 * Trash while a retention barrier still applies; it is preserved, not deleted,
 * and comes back only through the verified restore (every stored version and
 * digest is checked first; nothing partial is activated).
 */
import { RETENTION_ARCHIVE_EXPLAINER_COPY } from "@proovra/shared";

export function buildRetentionArchivePath(): string {
  return "/v1/evidence/retention-archive";
}

export function buildArchiveRestorePath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/archive-restore`;
}

export type NativeArchiveItem = {
  id: string;
  title: string;
  archivedAtUtc: string | null;
  barrier: string | null;
  earliestPurgeAtUtc: string | null;
  legalHold: boolean | null;
  restoreAvailable: boolean;
  restoreInProgress: boolean;
  lastFailureCode: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The list response, read by its real keys; malformed rows are dropped, never guessed. */
export function parseRetentionArchive(res: unknown): { items: NativeArchiveItem[]; nextCursor: string | null } {
  const r = res && typeof res === "object" ? (res as Record<string, unknown>) : {};
  const rows = Array.isArray(r["items"]) ? (r["items"] as unknown[]) : [];
  const items: NativeArchiveItem[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = str(o["id"]);
    if (!id) continue;
    const restore = o["restore"] && typeof o["restore"] === "object" ? (o["restore"] as Record<string, unknown>) : {};
    const last = restore["lastRequest"] && typeof restore["lastRequest"] === "object" ? (restore["lastRequest"] as Record<string, unknown>) : null;
    items.push({
      id,
      title: str(o["title"]) ?? "Untitled record",
      archivedAtUtc: str(o["archivedAtUtc"]),
      barrier: str(o["retentionBarrier"]),
      earliestPurgeAtUtc: str(o["earliestPurgeAtUtc"]),
      legalHold: typeof o["legalHold"] === "boolean" ? (o["legalHold"] as boolean) : null,
      restoreAvailable: restore["available"] === true,
      restoreInProgress: restore["inProgress"] === true,
      lastFailureCode: last && last["status"] === "FAILED" ? str(last["failureCode"]) : null,
    });
  }
  return { items, nextCursor: str(r["nextCursor"]) };
}

export const RETENTION_BARRIER_COPY: Readonly<Record<string, string>> = {
  OBJECT_RETENTION: "Storage retention period",
  APP_RETENTION: "Workspace retention policy",
  LEGAL_HOLD: "Legal hold",
  EVIDENCE_LOCKED: "Record lock",
  METADATA_MISSING: "Retention being verified",
  METADATA_INCONSISTENT: "Retention being verified",
  STORAGE_UNAVAILABLE: "Retention being verified",
  CLEAR: "Awaiting final review",
};

/** The one shared explainer (`@proovra/shared`), so web and native say the same policy. */
export const ARCHIVE_EXPLAINER_COPY = RETENTION_ARCHIVE_EXPLAINER_COPY;

export const ARCHIVE_RESTORE_CONFIRM_COPY =
  "PROOVRA first verifies every stored version of the evidence and its reports and packages. If everything checks out, the record returns to your library with the same identity, history and verification page. If anything does not match, it stays archived and nothing changes. Restoring uses no evidence allowance.";

export const ARCHIVE_RESTORE_FAILED_COPY =
  "The last restore stopped because a stored file or digest did not verify. The record stays archived and nothing was changed.";
