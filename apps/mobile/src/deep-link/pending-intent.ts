/**
 * Pending deep-link intent (Phase 3; Native Convergence M7 — now durable).
 *
 * When an external link arrives while unauthenticated, its in-app destination is
 * stashed here and replayed after the auth → MFA → legal journey completes. The
 * destination screen still enforces authorization via its own authenticated fetch
 * (server remains the authority); this only preserves *where the user was going*.
 *
 * Durability: the route is ALSO persisted (AsyncStorage, short TTL) so it survives
 * a process death DURING the auth journey — a real case (open link → cold start →
 * auth → app killed → reopen). The synchronous in-memory API is unchanged; boot
 * calls hydratePendingRoute() once to rehydrate a fresh persisted route, and a
 * stale/expired one is dropped. A failed read/write never breaks auth.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

/**
 * PRO-NA-09 — the pending route can carry an invitation token
 * (/invite/<token>), so it is persisted in the platform keystore
 * (expo-secure-store, as the session and the SSO verifier are), not in plain
 * AsyncStorage. The former AsyncStorage key is only ever REMOVED (on hydrate
 * and on every clear), never read.
 */
const STORAGE_KEY = "proovra.pending-intent.v1";
const SECURE_KEY = "proovra.pending-intent.v2";
/** A persisted intent older than this is stale — the journey clearly ended. */
export const PENDING_INTENT_TTL_MS = 30 * 60 * 1000; // 30 min

let pending: string | null = null;
/**
 * PRO-NA-04 — the ORIGINAL link a signed-out person opened, kept beside its
 * route so the post-sign-in replay can resolve it on the server and switch to
 * the record's workspace (as a signed-in tap does) instead of opening the raw
 * route in whatever workspace is active. The stored blob gains an optional
 * `url`; an older blob without one still replays its route.
 */
let pendingUrl: string | null = null;

export function setPendingRoute(route: string, url?: string | null): void {
  pending = route;
  pendingUrl = url ?? null;
  void persist(route, pendingUrl);
}

async function persist(route: string, url: string | null = null): Promise<void> {
  try {
    await SecureStore.setItemAsync(SECURE_KEY, JSON.stringify({ route, ...(url ? { url } : {}), savedAtMs: Date.now() }));
  } catch {
    // Best-effort — the in-memory copy still serves the same-launch case.
  }
}

function clearPersisted(): void {
  void SecureStore.deleteItemAsync(SECURE_KEY).catch(() => {});
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

/** Pure freshness check (exported for tests). */
export function isFreshPendingIntent(savedAtMs: unknown, nowMs: number = Date.now()): boolean {
  return typeof savedAtMs === "number" && Number.isFinite(savedAtMs) && nowMs - savedAtMs <= PENDING_INTENT_TTL_MS;
}

/** Pure parse of a persisted blob → a fresh route, or null (exported for tests). */
export function parsePersistedIntent(raw: string | null, nowMs: number = Date.now()): string | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { route?: unknown; savedAtMs?: unknown };
    if (typeof obj.route !== "string" || !obj.route) return null;
    return isFreshPendingIntent(obj.savedAtMs, nowMs) ? obj.route : null;
  } catch {
    return null;
  }
}

/**
 * On boot, rehydrate a fresh persisted intent into memory (only when nothing is
 * already pending this launch). A stale/absent one is dropped. Call once at start.
 */
export async function hydratePendingRoute(): Promise<void> {
  // PRO-NA-09 — a plaintext copy written by an older build is dropped.
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  if (pending) return;
  try {
    const raw = await SecureStore.getItemAsync(SECURE_KEY);
    const route = parsePersistedIntent(raw);
    if (route) {
      pending = route;
      try {
        const url = (JSON.parse(raw as string) as { url?: unknown }).url;
        pendingUrl = typeof url === "string" && url ? url : null;
      } catch {
        pendingUrl = null;
      }
    } else clearPersisted();
  } catch {
    // ignore — nothing to rehydrate
  }
}

export function peekPendingRoute(): string | null {
  return pending;
}

/** Sign-out: where the last person was going is not where the next one is. */
export function clearPendingRoute(): void {
  pending = null;
  pendingUrl = null;
  clearPersisted();
}

/** Read and clear the pending route (one-shot) — clears memory AND storage. */
export function takePendingRoute(): string | null {
  const r = pending;
  pending = null;
  if (r) clearPersisted();
  return r;
}

/** PRO-NA-04 — read and clear the original link with its route (one-shot). */
export function takePendingIntent(): { route: string; url: string | null } | null {
  const url = pendingUrl;
  pendingUrl = null;
  const route = takePendingRoute();
  return route ? { route, url } : null;
}

/**
 * PRO-NA-04 — the sign-in legal gate resumes a waiting RECORD link: take its
 * original URL (and clear the intent) only when one is pending. A plain route
 * (an invitation, a tab) is left where it is.
 */
export function takePendingRecordLink(): string | null {
  if (!pendingUrl) return null;
  const url = pendingUrl;
  pendingUrl = null;
  takePendingRoute();
  return url;
}
