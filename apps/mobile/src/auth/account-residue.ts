/**
 * WHAT A SESSION LEAVES ON THE DEVICE, removed when it ends (MOBILE-011).
 *
 * Capture records are kept per user by their own stores. These are the rest: what
 * the person searched for, where a link was taking them, and any export still
 * waiting in the temporary folder. A second person on the same phone sees none of
 * it. Every step is best effort, because sign-out must never fail on a cleanup.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { clearPendingRoute } from "../deep-link/pending-intent";
import { clearExportFiles } from "../lib/share-file";
import { SEARCH_RECENT_KEY_SUFFIX } from "../product/search";

async function clearRecentSearches(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  await AsyncStorage.multiRemove(keys.filter((k) => k.endsWith(SEARCH_RECENT_KEY_SUFFIX)));
}

export function clearAccountResidue(): void {
  clearPendingRoute();
  void clearRecentSearches().catch(() => undefined);
  void clearExportFiles().catch(() => undefined);
}
