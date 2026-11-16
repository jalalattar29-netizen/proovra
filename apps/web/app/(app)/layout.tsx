"use client";

import "../globals.css";

import { Fragment, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppShellV2 } from "../../components/app-shell-v2/AppShellV2";
import { ProovraChatWidget } from "../../components/ai/ProovraChatWidget";
import { useAuth } from "../providers";
import { PlatformContextProvider } from "../../lib/platform-context";
import { SignedOutAppGate } from "../../components/navigation/SignedOutAppState";
import { isInvitationAcceptPath } from "../../lib/navigation/invitation-path";
import { LegalAcceptanceStep } from "../../components/legal/LegalAcceptanceStep";
import {
  requestServerSignOut,
  signOutIncompleteMessage,
  SIGN_OUT_INCOMPLETE_TITLE,
  type ServerSignOutFailure,
} from "../../lib/auth/server-sign-out";

/**
 * Phase 32.8 Foundation — (app)/layout wraps every operator surface
 * with the canonical PlatformContextProvider. Every nested page reads
 * user, workspace, role, persona, capabilities, and navigation
 * exclusively from `usePlatformContext()`.
 *
 * IMPORTANT: This layout NO LONGER derives `isPlatformAdmin` from
 * `user.platformRole`. The canonical envelope's
 * `envelope.platform.isPlatformAdmin` is the single source of truth.
 * Components that previously received `isPlatformAdmin` as a prop now
 * read it from context.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const { authReady, hasSession, setToken, updateUser } = useAuth();

  // Phase scroll-perf — the body decorative effects (fixed gradient,
  // soft-light noise overlay, fixed radial overlays) live in globals.css
  // under `body.has-app-decor`. They cause scroll-jank when applied to
  // marketing routes because they trigger full-viewport repaints on
  // every scroll frame. Apply the class only while the (app) layout is
  // mounted so the dashboard keeps its texture but the marketing site
  // (which uses only the root layout) stays clean.
  useEffect(() => {
    document.body.classList.add("has-app-decor");
    // Cookie-banner scope — mark the authenticated app shell so the
    // public cookie consent banner + privacy launcher (rendered once in
    // the ROOT layout for marketing/external pages) are hidden on
    // internal pages. Layout-scoped via the (app) route group — no
    // fragile per-route pathname allowlist. Consent persistence and
    // analytics init are unaffected (the CMP still initialises globally;
    // only the visible banner/launcher are suppressed on internal pages).
    document.body.classList.add("is-internal-app");
    return () => {
      document.body.classList.remove("has-app-decor");
      document.body.classList.remove("is-internal-app");
    };
  }, []);

  const hideAiWidget = useMemo(() => {
    if (!pathname) return false;
    return (
      pathname.startsWith("/admin") ||
      pathname.startsWith("/verify") ||
      pathname.startsWith("/v/") ||
      pathname.startsWith("/share") ||
      pathname.startsWith("/intake") ||
      pathname.startsWith("/portal") ||
      pathname.startsWith("/auth")
    );
  }, [pathname]);

  /** B8-F-001 — set while a sign-out the server did not complete awaits a retry. */
  const [signOutFailure, setSignOutFailure] = useState<ServerSignOutFailure | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const handleLogout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    // B8-F-001 — the server must END the session (and clear the HttpOnly
    // `proovra_session` cookie). Its outcome is read, never assumed.
    const outcome = await requestServerSignOut();

    // Defensive cleanup of any legacy localStorage auth token. Safe either
    // way: it is not the session (the HttpOnly cookie is).
    try {
      localStorage.removeItem("proovra-token");
    } catch {
      // ignore
    }

    // PWA — nothing a session touched survives sign-out (the service worker
    // caches only the static shell, but it is cleared regardless).
    try {
      const { clearServiceWorkerCaches } = await import("../../lib/pwa/serviceWorkerClient");
      await clearServiceWorkerCaches();
    } catch {
      // best-effort
    }

    if (!outcome.ok) {
      // The session is still alive: say so and keep the person here, signed
      // in, with a retry — never "signed out" with a cookie that signs them
      // straight back in on the next load.
      setSignOutFailure(outcome.reason);
      setSigningOut(false);
      return;
    }

    setSignOutFailure(null);
    setSigningOut(false);
    setToken(null);
    updateUser(null);

    router.push("/login");
  };

  const signOutNotice = signOutFailure ? (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="signout-incomplete-title"
      aria-describedby="signout-incomplete-body"
      className="app-alert"
      data-tone="danger"
      data-signout-incomplete={signOutFailure}
      style={{ position: "fixed", insetInline: 16, bottom: 16, zIndex: 1000, maxWidth: 520, marginInline: "auto" }}
    >
      <strong id="signout-incomplete-title">{SIGN_OUT_INCOMPLETE_TITLE}</strong>
      <p id="signout-incomplete-body">{signOutIncompleteMessage(signOutFailure)}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="app-primary-action" onClick={() => void handleLogout()} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Retry sign-out"}
        </button>
        <button type="button" className="app-secondary-action" onClick={() => setSignOutFailure(null)} disabled={signingOut}>
          Stay signed in
        </button>
      </div>
    </div>
  ) : null;

  /*
   * THE PROVIDER MOUNTS WHILE AUTH IS STILL RESOLVING.
   *
   * This used to return the placeholder BEFORE `PlatformContextProvider`,
   * which meant the provider did not exist yet, which meant
   * `GET /v1/platform/context` could not begin until `GET /v1/users/me` had
   * come back. Every workspace-scoped read on the page then waited for the
   * context. Three levels, strictly one after another, for two requests that
   * ask the same server about the same session and do not depend on each
   * other's answer.
   *
   * Measured in Chrome against the local fixture: `/v1/users/me` occupied
   * 487-1121ms alone, `/v1/platform/context` ran 1167-1246ms, and the twelve
   * Home reads did not start until 1259ms.
   *
   * Nothing is shown any earlier. The placeholder is the same element, for
   * the same duration, on the same condition — it just renders INSIDE the
   * provider now, so the context fetch runs alongside the identity fetch
   * instead of behind it. The provider itself renders only its children, so
   * mounting it early cannot put anything on screen.
   */
  return (
    <PlatformContextProvider>
      <LegalAcceptanceStep active={authReady && hasSession} />
      {signOutNotice}
      {!authReady ? (
        <div className="min-h-screen bg-[#f3f5f7]" />
      ) : !hasSession && isInvitationAcceptPath(pathname) ? (
        <div data-signed-out-invitation className="min-h-screen" style={{ display: "flex", justifyContent: "center" }}>
          {children}
        </div>
      ) : (
      <SignedOutAppGate active={!hasSession} pathname={pathname}>
      <AppShellV2 onLogout={handleLogout}>
        {/* Both slots carry STABLE DOMAIN KEYS, and the route child rides a
            keyed fragment — deliberately, and not decoration:

            `children` here is the server route subtree, which arrives as a
            Flight-deserialized lazy element WITHOUT the `validated` mark the
            jsx runtime stamps on the elements it creates. React 19 validates
            keys in the reconciler off that mark, so this pair — an array by
            the time the shell's <main> renders it — logged a missing-key
            warning on every post-login mount, blamed on whichever component
            owned the slot (`main`, then `AppLayout`). Traced with a fiber
            walk and bisection: the child fiber is the lazy route element,
            and Next's dev segment-explorer was ruled out separately (its
            wrapper is gone from the warning's fiber chain with the flag off,
            and the warning survived).

            The route child is opaque, so the key lives on a fragment AROUND
            it; the fragment holds one child, so nothing under it reconciles
            as an array. The keys are identity, not order: the two slots are
            different kinds of thing, and neither ever swaps position. */}
        <Fragment key="route-content">{children}</Fragment>
        {hasSession && !hideAiWidget ? (
          <ProovraChatWidget key="assistant-widget" />
        ) : null}
      </AppShellV2>
      </SignedOutAppGate>
      )}
    </PlatformContextProvider>
  );
}

