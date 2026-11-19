/**
 * PRO-NB-05 — CAPTURED MEDIA DO NOT OUTLIVE THEIR PURPOSE.
 *
 * The ordinary capture path wrote photos, clips, recordings and picked-file
 * copies into the app cache and never removed them: a sealed or discarded
 * capture's originals stayed on the device with no record pointing at them.
 * They are now deleted once their purpose is over — after the record SEALED
 * (the server holds the bytes), or after an explicit discard or removal by the
 * person. Never on sign-out, never on a failed Finish (DEC-24: the device copy
 * may be the only one), and only files inside this app's own cache.
 */
import * as FileSystem from "expo-file-system";

/** PURE — may this uri be deleted by the app (its own cache, never a picker's content:// source)? */
export function isAppCacheFile(uri: string | null | undefined, cacheDirectory: string | null | undefined): boolean {
  if (!uri || !cacheDirectory) return false;
  return uri.startsWith(cacheDirectory);
}

/** Delete the given capture files from the app cache; each failure is isolated. */
export async function deleteCaptureFiles(uris: ReadonlyArray<string | null | undefined>): Promise<void> {
  const cache = FileSystem.cacheDirectory;
  for (const uri of uris) {
    if (!isAppCacheFile(uri, cache)) continue;
    try {
      await FileSystem.deleteAsync(uri as string, { idempotent: true });
    } catch {
      // Best effort: the next sweep or the OS cache purge takes it.
    }
  }
}

/** A materialised picker copy older than this is no longer in use by an upload. */
const UPLOAD_COPY_MIN_AGE_MS = 60_000;

/**
 * The `proovra-upload-*` copies ensureFileUri makes of content:// picks are
 * used by an upload and then forgotten. Swept after a seal or discard.
 */
export async function sweepUploadCopies(nowMs: number = Date.now()): Promise<number> {
  const cache = FileSystem.cacheDirectory;
  if (!cache) return 0;
  let removed = 0;
  try {
    for (const name of await FileSystem.readDirectoryAsync(cache)) {
      if (!name.startsWith("proovra-upload-")) continue;
      const uri = `${cache}${name}`;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        const modified = info.exists && typeof (info as { modificationTime?: number }).modificationTime === "number"
          ? (info as { modificationTime: number }).modificationTime * 1000
          : 0;
        if (nowMs - modified < UPLOAD_COPY_MIN_AGE_MS) continue;
        await FileSystem.deleteAsync(uri, { idempotent: true });
        removed += 1;
      } catch {
        // isolated
      }
    }
  } catch {
    // no listing: nothing swept
  }
  return removed;
}
