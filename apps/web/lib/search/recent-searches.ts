/**
 * Recent searches on this device: ONE authority for reading, writing and
 * forgetting them (PRO-074).
 *
 * They are a "preferences" item under the cookie policy. Without that
 * consent nothing is written to the device, and anything already there is
 * removed on the next read; withdrawing consent purges them through
 * `clearNonEssentialStorage`, which matches this key in the tenant namespace.
 *
 * Key: `proovra:tenant:<workspaceId>:search:recent` (tenantStorageKey). The
 * pre-canonical `proovra:search:recent:<workspaceId>` is migrated once on a
 * consented read and otherwise deleted.
 */
import { hasPreferencesConsent } from "../consent";
import { tenantStorageKey } from "../platform-context/tenantStorage";

export const RECENT_SEARCHES_LIMIT = 10;

export function recentSearchesKey(workspaceId: string | null): string {
  return tenantStorageKey(workspaceId, "search:recent");
}

function legacyKey(workspaceId: string | null): string {
  return `proovra:search:recent:${workspaceId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored list, or [] — and without consent, removes what is stored. */
export function readRecentSearches(workspaceId: string | null): string[] {
  const store = storage();
  if (!store) return [];
  const key = recentSearchesKey(workspaceId);
  const legacy = legacyKey(workspaceId);
  try {
    if (!hasPreferencesConsent()) {
      store.removeItem(key);
      store.removeItem(legacy);
      return [];
    }
    let raw = store.getItem(key);
    if (raw === null) {
      const old = store.getItem(legacy);
      if (old !== null) {
        store.setItem(key, old);
        raw = old;
      }
    }
    store.removeItem(legacy);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === "string")) {
      return parsed.slice(0, RECENT_SEARCHES_LIMIT);
    }
  } catch {
    /* storage disabled or a malformed value: no recents */
  }
  return [];
}

/**
 * Store the list, only with "preferences" consent. Writing the empty array
 * (rather than removing the key) keeps "the reader emptied this list"
 * distinguishable from "this browser has no list yet".
 */
export function writeRecentSearches(workspaceId: string | null, list: ReadonlyArray<string>): boolean {
  const store = storage();
  if (!store || !hasPreferencesConsent()) return false;
  try {
    store.setItem(recentSearchesKey(workspaceId), JSON.stringify(list.slice(0, RECENT_SEARCHES_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

/** Forget every recent search for the workspace. Needs no consent. */
export function clearRecentSearches(workspaceId: string | null): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(recentSearchesKey(workspaceId));
    store.removeItem(legacyKey(workspaceId));
  } catch {
    /* non-fatal */
  }
}
