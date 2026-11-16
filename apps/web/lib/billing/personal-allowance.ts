"use client";

/**
 * The viewer's OWN plan allowance — records and storage — for the shell meter
 * and Home (Free-user audit 0ea0: B2A-F-02, B2A-F-03).
 *
 * Source: the PERSONAL billing account projection
 * (`GET /v1/billing/accounts/PERSONAL/:id`), the same read Capture already
 * makes before a seal (`app/(app)/capture/_hooks/useCaptureAllowance.ts`).
 * `evidenceAdmission` is computed by the pure admission policy the creation
 * gate runs, and `usage.storage` by the measurement the storage gate uses, with
 * the server's own `formatBytesHuman` labels ("250 MB" — the Pricing unit).
 * Nothing here is derived from a plan name.
 *
 * Only meaningful in the viewer's own Personal Space; callers check that with
 * `isOwnPersonalActiveSpace` first.
 */
import { inFlightGet } from "../inFlightGet";
import { listBillingAccounts, readBillingAccount, type BillingAccountProjection } from "../api/billing-accounts";

export type RecordAllowance = {
  /** Records holding a plan slot (Trash included). */
  held: number;
  /** The enforced lifetime cap; null when the plan has none. */
  cap: number | null;
  /** False when the server's admission policy refuses the next record. */
  nextAllowed: boolean;
  /** Evidence credits that would fund the next record. */
  creditsAvailable: number;
};

export type PersonalStorageMeter = {
  usedLabel: string;
  limitLabel: string;
  usagePercent: number;
  nearLimit: boolean;
  limitReached: boolean;
};

export type PersonalAllowance = {
  records: RecordAllowance | null;
  storage: PersonalStorageMeter | null;
};

export function allowanceFromProjection(
  projection: Pick<BillingAccountProjection, "evidenceAdmission" | "usage"> | null | undefined,
): PersonalAllowance | null {
  if (!projection) return null;
  const admission = projection.evidenceAdmission ?? null;
  const records: RecordAllowance | null =
    admission && typeof admission.recordsHeld === "number"
      ? {
          held: admission.recordsHeld,
          cap: typeof admission.effectiveLifetimeCap === "number" ? admission.effectiveLifetimeCap : null,
          nextAllowed: admission.next?.allowed !== false,
          creditsAvailable: typeof admission.creditsAvailable === "number" ? admission.creditsAvailable : 0,
        }
      : null;
  const s = projection.usage?.storage ?? null;
  const storage: PersonalStorageMeter | null =
    s && s.state === "MEASURED" && typeof s.usedLabel === "string" && typeof s.limitLabel === "string"
      ? {
          usedLabel: s.usedLabel,
          limitLabel: s.limitLabel,
          usagePercent: Number.isFinite(s.usagePercent) ? Math.min(100, Math.max(0, s.usagePercent)) : 0,
          nearLimit: s.nearLimit === true,
          limitReached: s.limitReached === true,
        }
      : null;
  return { records, storage };
}

/**
 * One read of the PERSONAL account projection. Concurrent callers (the shell
 * meter and Home mount together) share the request in flight; nothing is
 * cached after it settles.
 */
export function readPersonalAllowance(): Promise<PersonalAllowance | null> {
  return inFlightGet("personal-allowance", async () => {
    const accounts = await inFlightGet("/v1/billing/accounts", () => listBillingAccounts());
    const personal = accounts.find((a) => a.type === "PERSONAL");
    if (!personal) return null;
    const projection = await readBillingAccount({ type: "PERSONAL", id: personal.id });
    return allowanceFromProjection(projection);
  });
}

/** "2 of 3 records" — only when the plan has a lifetime cap. */
export function recordAllowanceLabel(records: RecordAllowance | null): string | null {
  if (!records || records.cap === null) return null;
  return `${records.held} of ${records.cap} record${records.cap === 1 ? "" : "s"}`;
}

/**
 * Signalled when this tab changed what the meters measure (a record sealed or
 * discarded), so the shell meter re-reads instead of waiting for a reload.
 */
export const USAGE_CHANGED_EVENT = "proovra:usage-changed";

export function notifyUsageChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(USAGE_CHANGED_EVENT));
  } catch {
    /* presentation signal only */
  }
}
