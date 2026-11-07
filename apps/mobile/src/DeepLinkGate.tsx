/**
 * PHASE 11 §5 — the REAL mobile universal/deep-link consumer.
 *
 * Mounted once at the app root. Listens for incoming universal/app links and
 * routes them through the canonical client authority (`resolveMobileDeepLink`),
 * which parses ONLY the closed link shape, blocks unsafe transitions during
 * active capture/upload, and asks the SERVER (POST /v1/deep-link/resolve) to
 * authorize + re-derive the workspace before any navigation. Unsupported links
 * are ignored; denials show one generic toast (anti-enumeration preserved).
 */

import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";

import { apiFetch, getAuthToken } from "./api";
import { useAuth } from "./auth-context";
import { isCaptureActive } from "./capture/active-capture";
import {
  parseCanonicalMobileDeepLink,
  parseCredentialDeepLink,
  parsePublicDocumentDeepLink,
  parseExternalFlowDeepLink,
  resolveMobileDeepLink,
  workspacePageDeepLink,
} from "./deep-link";
import { stepUpReturnRoute } from "./product/challenge-step-up";
import { isSignInPasskeyReturn } from "./auth/auth-api";
import { ssoReturnRoute } from "./auth/sso-native";
import { setPendingRoute, hydratePendingRoute } from "./deep-link/pending-intent";

function hasActiveWork(): boolean {
  try {
    // Canonical: a live direct-capture / screen-capture session in progress.
    // (The legacy SQLite upload-queue is dead — nothing enqueues it — so it is
    // no longer consulted here; see src/capture/active-capture.ts.)
    return isCaptureActive();
  } catch {
    // Fail SAFE: treat as busy so a link can never force a context change past
    // an unknown capture state.
    return true;
  }
}

export function DeepLinkGate() {
  const url = Linking.useURL();
  const router = useRouter();
  const { authReady } = useAuth();
  // The effect runs again when the session has been restored. A link is acted on once.
  const handled = useRef<string | null>(null);

  // M7 — rehydrate a pending deep-link intent that survived a process death
  // during the auth journey (once, on mount). Stale/absent → no-op.
  useEffect(() => {
    void hydratePendingRoute();
  }, []);

  useEffect(() => {
    if (!url || handled.current === url) return;
    let disposed = false;

    // CREDENTIAL LINKS FIRST — email verification, password reset and
    // invitations are handed to a user who has no session and address no tenant
    // resource, so they must not pass through the server resolve gate. They are
    // checked before the session branch because they are valid precisely WHEN
    // there is no session. The token stays opaque; the destination screen proves
    // it with its own API call, exactly as the Web routes do.
    // The step-up handoff's return (proovra://step-up/complete) carries nothing
    // to resolve: the verdict is read from the server by the open dialog.
    // A sign-in passkey's return carries nothing either: the open MFA screen
    // asks the server whether the passkey was proved. Delivered as an ordinary
    // link, it must not fall through to the tenant resolve gate.
    if (isSignInPasskeyReturn(url)) {
      handled.current = url;
      return;
    }
    const stepUpReturn = stepUpReturnRoute(url);
    if (stepUpReturn) {
      handled.current = url;
      router.push(stepUpReturn as never);
      return;
    }
    // MOBILE-002 — an Organization single sign-on's return. Its code is worthless
    // without the verifier this app holds; the landing redeems it once.
    const ssoReturn = ssoReturnRoute(url);
    if (ssoReturn) {
      handled.current = url;
      router.push(ssoReturn as never);
      return;
    }

    const credential = parseCredentialDeepLink(url);
    if (credential) {
      handled.current = url;
      router.push(credential.route as never);
      return;
    }

    // PUBLIC DOCUMENTS — legal text addresses no tenant and needs no session.
    // Checked alongside credential links, and before the session branch, for
    // the same reason: a user asked to accept terms before signing in must be
    // able to read them, and deferring the link behind the auth gateway would
    // silently drop it.
    const document = parsePublicDocumentDeepLink(url);
    if (document) {
      handled.current = url;
      router.push(document.route as never);
      return;
    }

    // EXTERNAL FLOWS — intake and the reviewer portal. The reader has no
    // PROOVRA account, so these are handled here for the same reason legal
    // links are: deferring them behind the auth gateway would drop a link
    // belonging to somebody who will never sign in.
    const external = parseExternalFlowDeepLink(url);
    if (external) {
      handled.current = url;
      router.push(external.route as never);
      return;
    }

    // On a cold start the stored token is restored asynchronously. Until that has
    // finished, "no token" says nothing about whether this person is signed in.
    if (!authReady) return;
    handled.current = url;

    // Unauthenticated: preserve the intent and route to the gateway. The server
    // resolve requires a session, so we do not call it here; the destination is
    // replayed (and authorized by its own fetch) after the auth journey.
    const workspacePage = workspacePageDeepLink(url);
    if (!getAuthToken()) {
      const parsed = parseCanonicalMobileDeepLink(url);
      const route = parsed?.route ?? workspacePage;
      if (route) {
        setPendingRoute(route);
        router.replace("/(stack)/auth");
      }
      return;
    }
    if (workspacePage) {
      if (hasActiveWork()) {
        Alert.alert("Capture in progress", "Finish or pause the current capture before opening links.");
        return;
      }
      router.push(workspacePage as never);
      return;
    }

    void resolveMobileDeepLink(url, {
      resolve: (input) =>
        apiFetch("/v1/deep-link/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }) as Promise<{ ok?: boolean; workspaceId?: string } | null>,
      hasActiveWork,
    }).then((outcome) => {
      if (disposed) return;
      if (outcome.status === "navigate") {
        // The workspace came from the SERVER; the URL never carried tenant truth.
        router.push(outcome.route as never);
      } else if (outcome.status === "denied") {
        // Anti-enumeration: one generic message for every denial cause.
        Alert.alert("Not available", "This item is not available.");
      } else if (outcome.status === "blocked_busy") {
        Alert.alert(
          "Capture in progress",
          "Finish or pause the current capture before opening links.",
        );
      }
      // "unsupported" / "stale" → ignored safely, no navigation, no message.
    });
    return () => {
      disposed = true;
    };
  }, [url, router, authReady]);

  return null;
}
