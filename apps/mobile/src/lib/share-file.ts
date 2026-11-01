/**
 * SHARE A FILE — the one path for handing an exported file to the device.
 *
 * React Native's Share.share({ url }) shares the file only on iOS; on Android
 * `url` is ignored and the sheet received the file NAME as text (case export,
 * batch CSV, library CSV). expo-sharing hands the real file to either
 * platform's share sheet, with its type so the receiving app can open it.
 */
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

export class ShareUnavailableError extends Error {
  constructor() {
    super("Sharing files is not available on this device.");
    this.name = "ShareUnavailableError";
  }
}

/**
 * Where an export waits for the share sheet. One folder, so the whole of it can
 * go at sign-out: the receiving app may still be reading the file when the sheet
 * closes, so it cannot be deleted then, and a case archive or an audit export
 * must not stay behind for the next person on this device (MOBILE-011).
 */
const EXPORT_FOLDER = "proovra-exports/";

function exportFolder(): string | null {
  return FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}${EXPORT_FOLDER}` : null;
}

/** A path for an export, or null when the device has no temporary directory. */
export async function exportFileUri(filename: string): Promise<string | null> {
  const folder = exportFolder();
  if (!folder) return null;
  await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
  return `${folder}${filename}`;
}

export async function clearExportFiles(): Promise<void> {
  const folder = exportFolder();
  if (folder) await FileSystem.deleteAsync(folder, { idempotent: true });
}

export async function shareFile(
  uri: string,
  opts: { mimeType: string; dialogTitle?: string; uti?: string },
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new ShareUnavailableError();
  await Sharing.shareAsync(uri, { mimeType: opts.mimeType, dialogTitle: opts.dialogTitle, UTI: opts.uti });
}
