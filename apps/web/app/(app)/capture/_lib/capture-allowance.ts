/**
 * F-12 (Free-user audit 2026-11-13) — what the account's own billing
 * projection already says about the NEXT record, said on Capture before any
 * upload instead of after "Sign and finalize".
 *
 * Source: GET /v1/billing/accounts/PERSONAL/:id — `evidenceAdmission.next` is
 * computed by the same pure admission policy the creation gate runs, and
 * `usage.storage` is the same measurement the storage gate uses. This module
 * decides nothing: it turns those facts into notices. The server stays the
 * authority on actual bytes at create, presign and seal; a notice never
 * disables Finish & Sign (a draft resuming its own reserved record, for one,
 * needs no new slot).
 */
import { formatFileSize } from "./file-utils";

export type CaptureAllowanceFacts = {
  /** False when the projection says the next record would be refused. */
  nextRecordAllowed: boolean;
  /** The enforced lifetime cap, when the plan has one. */
  recordCap: number | null;
  /** MEASURED storage meter, in bytes; null when unavailable. */
  storageUsedBytes: number | null;
  storageLimitBytes: number | null;
};

export type CaptureAllowanceNotice = {
  code: "capture_records_exhausted" | "capture_storage_insufficient";
  title: string;
  detail: string;
};

type ProjectionLike = {
  evidenceAdmission?: {
    effectiveLifetimeCap?: number | null;
    next?: { allowed?: boolean } | null;
  } | null;
  usage?: {
    storage?: { state?: string; usedBytes?: string; limitBytes?: string } | null;
  } | null;
};

const toBytes = (raw: unknown): number | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Facts from the PERSONAL account projection; null when it states none. */
export function allowanceFactsFromProjection(projection: ProjectionLike | null | undefined): CaptureAllowanceFacts | null {
  if (!projection) return null;
  const admission = projection.evidenceAdmission ?? null;
  const storage = projection.usage?.storage ?? null;
  const measured = storage?.state === "MEASURED";
  const facts: CaptureAllowanceFacts = {
    nextRecordAllowed: admission?.next?.allowed !== false,
    recordCap: typeof admission?.effectiveLifetimeCap === "number" ? admission.effectiveLifetimeCap : null,
    storageUsedBytes: measured ? toBytes(storage?.usedBytes) : null,
    storageLimitBytes: measured ? toBytes(storage?.limitBytes) : null,
  };
  return facts;
}

/** The notices Capture shows for these facts and the currently staged bytes. */
export function captureAllowanceNotices(
  facts: CaptureAllowanceFacts | null,
  stagedBytes: number,
): CaptureAllowanceNotice[] {
  if (!facts) return [];
  const notices: CaptureAllowanceNotice[] = [];
  if (!facts.nextRecordAllowed) {
    notices.push({
      code: "capture_records_exhausted",
      title: "No record left on your plan",
      detail: `${
        facts.recordCap !== null
          ? `All ${facts.recordCap} records your plan includes are in use`
          : "Your plan's records are in use"
      }, so Finish & Sign cannot start a new record until you add an evidence credit or upgrade. An upload that was started but never finished holds a record until it is finished, discarded, or 24 hours after it was last touched. Your staged materials stay on this page.`,
    });
  }
  if (facts.storageUsedBytes !== null && facts.storageLimitBytes !== null && stagedBytes > 0) {
    const remaining = Math.max(0, facts.storageLimitBytes - facts.storageUsedBytes);
    if (stagedBytes > remaining) {
      notices.push({
        code: "capture_storage_insufficient",
        title: "Not enough storage for these materials",
        detail: `The staged materials total ${formatFileSize(stagedBytes)} and ${formatFileSize(remaining)} of storage is left, so Finish & Sign would be refused after the upload. Remove materials or add storage first. Your staged materials stay on this page.`,
      });
    }
  }
  return notices;
}
