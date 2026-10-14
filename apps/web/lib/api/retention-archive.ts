/**
 * RETENTION ARCHIVE (owner decision 2026-10-14) — Archived evidence.
 *
 * A record that has left the 90-day Trash while a retention barrier (storage
 * retention on a required object version, application retention, a legal
 * hold) still prevents final purge. It is never "permanently deleted" while
 * here, and it comes back only through the verified archive restore: the
 * worker checks every required stored version and digest before the record
 * becomes active again, with the same Evidence ID and the same artifacts.
 */
import { apiFetch } from "../api";

export type RetentionArchiveItem = {
  id: string;
  title: string | null;
  verificationReference: string | null;
  archivedAtUtc: string | null;
  reason: "RETENTION";
  retentionBarrier: string | null;
  earliestPurgeAtUtc: string | null;
  /** null = not visible to this caller, or could not be confirmed (never "no hold"). */
  legalHold: boolean | null;
  restore: {
    available: boolean;
    inProgress: boolean;
    lastRequest: { status: string; failureCode: string | null; requestedAtUtc: string | null } | null;
  };
};

export type RetentionArchivePage = { items: RetentionArchiveItem[]; nextCursor: string | null };

export function listRetentionArchive(cursor?: string | null): Promise<RetentionArchivePage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch(`/v1/evidence/retention-archive${qs}`) as Promise<RetentionArchivePage>;
}

export type ArchiveRestoreRequestView = {
  id: string;
  status: "REQUESTED" | "RUNNING" | "COMPLETED" | "FAILED" | string;
  failureCode: string | null;
  requestedAtUtc: string | null;
  completedAtUtc: string | null;
  failedAtUtc: string | null;
};

export function requestArchiveRestore(
  evidenceId: string,
  clientRequestKey: string,
): Promise<{ request: { id: string; status: string }; deduplicated: boolean }> {
  return apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/archive-restore`, {
    method: "POST",
    body: JSON.stringify({ clientRequestKey }),
  }) as Promise<{ request: { id: string; status: string }; deduplicated: boolean }>;
}

export function getArchiveRestoreStatus(evidenceId: string): Promise<{ request: ArchiveRestoreRequestView | null }> {
  return apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/archive-restore`) as Promise<{
    request: ArchiveRestoreRequestView | null;
  }>;
}

/** Words for a retention barrier the API names. */
export const RETENTION_BARRIER_LABEL: Readonly<Record<string, string>> = {
  OBJECT_RETENTION: "Storage retention period",
  APP_RETENTION: "Workspace retention policy",
  LEGAL_HOLD: "Legal hold",
  EVIDENCE_LOCKED: "Record lock",
  METADATA_MISSING: "Retention being verified",
  METADATA_INCONSISTENT: "Retention being verified",
  STORAGE_UNAVAILABLE: "Retention being verified",
  CLEAR: "Awaiting final review",
};

/** Words for a restore failure the API names. */
export const ARCHIVE_RESTORE_FAILURE_LABEL: Readonly<Record<string, string>> = {
  OBJECT_VERSION_MISSING: "A stored version of the evidence is missing.",
  DIGEST_MISMATCH: "Stored bytes did not match the recorded digest.",
  ARTIFACT_MISSING: "A report or package file is missing.",
  ARTIFACT_DIGEST_MISMATCH: "A report or package file did not match its recorded digest.",
  SIGNATURE_REFERENCE_MISSING: "The record's signing references are incomplete.",
  CUSTODY_CHAIN_INVALID: "The record's custody history did not verify.",
  STORAGE_UNAVAILABLE: "Storage did not answer. You can request the restore again.",
  STATE_CHANGED: "The record changed while the restore was running.",
};
