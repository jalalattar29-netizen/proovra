/**
 * ONE OWNER PER INCOMING LINK (Free audit F-13).
 *
 * expo-router handles every incoming URL itself (it subscribes to Linking and
 * navigates to the path), and `DeepLinkGate` handles the same URL too — it
 * parses the closed link shapes, defers behind sign-in, asks the server to
 * authorize evidence/case links, and blocks during an active capture. Both
 * acting on one link meant:
 *   - a link whose path has a route file (/invite/<t>, /reset-password,
 *     proovra://step-up/complete, /sso/complete) was opened TWICE;
 *   - a link whose path has no route file (/auth/verify-email, /cases/<id>,
 *     /org-invites/<t>/accept, the passkey return) left "+not-found" under
 *     the screen the gate opened;
 *   - an evidence/case link could be opened by the router BEFORE the server
 *     resolve and the capture-busy guard the gate exists for.
 *
 * `app/+native-intent.ts` asks this module: a link the gate routes is taken
 * away from the router (it stays on the current screen, or the boot screen on
 * a cold start); every other link — /verify/<id> among them — is left to the
 * router exactly as before.
 */
import { isSignInPasskeyReturn } from "../auth/auth-api";
import { ssoReturnRoute } from "../auth/sso-native";
import { stepUpReturnRoute } from "../product/challenge-step-up";
import {
  parseCanonicalMobileDeepLink,
  parseCredentialDeepLink,
  parseExternalFlowDeepLink,
  parsePublicDocumentDeepLink,
  workspacePageDeepLink,
} from "../deep-link";

/** PURE — true when DeepLinkGate routes this URL (the router must not). */
export function deepLinkGateOwns(url: string): boolean {
  if (!url) return false;
  return Boolean(
    isSignInPasskeyReturn(url) ||
      stepUpReturnRoute(url) ||
      ssoReturnRoute(url) ||
      parseCredentialDeepLink(url) ||
      parsePublicDocumentDeepLink(url) ||
      parseExternalFlowDeepLink(url) ||
      workspacePageDeepLink(url) ||
      parseCanonicalMobileDeepLink(url),
  );
}

/**
 * PURE — what expo-router should do with an incoming URL: the path unchanged
 * when it owns the link; otherwise nothing ("" — the router ignores an empty
 * URL) on a warm start, and the root (the boot screen) on a cold start, from
 * where the gate opens the link.
 */
export function routerPathForIncomingLink(path: string, initial: boolean): string {
  try {
    if (deepLinkGateOwns(path)) return initial ? "/" : "";
  } catch {
    // A parser that throws must not take the link from the router.
  }
  return path;
}
