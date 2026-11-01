/**
 * Leaves the signed-in shell the moment the session ends (MOBILE-008).
 *
 * Mounted once at the root, inside the router. Nothing on screen may outlive the
 * session, so the stack is dismissed before the sign-in screen replaces it. The
 * reason is shown there.
 */
import { useEffect } from "react";
import { useRouter } from "expo-router";

import { useAuth } from "../auth-context";

export function SessionEndGate() {
  const { sessionEndReason } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!sessionEndReason) return;
    if (router.canDismiss()) router.dismissAll();
    router.replace("/(stack)/auth");
  }, [sessionEndReason, router]);

  return null;
}
