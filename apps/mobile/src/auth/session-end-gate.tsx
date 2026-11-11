/**
 * Leaves the signed-in shell the moment the session ends (MOBILE-008).
 *
 * Mounted once at the root, inside the router. Nothing on screen may outlive the
 * session, so the stack is dismissed before the sign-in screen replaces it. The
 * reason is shown there.
 */
import { useEffect } from "react";
import { useRouter, useSegments } from "expo-router";

import { useAuth } from "../auth-context";
import { stopCaptureOnSessionEnd } from "../capture/capture-teardown";
import { routeNeedsSession } from "./route-access";

export function SessionEndGate() {
  const { sessionEndReason } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!sessionEndReason) return;
    void stopCaptureOnSessionEnd();
    if (router.canDismiss()) router.dismissAll();
    router.replace("/(stack)/auth");
  }, [sessionEndReason, router]);

  return null;
}

/**
 * AUD-0034 — a screen that needs a session is never shown without one.
 *
 * Once the stored session has been read (`authReady`) and there is none, any
 * route outside the public list (`route-access.ts`) is replaced by sign-in —
 * the rule the tabs already applied, now for every screen, however it was
 * reached (deep link, restored state, in-app link).
 */
export function SignedOutRouteGate() {
  const { authReady, token } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const blocked = authReady && !token && routeNeedsSession(segments);

  useEffect(() => {
    if (blocked) router.replace("/(stack)/auth");
  }, [blocked, router]);

  return null;
}
