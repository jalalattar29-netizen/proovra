/**
 * UC-AND-003 — THE runtime request for Android 13+'s notification permission,
 * before either screen-capture foreground service starts.
 *
 * `POST_NOTIFICATIONS` was only DECLARED (the screen-capture module's
 * AndroidManifest.xml). On Android 13+ (API 33) it is a runtime permission that
 * is OFF on a fresh install and PROOVRA never asked for it, so the foreground
 * service ran with its notification suppressed — and that notification carries
 * the ONLY controls that work while the user is in another app: "Capture Frame"
 * (UC-2's cross-app capture) and "Stop" (UC-3's out-of-app stop).
 *
 * Below API 33 the permission does not exist at runtime: "not_required". A
 * refusal is returned, never thrown: the screen explains what the user loses
 * and lets them decide (see `NOTIFICATION_DENIED_COPY`).
 */
import { PermissionsAndroid, Platform } from "react-native";

export type CaptureNotificationPermission = "granted" | "denied" | "not_required";

export const POST_NOTIFICATIONS_PERMISSION = "android.permission.POST_NOTIFICATIONS" as const;
/** Android 13 (TIRAMISU): the first API level with the runtime permission. */
export const POST_NOTIFICATIONS_MIN_API = 33;

export async function ensureCaptureNotificationPermission(): Promise<CaptureNotificationPermission> {
  if (Platform.OS !== "android") return "not_required";
  const api = typeof Platform.Version === "number" ? Platform.Version : Number(Platform.Version);
  if (!Number.isFinite(api) || api < POST_NOTIFICATIONS_MIN_API) return "not_required";
  try {
    const permission = (PermissionsAndroid.PERMISSIONS as Record<string, string | undefined>)
      .POST_NOTIFICATIONS ?? POST_NOTIFICATIONS_PERMISSION;
    if (await PermissionsAndroid.check(permission as never)) return "granted";
    const result = await PermissionsAndroid.request(permission as never);
    return result === PermissionsAndroid.RESULTS.GRANTED ? "granted" : "denied";
  } catch {
    // A request that could not be made is treated as not granted: the screen
    // then discloses the consequence instead of assuming the controls exist.
    return "denied";
  }
}

/** What the user loses without the notification, per capture kind. */
export const NOTIFICATION_DENIED_COPY = {
  frames:
    "Notifications are off for PROOVRA, so Android will not show the capture notification. Its Capture Frame and Stop buttons are the only way to capture another app's screen: without them PROOVRA can only capture its own screen. Turn notifications on for PROOVRA in Android Settings to capture other apps.",
  continuous:
    "Notifications are off for PROOVRA, so Android will not show the recording notification or its Stop button. The recording still runs: you will have to return to PROOVRA to stop it. Turn notifications on for PROOVRA in Android Settings to stop from the notification.",
} as const;
