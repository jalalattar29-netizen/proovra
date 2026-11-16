/**
 * B5B-F-506 — copy feedback reflects the outcome.
 *
 * The verify page called `navigator.clipboard.writeText(value)` without
 * awaiting it and toasted success at once, so a denied clipboard (permission,
 * an insecure context, an embedded frame) still said "copied". The write is
 * awaited now; a refusal says so.
 */
export type CopyToast = (message: string, tone: "success" | "error") => void;

export const COPY_FAILED_MESSAGE = "Could not copy. Select the text and copy it manually.";

export async function copyWithFeedback(value: string, toast: CopyToast, successMessage: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("clipboard unavailable");
    await clipboard.writeText(value);
    toast(successMessage, "success");
    return true;
  } catch {
    toast(COPY_FAILED_MESSAGE, "error");
    return false;
  }
}
