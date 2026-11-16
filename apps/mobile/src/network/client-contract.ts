/**
 * B8-F-402 (free-audit 0ea0) — IS THIS APP BUILD STILL ONE THE API SERVES?
 *
 * Every API response carries `x-proovra-contract` (the presentation contract
 * it serves, AUD-32) and now `x-proovra-min-client-contract` (the oldest
 * client contract it still serves correctly) and `x-proovra-route-epoch`.
 * A store build can stay installed for months; when the API has moved past
 * what this build was written for, the person is told to update instead of
 * reading responses through rules that no longer describe them.
 *
 *   below the minimum            → UPDATE_REQUIRED ("update required")
 *   API on a newer contract      → UPDATE_AVAILABLE ("please update")
 *   equal / client newer / absent → nothing
 *
 * NEVER blocks and never notices on an ABSENT or malformed header: an older
 * API sends neither new header, and that must change nothing. The helpers
 * mirror `@proovra/shared` release-contract (`clientBelowMinimumContract`),
 * which this build's shared package may predate.
 */
import { PRESENTATION_CONTRACT_VERSION, presentationContractSkew } from "@proovra/shared";

export const CLIENT_CONTRACT_HEADER = "x-proovra-contract";
export const CLIENT_MIN_CONTRACT_HEADER = "x-proovra-min-client-contract";
export const CLIENT_ROUTE_EPOCH_HEADER = "x-proovra-route-epoch";

export type ClientUpdateNotice = "UPDATE_REQUIRED" | "UPDATE_AVAILABLE";

function positiveInteger(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** True only when the API states a minimum and this build is below it. Absent never blocks. */
export function clientBelowMinimumContract(servedMinimum: string | null | undefined, own: number = PRESENTATION_CONTRACT_VERSION): boolean {
  const n = positiveInteger(servedMinimum);
  return n !== null && own < n;
}

/** The notice a response's headers call for, or null. */
export function clientUpdateVerdict(
  headers: { contract?: string | null; minClient?: string | null },
  own: number = PRESENTATION_CONTRACT_VERSION,
): ClientUpdateNotice | null {
  if (clientBelowMinimumContract(headers.minClient, own)) return "UPDATE_REQUIRED";
  if (presentationContractSkew(headers.contract ?? null, own) === "CLIENT_OLDER") return "UPDATE_AVAILABLE";
  return null;
}

export const CLIENT_UPDATE_COPY: Readonly<Record<ClientUpdateNotice, { title: string; body: string }>> = {
  UPDATE_REQUIRED: {
    title: "Update required",
    body: "This version of the PROOVRA app is older than the service now supports. Update the app from your app store to keep working reliably.",
  },
  UPDATE_AVAILABLE: {
    title: "Please update",
    body: "A newer PROOVRA app is available for this service. Some screens may not show the latest information until you update.",
  },
};

/* --------------------------------------------------------------- the store */

let current: ClientUpdateNotice | null = null;
const listeners = new Set<() => void>();

/**
 * Read one response's headers. The notice only ESCALATES within a session
 * (available → required); a later response without the headers clears nothing.
 */
export function observeClientContractHeaders(get: (name: string) => string | null | undefined): void {
  let verdict: ClientUpdateNotice | null;
  try {
    verdict = clientUpdateVerdict({ contract: get(CLIENT_CONTRACT_HEADER), minClient: get(CLIENT_MIN_CONTRACT_HEADER) });
  } catch {
    return;
  }
  if (verdict === null || verdict === current || current === "UPDATE_REQUIRED") return;
  current = verdict;
  for (const l of listeners) l();
}

export function getClientUpdateNotice(): ClientUpdateNotice | null {
  return current;
}

export function subscribeClientUpdateNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only. */
export function resetClientUpdateNoticeForTests(): void {
  current = null;
  for (const l of listeners) l();
}
