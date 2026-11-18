/**
 * B8-F-402 (free-audit 0ea0) — IS THIS EXTENSION BUILD STILL ONE THE API SERVES?
 *
 * Every API response carries `x-proovra-contract` (the presentation contract
 * it serves, AUD-32) and now `x-proovra-min-client-contract` (the oldest
 * client contract it still serves correctly). A store-installed extension can
 * lag the API for weeks; when the API has moved past what this build was
 * written for, the popup asks the person to update instead of silently
 * interpreting responses.
 *
 *   below the minimum             → UPDATE_REQUIRED
 *   API on a newer contract       → UPDATE_AVAILABLE
 *   equal / client newer / absent → nothing
 *
 * NEVER blocks a capture and never notices on an ABSENT or malformed header
 * (an older API sends neither new header). Mirrors `@proovra/shared`
 * release-contract `clientBelowMinimumContract`, which this build's shared
 * package may predate. PURE except the tiny last-verdict store.
 */
import { PRESENTATION_CONTRACT_VERSION, presentationContractSkew } from "@proovra/shared";

export const CLIENT_CONTRACT_HEADER = "x-proovra-contract";
export const CLIENT_MIN_CONTRACT_HEADER = "x-proovra-min-client-contract";
export const CLIENT_ROUTE_EPOCH_HEADER = "x-proovra-route-epoch";
/** chrome.storage.local key the background writes and the popup reads. */
export const CLIENT_UPDATE_STORAGE_KEY = "proovra.clientUpdateNotice";

export type ClientUpdateNotice = "UPDATE_REQUIRED" | "UPDATE_AVAILABLE";

function positiveInteger(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function clientBelowMinimumContract(servedMinimum: string | null | undefined, own: number = PRESENTATION_CONTRACT_VERSION): boolean {
  const n = positiveInteger(servedMinimum);
  return n !== null && own < n;
}

/** The notice one response's headers call for, or null. */
export function clientUpdateVerdict(
  headers: { get(name: string): string | null } | null | undefined,
  own: number = PRESENTATION_CONTRACT_VERSION,
): ClientUpdateNotice | null {
  if (!headers || typeof headers.get !== "function") return null;
  if (clientBelowMinimumContract(headers.get(CLIENT_MIN_CONTRACT_HEADER), own)) return "UPDATE_REQUIRED";
  if (presentationContractSkew(headers.get(CLIENT_CONTRACT_HEADER), own) === "CLIENT_OLDER") return "UPDATE_AVAILABLE";
  return null;
}

export const CLIENT_UPDATE_COPY: Readonly<Record<ClientUpdateNotice, string>> = {
  UPDATE_REQUIRED:
    "Update required: this version of the PROOVRA extension is older than the service now supports. Update it from your browser's extension store.",
  UPDATE_AVAILABLE: "Please update: a newer PROOVRA extension is available for this service.",
};

/** Only escalates (available → required); a later response without headers clears nothing. */
export function escalateClientUpdate(
  current: ClientUpdateNotice | null,
  next: ClientUpdateNotice | null,
): ClientUpdateNotice | null {
  if (next === null || current === "UPDATE_REQUIRED") return current;
  return next;
}

/**
 * PRO-X1-07 — the stored verdict is tied to the build that earned it. An entry
 * written by another build (or an old bare string) is foreign: updating the
 * extension must not keep showing "Update required" forever.
 */
export type StoredClientUpdate = { notice: ClientUpdateNotice; own: number; ext: string };

export function storedClientUpdate(notice: ClientUpdateNotice, ext: string, own: number = PRESENTATION_CONTRACT_VERSION): StoredClientUpdate {
  return { notice, own, ext };
}

export function parseStoredClientUpdate(
  v: unknown,
  ext?: string,
  own: number = PRESENTATION_CONTRACT_VERSION,
): ClientUpdateNotice | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<StoredClientUpdate>;
  if (s.notice !== "UPDATE_REQUIRED" && s.notice !== "UPDATE_AVAILABLE") return null;
  if (s.own !== own) return null;
  if (ext !== undefined && s.ext !== ext) return null;
  return s.notice;
}

/** PRO-X1-07 — a response that names its contract and calls for nothing: this build is current. */
export function headersSayCurrent(
  headers: { get(name: string): string | null } | null | undefined,
  own: number = PRESENTATION_CONTRACT_VERSION,
): boolean {
  if (!headers || typeof headers.get !== "function") return false;
  if (positiveInteger(headers.get(CLIENT_CONTRACT_HEADER)) === null) return false;
  return clientUpdateVerdict(headers, own) === null;
}
