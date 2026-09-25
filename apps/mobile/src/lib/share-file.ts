/**
 * SHARE A FILE — the one path for handing an exported file to the device.
 *
 * React Native's Share.share({ url }) shares the file only on iOS; on Android
 * `url` is ignored and the sheet received the file NAME as text (case export,
 * batch CSV, library CSV). expo-sharing hands the real file to either
 * platform's share sheet, with its type so the receiving app can open it.
 */
import * as Sharing from "expo-sharing";

export class ShareUnavailableError extends Error {
  constructor() {
    super("Sharing files is not available on this device.");
    this.name = "ShareUnavailableError";
  }
}

export async function shareFile(
  uri: string,
  opts: { mimeType: string; dialogTitle?: string; uti?: string },
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new ShareUnavailableError();
  await Sharing.shareAsync(uri, { mimeType: opts.mimeType, dialogTitle: opts.dialogTitle, UTI: opts.uti });
}
