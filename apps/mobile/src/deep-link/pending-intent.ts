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

const STORAGE_KEY = "proovra.pending-intent.v1";
/** A persisted intent older than this is stale — the journey clearly ended. */
export const PENDING_INTENT_TTL_MS = 30 * 60 * 1000; // 30 min

let pending: string | null = null;

export function setPendingRoute(route: string): void {
  pending = route;
  void persist(route);
}

async function persist(route: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ route, savedAtMs: Date.now() }));
  } catch {
    // Best-effort — the in-memory copy still serves the same-launch case.
  }
}

function clearPersisted(): void {
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
  if (pending) return;
  try {
    const route = parsePersistedIntent(await AsyncStorage.getItem(STORAGE_KEY));
    if (route) pending = route;
    else clearPersisted();
  } catch {
    // ignore — nothing to rehydrate
  }
}

export function peekPendingRoute(): string | null {
  return pending;
}

/** Read and clear the pending route (one-shot) — clears memory AND storage. */
export function takePendingRoute(): string | null {
  const r = pending;
  pending = null;
  if (r) clearPersisted();
  return r;
}
