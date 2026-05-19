/**
 * Phase 30.9 — Refresh / crash recovery scanner.
 *
 * On app boot, scans the persistence layer for unfinished upload
 * sessions and reconciles each with the server. Returns a bounded
 * RecoveryReport so the UI can render an explicit recovery panel
 * (no silent recovery — every restore is operator-visible).
 *
 * Hard rules:
 *   * NEVER auto-resumes uploads. Even if a session is clearly
 *     resumable, the UI surfaces an explicit "Resume" action.
 *   * NEVER silently deletes persisted sessions. A session reported
 *     by the server as FINALIZED or ABORTED gets `cleanupSafe: true`
 *     in the report so the UI can offer "clear from queue".
 *   * NEVER trusts the local snapshot — every classification is
 *     based on the server's response to GET /v1/uploads/sessions/:id.
 *   * Bounded vocabulary on `classification` — UI never sees raw
 *     server state strings.
 */

import { apiFetch } from "../api";
import type { UploadPersistence, PersistedUploadSession } from "./persistence";

export const RECOVERY_CLASSIFICATIONS = [
  /** Server confirms session is in INITIATED / UPLOADING — operator
   *  can hit "Resume" and the orchestrator will pick up where it
   *  left off. */
  "resumable",
  /** Server says session is in VERIFYING — uploads are done, the
   *  server is checking hashes. Operator should wait. */
  "verifying",
  /** Server confirms COMPLETED — the user just needs to finalize
   *  the evidence row. */
  "ready_for_finalization",
  /** Server says session is COMPLETED AND the evidence is finalized.
   *  Safe to clean from local queue. */
  "finalized",
  /** Server says session is EXPIRED. Cannot resume. Local state
   *  should be cleaned up + operator should re-stage the upload. */
  "expired",
  /** Server says session is ABORTED. Local state should be cleaned. */
  "aborted",
  /** Server says session is FAILED. Operator inspection required. */
  "failed",
  /** Server returns 404 — session never reached the server OR was
   *  cleaned up. Local state should be removed. */
  "not_found",
  /** Network / 5xx — we don't know. Try again later. */
  "unknown",
] as const;

export type RecoveryClassification =
  (typeof RECOVERY_CLASSIFICATIONS)[number];

export type RecoveryEntry = {
  sessionId: string;
  evidenceId: string;
  teamId: string;
  /** Classification driven by the server's reported state. */
  classification: RecoveryClassification;
  /** True ↔ the persistence row can be removed safely (no further
   *  client action). FINALIZED / ABORTED / EXPIRED / NOT_FOUND. */
  cleanupSafe: boolean;
  /** True ↔ the operator can press "Resume" to continue. */
  resumable: boolean;
  /** True ↔ the operator should be alerted to inspect / re-stage. */
  needsAttention: boolean;
  /** ms since epoch when this session was last touched by the
   *  orchestrator. Advisory only. */
  lastTouchedMsClient: number;
  /** File fingerprint so the UI can ask the operator to re-pick
   *  the file (browsers can't keep File references across reloads). */
  fileFingerprint: PersistedUploadSession["fileFingerprint"];
};

export type RecoveryReport = {
  ranAtMs: number;
  entries: ReadonlyArray<RecoveryEntry>;
  /** Aggregate count by classification for ops-panel headlines. */
  counts: Record<RecoveryClassification, number>;
};

/**
 * Scan + reconcile. The caller passes the persistence layer and
 * (optionally) a fetch overload — tests inject a stub.
 */
export async function runUploadRecovery(input: {
  persistence: UploadPersistence;
  /** Used by tests to inject a fake apiFetch. */
  fetcher?: typeof apiFetch;
}): Promise<RecoveryReport> {
  const fetcher = input.fetcher ?? apiFetch;
  const rows = await input.persistence.list();
  const counts: Record<RecoveryClassification, number> = {
    resumable: 0,
    verifying: 0,
    ready_for_finalization: 0,
    finalized: 0,
    expired: 0,
    aborted: 0,
    failed: 0,
    not_found: 0,
    unknown: 0,
  };
  const entries: RecoveryEntry[] = [];
  for (const row of rows) {
    const classification = await classifySession(row, fetcher);
    counts[classification] += 1;
    entries.push({
      sessionId: row.sessionId,
      evidenceId: row.evidenceId,
      teamId: row.teamId,
      classification,
      cleanupSafe:
        classification === "finalized" ||
        classification === "aborted" ||
        classification === "expired" ||
        classification === "not_found",
      resumable: classification === "resumable",
      needsAttention:
        classification === "failed" ||
        classification === "expired" ||
        classification === "aborted",
      lastTouchedMsClient: row.updatedAtMsClient,
      fileFingerprint: row.fileFingerprint,
    });
  }
  return {
    ranAtMs: Date.now(),
    entries,
    counts,
  };
}

async function classifySession(
  row: PersistedUploadSession,
  fetcher: typeof apiFetch,
): Promise<RecoveryClassification> {
  try {
    const res = (await fetcher(
      `/v1/uploads/sessions/${row.sessionId}/status?teamId=${encodeURIComponent(
        row.teamId,
      )}`,
      { method: "GET" },
    )) as { state?: string };
    return mapServerStateToClassification(res.state);
  } catch (err) {
    const status =
      (err as { statusCode?: number } | null | undefined)?.statusCode ?? 0;
    if (status === 404) return "not_found";
    return "unknown";
  }
}

function mapServerStateToClassification(
  state: string | undefined,
): RecoveryClassification {
  switch (state) {
    case "INITIATED":
    case "UPLOADING":
      return "resumable";
    case "VERIFYING":
      return "verifying";
    case "COMPLETED":
      return "ready_for_finalization";
    case "EXPIRED":
      return "expired";
    case "ABORTED":
      return "aborted";
    case "FAILED":
      return "failed";
    default:
      return "unknown";
  }
}
